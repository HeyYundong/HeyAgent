import unittest

from heyagent_desktop_agent.inputplan import InputPlanner, Pacer, plan_text, text_actions, to_absolute


class AbsoluteTest(unittest.TestCase):
    def test_corners(self):
        self.assertEqual(to_absolute(0, 0, 1920, 1080), (0, 0))
        self.assertEqual(to_absolute(1919, 1079, 1920, 1080), (65535, 65535))
        self.assertEqual(to_absolute(5000, -3, 1920, 1080), (65535, 0))
        self.assertEqual(to_absolute(959.6, 540, 1920, 1080), (round(960 * 65535 / 1919), round(540 * 65535 / 1079)))


class MouseTest(unittest.TestCase):
    def setUp(self):
        self.planner = InputPlanner()

    def plan(self, **message):
        return self.planner.plan({"t": "mouse", **message}, 1920, 1080)

    def test_click(self):
        self.assertEqual(self.plan(type="mousePressed", x=100.4, y=200.6, button="left"), [("move", 100, 201), ("button", "left", True)])
        self.assertEqual(self.planner.pressed_buttons, {"left"})
        self.assertEqual(self.plan(type="mouseReleased", x=100, y=201, button="left"), [("move", 100, 201), ("button", "left", False)])
        self.assertEqual(self.planner.pressed_buttons, set())

    def test_move_and_clamp(self):
        self.assertEqual(self.plan(type="mouseMoved", x=-5, y=9999), [("move", 0, 1079)])
        self.assertEqual(self.plan(type="mousePressed", x=1, y=1, button="none"), [("move", 1, 1)])

    def test_side_buttons(self):
        self.assertEqual(self.plan(type="mousePressed", x=1, y=1, button="back")[1], ("button", "back", True))
        self.assertEqual(self.plan(type="mousePressed", x=1, y=1, button="forward")[1], ("button", "forward", True))

    def test_wheel_whole_notches(self):
        # 浏览器往下滚一格 deltaY = 100 → Windows 往下一格 = -120
        self.assertEqual(self.plan(type="mouseWheel", x=5, y=5, deltaY=100), [("move", 5, 5), ("wheel", -120)])
        self.assertEqual(self.plan(type="mouseWheel", x=5, y=5, deltaY=-300), [("move", 5, 5), ("wheel", 360)])
        self.assertEqual(self.plan(type="mouseWheel", x=5, y=5, deltaX=100), [("move", 5, 5), ("hwheel", 120)])

    def test_wheel_accumulates_small_deltas(self):
        results = [self.plan(type="mouseWheel", x=0, y=0, deltaY=40) for _ in range(5)]
        wheels = [a for r in results for a in r if a[0] == "wheel"]
        # 5 × 40 = 200 像素 = 2 格
        self.assertEqual(sum(a[1] for a in wheels), -240)

    def test_release_all(self):
        self.plan(type="mousePressed", x=1, y=1, button="right")
        self.planner.plan({"t": "key", "type": "keyDown", "code": "ShiftLeft"}, 1920, 1080)
        self.assertEqual(self.planner.release_all(), [("key", 0xA0, False, False), ("button", "right", False)])
        self.assertEqual(self.planner.release_all(), [])


