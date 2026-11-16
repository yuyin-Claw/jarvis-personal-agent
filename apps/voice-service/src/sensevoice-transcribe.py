#!/usr/bin/env python3
"""SenseVoice ASR 子进程：voice-service 经 spawn 调用。

用法：
    python3 sensevoice-transcribe.py <wav-file> [--model <path>] [--tokens <path>]

输出（stdout JSON）：
    {"ok": true, "text": "...", "latencyMs": 123, "engine": "sensevoice"}
    {"ok": false, "error": "..."}

模型路径默认 ~/.local/share/sense-voice/model.int8.onnx + tokens.txt。
可用 JARVIS_SENSE_VOICE_MODEL / JARVIS_SENSE_VOICE_TOKENS 环境变量覆盖。
"""
import json
import os
import sys
import time
import wave
from pathlib import Path

import numpy as np
import sherpa_onnx


def main() -> int:
    if len(sys.argv) < 2:
        print(json.dumps({"ok": False, "error": "用法：sensevoice-transcribe.py <wav-file>"}))
        return 1

    wav_path = sys.argv[1]
    if not Path(wav_path).exists():
        print(json.dumps({"ok": False, "error": f"音频文件不存在：{wav_path}"}))
        return 1

    home = Path.home()
    model = os.environ.get(
        "JARVIS_SENSE_VOICE_MODEL",
        str(home / ".local/share/sense-voice/model.int8.onnx"),
    )
    tokens = os.environ.get(
        "JARVIS_SENSE_VOICE_TOKENS",
        str(home / ".local/share/sense-voice/tokens.txt"),
    )

    if not Path(model).exists():
        print(json.dumps({"ok": False, "error": f"模型不存在：{model}"}))
        return 1
    if not Path(tokens).exists():
        print(json.dumps({"ok": False, "error": f"tokens 不存在：{tokens}"}))
        return 1

    try:
        started = time.time()
        recognizer = sherpa_onnx.OfflineRecognizer.from_sense_voice(
            model=model,
            tokens=tokens,
            use_itn=True,  # 逆文本规范化（数字/标点）
            debug=False,
        )

        with wave.open(wav_path, "rb") as w:
            assert w.getnchannels() == 1, f"声道数 != 1：{w.getnchannels()}"
            assert w.getsampwidth() == 2, f"采样宽度 != 2：{w.getsampwidth()}"
            sample_rate = w.getframerate()
            samples = w.readframes(w.getnframes())

        samples_float = np.frombuffer(samples, dtype=np.int16).astype(np.float32) / 32768.0
        stream = recognizer.create_stream()
        stream.accept_waveform(sample_rate, samples_float)
        recognizer.decode_stream(stream)
        elapsed_ms = round((time.time() - started) * 1000)

        print(json.dumps({
            "ok": True,
            "text": stream.result.text,
            "latencyMs": elapsed_ms,
            "engine": "sensevoice",
        }, ensure_ascii=False))
        return 0
    except Exception as e:
        print(json.dumps({"ok": False, "error": f"{type(e).__name__}: {e}"}, ensure_ascii=False))
        return 1


if __name__ == "__main__":
    sys.exit(main())
