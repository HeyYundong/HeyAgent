import unittest

from heyagent_desktop_agent.frames import ChangeDetector, scaled_size


class FramesTest(unittest.TestCase):
    def test_scaled_size(self):
        self.assertEqual(scaled_size(1920, 1080, 1280), (1280, 720))
        self.assertEqual(scaled_size(2560, 1600, 1280), (1280, 800))
        self.assertEqual(scaled_size(1024, 768, 1280), (1024, 768))
        self.assertEqual(scaled_size(1920, 1080, 0), (1920, 1080))

    def test_change_detector(self):
        detector = ChangeDetector()
        self.assertTrue(detector.changed(2, 1, b"abcdef"))
        self.assertFalse(detector.changed(2, 1, b"abcdef"))
        self.assertTrue(detector.changed(2, 1, b"abcdeg"))
        self.assertTrue(detector.changed(1, 2, b"abcdeg"))
        detector.reset()
        self.assertTrue(detector.changed(1, 2, b"abcdeg"))


if __name__ == "__main__":
    unittest.main()
