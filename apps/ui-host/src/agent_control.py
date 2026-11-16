#!/usr/bin/env python3
"""JARVIS 设置中心后端：服务状态、启停、唤醒词事务式更新。

边界：UI Host 与 bridge-agent 保持运行，确保 Agent 停止后仍能从此窗口重新激活。
"""
import json
import re
import subprocess
import time
from pathlib import Path

from settings import JARVIS_ROOT, SETTINGS_FILE, load_settings, save_settings

AGENT_SERVICES = ("jarvis-core", "jarvis-voice", "jarvis-avatar")
INFRA_SERVICES = ("jarvis-bridge-agent", "jarvis-ui-host")
AUDIT_FILE = JARVIS_ROOT / "settings-actions.jsonl"


def audit(action: str, **data):
    AUDIT_FILE.parent.mkdir(parents=True, exist_ok=True)
    record = {"at": int(time.time() * 1000), "action": action, **data}
    with AUDIT_FILE.open("a", encoding="utf-8") as f:
        f.write(json.dumps(record, ensure_ascii=False) + "\n")


def run_systemctl(args: list[str], timeout: int = 20) -> subprocess.CompletedProcess:
    return subprocess.run(
        ["systemctl", "--user", *args],
        text=True,
        capture_output=True,
        timeout=timeout,
        check=False,
    )


def service_state(name: str) -> dict:
    try:
        p = run_systemctl(["is-active", name], timeout=5)
        state = p.stdout.strip() or "unknown"
    except subprocess.TimeoutExpired:
        state = "timeout"
    return {"active": state == "active", "state": state}


def service_status() -> dict:
    return {name: service_state(name) for name in (*AGENT_SERVICES, *INFRA_SERVICES)}


def control_agents(action: str) -> dict:
    if action not in ("start", "stop", "restart"):
        raise ValueError("action 仅支持 start / stop / restart")
    # 启动先核心与语音，停止按相反顺序；UI Host/bridge-agent 不动。
    targets = list(AGENT_SERVICES if action != "stop" else reversed(AGENT_SERVICES))
    audit("agent_control_begin", command=action)
    try:
        p = run_systemctl([action, *targets])
        if p.returncode != 0:
            raise RuntimeError(p.stderr.strip() or p.stdout.strip() or f"systemctl {action} 失败")
        services = service_status()
        expected = action != "stop"
        actual_ok = all(services[name]["active"] is expected for name in AGENT_SERVICES)
        if not actual_ok:
            raise RuntimeError("systemctl 已返回，但服务状态未达到预期")
        audit("agent_control_ok", command=action)
        return {"ok": True, "action": action, "services": services}
    except Exception as e:
        services = service_status()
        audit("agent_control_error", command=action, error=str(e))
        return {"ok": False, "action": action, "error": str(e), "services": services}


def chinese_to_kws_tokens(word: str) -> str:
    """中文 → sherpa-onnx wenetspeech KWS 音素行（INITIALS + FINALS_TONE）。"""
    if not re.fullmatch(r"[\u4e00-\u9fff]{2,8}", word):
        raise ValueError("唤醒词须为 2-8 个汉字（当前 KWS 模型仅支持中文）")
    try:
        from pypinyin import Style, lazy_pinyin
    except ImportError as e:
        raise RuntimeError("缺少 pypinyin，无法生成唤醒词音素") from e
    initials = lazy_pinyin(word, style=Style.INITIALS, strict=False)
    finals = lazy_pinyin(word, style=Style.FINALS_TONE, strict=False)
    if len(initials) != len(finals):
        raise RuntimeError("唤醒词拼音解析失败")
    tokens = []
    for initial, final in zip(initials, finals):
        if initial:
            tokens.append(initial)
        if final:
            tokens.append(final)
    if not tokens:
        raise RuntimeError("唤醒词音素为空")
    return " ".join(tokens) + " @" + word


def validate_kws_model(model_dir: Path):
    """实际加载一次 KWS，确保新 keywords 与 tokens/模型兼容。"""
    import sherpa_onnx
    spotter = sherpa_onnx.KeywordSpotter(
        encoder=str(model_dir / "encoder-epoch-99-avg-1-chunk-16-left-64.int8.onnx"),
        decoder=str(model_dir / "decoder-epoch-99-avg-1-chunk-16-left-64.int8.onnx"),
        joiner=str(model_dir / "joiner-epoch-12-avg-2-chunk-16-left-64.int8.onnx"),
        tokens=str(model_dir / "tokens.txt"),
        keywords_file=str(model_dir / "keywords.txt"),
        num_threads=1,
    )
    del spotter


def change_wake_word(
    word: str,
    *,
    settings_file: Path = SETTINGS_FILE,
    model_dir: Path | None = None,
) -> dict:
    """事务式修改唤醒词：任一步失败都恢复旧 keywords 与 settings。"""
    word = word.strip()
    token_line = chinese_to_kws_tokens(word)
    model_dir = model_dir or JARVIS_ROOT / "kws-model"
    keywords_file = model_dir / "keywords.txt"
    if not keywords_file.exists():
        raise RuntimeError(f"KWS keywords 不存在：{keywords_file}")

    old_settings = load_settings(settings_file)
    old_keywords = keywords_file.read_bytes()
    was_active = service_state("jarvis-voice")["active"]
    restarted = False
    audit("wake_word_begin", old=old_settings.get("wakeWord"), new=word)
    try:
        keywords_file.with_suffix(".previous").write_bytes(old_keywords)
        tmp = keywords_file.with_suffix(".tmp")
        # 只保留当前自定义唤醒词，确保旧词不再继续触发。
        tmp.write_text(token_line + "\n", encoding="utf-8")
        tmp.replace(keywords_file)

        validate_kws_model(model_dir)
        if was_active:
            p = run_systemctl(["restart", "jarvis-voice"])
            restarted = True
            if p.returncode != 0 or not service_state("jarvis-voice")["active"]:
                raise RuntimeError(p.stderr.strip() or "jarvis-voice 重启后未恢复 active")

        new_settings = {**old_settings, "wakeWord": word}
        save_settings(new_settings, settings_file)
        audit("wake_word_ok", new=word, tokens=token_line, voiceRestarted=restarted)
        return {
            "ok": True,
            "wakeWord": word,
            "tokens": token_line,
            "voiceRestarted": restarted,
            "settings": new_settings,
            "services": service_status(),
        }
    except Exception as e:
        # 先恢复关键词，再恢复 voice；settings 若已写入也一并回滚。
        keywords_file.write_bytes(old_keywords)
        save_settings(old_settings, settings_file)
        rollback_error = ""
        if restarted:
            p = run_systemctl(["restart", "jarvis-voice"])
            if p.returncode != 0:
                rollback_error = p.stderr.strip()
        audit("wake_word_rollback", new=word, error=str(e), rollbackError=rollback_error)
        raise RuntimeError(f"唤醒词修改失败，已回滚：{e}" + (f"；回滚重启异常：{rollback_error}" if rollback_error else "")) from e
