#!/usr/bin/env python3
import importlib.util
import json
import tempfile
import unittest
from pathlib import Path

SPEC = importlib.util.spec_from_file_location("ui_server", Path(__file__).with_name("server.py"))
SERVER = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(SERVER)


class PersistenceTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        SERVER.JARVIS_ROOT = Path(self.tmp.name)
        SERVER.WINDOWS_FILE = SERVER.JARVIS_ROOT / "ui-windows" / "windows.json"
        SERVER.WINDOWS = {
            "abc123": {
                "type": "confirm", "title": "确认", "data": {"text": "继续？"},
                "actions": [{"id": "ok", "label": "确定"}],
                "result": {"action": "ok", "at": 123}, "createdAt": 100,
            }
        }

    def tearDown(self):
        self.tmp.cleanup()

    def test_save_and_load_round_trip_preserves_result(self):
        SERVER.save_windows()
        SERVER.WINDOWS = {}
        loaded = SERVER.load_windows()
        self.assertEqual(loaded["abc123"]["result"]["action"], "ok")
        self.assertEqual(loaded["abc123"]["data"]["text"], "继续？")
        self.assertTrue(SERVER.WINDOWS_FILE.exists())

    def test_corrupt_registry_is_backed_up(self):
        SERVER.WINDOWS_FILE.parent.mkdir(parents=True)
        SERVER.WINDOWS_FILE.write_text("not json", encoding="utf-8")
        self.assertEqual(SERVER.load_windows(), {})
        backups = list(SERVER.WINDOWS_FILE.parent.glob("windows.corrupt-*.json"))
        self.assertEqual(len(backups), 1)
        self.assertEqual(backups[0].read_text(encoding="utf-8"), "not json")


if __name__ == "__main__":
    unittest.main()
