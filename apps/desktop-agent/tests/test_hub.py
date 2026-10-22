import asyncio
import unittest

from heyagent_desktop_agent.hub import ViewHub


class FakeImage:
    def __init__(self, width, height, pixels):
        self.size = (width, height)
        self.width, self.height = width, height
        self._pixels = pixels

    def tobytes(self):
        return self._pixels


class FakeBackend:
    def __init__(self):
        self.image = FakeImage(4, 3, b"one")
        self.position = (1, 1)
        self.hook = None
        self.grabs = 0

    def screen_size(self):
        return self.image.size

    def grab(self):
        self.grabs += 1
        return self.image

    def cursor(self):
        return self.position

    def start_hook(self, on_press):
        self.hook = on_press

    def stop_hook(self):
        self.hook = None


def encode(image, max_width, quality):
    return b"jpeg:" + image.tobytes()


async def drain(viewer, wait=0.15):
    await asyncio.sleep(wait)
    return viewer.take()


class HubTest(unittest.IsolatedAsyncioTestCase):
    async def test_meta_frames_and_skip_unchanged(self):
        backend = FakeBackend()
        hub = ViewHub(backend, encode, fps=50, cursor_hz=50, keyframe_seconds=60)
        viewer = await hub.join()
        items, frame = await drain(viewer)
        self.assertEqual(items[0], {"t": "meta", "width": 4, "height": 3, "canControl": True})
        self.assertIn({"t": "cursor", "x": 1, "y": 1, "kind": "move"}, items)
        self.assertEqual(frame, b"jpeg:one")
        # 画面没变：不再发帧，光标没动也不发
        items, frame = await drain(viewer)
        self.assertEqual((items, frame), ([], None))
        self.assertGreater(backend.grabs, 2)
        # 变了
        backend.image = FakeImage(4, 3, b"two")
        backend.position = (2, 3)
        items, frame = await drain(viewer)
        self.assertEqual(frame, b"jpeg:two")
        self.assertEqual(items, [{"t": "cursor", "x": 2, "y": 3, "kind": "move"}])
        hub.leave(viewer)

    async def test_resolution_change_resends_meta(self):
        backend = FakeBackend()
        hub = ViewHub(backend, encode, fps=50, keyframe_seconds=60)
        viewer = await hub.join()
        await drain(viewer)
        backend.image = FakeImage(8, 6, b"big")
        items, frame = await drain(viewer)
        self.assertEqual(items[0], {"t": "meta", "width": 8, "height": 6, "canControl": True})
        self.assertEqual(frame, b"jpeg:big")
        hub.leave(viewer)

    async def test_late_joiner_gets_last_frame_and_stop_when_empty(self):
        backend = FakeBackend()
        hub = ViewHub(backend, encode, fps=50)
        first = await hub.join()
        await drain(first)
        second = await hub.join()
        items, frame = second.take()
        self.assertEqual(items[0]["t"], "meta")
        self.assertEqual(frame, b"jpeg:one")
        self.assertIsNotNone(backend.hook)
        hub.leave(first)
        hub.leave(second)
        self.assertIsNone(backend.hook)
        grabs = backend.grabs
        await asyncio.sleep(0.1)
        self.assertEqual(backend.grabs, grabs)  # 没人看就不截屏
        self.assertIsNone(hub.last_frame)

    async def test_press_from_hook_thread(self):
        backend = FakeBackend()
        hub = ViewHub(backend, encode, fps=50)
        viewer = await hub.join()
        await drain(viewer)
        await asyncio.to_thread(backend.hook, 7, 8)
        items, _ = await drain(viewer, 0.05)
        self.assertIn({"t": "cursor", "x": 7, "y": 8, "kind": "press"}, items)
        hub.leave(viewer)

    async def test_rejoin_after_quick_leave_gets_frame_on_static_screen(self):
        # 控制台的第一个连接马上断开、第二个接着连上：画面一直没变，第二个也要拿到一帧
        backend = FakeBackend()
        hub = ViewHub(backend, encode, fps=50, keyframe_seconds=60)
        first = await hub.join()
        await drain(first)
        hub.leave(first)
        # 模拟被取消的截屏线程还往比较器里记了一笔
        hub._detector.changed(4, 3, b"one")
        second = await hub.join()
        items, frame = await drain(second)
        self.assertEqual(items[0]["t"], "meta")
        self.assertEqual(frame, b"jpeg:one")
        hub.leave(second)

    async def test_join_while_running_gets_frame_even_if_none_cached(self):
        backend = FakeBackend()
        hub = ViewHub(backend, encode, fps=50, keyframe_seconds=60)
        first = await hub.join()
        await drain(first)
        hub.last_frame = None  # 例如还没截到
        second = await hub.join()
        _, frame = await drain(second)
        self.assertEqual(frame, b"jpeg:one")
        hub.leave(first)
        hub.leave(second)

    async def test_keyframe_resent_when_static(self):
        backend = FakeBackend()
        hub = ViewHub(backend, encode, fps=50, keyframe_seconds=0.1)
        viewer = await hub.join()
        await drain(viewer, 0.05)
        frames = 0
        for _ in range(5):
            _, frame = await drain(viewer, 0.12)
            frames += frame == b"jpeg:one"
        self.assertGreaterEqual(frames, 4)
        hub.leave(viewer)


if __name__ == "__main__":
    unittest.main()
