import unittest

from heyagent_desktop_agent.keymap import COMBOS, Key, key_for


class KeyForTest(unittest.TestCase):
    def test_letters_digits_by_code(self):
        self.assertEqual(key_for("KeyA", 65), Key(0x41, False))
        self.assertEqual(key_for("KeyZ", None), Key(0x5A, False))
        self.assertEqual(key_for("Digit0", 48), Key(0x30, False))
        self.assertEqual(key_for("Numpad7", None), Key(0x67, False))

    def test_code_wins_over_key_code(self):
        # 法语键盘上 KeyQ 打出 a（keyCode 65），按物理键位走
        self.assertEqual(key_for("KeyQ", 65).vk, ord("Q"))

    def test_left_right_modifiers(self):
        self.assertEqual(key_for("ShiftLeft", 16), Key(0xA0, False))
        self.assertEqual(key_for("ShiftRight", 16), Key(0xA1, False))
        self.assertEqual(key_for("ControlRight", 17), Key(0xA3, True))
        self.assertEqual(key_for("AltRight", 18), Key(0xA5, True))
        self.assertEqual(key_for("MetaLeft", 91), Key(0x5B, True))

    def test_extended_navigation_keys(self):
        for code, vk in [("ArrowLeft", 0x25), ("ArrowDown", 0x28), ("Delete", 0x2E), ("Home", 0x24), ("PageDown", 0x22)]:
            self.assertEqual(key_for(code, None), Key(vk, True), code)
        self.assertEqual(key_for("NumpadEnter", 13), Key(0x0D, True))
        self.assertEqual(key_for("Enter", 13), Key(0x0D, False))

    def test_function_and_punctuation(self):
        self.assertEqual(key_for("F1", 112).vk, 0x70)
        self.assertEqual(key_for("F12", 123).vk, 0x7B)
        self.assertEqual(key_for("F24", None).vk, 0x87)
        self.assertEqual(key_for("Semicolon", 186).vk, 0xBA)
        self.assertEqual(key_for("Backquote", 192).vk, 0xC0)
        self.assertEqual(key_for("BracketLeft", 219).vk, 0xDB)
        self.assertEqual(key_for("Quote", 222).vk, 0xDE)

    def test_key_code_fallback(self):
        self.assertEqual(key_for("", 65), Key(65, False))
        self.assertEqual(key_for(None, 37), Key(37, True))  # ←
        self.assertEqual(key_for("Unidentified", 13), Key(13, False))
        self.assertEqual(key_for(None, 59).vk, 0xBA)  # Firefox 的分号

    def test_unknown(self):
        self.assertIsNone(key_for(None, None))
        self.assertIsNone(key_for("Fn", None))
        self.assertIsNone(key_for(None, 0))
        self.assertIsNone(key_for(None, 229))  # 输入法占位
        self.assertIsNone(key_for(None, 300))

    def test_combos(self):
        self.assertEqual(set(COMBOS), {"win", "alt+tab", "alt+f4", "win+d", "win+r"})
        self.assertEqual([k.vk for k in COMBOS["alt+f4"]], [0xA4, 0x73])
        self.assertEqual([k.vk for k in COMBOS["win+r"]], [0x5B, ord("R")])


if __name__ == "__main__":
    unittest.main()
