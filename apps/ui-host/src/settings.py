#!/usr/bin/env python3
"""JARVIS 设置读写（settings.json）。

设置项：
- wakeWord：唤醒词（默认「你好贾维斯」）
- voiceEnabled：语音反馈（默认 true）
- notifyEnabled：主动通知（默认 true）
- agentAutoStart：agent 开机自启（默认 true）

用法：
    from settings import load_settings, save_settings
    settings = load_settings()
    settings["wakeWord"] = "你好小贾"
    save_settings(settings)
"""
import json
from pathlib import Path

HOME = Path.home()
JARVIS_ROOT = HOME / ".local/share/jarvis"
SETTINGS_FILE = JARVIS_ROOT / "settings.json"

DEFAULT_SETTINGS = {
    "wakeWord": "你好贾维斯",
    "voiceEnabled": True,
    "notifyEnabled": True,
    "agentAutoStart": True,
}


def load_settings() -> dict:
    """加载设置（不存在则返回默认值）"""
    if not SETTINGS_FILE.exists():
        return DEFAULT_SETTINGS.copy()
    try:
        return {**DEFAULT_SETTINGS, **json.loads(SETTINGS_FILE.read_text(encoding="utf-8"))}
    except Exception:
        return DEFAULT_SETTINGS.copy()


def save_settings(settings: dict):
    """保存设置"""
    SETTINGS_FILE.parent.mkdir(parents=True, exist_ok=True)
    SETTINGS_FILE.write_text(json.dumps(settings, ensure_ascii=False, indent=2), encoding="utf-8")


def get_wake_word() -> str:
    """获取唤醒词"""
    return load_settings()["wakeWord"]


def set_wake_word(word: str):
    """设置唤醒词"""
    settings = load_settings()
    settings["wakeWord"] = word
    save_settings(settings)
