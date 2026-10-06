import json
import unittest

from measure import MANIFEST, check

BENCHMARKS = [
    b
    for b in json.loads(MANIFEST.read_text())["benchmarks"]
    if "peers" not in b.get("skip", {})
]


class CheckTest(unittest.TestCase):
    def test_every_port_produces_the_scripts_expected_output(self):
        for b in BENCHMARKS:
            with self.subTest(b["name"]):
                check(b, b["smoke"])

    def test_a_wrong_expected_output_fails_the_check(self):
        b = BENCHMARKS[0]
        wrong = {**b["smoke"], "expect": b["smoke"]["expect"] + "0"}
        with self.assertRaisesRegex(ValueError, f"expected {wrong['expect']}$"):
            check(b, wrong)

    def test_a_missing_port_fails_the_check(self):
        with self.assertRaises(OSError):
            check({"name": "core/absent"}, BENCHMARKS[0]["smoke"])


if __name__ == "__main__":
    unittest.main()
