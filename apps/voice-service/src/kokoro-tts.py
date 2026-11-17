#!/usr/bin/env python3
"""常驻 Kokoro TTS worker：stdin/stdout JSON Lines，避免每句重复加载模型。"""
import base64
import io
import json
import os
import sys
import time
import wave
from pathlib import Path

import numpy as np
import sherpa_onnx

VOICES = {
    "zf_xiaobei": 45, "zf_xiaoni": 46, "zf_xiaoxiao": 47, "zf_xiaoyi": 48,
    "zm_yunjian": 49, "zm_yunxi": 50, "zm_yunxia": 51, "zm_yunyang": 52,
}


def main():
    model_dir = Path(os.environ.get("JARVIS_KOKORO_MODEL_DIR", str(Path.home() / ".local/share/jarvis/kokoro-multi-lang-v1_0")))
    model_path = model_dir / ("model.int8.onnx" if (model_dir / "model.int8.onnx").exists() else "model.onnx")
    kokoro = sherpa_onnx.OfflineTtsKokoroModelConfig(
        model=str(model_path),
        voices=str(model_dir / "voices.bin"),
        tokens=str(model_dir / "tokens.txt"),
        data_dir=str(model_dir / "espeak-ng-data"),
        lexicon=f"{model_dir}/lexicon-us-en.txt,{model_dir}/lexicon-zh.txt",
    )
    config = sherpa_onnx.OfflineTtsConfig(
        model=sherpa_onnx.OfflineTtsModelConfig(
            kokoro=kokoro,
            num_threads=int(os.environ.get("JARVIS_KOKORO_THREADS", "2")),
        ),
        max_num_sentences=1,
        silence_scale=0.2,
    )
    tts = sherpa_onnx.OfflineTts(config)
    for line in sys.stdin:
        request = json.loads(line)
        request_id = request.get("id")
        started = time.time()
        try:
            voice = request.get("voice", "zf_xiaoxiao")
            sid = VOICES.get(voice, int(voice) if str(voice).isdigit() else 47)
            speed = float(request.get("speed", 1.0))
            speed = min(1.3, max(0.8, speed))
            audio = tts.generate(request["text"], sid=sid, speed=speed)
            samples = np.asarray(audio.samples, dtype=np.float32)
            pcm = (np.clip(samples, -1.0, 1.0) * 32767).astype("<i2")
            buffer = io.BytesIO()
            with wave.open(buffer, "wb") as wav:
                wav.setnchannels(1)
                wav.setsampwidth(2)
                wav.setframerate(audio.sample_rate)
                wav.writeframes(pcm.tobytes())
            print(json.dumps({
                "id": request_id, "ok": True, "audio": base64.b64encode(buffer.getvalue()).decode(),
                "sampleRate": audio.sample_rate, "format": "wav", "voice": voice,
                "latencyMs": round((time.time() - started) * 1000),
            }), flush=True)
        except Exception as e:
            print(json.dumps({"id": request_id, "ok": False, "error": str(e)}), flush=True)


if __name__ == "__main__":
    main()
