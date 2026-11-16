#!/usr/bin/env python3
import importlib.util
import json
import unittest
from pathlib import Path
from unittest.mock import patch

SPEC = importlib.util.spec_from_file_location("open_settings", Path(__file__).with_name("open-settings.py"))
MODULE = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(MODULE)


class OpenSettingsTest(unittest.TestCase):
    def test_existing_window_is_focused_without_http(self):
        clients = [{"title": "JARVIS 设置", "address": "0xabc"}]
        with patch.object(MODULE.subprocess, "check_output", return_value=json.dumps(clients)), \
             patch.object(MODULE.subprocess, "run") as run, \
             patch.object(MODULE.urllib.request, "urlopen", side_effect=AssertionError("不应请求 HTTP")):
            MODULE.main()
        self.assertEqual(run.call_args.args[0], ["hyprctl", "dispatch", "focuswindow", "address:0xabc"])

    def test_missing_window_calls_ui_host(self):
        response = unittest.mock.MagicMock()
        response.read.return_value = b'{"ok":true,"windowId":"abc"}'
        response.__enter__.return_value = response
        with patch.object(MODULE.subprocess, "check_output", return_value="[]"), \
             patch.object(MODULE.urllib.request, "urlopen", return_value=response) as urlopen:
            MODULE.main()
        request = urlopen.call_args.args[0]
        self.assertEqual(request.full_url, "http://127.0.0.1:8788/ui/render")
        self.assertEqual(json.loads(request.data)["type"], "settings")


if __name__ == "__main__":
    unittest.main()
