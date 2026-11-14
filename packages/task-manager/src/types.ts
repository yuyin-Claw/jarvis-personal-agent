/**
 * Task Manager（PRD FR-05 / 架构 §3.6）
 *
 * 任务状态与 Harness 进程状态分离：进程退出 ≠ 任务成败，由宿主验证后推进状态。
 */

/** 任务状态（PRD FR-05） */
export type TaskStatus =
  | "CREATED"
  | "PLANNED"
  | "WAITING_APPROVAL"
  | "RUNNING"
  | "BLOCKED"
  | "COMPLETED"
  | "FAILED"
  | "CANCELLED";

/** 合法状态转换表（非法转换抛错——状态机测试覆盖每条边） */
export const TRANSITIONS: Record<TaskStatus, TaskStatus[]> = {
  CREATED: ["PLANNED", "CANCELLED"],
  PLANNED: ["WAITING_APPROVAL", "RUNNING", "CANCELLED"],
  WAITING_APPROVAL: ["RUNNING", "CANCELLED"],
  RUNNING: ["BLOCKED", "COMPLETED", "FAILED", "CANCELLED"],
  BLOCKED: ["RUNNING", "CANCELLED"],
  COMPLETED: [],
  FAILED: ["PLANNED", "CANCELLED"], // 重试：回 PLANNED 重新执行
  CANCELLED: [],
};

/** 任务 */
export interface AgentTask {
  id: string;
  title: string;
  goal: string;
  status: TaskStatus;
  createdAt: string;
  updatedAt: string;
  /** 执行器标识（harness id），未分配为 null */
  harnessId: string | null;
  /** harness 侧作业 id（任务状态与 harness 进程状态分离） */
  harnessJobId: string | null;
  /** 上下文引用（记忆 id / 对话 id 等） */
  contextRefs: string[];
  /** 依赖的任务 id */
  dependencies: string[];
  requiresApproval: boolean;
  /** 终态结果（完成/失败原因） */
  result: TaskResult | null;
}

export interface TaskResult {
  /** 成功产物描述或文件路径 */
  output?: string;
  /** 失败原因 */
  error?: string;
  finishedAt: string;
}

/** 任务事件（task_events 表，审计与恢复用） */
export interface TaskEvent {
  taskId: string;
  type: string;
  detail: string;
  at: string;
}

/** 任务过滤器 */
export interface TaskFilter {
  status?: TaskStatus;
  /** 依赖未全部完成的任务 */
  blockedByDependencies?: boolean;
}

/** Task Manager 接口（实现见 sqlite-task-manager.ts） */
export interface TaskManager {
  migrate(): void;
  create(input: {
    title: string;
    goal: string;
    requiresApproval?: boolean;
    dependencies?: string[];
    contextRefs?: string[];
  }): AgentTask;
  get(id: string): AgentTask | undefined;
  list(filter?: TaskFilter): AgentTask[];
  /** 状态机转换（非法路径抛错） */
  transition(id: string, to: TaskStatus, result?: TaskResult): AgentTask;
  /** 绑定 harness 执行 */
  assign(id: string, harnessId: string, harnessJobId: string): AgentTask;
  /** 依赖是否全部满足（非终态依赖视为未满足） */
  dependenciesMet(id: string): boolean;
  /** 取消（任何非终态可达） */
  cancel(id: string): AgentTask;
  /** 崩溃恢复：RUNNING 但宿主已重启的任务标记 BLOCKED */
  recoverOrphans(): AgentTask[];
  /** 事件追加与查询 */
  appendEvent(taskId: string, type: string, detail: string): void;
  listEvents(taskId: string): TaskEvent[];
}

/** 实现类类型引用（避免循环 import） */
export type TaskManagerImplTypes = TaskManager;
