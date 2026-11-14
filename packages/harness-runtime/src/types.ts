/**
 * Harness Adapter 接口（架构 §4.2）
 *
 * Harness = JARVIS 调用的执行环境。不重新实现 Codex/Claude Code 内部机制，
 * 通过统一 Adapter 连接。0.1 首个实现：Coding Harness（GLM/DeepSeek 工具调用循环）。
 */

/** 能力声明 */
export interface Capability {
  id: string;
  description: string;
}

/** 健康状态 */
export interface HealthStatus {
  ok: boolean;
  detail?: string;
}

/** 提交给 Harness 的任务 */
export interface HarnessTask {
  /** 工作目录（Harness 只能在此目录内读写） */
  workDir: string;
  /** 任务目标（自然语言） */
  goal: string;
  /** 可选：上下文文件相对路径列表 */
  inputFiles?: string[];
}

/** Harness 作业 */
export interface HarnessJob {
  jobId: string;
  harnessId: string;
  startedAt: string;
}

/** 作业状态（与 TaskManager 任务状态分离——架构 §3.6） */
export interface HarnessJobStatus {
  jobId: string;
  state: "RUNNING" | "COMPLETED" | "FAILED" | "CANCELLED";
  /** 已执行的步数（LLM 轮次） */
  steps: number;
  /** 产物描述（完成时） */
  output?: string;
  /** 失败原因 */
  error?: string;
  /** 执行日志（工具调用记录） */
  log: HarnessEventRecord[];
}

export interface HarnessEventRecord {
  at: string;
  kind: "llm_call" | "tool_call" | "tool_result" | "info" | "error";
  detail: string;
}

/** 流式事件 */
export type HarnessEvent =
  | { type: "progress"; jobId: string; text: string }
  | { type: "completed"; jobId: string; status: HarnessJobStatus }
  | { type: "failed"; jobId: string; status: HarnessJobStatus };

/** Harness Adapter 统一接口（架构 §4.2） */
export interface HarnessAdapter {
  readonly id: string;
  getCapabilities(): Promise<Capability[]>;
  healthCheck(): Promise<HealthStatus>;
  execute(task: HarnessTask): Promise<HarnessJob>;
  getStatus(jobId: string): Promise<HarnessJobStatus>;
  streamEvents(jobId: string): AsyncIterable<HarnessEvent>;
  cancel(jobId: string): Promise<void>;
}

/** Harness 执行配置 */
export interface HarnessRuntimeOptions {
  /** 单作业最大 LLM 轮次（防失控，默认 24） */
  maxSteps?: number;
  /** 单轮超时 ms（默认 120s） */
  stepTimeoutMs?: number;
}
