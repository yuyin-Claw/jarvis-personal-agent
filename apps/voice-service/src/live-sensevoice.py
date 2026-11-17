#!/usr/bin/env python3
"""JARVIS live 语音链路：Silero VAD + KWS 唤醒词门控 + SenseVoice ASR。

架构：
    pw-record → ring 文件 → Silero VAD（语音活动检测）→ KWS（检测「你好贾维斯」）→ SenseVoice ASR → 事件流

用法：
    python3 live-sensevoice.py <ring-file> [--target <pipewire-source>]

事件输出（stdout JSON Lines）：
    {"type": "listening_start", ...}
    {"type": "speech_start", "atMs": ...}
    {"type": "transcribing", "id": ...}
    {"type": "final", "id": ..., "text": "...", "engine": "sensevoice", "latencyMs": ...}
    {"type": "listening_stop", ...}

模型路径默认 ~/.local/share/jarvis/ 下，可用环境变量覆盖：
- JARVIS_SENSE_VOICE_MODEL / JARVIS_SENSE_VOICE_TOKENS
- JARVIS_SILERO_VAD_MODEL
- JARVIS_KWS_MODEL_DIR
"""
import json
import os
import sys
import time
import wave
from pathlib import Path

import numpy as np
import sherpa_onnx

from wake_gate import WakeCommandGate

HOME = Path.home()
JARVIS_ROOT = HOME / ".local/share/jarvis"


def log_event(event_type: str, **data):
    """输出事件到 stdout（JSON Lines）"""
    event = {"type": event_type, "at": int(time.time() * 1000), **data}
    print(json.dumps(event, ensure_ascii=False), flush=True)


def playback_is_playing(control_file: str) -> bool:
    try:
        return Path(control_file).read_text(encoding="utf-8").strip() == "1"
    except (FileNotFoundError, OSError):
        return False


