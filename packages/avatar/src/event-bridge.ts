/**
 * Core Event Bridge：把各子系统事件翻译成 CoreEvent 投递给状态机。
 *
 * 事件源（现有实现均为事件可观察）：
 * - ConversationGateway 流式回调（onDelta 前后）→ thinking/speaking
 * - TaskManager 状态变化（轮询 diff 或事件包裹）→ working/responding
 * - ContinuousRuntime.onEvent → proactive_notice
 * - 语音层（0.2-③）→ user_speech_* / user_interrupt / tts_*
 */
import type { AvatarStateEngine, CoreEvent } from "./state-engine.js";
import type { TaskStatus } from "@jarvis/task-manager";

/** 任务状态变化 → Core 事件映射（working↔responding 的判定核心） */
export function taskEventFor(from: TaskStatus, to: TaskStatus): CoreEvent | null {
  if (to === "RUNNING" && from !== "RUNNING") return { type: "harness_start" };
  if (to === "COMPLETED" && from === "RUNNING") return { type: "task_completed" };
  if ((to === "FAILED" || to === "CANCELLED") && from === "RUNNING") {
    return { type: "harness_end", ok: false };
  }
  return null; // 其他转换不驱动数字人
}

/** 对话轮生命周期 → Core 事件序列 */
export function conversationEvents(): {
  onLLMStart(): CoreEvent;
  onLLMDone(): CoreEvent;
  onTTSStart(): CoreEvent;
  onTTSEnd(): CoreEvent;
} {
  return {
    onLLMStart: () => ({ type: "llm_request_start" }),
    onLLMDone: () => ({ type: "llm_response_done" }),
    onTTSStart: () => ({ type: "tts_start" }),
    onTTSEnd: () => ({ type: "tts_end" }),
  };
}

/**
 * 任务观察器：轮询 TaskManager diff，翻译投递。
 * （TaskManager 无推送接口；0.2 用轻轮询，事件即时的替代是调用方显式桥接）
 */
export class TaskEventWatcher {
  private last = new Map<string, TaskStatus>();
  private timer: unknown;

  constructor(
    private readonly tm: { list(): Array<{ id: string; status: TaskStatus }> },
    private readonly engine: AvatarStateEngine,
    private readonly intervalMs = 1000,
  ) {}

  start(): void {
    // 基线快照（首扫不触发 working）
    for (const t of this.tm.list()) this.last.set(t.id, t.status);
    this.timer = setInterval(() => void this.poll(), this.intervalMs);
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer as ReturnType<typeof setInterval>);
  }

  /** 手动触发一次（测试/即时桥接） */
  async poll(): Promise<void> {
    for (const t of this.tm.list()) {
      const prev = this.last.get(t.id);
      if (prev !== undefined && prev !== t.status) {
        const ev = taskEventFor(prev, t.status);
        if (ev) this.engine.dispatch(ev);
      }
      this.last.set(t.id, t.status);
    }
  }
}
