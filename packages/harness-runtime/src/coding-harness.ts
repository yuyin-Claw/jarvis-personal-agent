/**
 * GLM Coding Harness —— 自研轻量 Coding Agent（ADR-004）
 *
 * LLM 工具调用循环：目标 → 模型请求工具（read/write/list/run）→ 执行 → 回填 → 循环，
 * 直到模型输出完成声明或达 maxSteps。底层模型经 LLMGateway 可换（GLM/DeepSeek）。
 */
import { spawn } from "node:child_process";
import type { LLMGateway, LLMRequest } from "@jarvis/llm-gateway";
import type {
  Capability,
  HarnessAdapter,
  HarnessEvent,
  HarnessJob,
  HarnessJobStatus,
  HarnessTask,
  HealthStatus,
} from "./types.js";
import { ToolError, checkCommand, toolListFiles, toolReadFile, toolWriteFile } from "./tools.js";

/** OpenAI 风格工具定义 */
interface ToolDef {
  type: "function";
  function: {
    name: string;
    description: string;
    parameters: Record<string, unknown>;
  };
}

const TOOLS: ToolDef[] = [
  {
    type: "function",
    function: {
      name: "read_file",
      description: "读取工作目录内的文本文件",
      parameters: {
        type: "object",
        properties: { path: { type: "string", description: "相对路径" } },
        required: ["path"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "write_file",
      description: "创建或覆写工作目录内的文本文件",
      parameters: {
        type: "object",
        properties: { path: { type: "string" }, content: { type: "string" } },
        required: ["path", "content"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "list_files",
      description: "列出目录内容",
      parameters: {
        type: "object",
        properties: { dir: { type: "string", description: "相对目录，默认 ." } },
        required: [],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "run_command",
      description: "在工作目录执行白名单命令（node/npm/git 等；禁止 rm/sudo）",
      parameters: {
        type: "object",
        properties: { command: { type: "string" } },
        required: ["command"],
      },
    },
  },
];

const SYSTEM = `你是 JARVIS 的编码执行器。在指定工作目录内完成任务目标。
规则：
- 优先 read_file/list_files 了解现状，再写代码
- 每步只调一个工具，等结果再继续
- 完成后（不调工具）输出总结：做了什么、产物文件、如何验证
- 不得访问工作目录外的文件；命令必须安全`;

interface JobState {
  harnessId: string;
  task: HarnessTask;
  status: HarnessJobStatus;
  cancelled: boolean;
  listeners: Array<(ev: HarnessEvent) => void>;
  done: Promise<void>;
}

export interface CodingHarnessOptions {
  gateway: LLMGateway;
  model: string;
  harnessId?: string;
  maxSteps?: number;
  stepTimeoutMs?: number;
  /** 注入 spawn（测试） */
  spawnImpl?: typeof spawn;
}

export class CodingHarness implements HarnessAdapter {
  readonly id: string;
  private readonly gateway: LLMGateway;
  private readonly model: string;
  private readonly maxSteps: number;
  private readonly stepTimeoutMs: number;
  private readonly spawnImpl: typeof spawn;
  private readonly jobs = new Map<string, JobState>();

  constructor(opts: CodingHarnessOptions) {
    this.id = opts.harnessId ?? "glm-coding";
    this.gateway = opts.gateway;
    this.model = opts.model;
    this.maxSteps = opts.maxSteps ?? 24;
    this.stepTimeoutMs = opts.stepTimeoutMs ?? 120_000;
    this.spawnImpl = opts.spawnImpl ?? spawn;
  }

  async getCapabilities(): Promise<Capability[]> {
    return [
      { id: "coding", description: "软件开发、代码修改、自动化测试" },
      { id: "scripting", description: "编写与运行脚本工具" },
    ];
  }

  async healthCheck(): Promise<HealthStatus> {
    // 模型可达性由 provider 层分类负责；此处恒真（CI 无网络也能构造）
    return { ok: true };
  }

  async execute(task: HarnessTask): Promise<HarnessJob> {
    const jobId = `job_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
    const state: JobState = {
      harnessId: this.id,
      task,
      cancelled: false,
      listeners: [],
      status: {
        jobId,
        state: "RUNNING",
        steps: 0,
        log: [],
      },
      done: Promise.resolve(),
    };
    this.jobs.set(jobId, state);

    // 异步跑循环；execute 立即返回 job 句柄
    state.done = this.runLoop(state).catch((err) => {
      state.status.state = "FAILED";
      state.status.error = err instanceof Error ? err.message : String(err);
    });

    return { jobId, harnessId: this.id, startedAt: new Date().toISOString() };
  }

  async getStatus(jobId: string): Promise<HarnessJobStatus> {
    const state = this.jobs.get(jobId);
    if (!state) throw new Error(`作业不存在: ${jobId}`);
    return { ...state.status, log: [...state.status.log] };
  }

  async *streamEvents(jobId: string): AsyncIterable<HarnessEvent> {
    const state = this.jobs.get(jobId);
    if (!state) throw new Error(`作业不存在: ${jobId}`);
    // 简单轮询实现（0.1 足够；事件量小）
    let lastLen = 0;
    for (;;) {
      await new Promise((r) => setTimeout(r, 100));
      const log = state.status.log;
      for (let i = lastLen; i < log.length; i++) {
        const rec = log[i];
        if (rec) yield { type: "progress", jobId, text: `${rec.kind}: ${rec.detail}` };
      }
      lastLen = log.length;
      if (state.status.state !== "RUNNING") {
        if (state.status.state === "COMPLETED") {
          yield { type: "completed", jobId, status: { ...state.status } };
        } else {
          yield { type: "failed", jobId, status: { ...state.status } };
        }
        return;
      }
    }
  }

  async cancel(jobId: string): Promise<void> {
    const state = this.jobs.get(jobId);
    if (state) state.cancelled = true;
  }

  /** 主循环：LLM ↔ 工具，直到完成/失败/取消/步数上限 */
  private async runLoop(state: JobState): Promise<void> {
    const { task, status } = state;
    status.log.push({ at: now(), kind: "info", detail: `开始：${task.goal}（目录 ${task.workDir}）` });

    // 消息序列（OpenAI tool 协议）
    const messages: Array<Record<string, unknown>> = [
      { role: "system", content: SYSTEM },
      {
        role: "user",
        content: `任务目标：${task.goal}\n工作目录：${task.workDir}`,
      },
    ];

    for (let step = 0; step < this.maxSteps; step++) {
      if (state.cancelled) {
        status.state = "CANCELLED";
        return;
      }
      status.steps = step + 1;

      // 1. 调模型
      const request: LLMRequest & { tools?: ToolDef[] } = {
        model: this.model,
        messages: messages as never,
        tools: TOOLS,
      };
      status.log.push({ at: now(), kind: "llm_call", detail: `第 ${step + 1} 轮` });
      const raw = await this.callModel(request);

      // 2. 解析工具调用（兼容 tool_calls 数组与纯文本完成）
      const toolCalls = raw.tool_calls;
      if (toolCalls && toolCalls.length > 0) {
        messages.push(raw); // assistant 消息（含 tool_calls）
        for (const call of toolCalls) {
          if (state.cancelled) break;
          const result = await this.runTool(state, call);
          messages.push({
            role: "tool",
            tool_call_id: call.id,
            content: result,
          });
        }
        continue;
      }

      // 3. 无工具调用 = 完成声明
      status.state = "COMPLETED";
      status.output = String(raw.content ?? "");
      status.log.push({ at: now(), kind: "info", detail: "完成" });
      return;
    }

    status.state = "FAILED";
    status.error = `达到最大步数 ${this.maxSteps}`;
  }

  /** 模型调用（走 gateway，带 raw 返回以拿 tool_calls） */
  private async callModel(
    request: LLMRequest & { tools?: ToolDef[] },
  ): Promise<{ content?: string; tool_calls?: Array<{ id: string; function: { name: string; arguments: string } }> }> {
    const provider = this.resolveProvider();
    const res = (await provider.rawChat(request)) as {
      content?: string;
      tool_calls?: Array<{ id: string; function: { name: string; arguments: string } }>;
    };
    return res;
  }

  private resolveProvider(): { rawChat: (req: object) => Promise<unknown> } {
    const gw = this.gateway as unknown as {
      providers?: () => ReadonlyMap<string, { rawChat?: (req: object) => Promise<unknown> }>;
    };
    if (typeof gw.providers === "function") {
      for (const p of gw.providers().values()) {
        if (typeof p.rawChat === "function") {
          return p as { rawChat: (req: object) => Promise<unknown> };
        }
      }
    }
    throw new Error("gateway 无 rawChat 能力的 provider");
  }

  /** 执行单个工具调用 */
  private async runTool(
    state: JobState,
    call: { id: string; function: { name: string; arguments: string } },
  ): Promise<string> {
    const { status, task } = state;
    let args: Record<string, string>;
    try {
      args = JSON.parse(call.function.arguments || "{}") as Record<string, string>;
    } catch {
      status.log.push({ at: now(), kind: "error", detail: `参数解析失败: ${call.function.arguments}` });
      return "错误：参数不是合法 JSON";
    }
    const name = call.function.name;
    status.log.push({
      at: now(),
      kind: "tool_call",
      detail: `${name} ${name === "write_file" ? String(args.path) : name === "run_command" ? String(args.command).slice(0, 60) : JSON.stringify(args).slice(0, 60)}`,
    });

    try {
      switch (name) {
        case "read_file":
          return toolReadFile(task.workDir, String(args.path));
        case "write_file":
          return toolWriteFile(task.workDir, String(args.path), String(args.content));
        case "list_files":
          return toolListFiles(task.workDir, String(args.dir ?? "."));
        case "run_command": {
          const command = String(args.command);
          checkCommand(command);
          return await this.exec(task.workDir, command, state);
        }
        default:
          return `错误：未知工具 ${name}`;
      }
    } catch (err) {
      const msg = err instanceof ToolError ? err.message : String(err);
      status.log.push({ at: now(), kind: "error", detail: msg });
      return `错误：${msg}`;
    }
  }

  /** 白名单命令执行（cwd 限定 + 超时） */
  private exec(cwd: string, command: string, state: JobState): Promise<string> {
    return new Promise((resolve) => {
      const parts = command.trim().split(/\s+/);
      const bin = parts[0] ?? "";
      const rest = parts.slice(1);
      const child = this.spawnImpl(bin, rest, {
        cwd,
        shell: false,
        env: { ...process.env, CI: "1" },
      });
      let out = "";
      const timer = setTimeout(() => {
        child.kill("SIGKILL");
        resolve(`超时（${this.stepTimeoutMs}ms）：${out.slice(0, 2000)}`);
      }, this.stepTimeoutMs);
      child.stdout?.on("data", (d) => (out += d.toString()));
      child.stderr?.on("data", (d) => (out += d.toString()));
      child.on("error", (err) => {
        clearTimeout(timer);
        resolve(`启动失败：${err.message}`);
      });
      child.on("close", (code) => {
        clearTimeout(timer);
        void state;
        resolve(`[退出码 ${code}]\n${out.slice(0, 4000)}`);
      });
    });
  }
}

function now(): string {
  return new Date().toISOString();
}
