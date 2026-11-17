#!/usr/bin/env python3
import unittest
from wake_gate import WakeCommandGate


class WakeCommandGateTest(unittest.TestCase):
    def test_wake_only_waits_for_next_command_segment(self):
        gate = WakeCommandGate(timeout_s=8)
        gate.wake("你好贾维斯", 100.0)
        self.assertEqual(gate.on_text("你好，贾维斯。", 100.2), "wait")
        self.assertTrue(gate.active)
        self.assertEqual(gate.on_text("给我讲一个长故事", 101.0), "accept")

    def test_full_phrase_is_accepted_immediately(self):
        gate = WakeCommandGate()
        gate.wake("你好贾维斯", 0.0)
        self.assertEqual(gate.on_text("你好贾维斯，介绍一下你自己", 0.2), "accept")

    def test_empty_segment_waits_and_timeout_discards(self):
        gate = WakeCommandGate(timeout_s=2)
        gate.wake("你好贾维斯", 10.0)
        self.assertEqual(gate.on_text("", 10.5), "wait")
        self.assertTrue(gate.expired(12.1))
        self.assertEqual(gate.on_text("你好贾维斯", 12.1), "discard")
        self.assertFalse(gate.active)
    def test_stop_keeps_session_but_sleep_requires_new_wake(self):
        gate = WakeCommandGate(timeout_s=300)
        gate.wake("你好贾维斯", 0.0)
        self.assertEqual(gate.on_text("停一下", 1.0), "stop")
        self.assertTrue(gate.active)
        self.assertEqual(gate.on_text("你好贾维斯，休息吧", 2.0), "sleep")
        self.assertFalse(gate.active)
        self.assertEqual(gate.on_text("随便说话", 3.0), "discard")
        gate.wake("你好贾维斯", 10.0)
        self.assertEqual(gate.on_text("介绍你自己", 10.2), "accept")

    def test_accepted_command_refreshes_five_minute_session(self):
        gate = WakeCommandGate(timeout_s=300)
        gate.wake("你好贾维斯", 0.0)
        self.assertEqual(gate.on_text("讲一个故事", 100.0), "accept")
        self.assertTrue(gate.active)
        self.assertFalse(gate.expired(350.0))  # 距最近指令 250 秒
        self.assertTrue(gate.expired(401.0))   # 距最近指令 301 秒


if __name__ == "__main__":
    unittest.main()
