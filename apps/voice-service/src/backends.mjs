/**
 * 语音服务的可插拔后端。
 *
 * ADR-009 红线：本服务是架设在 Omarchy 系统内的语音子系统，**零 macOS 依赖**——
 * 不引用任何 Apple 专有的语音命令行工具、播放器或识别框架，也不按
 * process.platform 做分支。
 *
 * omarchy: ASR = superwhisper / whisper.cpp / vosk（若已安装），TTS = espeak-ng / piper；
 *          本地引擎缺失时按 JARVIS_VOICE_UPSTREAM 转发到同契约上游服务
 * upstream: 纯转发（计算委托同契约上游）
 * fake   : 确定性实现，仅用于契约测试与 CI
 */
import { execFile } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { CONTRACT_VERSION, pcmWav, sanitizeText } from "./contract.mjs";

const run = promisify(execFile);

function which(cmd) {
  if (cmd.startsWith("/")) return fs.existsSync(cmd) ? cmd : null;
  for (const dir of (process.env.PATH ?? "").split(":")) {
    const p = path.join(dir, cmd);
    try { if (fs.statSync(p).isFile() && (fs.statSync(p).mode & 0o111)) return p; } catch { /* next */ }
  }
  return null;
}

function tmpDir() {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), "jarvis-voice-"));
  return d;
}

function cleanup(d) {
  try { fs.rmSync(d, { recursive: true, force: true }); } catch { /* best effort */ }
}

function err(message, cause) {
  const e = new Error(message);
  if (cause) e.cause = cause;
  return e;
}

/** 任意输入音频 → 16k/mono/16-bit WAV（whisper.cpp / vosk 通用输入） */
async function toWav(audio, format) {
  const d = tmpDir();
  const input = path.join(d, `input.${(format || "wav").replace(/[^a-z0-9]/gi, "") || "wav"}`);
  // 输出必须换名：输入已经是 WAV 时同路径会让 ffmpeg 拒绝覆盖
  const wav = path.join(d, "converted.wav");
  fs.writeFileSync(input, audio);
  try {
    await run("ffmpeg", ["-y", "-loglevel", "error", "-i", input,
      "-ar", "16000", "-ac", "1", "-c:a", "pcm_s16le", wav], { timeout: 30_000 });
    return { dir: d, wav };
  } catch (e) {
    cleanup(d);
    throw err(`音频转码失败：${e.message}`, e);
  }
}

class BaseBackend {
  constructor(env = process.env) { this.env = env; }
  describe() { return { platform: "unknown", asr: { engine: "none", ready: false }, tts: { engine: "none", ready: false } }; }
  async transcribe() { throw err("ASR 未实现"); }
  async synthesize() { throw err("TTS 未实现"); }
}

