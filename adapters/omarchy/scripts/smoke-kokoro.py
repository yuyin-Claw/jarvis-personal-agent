#!/usr/bin/env python3
import base64
import json
import os
import pathlib
import select
import subprocess

ROOT = pathlib.Path.home() / ".local/share/jarvis"
MODEL = ROOT / "kokoro-multi-lang-v1_0"
SCRIPT = ROOT / "jarvis-voice-service/src/kokoro-tts.py"
REPORT = pathlib.Path("/mnt/mac/kokoro-smoke-result.json")
proc = None
report = {}
try:
    proc = subprocess.Popen(["python3", str(SCRIPT)], env={**os.environ, "JARVIS_KOKORO_MODEL_DIR": str(MODEL)}, stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)
    results = []
    for i, (voice, text) in enumerate([
        ("zm_yunjian", "你好，我是 JARVIS。现在的语音应该更自然、更清晰。"),
        ("zf_xiaoxiao", "你好，我是 JARVIS。现在的语音应该更自然、更清晰。"),
        ("zm_yunjian", "第二次合成应该更快。"),
    ], 1):
        proc.stdin.write(json.dumps({"id": i, "text": text, "voice": voice, "speed": 1.0}, ensure_ascii=False) + "\n")
        proc.stdin.flush()
        ready, _, _ = select.select([proc.stdout], [], [], 180)
        assert ready, "Kokoro 合成超时"
        msg = json.loads(proc.stdout.readline())
        assert msg["ok"], msg
        audio = base64.b64decode(msg["audio"])
        assert audio[:4] == b"RIFF" and len(audio) > 10_000
        name = f"/mnt/mac/kokoro-{voice}{'-warm' if i == 3 else ''}.wav"
        pathlib.Path(name).write_bytes(audio)
        results.append({**msg, "audio": None, "bytes": len(audio), "file": name})
    report = {"ok": True, "results": results}
except Exception as e:
    report = {"ok": False, "error": repr(e), "stderr": proc.stderr.read() if proc and proc.poll() is not None else ""}
finally:
    if proc:
        proc.kill()
REPORT.write_text(json.dumps(report, ensure_ascii=False, indent=2) + "\n")
