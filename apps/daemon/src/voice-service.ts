/**
 * 语音服务的平台端点实现（ADR-009）
 *
 * Core 侧只认 @jarvis/platform 的 speechOutput / speechInput 契约；
 * 设置 JARVIS_VOICE_URL 后，composition root 用这里的实现覆盖原生端点，
 * 于是「语音」从 macOS say/SFSpeechRecognizer 或 Linux espeak/PipeWire 绑定，
 * 变成对语音服务进程的 HTTP 调用——该服务架设在 Omarchy 系统内。
 */
import { spawn, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type {
  AdapterId, AdapterStatus, PlatformAdapter, SpeakEndReason, SpeakOptions,
  SpeechInputEvent, SpeechOutputAdapter, SpeechInputAdapter,
} from "@jarvis/platform";
import type { VoiceIO } from "@jarvis/voice";

export interface VoiceServiceOptions {
  url: string;
  /** 覆盖播放命令；默认按平台选择 afplay / pw-play */
  player?: string;
  platform?: NodeJS.Platform;
  /** 注入 fetch（测试用） */
  fetchImpl?: typeof fetch;
}

interface Health {
  ok: boolean;
  contract: string;
  platform: string;
  asr: { engine: string; model?: string; ready: boolean; local?: boolean };
  tts: { engine: string; voice?: string; ready: boolean; local?: boolean };
  upstream: string | null;
  ready: boolean;
}

function normalize(url: string): string {
  return url.replace(/\/+$/, "");
}

export class VoiceServiceClient {
  private readonly base: string;
  private readonly doFetch: typeof fetch;

  constructor(private readonly opts: VoiceServiceOptions) {
    this.base = normalize(opts.url);
    this.doFetch = opts.fetchImpl ?? globalThis.fetch.bind(globalThis);
  }

  async health(): Promise<Health> {
    const r = await this.doFetch(`${this.base}/health`);
    if (!r.ok) throw new Error(`语音服务 health ${r.status}`);
    return (await r.json()) as Health;
  }

  async transcribe(audio: Uint8Array, format = "wav", language = "zh"): Promise<string> {
    const r = await this.doFetch(`${this.base}/asr`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ audio: Buffer.from(audio).toString("base64"), format, language }),
    });
    const j = (await r.json()) as { ok: boolean; text?: string; error?: string };
    if (!r.ok || !j.ok) throw new Error(j.error ?? `ASR ${r.status}`);
    return j.text ?? "";
  }

  async synthesize(text: string, opts: { voice?: string; rate?: number } = {}, signal?: AbortSignal): Promise<{ audio: Buffer; format: string; sampleRate: number }> {
    const r = await this.doFetch(`${this.base}/tts`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ text, ...opts }),
      signal,
    });
    const j = (await r.json()) as { ok: boolean; audio?: string; format?: string; sampleRate?: number; error?: string };
    if (!r.ok || !j.ok || !j.audio) throw new Error(j.error ?? `TTS ${r.status}`);
    return { audio: Buffer.from(j.audio, "base64"), format: j.format ?? "wav", sampleRate: j.sampleRate ?? 16000 };
  }
}

/** speechOutput 端点：/tts 取音频 → 落盘或播放；可被打断 */
export class VoiceServiceSpeechOutput implements SpeechOutputAdapter {
  readonly id: AdapterId;
  private readonly client: VoiceServiceClient;
  private current: ChildProcess | undefined;
  /** 当前轮次的中止器：合成（HTTP）与播放阶段都可被立即打断 */
  private cancel: (() => void) | undefined;
  private busy = false;
  private readonly platform: NodeJS.Platform;

  constructor(id: AdapterId, private readonly opts: VoiceServiceOptions) {
    this.id = id;
    this.client = new VoiceServiceClient(opts);
    this.platform = opts.platform ?? process.platform;
  }

  get speaking(): boolean { return this.busy || this.current !== undefined; }

  async speak(text: string, speakOpts: SpeakOptions = {}): Promise<SpeakEndReason> {
    if (this.speaking) this.interrupt();
    // eslint-disable-next-line no-control-regex -- 朗读文本必须剥离控制字符
    const clean = text.replace(/[\u0000-\u001f\u007f]/g, " ").trim();
    if (!clean) return "completed";

    const ac = new AbortController();
    let interrupted = false;
    let proc: ChildProcess | undefined;
    this.busy = true;
    this.cancel = () => {
      interrupted = true;
      ac.abort();
      proc?.kill("SIGTERM");
    };

    const settle = (reason: SpeakEndReason, dir?: string) => {
      this.busy = false;
      this.current = undefined;
      this.cancel = undefined;
      if (dir) { try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* best effort */ } }
      return reason;
    };

    let result: { audio: Buffer; format: string };
    try {
      result = await this.client.synthesize(clean, { voice: speakOpts.voice, rate: speakOpts.rate }, ac.signal);
    } catch {
      return settle(interrupted ? "interrupted" : "error");
    }
    if (interrupted) return settle("interrupted");