/** Omarchy / Linux：本地引擎优先，缺失则转发上游 */
export class OmarchyBackend extends BaseBackend {
  constructor(env) {
    super(env);
    this.whisperCli = which("whisper-cli") ?? which("whisper-cpp") ?? which("main");
    this.vosk = which("vosk-transcriber");
    this.superwhisper = env.JARVIS_ASR_SUPERWHISPER === "0" ? null : which("superwhisper");
    this.piper = which("piper");
    this.espeak = env.JARVIS_ESPEAK_BIN ?? (which("espeak-ng") ?? which("espeak"));
    this.ffmpeg = which("ffmpeg");
    this.upstream = env.JARVIS_VOICE_UPSTREAM ?? "";
    this.model = env.JARVIS_ASR_MODEL ?? "base";
    // SenseVoice（阿里多语言 ASR，int8 量化）：模型 + Python 脚本路径
    // 优先级高于 whisper.cpp（中文识别更准 + 简体输出 + 速度更快）
    this.senseVoiceModel = env.JARVIS_SENSE_VOICE_MODEL
      ?? path.join(os.homedir(), ".local/share/sense-voice/model.int8.onnx");
    this.senseVoiceTokens = env.JARVIS_SENSE_VOICE_TOKENS
      ?? path.join(os.homedir(), ".local/share/sense-voice/tokens.txt");
    this.senseVoiceScript = env.JARVIS_SENSE_VOICE_SCRIPT
      ?? path.join(os.homedir(), "Omarchy/jarvis-voice-service/src/sensevoice-transcribe.py");
    this.senseVoiceEnabled = env.JARVIS_SENSE_VOICE !== "0"
      && fs.existsSync(this.senseVoiceModel)
      && fs.existsSync(this.senseVoiceTokens)
      && fs.existsSync(this.senseVoiceScript);
  }
  describe() {
    const asrLocal = !!(this.senseVoiceEnabled || this.whisperCli || this.vosk || this.superwhisper);
    const ttsLocal = !!(this.piper || this.espeak);
    // SenseVoice 优先（中文识别更准 + 简体输出 + 速度更快）
    const asrEngine = this.senseVoiceEnabled ? "sensevoice"
      : this.whisperCli ? "whisper.cpp"
      : this.vosk ? "vosk"
        : this.superwhisper ? "superwhisper"
          : (this.upstream ? "upstream" : "none");
    return {
      platform: "omarchy",
      asr: {
        engine: asrEngine, model: this.senseVoiceEnabled ? "sensevoice-int8" : this.model,
        ready: asrLocal || !!this.upstream, local: asrLocal,
        // 8GB VM 下 Superwhisper 离线模型不可用，会走其云端后端；如实标注
        modelLocation: this.senseVoiceEnabled ? "guest-local"
          : this.superwhisper && !this.whisperCli && !this.vosk ? "guest-process" : "guest-local",
      },
      tts: {
        engine: ttsLocal ? (this.piper ? "piper" : "espeak-ng") : (this.upstream ? "upstream" : "none"),
        voice: "zh-CN", ready: ttsLocal || !!this.upstream, local: ttsLocal,
      },
      upstream: this.upstream || undefined,
    };
  }
  async upstreamCall(endpoint, body) {
    if (!this.upstream) throw err("无本地引擎且未配置 JARVIS_VOICE_UPSTREAM");
    const url = `${this.upstream.replace(/\/$/, "")}/${endpoint}`;
    let res;
    try { res = await fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) }); }
    catch (e) { throw err(`上游服务不可达：${e.message}`, e); }
    const json = await res.json();
    if (!res.ok || json.ok === false) throw err(`上游 ${endpoint} 失败：${json.error ?? res.status}`);
    return json;
  }
  /** Superwhisper（Omarchy 预装听写引擎）：transcribe FILE 异步，read 轮询取结果 */
  async superwhisperTranscribe(audio, format) {
    const { dir, wav } = await toWav(audio, format);
    try {
      const { stdout } = await run(this.superwhisper, ["transcribe", wav],
        { timeout: 30_000, maxBuffer: 1024 * 1024 });
      const m = stdout.match(/"session_id"\s*:\s*(\d+)/);
      const sid = m ? Number(m[1]) : null;
      const deadline = Date.now() + 45_000;
      while (Date.now() < deadline) {
        await new Promise((r) => setTimeout(r, 600));
        let out = "";
        try { out = (await run(this.superwhisper, ["read"], { timeout: 10_000, maxBuffer: 1024 * 1024 })).stdout; }
        catch { continue; }
        try {
          const j = JSON.parse(out.trim().split("\n")[0]);
          if (j.text && (sid === null || j.session_id === sid)) return String(j.text).trim();
        } catch { /* 尚在转写，输出非 JSON */ }
      }
      throw err("superwhisper 转写超时（45s）");
    } finally { cleanup(dir); }
  }

  async transcribe(audio, format = "wav", language = "zh") {
    const started = Date.now();
    const upstreamAsr = async () => {
      const r = await this.upstreamCall("asr", { audio: Buffer.from(audio).toString("base64"), format, language });
      return { ...r, engine: `upstream:${r.engine}` };
    };

    // SenseVoice 优先（中文识别更准 + 简体输出 + 速度更快）
    if (this.senseVoiceEnabled) {
      const { dir, wav } = await toWav(audio, format);
      try {
        const { stdout } = await run("python3", [this.senseVoiceScript, wav], {
          timeout: 60_000, maxBuffer: 1024 * 1024,
          env: {
            ...process.env,
            JARVIS_SENSE_VOICE_MODEL: this.senseVoiceModel,
            JARVIS_SENSE_VOICE_TOKENS: this.senseVoiceTokens,
          },
        });
        const r = JSON.parse(stdout.trim());
        if (!r.ok) throw err(r.error ?? "SenseVoice 未产出文本");
        return { text: r.text, engine: "sensevoice", model: "int8", latencyMs: Date.now() - started };
      } catch (e) {
        console.error(`[asr] SenseVoice 失败，降级 whisper.cpp：${e.message}`);
        // 降级走 whisper.cpp 流程
      } finally { cleanup(dir); }
    }

    if (this.superwhisper && !this.whisperCli && !this.vosk) {
      try {
        const text = await this.superwhisperTranscribe(audio, format);
        if (text) return { text, engine: "superwhisper", model: "S1-Voice", latencyMs: Date.now() - started };
      } catch (e) {
        console.error(`[asr] superwhisper 失败，尝试上游：${e.message}`);
        if (!this.upstream) throw err(`Superwhisper ASR 失败且无上游：${e.message}`, e);
        return upstreamAsr();
      }
    }
    if (!this.whisperCli && !this.vosk) return upstreamAsr();
    const { dir, wav } = await toWav(audio, format);
    try {
      let text = "";
      if (this.whisperCli) {
        const modelPath = this.env.JARVIS_WHISPER_CPP_MODEL ?? "";
        const args = ["-m", modelPath, "-f", wav, "-l", language, "-otxt", "-of", path.join(dir, "out")];
        await run(this.whisperCli, args, { timeout: 180_000, maxBuffer: 4 * 1024 * 1024 });
        text = fs.readFileSync(path.join(dir, "out.txt"), "utf8").trim();
      } else {
        const modelPath = this.env.JARVIS_VOSK_MODEL ?? "";
        const args = ["--model", modelPath, "--lang", language, wav];
        const { stdout } = await run(this.vosk, args, { timeout: 180_000, maxBuffer: 4 * 1024 * 1024 });
        text = stdout.trim();
      }
      if (!text) throw err("本地 ASR 未产出文本");
      return { text, engine: this.whisperCli ? "whisper.cpp" : "vosk", model: this.model, latencyMs: Date.now() - started };
    } catch (e) {
      throw err(`本地 ASR 失败：${e.message}`, e);
    } finally { cleanup(dir); }
  }
  async synthesize(text, opts = {}) {
    const clean = sanitizeText(text);
    if (!clean) throw err("TTS 文本为空");
    if (!this.piper && !this.espeak) {
      const r = await this.upstreamCall("tts", { text: clean, voice: opts.voice, rate: opts.rate });
      return { ...r, audio: Buffer.from(r.audio, "base64"), engine: `upstream:${r.engine}` };
    }
    const started = Date.now();
    const d = tmpDir();
    const out = path.join(d, "tts.wav");
    try {
      const safe = clean.startsWith("-") ? ` ${clean}` : clean;
      if (this.piper) {
        const model = this.env.JARVIS_PIPER_MODEL ?? "";
        // piper CLI：文本经 stdin，-f 是输出文件参数（不是输入文件）
        const { execFile } = await import("node:child_process");
        await new Promise((resolve, reject) => {
          const p = execFile(this.piper,
            ["--model", model, "-f", out],
            { timeout: 120_000, maxBuffer: 4 * 1024 * 1024 },
            (e2) => (e2 ? reject(e2) : resolve()));
          p.stdin?.end(safe);
        });
      } else {
        await run(this.espeak, ["-v", "zh", "-s", String(opts.rate ?? 150), "-w", out, safe], { timeout: 60_000 });
      }
      if (!fs.existsSync(out)) throw err("本地 TTS 未产出音频");
      return { audio: fs.readFileSync(out), format: "wav", sampleRate: 22050,
        engine: this.piper ? "piper" : "espeak-ng", latencyMs: Date.now() - started };
    } catch (e) {
      throw err(`本地 TTS 失败：${e.message}`, e);
    } finally { cleanup(d); }
  }
}