def main():
    if len(sys.argv) < 2:
        log_event("error", error="用法：live-sensevoice.py <ring-file>")
        sys.exit(1)

    ring_file = sys.argv[1]
    playback_file = sys.argv[2] if len(sys.argv) > 2 else ""

    # 模型路径
    sense_voice_model = os.environ.get(
        "JARVIS_SENSE_VOICE_MODEL",
        str(JARVIS_ROOT / "sense-voice/model.int8.onnx"),
    )
    sense_voice_tokens = os.environ.get(
        "JARVIS_SENSE_VOICE_TOKENS",
        str(JARVIS_ROOT / "sense-voice/tokens.txt"),
    )
    silero_vad_model = os.environ.get(
        "JARVIS_SILERO_VAD_MODEL",
        str(JARVIS_ROOT / "silero_vad.onnx"),
    )
    kws_model_dir = os.environ.get(
        "JARVIS_KWS_MODEL_DIR",
        str(JARVIS_ROOT / "kws-model"),
    )

    # 检查模型文件
    for p in [sense_voice_model, sense_voice_tokens, silero_vad_model]:
        if not Path(p).exists():
            log_event("error", error=f"模型不存在：{p}")
            sys.exit(1)

    # 加载 Silero VAD
    vad_config = sherpa_onnx.VadModelConfig()
    vad_config.silero_vad.model = silero_vad_model
    vad_config.silero_vad.threshold = 0.5
    vad_config.silero_vad.min_speech_duration = 0.25
    vad_config.silero_vad.min_silence_duration = 0.3
    vad_config.silero_vad.max_speech_duration = 20
    vad_config.sample_rate = 16000
    vad = sherpa_onnx.VoiceActivityDetector(vad_config, buffer_size_in_seconds=30)

    # 加载 KWS
    kws = sherpa_onnx.KeywordSpotter(
        encoder=f"{kws_model_dir}/encoder-epoch-99-avg-1-chunk-16-left-64.int8.onnx",
        decoder=f"{kws_model_dir}/decoder-epoch-99-avg-1-chunk-16-left-64.int8.onnx",
        joiner=f"{kws_model_dir}/joiner-epoch-12-avg-2-chunk-16-left-64.int8.onnx",
        tokens=f"{kws_model_dir}/tokens.txt",
        keywords_file=f"{kws_model_dir}/keywords.txt",
        num_threads=1,
    )

    # 加载 SenseVoice
    recognizer = sherpa_onnx.OfflineRecognizer.from_sense_voice(
        model=sense_voice_model,
        tokens=sense_voice_tokens,
        use_itn=True,
        debug=False,
    )

    log_event("listening_start")

    # 从 ring 文件读取 PCM 音频（16kHz s16le mono）
    # pw-record 持续写 ring 文件，本脚本定期读增量
    sample_rate = 16000
    window_size = 512
    bytes_per_frame = window_size * 2  # s16le
    cursor = 0

    event_id = 0
    kws_stream = kws.create_stream()
    wake_gate = WakeCommandGate(float(os.environ.get(
        "JARVIS_WAKE_SESSION_TIMEOUT_S",
        os.environ.get("JARVIS_WAKE_COMMAND_TIMEOUT_S", "300"),
    )))
    interrupt_pending = False

    while True:
        if wake_gate.expired(time.monotonic()):
            log_event("session_end", text="有事请随时叫我", reason="唤醒会话空闲超时")
            wake_gate.reset()
            interrupt_pending = False
        # 读 ring 文件增量
        try:
            size = os.path.getsize(ring_file)
        except FileNotFoundError:
            time.sleep(0.06)
            continue

        fresh = size - cursor
        if fresh < bytes_per_frame:
            time.sleep(0.06)
            continue

        # 读完整帧
        frames = fresh // bytes_per_frame
        with open(ring_file, "rb") as f:
            f.seek(cursor)
            chunk = f.read(frames * bytes_per_frame)
        cursor += len(chunk)

        # 转 float32
        samples = np.frombuffer(chunk, dtype=np.int16).astype(np.float32) / 32768.0

        # 按 window_size 分帧处理
        for i in range(0, len(samples), window_size):
            frame = samples[i:i+window_size]
            if len(frame) < window_size:
                break

            # VAD 检测
            vad.accept_waveform(frame)

            # KWS 检测（持续监听唤醒词）
            kws_stream.accept_waveform(sample_rate, frame)
            while kws.is_ready(kws_stream):
                kws.decode_stream(kws_stream)
                result = kws.get_result(kws_stream)
                if result:
                    log_event("kws_detected", keyword=result)
                    interrupt_pending = True
                    wake_gate.wake(result, time.monotonic())
                    kws_stream = kws.create_stream()  # 重置 KWS 流

            # VAD 分段
            while not vad.empty():
                segment = vad.front
                duration = len(segment.samples) / sample_rate
                log_event("speech_segment", start=segment.start / sample_rate, duration=duration)

                # TTS 播报时只接受新唤醒打断，禁止把 JARVIS 自己的声音当用户指令。
                playing = playback_is_playing(playback_file)
                if playing and not interrupt_pending:
                    log_event("speech_discard", durMs=int(duration * 1000), reason="TTS 播报中，仅允许唤醒打断")
                elif wake_gate.active:
                    event_id += 1
                    log_event("transcribing", id=event_id)
                    t0 = time.time()
                    stream = recognizer.create_stream()
                    stream.accept_waveform(sample_rate, segment.samples)
                    recognizer.decode_stream(stream)
                    latency_ms = round((time.time() - t0) * 1000)
                    text = stream.result.text
                    decision = wake_gate.on_text(text, time.monotonic())
                    if decision == "wait":
                        log_event("wake_ready", id=event_id, text=text, engine="sensevoice", latencyMs=latency_ms)
                    elif decision == "stop":
                        interrupt_pending = False
                        log_event("playback_stop", id=event_id, text=text, engine="sensevoice", latencyMs=latency_ms)
                        kws_stream = kws.create_stream()
                    elif decision == "sleep":
                        interrupt_pending = False
                        log_event("session_end", text="好的，我先休息。有事请随时叫我", reason="语音指令进入睡眠")
                        kws_stream = kws.create_stream()
                    elif decision == "accept":
                        log_event("final", id=event_id, text=text, engine="sensevoice", latencyMs=latency_ms)
                        interrupt_pending = False
                        # 保持唤醒会话，下一条指令可直接输入；有效指令已在 gate 内刷新计时。
                        kws_stream = kws.create_stream()
                    else:
                        interrupt_pending = False
                        log_event("speech_discard", durMs=int(duration * 1000), reason="唤醒指令超时")
                else:
                    log_event("speech_discard", durMs=int(duration * 1000), reason="无唤醒词")

                vad.pop()

    log_event("listening_stop", reason="ring file closed")


if __name__ == "__main__":
    main()
