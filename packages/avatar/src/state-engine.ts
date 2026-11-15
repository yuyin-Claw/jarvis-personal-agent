/**
 * Avatar State Engine（JARVIS 0.2 Embodied Conversational Agent）
 *
 * 数字人=JARVIS 的实时表现层。本模块是纯逻辑状态机：
 * 六状态 + 转换规则 + Core 事件绑定。不含任何渲染细节——
 * 渲染层（2D 粒子/3D VRM/Live2D）只消费 AestheticState 事件流。
 */

/** 六状态（用户定义，与 Core 事件绑定） */
export type AvatarState =
  | "idle" // 待机：呼吸微光
  | "listening" // 聆听：用户说话中（含打断后）
  | "thinking" // 思考：LLM 请求中
  | "speaking" // 说话：TTS 播放中
  | "working" // 执行任务：Harness 运行中
  | "responding"; // 回应：任务完成/结果反馈的高亮时刻

/** 触发状态转换的 Core 事件（事件桥翻译各子系统事件后投递） */
export type CoreEvent =
  | { type: "user_speech_start" } // 用户开始说话（语音活动检测/按键）
  | { type: "user_speech_end" } // 用户说完
  | { type: "user_interrupt" } // 用户打断（说话时 TTS 立即停）
  | { type: "llm_request_start" } // 请求进入 LLM
  | { type: "llm_response_done" } // LLM 返回
  | { type: "tts_start" } // TTS 开始播放
  | { type: "tts_end" } // TTS 播完
  | { type: "harness_start" } // Harness 开始执行
  | { type: "harness_end"; ok: boolean } // Harness 结束
  | { type: "task_completed" } // 任务完成（回应时刻）
  | { type: "proactive_notice" } // 主动通知（数字人主动开口）
  | { type: "llm_error" } // 生成失败：任意状态立即回 idle，避免卡在 thinking
  | { type: "activity_timeout" }; // 空闲超时（引擎内部定时驱动）

/** 状态转换表：current × event → next */
const TRANSITIONS: Partial<Record<AvatarState, Partial<Record<CoreEvent["type"], AvatarState>>>> = {
  idle: {
    user_speech_start: "listening",
    proactive_notice: "speaking", // 主动开口直接进入说话
    llm_request_start: "thinking",
    tts_start: "speaking",
    harness_start: "working",
    llm_error: "idle",
    user_interrupt: "listening",
  },
  listening: {
    user_speech_end: "thinking", // 说完默认进入理解（由对话层接管）
    user_interrupt: "listening", // 打断后仍在聆听
    llm_request_start: "thinking",
    tts_start: "speaking",
    llm_error: "idle",
  },
  thinking: {
    llm_response_done: "speaking", // 有话要说（TTS 随后启动）
    tts_start: "speaking",
    harness_start: "working", // 决策为执行任务
    user_speech_start: "listening", // 用户补充打断思考
    user_interrupt: "listening",
    llm_error: "idle",
  },
  speaking: {
    user_interrupt: "listening", // 打断：立即停 TTS 切聆听
    tts_end: "idle",
    harness_start: "working", // 边说边启动执行
    user_speech_start: "listening",
    llm_error: "idle",
  },
  working: {
    harness_end: "responding",
    task_completed: "responding",
    user_speech_start: "listening", // 用户随时可插话
    proactive_notice: "working", // 工作中收到通知保持工作（不打断表现）
    user_interrupt: "listening",
    llm_error: "idle",
  },
  responding: {
    tts_start: "speaking", // 播报结果
    user_speech_start: "listening",
    harness_start: "working", // 连续任务
    activity_timeout: "idle",
    user_interrupt: "listening",
    llm_error: "idle",
  },
};

/** 表现层输出：渲染器每帧消费的审美建议（与具体渲染技术无关） */
export interface AestheticState {
  state: AvatarState;
  /** 强度 0-1：listening 随音量、speaking 随振幅、working 随进度 */
  intensity: number;
  /** 状态进入时间戳（渲染层做过渡动画用） */
  enteredAt: number;
  /** 可选文本提示（responding 播报内容 / working 任务名） */
  caption?: string;
}