/** 纯转发后端（服务进程仍在目标系统，计算委托上游） */
export class UpstreamBackend extends BaseBackend {
  constructor(env) {
    super(env);
    this.upstream = env.JARVIS_VOICE_UPSTREAM ?? "";
  }
  describe() {
    return {
      platform: "upstream",
      asr: { engine: "upstream", ready: !!this.upstream },
      tts: { engine: "upstream", ready: !!this.upstream },
      upstream: this.upstream || undefined,
    };
  }
  async call(endpoint, body) {
    const res = await fetch(`${this.upstream.replace(/\/$/, "")}/${endpoint}`, {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body),
    });
    const json = await res.json();
    if (!res.ok || json.ok === false) throw err(`上游 ${endpoint} 失败：${json.error ?? res.status}`);
    return json;
  }
  async transcribe(audio, format = "wav", language = "zh") {
    const r = await this.call("asr", { audio: Buffer.from(audio).toString("base64"), format, language });
    return { ...r, engine: `upstream:${r.engine}` };
  }
  async synthesize(text, opts = {}) {
    const r = await this.call("tts", { text, voice: opts.voice, rate: opts.rate });
    return { ...r, audio: Buffer.from(r.audio, "base64"), engine: `upstream:${r.engine}` };
  }
}

/** 确定性后端：契约测试 / CI 用，产出真实 WAV 但不调用模型 */
export class FakeBackend extends BaseBackend {
  describe() {
    return { platform: "fake", asr: { engine: "fake", model: "deterministic", ready: true },
      tts: { engine: "fake", voice: "test", ready: true } };
  }
  async transcribe(audio, format = "wav", language = "zh") {
    if (!audio || audio.length < 44) throw err("音频过短");
    return { text: this.env.JARVIS_FAKE_ASR_TEXT ?? "请介绍一下你自己", engine: "fake",
      model: "deterministic", latencyMs: 1, language, format };
  }
  async synthesize(text, opts = {}) {
    const clean = sanitizeText(text);
    if (!clean) throw err("TTS 文本为空");
    return { audio: pcmWav(0.35), format: "wav", sampleRate: 16000, latencyMs: 1, chars: clean.length, opts };
  }
}

export function createBackend(name = process.env.JARVIS_VOICE_BACKEND ?? "auto", env = process.env) {
  // auto 一律 omarchy 后端：本服务只面向 Linux/Omarchy，无 macOS 实现
  switch (name === "auto" ? "omarchy" : name) {
    case "omarchy": return new OmarchyBackend(env);
    case "upstream": return new UpstreamBackend(env);
    case "fake": return new FakeBackend(env);
    default: throw err(`未知语音后端：${name}`);
  }
}

export { CONTRACT_VERSION };
