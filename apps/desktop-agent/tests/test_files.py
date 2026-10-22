import unittest

from heyagent_desktop_agent.files import header_file_name, is_allowed_path, resolve_download, sanitize_name, unique_name

ROOTS = [r"C:\Users\spike", r"C:\HeyAgent\files"]


class SanitizeTest(unittest.TestCase):
    def test_plain(self):
        self.assertEqual(sanitize_name("报价单.xlsx"), "报价单.xlsx")

    def test_strips_directories_and_bad_chars(self):
        self.assertEqual(sanitize_name(r"..\..\Windows\system32\evil.dll"), "evil.dll")
        self.assertEqual(sanitize_name("a/b/c.txt"), "c.txt")
        self.assertEqual(sanitize_name('a<b>c:"d|e?f*.txt'), "a_b_c__d_e_f_.txt")
        self.assertEqual(sanitize_name("x\x00y\n.txt"), "x_y_.txt")

    def test_empty_and_dots(self):
        for name in ["", "   ", ".", "..", "...", "a/"]:
            self.assertEqual(sanitize_name(name), "file", repr(name))
        self.assertEqual(sanitize_name("report. . "), "report")

    def test_reserved(self):
        self.assertEqual(sanitize_name("CON"), "_CON")
        self.assertEqual(sanitize_name("nul.txt"), "_nul.txt")
        self.assertEqual(sanitize_name("com1.tar.gz"), "_com1.tar.gz")
        self.assertEqual(sanitize_name("console.txt"), "console.txt")

    def test_long(self):
        name = sanitize_name("长" * 300 + ".docx")
        self.assertEqual(len(name), 150)
        self.assertTrue(name.endswith(".docx"))


class UniqueTest(unittest.TestCase):
    def test_numbering(self):
        taken = {"a.txt", "a (1).txt"}
        self.assertEqual(unique_name("a.txt", taken.__contains__), "a (2).txt")
        self.assertEqual(unique_name("b.txt", taken.__contains__), "b.txt")
        self.assertEqual(unique_name("Makefile", {"Makefile"}.__contains__), "Makefile (1)")


class AllowedTest(unittest.TestCase):
    def test_inside(self):
        self.assertTrue(is_allowed_path(r"C:\Users\spike\Desktop\a.txt", ROOTS))
        self.assertTrue(is_allowed_path(r"c:\users\SPIKE\desktop\a.txt", ROOTS))
        self.assertTrue(is_allowed_path(r"C:\HeyAgent\files\2026-10-22\a.txt", ROOTS))
        self.assertTrue(is_allowed_path("C:/Users/spike/a.txt", ROOTS))

    def test_outside(self):
        for path in [
            r"C:\Windows\win.ini",
            r"C:\HeyAgent\key",
            r"C:\Users\spike",
            r"C:\Users\spike2\a.txt",
            r"C:\Users\spike\..\other\a.txt",
            r"C:\HeyAgent\files\..\key",
            r"Users\spike\a.txt",
            r"C:Users\spike\a.txt",
            r"\\server\share\Users\spike\a.txt",
            r"\\?\C:\Users\spike\a.txt",
            r"\\.\C:\Users\spike\a.txt",
            r"C:\Users\spike\a.txt:secret",
            "",
            "C:\\Users\\spike\\a\x00.txt",
        ]:
            self.assertFalse(is_allowed_path(path, ROOTS), path)

    def test_empty_root_ignored(self):
        self.assertFalse(is_allowed_path(r"C:\a.txt", ["", r"C:\HeyAgent\files"]))

    def test_resolve_follows_links(self):
        links = {r"C:\Users\spike\link.txt": r"C:\HeyAgent\key"}
        real = lambda p: links.get(p, p)  # noqa: E731
        self.assertIsNone(resolve_download(r"C:\Users\spike\link.txt", ROOTS, real))
        self.assertEqual(resolve_download(r"C:\Users\spike\a.txt", ROOTS, real), r"C:\Users\spike\a.txt")


class HeaderTest(unittest.TestCase):
    def test_encoding(self):
        self.assertEqual(header_file_name("a b.txt"), "a%20b.txt")
        self.assertEqual(header_file_name("报价.xlsx"), "%E6%8A%A5%E4%BB%B7.xlsx")
        header_file_name("报价.xlsx").encode("latin-1")


if __name__ == "__main__":
    unittest.main()
