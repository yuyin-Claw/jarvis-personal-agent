/**
 * VoiceIO：语音双向的事件编排层（0.2-③）
 *
 * 只负责「事件 → AvatarStateEngine」与「TTS 生命周期」，不关心
 * 音频来自 SFSpeechRecognizer 还是键盘文本，也不直接依赖渲染层：
 * 渲染层已通过 AvatarRenderTransport.bind(engine) 订阅状态流。
 *
 * 打断语义是核心：TTS 被用户打断时绝不派发 tts_end（会错误回 idle），
 * 而是派发 user_interrupt（speaking → listening）。
 */
import type { CoreEvent } from "@jarvis/avatar";
import type { SpeechSynthesizer } from "./mac-say-tts.js";

export type VoiceEventType = Extract<
  CoreEvent["type"],
  "user_speech_start" | "user_speech_end" | "user_interrupt" | "tts_start" | "tts_end"
>;

export interface VoiceEvent {
  type: VoiceEventType;
  at: number;
}

/** 状态引擎的最小接口（便于注入替身 / 避免与具体实现耦合） */
export interface VoiceEventSink {
  dispatch(event: CoreEvent): unknown;
  setIntensity(v: number, caption?: string): void;
}

export interface VoiceIOOptions {
  /** 播放期间推送强度包络，让全息球随语音波动（默认开） */
  envelope?: boolean;
  envelopeMs?: number;
  now?: () => number;
  onEvent?: (e: VoiceEvent) => void;
  setIntervalImpl?: (fn: () => void, ms: number) => unknown;
  clearIntervalImpl?: (timer: unknown) => void;
}

export class VoiceIO {
  private readonly events: VoiceEvent[] = [];
  private readonly now: () => number;
  private readonly on?: (e: VoiceEvent) => void;
  private readonly setTimer: (fn: () => void, ms: number) => unknown;
  private readonly clearTimer: (timer: unknown) => void;
  private readonly envelopeOn: boolean;
  private readonly envelopeMs: number;
  private timer: unknown;
  private tick = 0;
  private transcript = "";

  constructor(
    readonly tts: SpeechSynthesizer,
    readonly engine: VoiceEventSink,
    opts: VoiceIOOptions = {},
  ) {
    this.now = opts.now ?? (() => Date.now());
    this.on = opts.onEvent;
    this.setTimer = opts.setIntervalImpl ?? ((fn, ms) => setInterval(fn, ms));
    this.clearTimer = opts.clearIntervalImpl ?? ((t) => clearInterval(t as ReturnType<typeof setInterval>));
    this.envelopeOn = opts.envelope ?? true;
    this.envelopeMs = opts.envelopeMs ?? 120;
  }

  get trail(): readonly VoiceEvent[] {
    return this.events;
  }

  get lastTranscript(): string {
    return this.transcript;
  }

  private emit(type: VoiceEventType): void {
    const e: VoiceEvent = { type, at: this.now() };
    this.events.push(e);
    this.on?.(e);
  }

  /** 用户开始说话 / 按下说话键 */
  startListening(): void {
    this.engine.dispatch({ type: "user_speech_start" });
    this.emit("user_speech_start");
  }

  /** 用户说完（ASR 结果或文本输入落到这里） */
  endListening(transcript?: string): string {
    if (transcript !== undefined) this.transcript = transcript.trim();
    this.engine.dispatch({ type: "user_speech_end" });
    this.emit("user_speech_end");
    return this.transcript;
  }

  /** 用户打断：立即停 TTS，数字人立刻转聆听 */
  interrupt(): void {
    this.stopEnvelope();
    this.tts.interrupt();
    this.engine.dispatch({ type: "user_interrupt" });
    this.emit("user_interrupt");
  }

  /** JARVIS 说话；返回时状态引擎已回到正确状态 */
  async speak(text: string): Promise<void> {
    this.engine.dispatch({ type: "tts_start" });
    this.emit("tts_start");
    this.startEnvelope();
    const reason = await this.tts.speak(text);
    this.stopEnvelope();
    // interrupted 由 interrupt() 已派发 user_interrupt；不能再派 tts_end
    if (reason !== "interrupted") {
      this.engine.dispatch({ type: "tts_end" });
      this.emit("tts_end");
    }
  }

  /** 主动开口（0.2-⑤ 主动交流入口） */
  async announce(text: string): Promise<void> {
    this.engine.dispatch({ type: "proactive_notice" });
    await this.speak(text);
  }

  /** 一次强度脉冲（也可由真实音频幅度驱动，见 0.2-③ 后续 ASR 接入） */
  pulse(): void {
    this.tick += 1;
    this.engine.setIntensity(0.55 + 0.35 * Math.abs(Math.sin(this.tick * 0.7)));
  }

  private startEnvelope(): void {
    if (!this.envelopeOn || this.timer) return;
    this.timer = this.setTimer(() => this.pulse(), this.envelopeMs);
  }

  private stopEnvelope(): void {
    if (this.timer) {
      this.clearTimer(this.timer);
      this.timer = undefined;
    }
  }

  dispose(): void {
    this.stopEnvelope();
  }
}
