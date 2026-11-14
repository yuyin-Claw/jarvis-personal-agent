/**
 * 停滞任务检测器（Proactive Engine 的规则核心）
 *
 * 场景：任务长时间无进展 → 先自查（事件日志），值得打扰才通知用户。
 */
import type { AgentTask, TaskManager } from "@jarvis/task-manager";

export interface StagnationConfig {
  /** 任务视为停滞的毫秒数（默认 24h） */
  thresholdMs?: number;
  /** 检查时的时间 */
  now?: () => Date;
}

export interface StagnationReport {
  task: AgentTask;
  /** 距最后更新的毫秒 */
  idleMs: number;
  /** 最后一条事件摘要 */
  lastEvent?: string;
}

/** 找出停滞的非终态任务 */
export function findStagnantTasks(tm: TaskManager, cfg: StagnationConfig = {}): StagnationReport[] {
  const threshold = cfg.thresholdMs ?? 24 * 3600_000;
  const now = (cfg.now ?? (() => new Date()))().getTime();
  const out: StagnationReport[] = [];
  for (const t of tm.list()) {
    if (["COMPLETED", "FAILED", "CANCELLED", "WAITING_APPROVAL"].includes(t.status)) continue;
    if (t.status === "CREATED") continue; // 未启动的任务不算停滞（等用户/调度）
    const idleMs = now - new Date(t.updatedAt).getTime();
    if (idleMs >= threshold) {
      const events = tm.listEvents(t.id);
      out.push({
        task: t,
        idleMs,
        lastEvent: events[events.length - 1]?.detail,
      });
    }
  }
  return out.sort((a, b) => b.idleMs - a.idleMs);
}
