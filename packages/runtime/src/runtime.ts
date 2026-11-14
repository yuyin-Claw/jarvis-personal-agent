/**
 * Continuous Runtime（PRD FR-07/FR-08 / 架构 §9）
 *
 * 事件驱动 + 定时检查 + 主动沟通（有分寸），禁止无休止模型轮询。
 */

/** 定时任务定义 */
export interface ScheduledJob {
  id: string;
  /** cron 风格简化：间隔毫秒 + 首次延迟 */
  intervalMs: number;
  /** 任务名（审计用） */
  name: string;
  run: () => Promise<void>;
}

/** 主动通知 */
export interface ProactiveNotice {
  /** 通知内容（面向用户） */
  text: string;
  /** 优先级：low=可攒批 / normal=及时 / high=立即 */
  priority: "low" | "normal" | "high";
  /** 去重键（相同 key 的通知在冷却期内合并） */
  dedupeKey: string;
  at: string;
}

/** 通知通道抽象（0.2：文件+stdout；未来 macOS 通知/系统通知） */
export interface NotifyChannel {
  send(notice: ProactiveNotice): Promise<void>;
}

/** 主动策略配置（Proactive Policy，架构 §3.7） */
export interface ProactivePolicy {
  /** 同 dedupeKey 冷却毫秒（默认 1 小时） */
  dedupeCooldownMs?: number;
  /** 每日通知上限（默认 20） */
  dailyLimit?: number;
  /** 静默时段（如 23:00-07:00 不发 normal/low） */
  quietHours?: { startHour: number; endHour: number };
}

/** 运行时事件 */
export type RuntimeEvent =
  | { type: "job_started"; jobId: string; name: string; at: string }
  | { type: "job_finished"; jobId: string; name: string; ok: boolean; error?: string; at: string }
  | { type: "notice_sent"; dedupeKey: string; at: string }
  | { type: "notice_suppressed"; dedupeKey: string; reason: string; at: string };

export interface RuntimeOptions {
  /** 时钟注入（测试） */
  now?: () => Date;
  /** 定时器实现注入（测试） */
  scheduler?: { setInterval(fn: () => void, ms: number): unknown; clearInterval(h: unknown): void };
}

/** Proactive Engine：通知裁决（去重/限额/静默时段） */
export class ProactiveEngine {
  private readonly sentAt = new Map<string, number>();
  private readonly todayCount = new Map<string, number>(); // dateKey -> count
  private readonly policy: Required<Pick<ProactivePolicy, "dedupeCooldownMs" | "dailyLimit">> & ProactivePolicy;
  private readonly now: () => Date;

  constructor(policy: ProactivePolicy = {}, now: () => Date = () => new Date()) {
    this.policy = {
      dedupeCooldownMs: policy.dedupeCooldownMs ?? 3_600_000,
      dailyLimit: policy.dailyLimit ?? 20,
      quietHours: policy.quietHours,
    };
    this.now = now;
  }

  /** 裁决：允许发送 / 拒绝（返回原因） */
  decide(notice: ProactiveNotice): { allow: true } | { allow: false; reason: string } {
    const t = this.now().getTime();

    // 静默时段：high 放行，normal/low 抑制
    const hour = this.now().getHours();
    const q = this.policy.quietHours;
    if (q && notice.priority !== "high") {
      const inQuiet =
        q.startHour > q.endHour
          ? hour >= q.startHour || hour < q.endHour
          : hour >= q.startHour && hour < q.endHour;
      if (inQuiet) return { allow: false, reason: `静默时段 ${q.startHour}:00-${q.endHour}:00` };
    }

    // 去重冷却
    const last = this.sentAt.get(notice.dedupeKey);
    if (last !== undefined && t - last < this.policy.dedupeCooldownMs) {
      return { allow: false, reason: "冷却期内重复" };
    }

    // 每日限额
    const dateKey = this.now().toISOString().slice(0, 10);
    const count = this.todayCount.get(dateKey) ?? 0;
    if (count >= this.policy.dailyLimit) {
      return { allow: false, reason: `已达每日上限 ${this.policy.dailyLimit}` };
    }

    // 放行并记账
    this.sentAt.set(notice.dedupeKey, t);
    this.todayCount.set(dateKey, count + 1);
    return { allow: true };
  }
}