    if (speakOpts.outputFile) {
      try { fs.writeFileSync(speakOpts.outputFile, result.audio); }
      catch { return settle("error"); }
      return settle("completed");
    }

    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "jarvis-voice-play-"));
    const file = path.join(dir, `speech.${result.format}`);
    fs.writeFileSync(file, result.audio);
    const player = this.opts.player ?? (this.platform === "darwin" ? "afplay" : "pw-play");
    try {
      proc = spawn(player, [file], { stdio: "ignore" });
    } catch {
      return settle("error", dir);
    }
    this.current = proc;

    return new Promise<SpeakEndReason>((resolve) => {
      let settled = false;
      const finish = (reason: SpeakEndReason) => {
        if (settled) return;
        settled = true;
        resolve(settle(reason, dir));
      };
      proc?.on("error", () => finish("error"));
      proc?.on("close", () => finish(interrupted ? "interrupted" : "completed"));
    });
  }

  interrupt(): void {
    this.cancel?.();
  }

  async probe(): Promise<AdapterStatus> {
    try {
      const h = await this.client.health();
      return {
        id: this.id, endpoint: "speechOutput",
        state: h.tts.ready ? "ready" : "unavailable",
        detail: `voice-service ${h.tts.engine}${h.upstream ? ` → ${h.upstream}` : ""}`,
      };
    } catch (e) {
      return { id: this.id, endpoint: "speechOutput", state: "unavailable", detail: String(e) };
    }
  }
}

/** speechInput 端点：音频 → /asr → partial/final 事件（与 SpeechInput JSONL 语义一致） */
export class VoiceServiceSpeechInput implements SpeechInputAdapter {
  readonly id: AdapterId;
  private readonly client: VoiceServiceClient;
  private listeners = new Set<(e: SpeechInputEvent) => void>();
  private running = false;
  private inUtterance = false;

  constructor(id: AdapterId, opts: VoiceServiceOptions) {
    this.id = id;
    this.client = new VoiceServiceClient(opts);
  }

  onEvent(cb: (e: SpeechInputEvent) => void): () => void {
    this.listeners.add(cb);
    return () => this.listeners.delete(cb);
  }

  private emit(e: SpeechInputEvent): void {
    for (const cb of this.listeners) cb(e);
  }

  async start(): Promise<void> {
    if (this.running) return;
    await this.client.health();
    this.running = true;
    this.emit({ type: "ready" });
  }

  async stop(): Promise<void> {
    this.running = false;
    this.inUtterance = false;
  }

  /** 只做识别不派事件，供流式分段（partial/final）编排使用 */
  async transcribe(audio: Uint8Array, format = "wav", language = "zh"): Promise<string> {
    return this.client.transcribe(audio, format, language);
  }

  /** 用户开口的第一段识别结果：派 partial（TTS 播放中即被打断） */
  beginUtterance(text: string): void {
    if (this.inUtterance) return;
    this.inUtterance = true;
    this.emit({ type: "partial", text });
  }

  /** 一句话识别完成：派 final，结束聆听 */
  finishUtterance(text: string): void {
    this.emit({ type: "final", text });
    this.inUtterance = false;
  }

  /** 把一段真实音频送进服务识别，并按语音输入事件语义派发 */
  async submitAudio(audio: Uint8Array, format = "wav", language = "zh"): Promise<string> {
    const text = await this.transcribe(audio, format, language);
    this.beginUtterance(text);
    this.finishUtterance(text);
    return text;
  }

  /** 接到 VoiceIO：首段 partial 打断 TTS，final 结束聆听 */
  attach(voice: VoiceIO): () => void {
    return this.onEvent((e) => {
      if (e.type === "partial" && e.text) {
        if (voice.tts.speaking) voice.interrupt();
        else voice.startListening();
      } else if (e.type === "final") {
        voice.endListening(e.text ?? "");
      }
    });
  }

  async probe(): Promise<AdapterStatus> {
    try {
      const h = await this.client.health();
      return {
        id: this.id, endpoint: "speechInput",
        state: h.asr.ready ? "ready" : "unavailable",
        detail: `voice-service ${h.asr.engine}${h.asr.model ? ` (${h.asr.model})` : ""}${h.upstream ? ` → ${h.upstream}` : ""}`,
      };
    } catch (e) {
      return { id: this.id, endpoint: "speechInput", state: "unavailable", detail: String(e) };
    }
  }
}

/** 用语音服务端点覆盖平台适配器的两个语音端点，其余保持不变 */
export function withVoiceService(platform: PlatformAdapter, opts: VoiceServiceOptions): PlatformAdapter {
  const out = new VoiceServiceSpeechOutput(platform.id, opts);
  const input = new VoiceServiceSpeechInput(platform.id, opts);
  return {
    ...platform,
    speechOutput: out,
    speechInput: input,
    async probe() {
      const rest = (await platform.probe()).filter(
        (s) => s.endpoint !== "speechOutput" && s.endpoint !== "speechInput",
      );
      return [...rest, await out.probe(), await input.probe()];
    },
  };
}
