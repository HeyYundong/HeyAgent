import unittest

from heyagent_desktop_agent.messages import parse_client_message as parse
from heyagent_desktop_agent.messages import parse_type_request


class ParseTest(unittest.TestCase):
    def test_mouse(self):
        message = parse({"t": "mouse", "type": "mousePressed", "x": 10.5, "y": 20, "button": "left", "buttons": 1, "clickCount": 1, "modifiers": 0, "extra": 1})
        self.assertEqual(message, {"t": "mouse", "type": "mousePressed", "x": 10.5, "y": 20, "button": "left", "buttons": 1, "clickCount": 1, "modifiers": 0})
        self.assertEqual(parse({"t": "mouse", "type": "mouseWheel", "x": 0, "y": 0, "deltaY": -100})["deltaY"], -100)

    def test_mouse_invalid(self):
        base = {"t": "mouse", "type": "mouseMoved", "x": 1, "y": 1}
        self.assertIsNotNone(parse(base))
        for change in [
            {"type": "click"},
            {"x": "1"},
            {"x": True},
            {"y": None},
            {"x": float("nan")},
            {"button": "side"},
            {"button": None},
            {"buttons": 32},
            {"buttons": 1.5},
            {"clickCount": 4},
            {"modifiers": 16},
            {"deltaY": "x"},
        ]:
            self.assertIsNone(parse({**base, **change}), change)
        self.assertIsNone(parse({"t": "mouse", "type": "mouseMoved", "x": 1}))
        self.assertEqual(parse({**base, "buttons": 2.0})["buttons"], 2)

    def test_key(self):
        self.assertEqual(
            parse({"t": "key", "type": "keyDown", "key": "a", "code": "KeyA", "keyCode": 65, "text": "a", "modifiers": 0}),
            {"t": "key", "type": "keyDown", "key": "a", "code": "KeyA", "keyCode": 65, "text": "a", "modifiers": 0},
        )
        self.assertEqual(parse({"t": "key", "type": "keyUp"}), {"t": "key", "type": "keyUp"})
        self.assertIsNone(parse({"t": "key", "type": "press", "code": "KeyA"}))
        self.assertIsNone(parse({"t": "key", "type": "keyUp", "code": "x" * 41}))
        self.assertIsNone(parse({"t": "key", "type": "keyUp", "keyCode": 1001}))
        self.assertIsNone(parse({"t": "key", "type": "keyDown", "text": "123456789"}))

    def test_text(self):
        self.assertEqual(parse({"t": "text", "text": "你好"}), {"t": "text", "text": "你好"})
        self.assertIsNone(parse({"t": "text", "text": ""}))
        self.assertIsNotNone(parse({"t": "text", "text": "x" * 10000}))
        self.assertIsNone(parse({"t": "text", "text": "x" * 10001}))
        # 长度按 UTF-16 码元：emoji 算 2
        self.assertIsNone(parse({"t": "text", "text": "😀" * 5001}))
        self.assertIsNone(parse({"t": "text", "text": 5}))

    def test_combo(self):
        for keys in ["win", "alt+tab", "alt+f4", "win+d", "win+r"]:
            self.assertEqual(parse({"t": "combo", "keys": keys}), {"t": "combo", "keys": keys})
        self.assertIsNone(parse({"t": "combo", "keys": "ctrl+alt+del"}))

    def test_browser_only_messages_dropped(self):
        for message in [
            {"t": "nav", "action": "back"},
            {"t": "tab", "id": 1},
            {"t": "closeTab", "id": 1},
            {"t": "dialog", "accept": True},
            {"t": 1},
            {},
            [],
            "mouse",
            None,
        ]:
            self.assertIsNone(parse(message), message)


class TypeRequestTest(unittest.TestCase):
    def test_valid(self):
        self.assertEqual(parse_type_request({"text": "你好 😀"}), "你好 😀")
        self.assertEqual(parse_type_request({"text": "a\nb", "extra": 1}), "a\nb")
        self.assertEqual(parse_type_request({"text": "x" * 10000}), "x" * 10000)

    def test_invalid(self):
        for body in [None, [], "text", {}, {"text": ""}, {"text": None}, {"text": 5}, {"text": ["a"]}, {"text": "x" * 10001}, {"text": "😀" * 5001}]:
            self.assertIsNone(parse_type_request(body), repr(body)[:40])


if __name__ == "__main__":
    unittest.main()