/** 持续运行时：定时任务调度 + 心跳 + 主动通知出口 */
export class ContinuousRuntime {
  private readonly jobs = new Map<string, { job: ScheduledJob; handle: unknown }>();
  private readonly proactive: ProactiveEngine;
  private readonly channels: NotifyChannel[];
  private readonly now: () => Date;
  private readonly scheduler: NonNullable<RuntimeOptions["scheduler"]>;
  private readonly listeners: Array<(ev: RuntimeEvent) => void> = [];
  private heartbeatCount = 0;

  constructor(opts: { channels: NotifyChannel[]; policy?: ProactivePolicy } & RuntimeOptions = { channels: [] }) {
    this.channels = opts.channels;
    this.now = opts.now ?? (() => new Date());
    this.proactive = new ProactiveEngine(opts.policy ?? {}, this.now);
    this.scheduler = opts.scheduler ?? {
      setInterval: (fn, ms) => setInterval(fn, ms),
      clearInterval: (h) => clearInterval(h as ReturnType<typeof setInterval>),
    };
  }

  onEvent(listener: (ev: RuntimeEvent) => void): void {
    this.listeners.push(listener);
  }

  private emit(ev: RuntimeEvent): void {
    for (const l of this.listeners) l(ev);
  }

  /** 注册并启动定时任务（幂等：同 id 覆盖） */
  schedule(job: ScheduledJob): void {
    const existing = this.jobs.get(job.id);
    if (existing) this.scheduler.clearInterval(existing.handle);
    const handle = this.scheduler.setInterval(() => void this.runJob(job), job.intervalMs);
    this.jobs.set(job.id, { job, handle });
  }

  /** 立即执行一次（不等间隔） */
  async runJob(job: ScheduledJob): Promise<void> {
    const at = this.now().toISOString();
    this.emit({ type: "job_started", jobId: job.id, name: job.name, at });
    try {
      await job.run();
      this.emit({ type: "job_finished", jobId: job.id, name: job.name, ok: true, at: this.now().toISOString() });
    } catch (err) {
      this.emit({
        type: "job_finished",
        jobId: job.id,
        name: job.name,
        ok: false,
        error: err instanceof Error ? err.message : String(err),
        at: this.now().toISOString(),
      });
    }
  }

  /** 心跳（由外部定时驱动；每次计数，不调模型） */
  heartbeat(): void {
    this.heartbeatCount++;
  }

  get heartbeatTotal(): number {
    return this.heartbeatCount;
  }

  /** 主动通知出口（经 ProactiveEngine 裁决） */
  async notify(notice: ProactiveNotice): Promise<boolean> {
    const verdict = this.proactive.decide(notice);
    if (!verdict.allow) {
      this.emit({ type: "notice_suppressed", dedupeKey: notice.dedupeKey, reason: verdict.reason, at: this.now().toISOString() });
      return false;
    }
    for (const ch of this.channels) await ch.send(notice);
    this.emit({ type: "notice_sent", dedupeKey: notice.dedupeKey, at: this.now().toISOString() });
    return true;
  }

  /** 停止全部 */
  stop(): void {
    for (const { handle } of this.jobs.values()) this.scheduler.clearInterval(handle);
    this.jobs.clear();
  }

  get jobIds(): string[] {
    return [...this.jobs.keys()];
  }

  /** 按 id 取已注册任务（立即触发用） */
  getJob(id: string): ScheduledJob | undefined {
    return this.jobs.get(id)?.job;
  }
}