class KeyTest(unittest.TestCase):
    def setUp(self):
        self.planner = InputPlanner()

    def plan(self, **message):
        return self.planner.plan({"t": "key", **message}, 1920, 1080)

    def test_down_up(self):
        self.assertEqual(self.plan(type="keyDown", code="KeyA", keyCode=65), [("key", 0x41, False, True)])
        self.assertEqual(self.plan(type="rawKeyDown", code="ArrowLeft", keyCode=37), [("key", 0x25, True, True)])
        self.assertEqual(self.plan(type="keyUp", code="KeyA", keyCode=65), [("key", 0x41, False, False)])
        self.assertEqual(self.planner.pressed_keys, {0x25: True})

    def test_printable_keys_typed_as_text(self):
        # 绕过虚拟机里的输入法：按 text 发 unicode，keyUp 不发
        self.assertEqual(self.plan(type="keyDown", code="KeyA", keyCode=65, key="a", text="a"), [("unicode", 0x61, True), ("unicode", 0x61, False)])
        self.assertEqual(self.plan(type="keyDown", code="KeyA", keyCode=65, key="a", text="a"), [("unicode", 0x61, True), ("unicode", 0x61, False)])
        self.assertEqual(self.plan(type="keyUp", code="KeyA", keyCode=65, key="a"), [])
        self.assertEqual(self.planner.pressed_keys, {})
        # Shift 照样按键发；Shift+C 的 text 是 C
        self.assertEqual(self.plan(type="rawKeyDown", code="ShiftLeft", keyCode=16, modifiers=8), [("key", 0xA0, False, True)])
        self.assertEqual(self.plan(type="keyDown", code="KeyC", keyCode=67, text="C", modifiers=8), [("unicode", 0x43, True), ("unicode", 0x43, False)])

    def test_enter_space_and_commands_stay_keys(self):
        self.assertEqual(self.plan(type="keyDown", code="Enter", keyCode=13, text="\r"), [("key", 0x0D, False, True)])
        self.assertEqual(self.plan(type="keyDown", code="Space", keyCode=32, text=" "), [("key", 0x20, False, True)])
        self.assertEqual(self.plan(type="keyDown", code="KeyC", keyCode=67, text="c", modifiers=2), [("key", 0x43, False, True)])
        self.assertEqual(self.plan(type="keyUp", code="KeyC", keyCode=67, modifiers=2), [("key", 0x43, False, False)])

    def test_char_and_unknown_ignored(self):
        self.assertEqual(self.plan(type="char", code="KeyA", text="a"), [])
        self.assertEqual(self.plan(type="keyDown", code="Fn"), [])

    def test_combo(self):
        actions = self.planner.plan({"t": "combo", "keys": "win+r"}, 1920, 1080)
        self.assertEqual(actions, [("key", 0x5B, True, True), ("key", 0x52, False, True), ("key", 0x52, False, False), ("key", 0x5B, True, False)])
        self.assertEqual(self.planner.plan({"t": "combo", "keys": "win"}, 1920, 1080), [("key", 0x5B, True, True), ("key", 0x5B, True, False)])


class TextTest(unittest.TestCase):
    def test_chinese_units(self):
        self.assertEqual(text_actions("中a"), [("unicode", 0x4E2D, True), ("unicode", 0x4E2D, False), ("unicode", 0x61, True), ("unicode", 0x61, False)])

    def test_surrogate_pair(self):
        units = [a[1] for a in text_actions("😀") if a[2]]
        self.assertEqual(units, [0xD83D, 0xDE00])

    def test_short_line_typed(self):
        self.assertEqual(plan_text("你好"), text_actions("你好"))
        self.assertEqual(plan_text("x" * 64), text_actions("x" * 64))

    def test_multiline_and_long_pasted(self):
        self.assertEqual(plan_text("a\nb\r\nc\rd"), [("paste", "a\r\nb\r\nc\r\nd")])
        self.assertEqual(plan_text("x" * 65), [("paste", "x" * 65)])
        # 按 UTF-16 码元数：33 个 emoji = 66 个码元
        self.assertEqual(plan_text("😀" * 33)[0][0], "paste")
        planner = InputPlanner()
        self.assertEqual(planner.plan({"t": "text", "text": "第一行\n第二行"}, 100, 100), [("paste", "第一行\r\n第二行")])

    def test_type_endpoint_restores_clipboard(self):
        self.assertEqual(plan_text("第一行\n第二行", restore_clipboard=True), [("paste", "第一行\r\n第二行", True)])
        self.assertEqual(plan_text("你好", restore_clipboard=True), text_actions("你好"))


class PacerTest(unittest.TestCase):
    def test_keys_wait_for_typed_text(self):
        pacer = Pacer(per_unit=0.01)
        pacer.sent(text_actions("你好吗"), now=100.0)
        self.assertAlmostEqual(pacer.settle_until, 100.03)
        self.assertAlmostEqual(pacer.delay_before([("key", 13, False, True)], now=100.01), 0.02)
        self.assertAlmostEqual(pacer.delay_before([("move", 1, 1), ("button", "left", True)], now=100.0), 0.03)
        self.assertAlmostEqual(pacer.delay_before([("paste", "x")], now=100.0), 0.03)
        # 移动、滚轮、继续打字不用等
        self.assertEqual(pacer.delay_before([("move", 1, 1)], now=100.0), 0.0)
        self.assertEqual(pacer.delay_before([("move", 1, 1), ("wheel", 120)], now=100.0), 0.0)
        self.assertEqual(pacer.delay_before(text_actions("a"), now=100.0), 0.0)
        # 接着打的字排在后面
        pacer.sent(text_actions("ab"), now=100.01)
        self.assertAlmostEqual(pacer.settle_until, 100.05)
        self.assertEqual(pacer.delay_before([("key", 13, False, True)], now=200.0), 0.0)

    def test_capped(self):
        pacer = Pacer(per_unit=1)
        pacer.sent(text_actions("x" * 50), now=0.0)
        self.assertEqual(pacer.delay_before([("key", 13, False, True)], now=0.0), 2.0)

if __name__ == "__main__":
    unittest.main()
