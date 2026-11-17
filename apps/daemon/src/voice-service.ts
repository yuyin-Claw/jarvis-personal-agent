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
  /** 播放期振幅回调（口型同步驱动）：每 ~40ms 推一次 0-1 包络值，结束推 0 */
  onAmplitude?: (a: number) => void;
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

  /** ADR-012 实时监听：启动/状态轮询/停止 */
  async listenStart(target?: string): Promise<{ live: boolean; state: string }> {
    const r = await this.doFetch(`${this.base}/listen/start`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ target: target ?? null }),
    });
    const j = (await r.json()) as { ok: boolean; error?: string; live?: boolean; state?: string };
    if (!r.ok || !j.ok) throw new Error(j.error ?? `listen/start ${r.status}`);
    return { live: !!j.live, state: j.state ?? "listening" };
  }

  async listenStatus(since = 0): Promise<LiveStatus> {
    const r = await this.doFetch(`${this.base}/listen/status?since=${since}`);
    const j = (await r.json()) as { ok: boolean } & LiveStatus;
    if (!r.ok || !j.ok) throw new Error(`listen/status ${r.status}`);
    return j;
  }

  async listenPlayback(playing: boolean): Promise<void> {
    const r = await this.doFetch(`${this.base}/listen/playback`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ playing }),
    });
    if (!r.ok) throw new Error(`listen/playback ${r.status}`);
  }

  async listenStop(): Promise<void> {
    const r = await this.doFetch(`${this.base}/listen/stop`, { method: "POST" });
    if (!r.ok) throw new Error(`listen/stop ${r.status}`);
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
  private playbackSignal: Promise<void> = Promise.resolve();
  private readonly platform: NodeJS.Platform;

  constructor(id: AdapterId, private readonly opts: VoiceServiceOptions) {
    this.id = id;
    this.client = new VoiceServiceClient(opts);
    this.platform = opts.platform ?? process.platform;
  }

  get speaking(): boolean { return this.busy || this.current !== undefined; }

  private setPlayback(playing: boolean): Promise<void> {
    this.playbackSignal = this.playbackSignal
      .then(() => this.client.listenPlayback?.(playing))
      .catch(() => undefined); // 无实时监听时不影响 TTS 播放
    return this.playbackSignal;
  }

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

    let playbackStarted = false;
    const settle = (reason: SpeakEndReason, dir?: string) => {
      this.busy = false;
      this.current = undefined;
      this.cancel = undefined;
      if (playbackStarted) {
        playbackStarted = false;
        void this.setPlayback(false);
      }
      if (dir) { try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* best effort */ } }
      return reason;
    };

    let result: { audio: Buffer; format: string; sampleRate: number };
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
    await this.setPlayback(true);
    playbackStarted = true;
    if (interrupted) return settle("interrupted", dir);
    try {
      proc = spawn(player, [file], { stdio: "ignore" });
    } catch {
      return settle("error", dir);
    }
    this.current = proc;

    // 口型同步：真实振幅包络按播放进度推送（wav 分帧 RMS）。
    // 采样率用合成结果（piper 22050；macOS 原生 say 16000 兼容）
    const env = this.opts.onAmplitude && result.format === "wav"
      ? analyzeAmplitude(result.audio, result.sampleRate)
      : [];
    let envIdx = 0;
    let ampTimer: NodeJS.Timeout | undefined;
    if (env.length > 0 && this.opts.onAmplitude) {
      const push = this.opts.onAmplitude;
      push(0.05); // 起播微张（避免首帧闭合突变）
      ampTimer = setInterval(() => {
        if (envIdx >= env.length) {
          if (ampTimer) clearInterval(ampTimer);
          return;
        }
        push(env[envIdx++] ?? 0);
      }, 40);
    }

    return new Promise<SpeakEndReason>((resolve) => {
      let settled = false;
      const finish = (reason: SpeakEndReason) => {
        if (settled) return;
        settled = true;
        if (ampTimer) clearInterval(ampTimer);
        this.opts.onAmplitude?.(0); // 口型闭合（结束/打断都归零）
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

/** /listen/status 载荷（ADR-012 实时监听） */
export interface LiveStatus {
  live: boolean;
  state: string;
  target: string | null;
  events: Array<{ type: string; at: number; text?: string; id?: number; error?: string }>;
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
    await this.stopLive().catch(() => undefined);
  }

  // ---- ADR-012 实时监听：轮询 /listen/status 并翻译为 SpeechInputEvent ----
  private liveTimer: ReturnType<typeof setInterval> | null = null;
  private liveSince = 0;

  /** 启动实时监听（麦克风经 guest 内 PipeWire 采集 + VAD + 本地 ASR） */
  async startLive(target?: string, pollMs = 400): Promise<void> {
    if (this.liveTimer) return;
    await this.client.listenStart(target);
    this.liveSince = Date.now();
    this.emit({ type: "ready" });
    this.liveTimer = setInterval(() => {
      void this.pollLive();
    }, pollMs);
  }

  async stopLive(): Promise<void> {
    if (!this.liveTimer) return;
    clearInterval(this.liveTimer);
    this.liveTimer = null;
    await this.client.listenStop();
  }

  private async pollLive(): Promise<void> {
    let st: LiveStatus;
    try {
      st = await this.client.listenStatus(this.liveSince);
    } catch {
      return; // 服务暂不可达：下轮再试，不中断监听
    }
    for (const ev of st.events) {
      this.liveSince = Math.max(this.liveSince, ev.at);
      switch (ev.type) {
        // KWS 命中（Silero 路径）或 VAD 检测到人声（能量降级路径）：
        // 立即 partial（空文本）→ 打断 TTS，不能等 ASR final。
        case "kws_detected":
        case "speech_start":
          if (!this.inUtterance) {
            this.inUtterance = true;
            this.emit({ type: "partial", text: "" });
          }
          break;
        case "session_end":
          this.inUtterance = false;
          this.emit({ type: "session_end", text: ev.text ?? "有事请随时叫我" });
          break;
        // 一段转写完成：final → 结束聆听进 thinking
        case "final":
          if (ev.text) this.emit({ type: "final", text: ev.text });
          this.inUtterance = false;
          break;
        default:
          break; // transcribing/speech_discard/listening_* 为诊断事件，不映射
      }
    }
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
      if (e.type === "partial") {
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
  // 口型同步接线：播放期真实振幅 → avatarHost.setState(amplitude)。
  // 若用户已提供 onAmplitude 则优先（测试/定制），否则自动接到 avatar。
  const amplitudeSink = opts.onAmplitude ?? ((a: number) => {
    void platform.avatarHost?.setState({
      state: "speaking", intensity: 0.8, amplitude: a,
    }).catch(() => undefined);
  });
  const out = new VoiceServiceSpeechOutput(platform.id, { ...opts, onAmplitude: amplitudeSink });
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

/**
 * wav（PCM s16le）分帧 RMS 振幅包络。
 * 20ms 一帧；归一化到 0-1（32768 满幅；用 sqrt(RMS) 提升中低音量区分度）
 */
export function analyzeAmplitude(wav: Buffer, sampleRate: number): number[] {
  const data = wav.subarray(44); // 标准 44 字节头（piper/macOS say 均为此格式）
  const frameSamples = Math.max(1, Math.round(sampleRate * 0.02));
  const frames = Math.floor(data.length / 2 / frameSamples);
  const out: number[] = [];
  for (let f = 0; f < frames; f++) {
    let sum = 0;
    const base = f * frameSamples * 2;
    for (let i = 0; i < frameSamples; i++) {
      const v = data.readInt16LE(base + i * 2) / 32768;
      sum += v * v;
    }
    const rms = Math.sqrt(sum / frameSamples);
    out.push(Math.min(1, Math.sqrt(rms) * 1.6)); // sqrt 提升中低音量；1.6 增益
  }
  return out;
}
