/**
 * Proactive Voice Channel（0.2-⑤ 主动交流）
 *
 * 把 ContinuousRuntime 的主动通知变成「数字人主动开口」：
 * 通知 → VoiceIO.announce（proactive_notice → speaking → idle）→ 语音播报。
 *
 * 分寸规则（架构 §3.7 主动策略的具体落地）：
 * - 只在数字人 idle 时开口；listening/thinking/speaking/working/responding 一律排队，
 *   绝不打断用户说话或正在执行的任务。
 * - 队列有上限与 TTL，过期消息不补播；high 优先级插到队头。
 * - 语音关闭 / 宿主不可用时降级为静默（文件与系统通知通道仍照常工作，消息不丢）。
 * - 公告串行执行，防止 onAesthetic(idle) 回调引发重入导致连珠炮式播报。
 */
import type { AestheticState } from "@jarvis/avatar";

/** 结构兼容 @jarvis/runtime 的 ProactiveNotice（本包不依赖运行时实现） */
export interface ProactiveNoticeLike {
  text: string;
  priority: "low" | "normal" | "high";
  dedupeKey: string;
  at: string;
}

export interface Announcer {
  announce(text: string): Promise<void>;
}

export interface ProactiveEngineView {
  readonly aesthetic: AestheticState;
  onAesthetic(cb: (a: AestheticState) => void): () => void;
}

export type ProactiveVoiceEventType =
  | "spoken"
  | "queued"
  | "degraded"
  | "dropped"
  | "expired"
  | "error";

export interface ProactiveVoiceEvent {
  type: ProactiveVoiceEventType;
  dedupeKey?: string;
  detail?: string;
  at: number;
}

export interface ProactiveVoiceOptions {
  engine: ProactiveEngineView;
  announcer: Announcer;
  /** 关闭语音时的兜底通道（一般无需：ContinuousRuntime 同时挂文件/系统通知） */
  fallback?: (n: ProactiveNoticeLike) => Promise<void>;
  /** 默认 true；关闭后完全不发声、只走 fallback */
  enabled?: boolean;
  now?: () => number;
  /** 队列上限，默认 5 */
  queueLimit?: number;
  /** 排队消息存活时间，默认 5 分钟 */
  ttlMs?: number;
  onEvent?: (e: ProactiveVoiceEvent) => void;
}

interface Queued {
  notice: ProactiveNoticeLike;
  at: number;
}

export class ProactiveVoiceChannel {
  private readonly engine: ProactiveEngineView;
  private readonly announcer: Announcer;
  private readonly fallback?: ProactiveVoiceOptions["fallback"];
  private readonly enabled: boolean;
  private readonly now: () => number;
  private readonly queueLimit: number;
  private readonly ttlMs: number;
  private readonly onEvent?: ProactiveVoiceOptions["onEvent"];
  private readonly queue: Queued[] = [];
  private readonly unsubscribe: () => void;
  private announcing = false;
  private disposed = false;

  constructor(opts: ProactiveVoiceOptions) {
    this.engine = opts.engine;
    this.announcer = opts.announcer;
    this.fallback = opts.fallback;
    this.enabled = opts.enabled ?? true;
    this.now = opts.now ?? (() => Date.now());
    this.queueLimit = opts.queueLimit ?? 5;
    this.ttlMs = opts.ttlMs ?? 300_000;
    this.onEvent = opts.onEvent;
    this.unsubscribe = this.engine.onAesthetic((a) => {
      if (a.state === "idle" && !this.announcing) void this.flush();
    });
  }

  private emit(type: ProactiveVoiceEventType, dedupeKey?: string, detail?: string): void {
    this.onEvent?.({ type, dedupeKey, detail, at: this.now() });
  }

  get pending(): number {
    return this.queue.length;
  }

  /** 兼容 ContinuousRuntime.NotifyChannel.send */
  async send(notice: ProactiveNoticeLike): Promise<void> {
    if (this.disposed) return;
    if (!this.enabled) {
      await this.fallback?.(notice);
      this.emit("degraded", notice.dedupeKey, "语音主动交流已关闭");
      return;
    }
    const item: Queued = { notice, at: this.now() };
    if (notice.priority === "high") this.queue.unshift(item);
    else this.queue.push(item);
    this.emit("queued", notice.dedupeKey, `state=${this.engine.aesthetic.state} queue=${this.queue.length}`);

    // 超限：优先丢最旧的低优先级消息，保留 high
    while (this.queue.length > this.queueLimit) {
      const idx = this.queue.findIndex((q) => q.notice.priority !== "high");
      const dropAt = idx >= 0 ? idx : this.queue.length - 1;
      const [dropped] = this.queue.splice(dropAt, 1);
      this.emit("dropped", dropped?.notice.dedupeKey, "队列超限");
    }
    if (this.engine.aesthetic.state === "idle") await this.flush();
  }

  /** 便捷入口：生成一条主动消息（dedupeKey 缺省按文本摘要） */
  async offer(text: string, priority: ProactiveNoticeLike["priority"] = "normal", dedupeKey?: string): Promise<void> {
    await this.send({
      text,
      priority,
      dedupeKey: dedupeKey ?? `offer:${text.slice(0, 24)}`,
      at: new Date(this.now()).toISOString(),
    });
  }

  private async flush(): Promise<void> {
    if (this.announcing || this.disposed) return;
    this.announcing = true;
    try {
      while (this.queue.length > 0 && this.engine.aesthetic.state === "idle") {
        const item = this.queue.shift()!;
        if (this.now() - item.at > this.ttlMs) {
          this.emit("expired", item.notice.dedupeKey);
          continue;
        }
        try {
          await this.announcer.announce(item.notice.text);
          this.emit("spoken", item.notice.dedupeKey);
        } catch (err) {
          this.emit("error", item.notice.dedupeKey, err instanceof Error ? err.message : String(err));
        }
      }
    } finally {
      this.announcing = false;
    }
  }

  dispose(): void {
    this.disposed = true;
    this.queue.length = 0;
    this.unsubscribe();
  }
}
