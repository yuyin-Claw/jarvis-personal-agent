/**
 * JARVIS 语音服务契约 v1（ADR-009）
 *
 * 语音能力从 Core 中剥离为独立进程：Core 只经 Platform Adapter 的
 * speechOutput / speechInput 端点调用本服务，不绑定任何单个系统的音频框架。
 * ADR-009 红线：零 macOS 依赖（本服务架设在 Omarchy 系统内），本地后端面向 Linux/Omarchy，
 * 本地引擎缺失时可转发到上游服务（upstream），health 必须如实标注。
 *
 *   GET  /health   → { ok, contract, platform, asr, tts, upstream? }
 *   GET  /contract → { version, endpoints, limits }
 *   POST /asr      { audio: base64, format?, language? } → { text, engine, model, latencyMs }
 *   POST /tts      { text, voice?, rate? }               → { audio: base64, format, sampleRate, latencyMs }
 *
 * 设计约束：
 *  - 音频一律 base64（避免 multipart 依赖），单请求上限 16 MiB
 *  - 文本一律走参数数组交给本地引擎，绝不拼 shell
 *  - 任何后端失败返回结构化错误，health 不得谎报 ready
 */
export const CONTRACT_VERSION = "1.0";
export const MAX_AUDIO_BYTES = 16 * 1024 * 1024;
export const MAX_TEXT_CHARS = 500;

export const ENDPOINTS = ["health", "contract", "asr", "tts"];

export function envelope(ok, extra) {
  return { ok, contract: CONTRACT_VERSION, ...extra };
}

export function sanitizeText(value, max = MAX_TEXT_CHARS) {
  const s = String(value ?? "")
    // eslint-disable-next-line no-control-regex -- 语音文本必须剥离控制字符
    .replace(/[\u0000-\u001f\u007f]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, max);
  return s;
}

/** 生成可用于契约测试的真实 WAV（16k / mono / 16-bit PCM，440Hz 短音） */
export function pcmWav(durationSec = 0.35, freq = 440) {
  const rate = 16000;
  const n = Math.floor(rate * durationSec);
  const data = Buffer.alloc(n * 2);
  for (let i = 0; i < n; i++) {
    data.writeInt16LE(Math.round(Math.sin((2 * Math.PI * freq * i) / rate) * 8000), i * 2);
  }
  const header = Buffer.alloc(44);
  header.write("RIFF", 0);
  header.writeUInt32LE(36 + data.length, 4);
  header.write("WAVEfmt ", 8);
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20);
  header.writeUInt16LE(1, 22);
  header.writeUInt32LE(rate, 24);
  header.writeUInt32LE(rate * 2, 28);
  header.writeUInt16LE(2, 32);
  header.writeUInt16LE(16, 34);
  header.write("data", 36);
  header.writeUInt32LE(data.length, 40);
  return Buffer.concat([header, data]);
}
