/**
 * Embodied Conversation（0.2-④ 对话连接）
 *
 * 把「一轮用户输入」编排成数字人的完整表现弧：
 *   idle → listening → thinking → [working → responding] → speaking → idle
 *
 * 设计边界：
 * - 本类只编排状态事件与 TTS 调用，**不直连 LLM、不直连渲染、不依赖任何平台 API**。
 *   LLM 由 reply() 注入，发声由 speaker 注入，状态机/渲染由 sink 注入。
 * - 任何异常路径都必须回落 idle（llm_error），绝不把数字人卡在 thinking。
 * - 打断优先：用户开口立即停 TTS，正在生成/执行的轮次被标记取消，不再播报旧结果。
 * - onPhase 是显式暂停点：生产可不传；自动验收在此截图/断言，无需改动业务逻辑。
 */
import type { AestheticState, AvatarState, CoreEvent } from "@jarvis/avatar";

/** 状态引擎的最小契约（AvatarStateEngine 天然满足） */
export interface EmbodiedSink {
  dispatch(event: CoreEvent): unknown;
  setIntensity(v: number, caption?: string): void;
  readonly aesthetic: AestheticState;
}

/**
 * 发声器。VoiceIO 会自行派发 tts_start/tts_end/user_interrupt，
 * 用 emitsStateEvents=true 标记；裸 TTS 适配器则为 false，由本类补齐事件。
 */
export interface EmbodiedSpeaker {
  speak(text: string): Promise<void>;
  interrupt(): void;
  readonly speaking?: boolean;
  emitsStateEvents?: boolean;
}

/** 一轮对话的产出：普通回答 / 需执行的任务 / 静默（无需播报） */
export type ReplyOutcome =
  | { kind: "answer"; text: string }
  | { kind: "task"; text: string; caption?: string; run: () => Promise<boolean> }
  | { kind: "silent" };

export interface ReplyHooks {
  /** LLM 流式增量（驱动 thinking 强度波动） */
  onDelta?(text: string): void;
  /** 记忆注入条数（可观测性） */
  onMemoryInjected?(count: number): void;
}

export type ReplyGenerator = (text: string, hooks: ReplyHooks) => Promise<ReplyOutcome>;

export type EmbodiedPhase =
  | "listening"
  | "thinking"
  | "working"
  | "responding"
  | "speaking"
  | "idle"
  | "error";

export interface EmbodiedEvent {
  type: CoreEvent["type"];
  at: number;
}

export interface EmbodiedConversationOptions {
  sink: EmbodiedSink;
  reply: ReplyGenerator;
  speaker: EmbodiedSpeaker;
  /** 阶段暂停点（验收用；可异步等待截图/ack） */
  onPhase?: (phase: EmbodiedPhase, aesthetic: AestheticState) => void | Promise<void>;
  onEvent?: (e: EmbodiedEvent) => void;
  now?: () => number;
}

export interface EmbodiedTurnResult {
  ok: boolean;
  text: string;
  error?: string;
  interrupted: boolean;
  /** 本轮结束时的状态（正常应为 idle，被打断时为 listening） */
  state: AvatarState;
  /** 本轮派发的 Core 事件序列（审计/验收） */
  events: Array<CoreEvent["type"]>;
}

export class EmbodiedConversation {
  private readonly sink: EmbodiedSink;
  private readonly reply: ReplyGenerator;
  private readonly speaker: EmbodiedSpeaker;
  private readonly onPhase?: EmbodiedConversationOptions["onPhase"];
  private readonly onEvent?: EmbodiedConversationOptions["onEvent"];
  private readonly now: () => number;
  private active: Promise<EmbodiedTurnResult> | undefined;
  private generation = 0;
  private interrupted = false;
  private deltaCount = 0;

  constructor(opts: EmbodiedConversationOptions) {
    this.sink = opts.sink;
    this.reply = opts.reply;
    this.speaker = opts.speaker;
    this.onPhase = opts.onPhase;
    this.onEvent = opts.onEvent;
    this.now = opts.now ?? (() => Date.now());
  }

  get busy(): boolean {
    return this.active !== undefined;
  }

