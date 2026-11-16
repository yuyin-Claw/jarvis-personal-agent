#!/usr/bin/env python3
import importlib.util
import json
import tempfile
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch

import agent_control
from settings import load_settings


class AgentControlTest(unittest.TestCase):
    def setUp(self):
        self.tmp_obj = tempfile.TemporaryDirectory(prefix="jarvis-settings-test-")
        self.tmp = Path(self.tmp_obj.name)
        self.settings = self.tmp / "settings.json"
        self.model = self.tmp / "kws-model"
        self.model.mkdir()
        self.keywords = self.model / "keywords.txt"
        self.keywords.write_text("n ǐ h ǎo j iǎ w éi s ī @你好贾维斯\n", encoding="utf-8")
        self.audit = patch.object(agent_control, "AUDIT_FILE", self.tmp / "audit.jsonl")
        self.audit.start()
        self.ok_proc = SimpleNamespace(returncode=0, stdout="", stderr="")

    def tearDown(self):
        self.audit.stop()
        self.tmp_obj.cleanup()

    @unittest.skipUnless(importlib.util.find_spec("pypinyin"), "需要 pypinyin")
    def test_chinese_to_kws_tokens(self):
        self.assertEqual(
            agent_control.chinese_to_kws_tokens("你好贾维斯"),
            "n ǐ h ǎo j iǎ w éi s ī @你好贾维斯",
        )
        self.assertEqual(
            agent_control.chinese_to_kws_tokens("小爱同学"),
            "x iǎo ài t óng x ué @小爱同学",
        )

    def test_invalid_word_rejected(self):
        for word in ("贾", "hello", "你好贾维斯啊啊啊啊", "你好 Jarvis"):
            with self.assertRaises(ValueError):
                agent_control.chinese_to_kws_tokens(word)

    def test_wake_word_success_restarts_voice_and_persists(self):
        calls = []
        with patch.object(agent_control, "chinese_to_kws_tokens", return_value="n ǐ h ǎo x iǎo j iǎ @你好小贾"), \
             patch.object(agent_control, "validate_kws_model"), \
             patch.object(agent_control, "service_state", return_value={"active": True, "state": "active"}), \
             patch.object(agent_control, "service_status", return_value={}), \
             patch.object(agent_control, "run_systemctl", side_effect=lambda args, timeout=20: calls.append(args) or self.ok_proc):
            result = agent_control.change_wake_word(
                "你好小贾", settings_file=self.settings, model_dir=self.model,
            )
        self.assertTrue(result["ok"])
        self.assertTrue(result["voiceRestarted"])
        self.assertEqual(calls, [["restart", "jarvis-voice"]])
        self.assertEqual(self.keywords.read_text(encoding="utf-8"), "n ǐ h ǎo x iǎo j iǎ @你好小贾\n")
        self.assertEqual(load_settings(self.settings)["wakeWord"], "你好小贾")

    def test_wake_word_validation_failure_rolls_back(self):
        before = self.keywords.read_bytes()
        with patch.object(agent_control, "chinese_to_kws_tokens", return_value="n ǐ h ǎo x iǎo j iǎ @你好小贾"), \
             patch.object(agent_control, "validate_kws_model", side_effect=RuntimeError("bad tokens")), \
             patch.object(agent_control, "service_state", return_value={"active": True, "state": "active"}):
            with self.assertRaisesRegex(RuntimeError, "已回滚"):
                agent_control.change_wake_word("你好小贾", settings_file=self.settings, model_dir=self.model)
        self.assertEqual(self.keywords.read_bytes(), before)
        self.assertEqual(load_settings(self.settings)["wakeWord"], "你好贾维斯")

    def test_stop_only_targets_agent_services_in_reverse_order(self):
        states = {
            **{name: {"active": False, "state": "inactive"} for name in agent_control.AGENT_SERVICES},
            **{name: {"active": True, "state": "active"} for name in agent_control.INFRA_SERVICES},
        }
        calls = []
        with patch.object(agent_control, "run_systemctl", side_effect=lambda args, timeout=20: calls.append(args) or self.ok_proc), \
             patch.object(agent_control, "service_status", return_value=states):
            result = agent_control.control_agents("stop")
        self.assertTrue(result["ok"])
        self.assertEqual(calls[0], ["stop", "jarvis-avatar", "jarvis-voice", "jarvis-core"])
        self.assertNotIn("jarvis-ui-host", calls[0])
        self.assertNotIn("jarvis-bridge-agent", calls[0])


if __name__ == "__main__":
    unittest.main()
