#!/usr/bin/env python3
"""JARVIS 设置持久化（settings.json，原子写入）。"""
import json
import os
from pathlib import Path

HOME = Path.home()
JARVIS_ROOT = Path(os.environ.get("JARVIS_ROOT", str(HOME / ".local/share/jarvis")))
SETTINGS_FILE = Path(os.environ.get("JARVIS_SETTINGS_FILE", str(JARVIS_ROOT / "settings.json")))

DEFAULT_SETTINGS = {
    "wakeWord": "你好贾维斯",
    "voiceEnabled": True,
    "notifyEnabled": True,
    "agentAutoStart": True,
}


def load_settings(path: Path | None = None) -> dict:
    """加载设置；文件不存在或损坏时返回默认值。"""
    target = path or SETTINGS_FILE
    if not target.exists():
        return DEFAULT_SETTINGS.copy()
    try:
        return {**DEFAULT_SETTINGS, **json.loads(target.read_text(encoding="utf-8"))}
    except Exception:
        return DEFAULT_SETTINGS.copy()


def save_settings(settings: dict, path: Path | None = None):
    """原子保存设置，避免进程中断留下半个 JSON 文件。"""
    target = path or SETTINGS_FILE
    target.parent.mkdir(parents=True, exist_ok=True)
    tmp = target.with_suffix(target.suffix + ".tmp")
    tmp.write_text(json.dumps(settings, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    tmp.replace(target)


def update_preferences(values: dict) -> dict:
    """更新语音/通知开关，只允许布尔值，忽略其他键。"""
    settings = load_settings()
    for key in ("voiceEnabled", "notifyEnabled", "agentAutoStart"):
        if key in values:
            if not isinstance(values[key], bool):
                raise ValueError(f"{key} 必须是布尔值")
            settings[key] = values[key]
    save_settings(settings)
    return settings