  /** 提交一轮；若上一轮未结束，先打断再串行接管（不会并发说话） */
  async submit(text: string): Promise<EmbodiedTurnResult> {
    const input = text.trim();
    if (this.active) {
      this.interrupt();
      await this.active.catch(() => undefined);
    }
    const gen = ++this.generation;
    this.interrupted = false;
    const task = this.runTurn(input, gen);
    this.active = task;
    try {
      return await task;
    } finally {
      if (this.active === task) this.active = undefined;
    }
  }

  /** 外部打断（语音层首段 partial / 用户按键）：立即停 TTS，数字人转聆听 */
  interrupt(): void {
    this.interrupted = true;
    this.stopSpeech();
  }

  /** 停当前 TTS 但不标记本轮取消（新一轮接管旧语音时用） */
  private stopSpeech(): void {
    this.speaker.interrupt();
    if (!this.speaker.emitsStateEvents) {
      this.emit({ type: "user_interrupt" }, []);
    }
  }

  private emit(e: CoreEvent, trail: Array<CoreEvent["type"]>, record = true): void {
    if (record) trail.push(e.type);
    this.sink.dispatch(e);
    this.onEvent?.({ type: e.type, at: this.now() });
  }

  private async runTurn(text: string, gen: number): Promise<EmbodiedTurnResult> {
    const trail: Array<CoreEvent["type"]> = [];
    const dispatch = (e: CoreEvent) => this.emit(e, trail);
    const phase = async (p: EmbodiedPhase) => {
      await this.onPhase?.(p, this.sink.aesthetic);
    };
    const cancelled = () => gen !== this.generation || this.interrupted;
    const done = (ok: boolean, out: Partial<EmbodiedTurnResult> = {}): EmbodiedTurnResult => ({
      ok,
      text: out.text ?? "",
      error: out.error,
      interrupted: out.interrupted ?? false,
      state: this.sink.aesthetic.state,
      events: trail,
    });

    // 上一轮仍在播报时，先停语音（user_interrupt 会把 speaking 拉回 listening）
    if (this.speaker.speaking) this.stopSpeech();

    dispatch({ type: "user_speech_start" });
    await phase("listening");
    if (cancelled()) return done(true, { interrupted: true });

    dispatch({ type: "user_speech_end" });
    dispatch({ type: "llm_request_start" });
    await phase("thinking");
    if (cancelled()) return done(true, { interrupted: true });

    let outcome: ReplyOutcome;
    try {
      this.deltaCount = 0;
      outcome = await this.reply(text, {
        onDelta: () => {
          // thinking 期间用流式增量制造轻微强度波动，不触发状态转换
          this.deltaCount += 1;
          if (this.deltaCount % 3 === 0) {
            this.sink.setIntensity(0.55 + 0.15 * Math.abs(Math.sin(this.deltaCount * 0.4)));
          }
        },
      });
    } catch (err) {
      dispatch({ type: "llm_error" });
      await phase("error");
      await phase("idle");
      return done(false, { error: err instanceof Error ? err.message : String(err) });
    }

    if (cancelled()) return done(true, { interrupted: true });

    if (outcome.kind === "task") {
      dispatch({ type: "harness_start" });
      this.sink.setIntensity(0.55, outcome.caption ?? "执行中");
      await phase("working");
      let ok = true;
      try {
        ok = await outcome.run();
      } catch {
        ok = false;
      }
      if (cancelled()) return done(true, { interrupted: true });
      dispatch({ type: "harness_end", ok });
      await phase("responding");
    }

    // llm_response_done: thinking→speaking；working/responding 下忽略（由 tts_start 接管）
    dispatch({ type: "llm_response_done" });
    // tts_start: responding→speaking（任务结果播报）；已在 speaking 时忽略
    dispatch({ type: "tts_start" });
    await phase("speaking");

    if (cancelled()) return done(true, { interrupted: true, text: outcome.kind === "silent" ? "" : outcome.text });

    if (outcome.kind !== "silent" && outcome.text.trim()) {
      await this.speaker.speak(outcome.text);
    }
    // VoiceIO 自行派 tts_end（打断时改派 user_interrupt）；裸适配器 / 静默轮由本类补齐
    if ((!this.speaker.emitsStateEvents || outcome.kind === "silent") && !cancelled()) {
      dispatch({ type: "tts_end" });
    }
    await phase("idle");
    return done(true, { text: outcome.kind === "silent" ? "" : outcome.text });
  }
}