/** 状态转换记录（审计与测试） */
export interface StateTransition {
  from: AvatarState;
  to: AvatarState;
  event: CoreEvent["type"];
  at: number;
}

export interface AvatarStateEngineOptions {
  /** 空闲回退毫秒（responding 停留后回 idle；默认 4000） */
  respondingHoldMs?: number;
  /** 时钟注入（测试） */
  now?: () => number;
  /** 定时器注入（测试） */
  setTimeoutImpl?: (fn: () => void, ms: number) => unknown;
}

export class AvatarStateEngine {
  private state: AvatarState = "idle";
  private intensity = 0;
  private enteredAt: number;
  private caption: string | undefined;
  private readonly transitions: StateTransition[] = [];
  private readonly listeners = new Set<(a: AestheticState) => void>();
  private readonly respondingHoldMs: number;
  private readonly now: () => number;
  private readonly setTimeoutImpl: NonNullable<AvatarStateEngineOptions["setTimeoutImpl"]>;
  private holdTimer: unknown;

  constructor(opts: AvatarStateEngineOptions = {}) {
    this.respondingHoldMs = opts.respondingHoldMs ?? 4000;
    this.now = opts.now ?? (() => Date.now());
    this.setTimeoutImpl = opts.setTimeoutImpl ?? ((fn, ms) => setTimeout(fn, ms));
    this.enteredAt = this.now();
  }

  /** 当前表现快照 */
  get aesthetic(): AestheticState {
    return {
      state: this.state,
      intensity: this.intensity,
      enteredAt: this.enteredAt,
      caption: this.caption,
    };
  }

  /** 订阅表现流（渲染器接这里） */
  onAesthetic(listener: (a: AestheticState) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /** 历史轨迹（测试/审计） */
  get trail(): readonly StateTransition[] {
    return this.transitions;
  }

  /** 外部强度更新（麦克风音量/TTS 振幅/任务进度——不触发状态转换） */
  setIntensity(v: number, caption?: string): void {
    this.intensity = Math.max(0, Math.min(1, v));
    if (caption !== undefined) this.caption = caption;
    this.emit();
  }

  /** 投递 Core 事件（事件桥调用）；未定义转换=忽略（保持现态） */
  dispatch(event: CoreEvent): AvatarState {
    const next = TRANSITIONS[this.state]?.[event.type];
    if (!next || next === this.state) {
      // speaking 中 tts_end 后的自然回 idle 由显式事件驱动；忽略未知组合
      if (next === this.state) this.applyState(next, event);
      return this.state;
    }
    return this.applyState(next, event);
  }

  private applyState(next: AvatarState, event: CoreEvent): AvatarState {
    const from = this.state;
    this.state = next;
    this.enteredAt = this.now();
    this.transitions.push({ from, to: next, event: event.type, at: this.enteredAt });
    if (this.holdTimer) {
      clearTimeout(this.holdTimer as ReturnType<typeof setTimeout>);
      this.holdTimer = undefined;
    }
    // 状态默认强度基线（渲染层可再被 setIntensity 覆盖）
    this.intensity = BASELINE[next];
    if (event.type === "harness_end" && "ok" in event && event.ok === false) {
      this.caption = "任务失败";
    }
    if (next === "responding") {
      // 停留后自动回 idle（无后续 TTS 时）
      this.holdTimer = this.setTimeoutImpl(() => {
        this.dispatch({ type: "activity_timeout" });
      }, this.respondingHoldMs);
    }
    this.emit();
    return next;
  }

  private emit(): void {
    const snap = this.aesthetic;
    for (const l of this.listeners) l(snap);
  }
}

/** 各状态表现基线强度（渲染层起点） */
export const BASELINE: Record<AvatarState, number> = {
  idle: 0.15,
  listening: 0.5,
  thinking: 0.6,
  speaking: 0.7,
  working: 0.5,
  responding: 0.85,
};
