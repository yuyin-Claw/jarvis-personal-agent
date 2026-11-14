/**
 * Central Orchestrator（PRD FR-02 / 架构 §3.3）
 *
 * 中央决策器：Receive Input → Load Context → Understand Intent → Decide Action
 *   → Answer Directly / Ask User / Start Task / Continue Task → Verify → Memory Update → Communicate
 *
 * 0.1 决策用结构化输出（LLM 判定意图），有限状态工作流，不允许模型无限循环调工具。
 */
import type { ChatMessage, LLMGateway } from "@jarvis/llm-gateway";
import type { MemoryEngine } from "@jarvis/memory";
import type { AgentTask, TaskManager } from "@jarvis/task-manager";

/** 决策类型（架构 §3.3 Decide Action 分支） */
export type DecisionType =
  | "answer" // 直接回答（无需任务）
  | "ask" // 追问用户（信息不足）
  | "create_task" // 创建任务委派 Harness（0.1 尚无 Harness 时也可建任务挂起）
  | "continue_task"; // 继续既有任务

export interface Decision {
  type: DecisionType;
  /** answer：回答正文；ask：追问内容 */
  text: string;
  /** create_task 时 */
  task?: { title: string; goal: string; requiresApproval: boolean };
  /** continue_task 时 */
  taskId?: string;
}

/** 单轮处理产出 */
export interface OrchestratorTurn {
  decision: Decision;
  /** 若产生了任务 */
  task?: AgentTask;
  /** 本轮沉淀的记忆条数 */
  memoriesSaved: number;
}

export interface OrchestratorOptions {
  gateway: LLMGateway;
  memory: MemoryEngine;
  tasks: TaskManager;
  model: string;
  systemPrompt: string;
}

/** 意图判定提示词（严格 JSON 输出） */
function intentPrompt(userText: string, openTasks: AgentTask[]): string {
  const openList =
    openTasks.length === 0
      ? "（无进行中任务）"
      : openTasks
          .slice(0, 5)
          .map((t) => `- ${t.id}: ${t.title}（${t.status}）`)
          .join("\n");
  return `分析用户输入，决定下一步动作。只输出 JSON，不要输出其他内容。

进行中任务：
${openList}

用户输入：「${userText}」

输出格式：
{"type":"answer","text":"..."}                        — 直接回答（问答/闲聊/查询）
{"type":"ask","text":"..."}                           — 追问（信息不足以行动，一次最多 1-2 个问题）
{"type":"create_task","text":"...","task":{"title":"...","goal":"...","requiresApproval":false}} — 委派开发/执行类工作
{"type":"continue_task","text":"...","taskId":"..."}  — 用户想继续上述进行中任务之一

判断规则：
- 涉及删除、支付、系统级变更、发送给他人 → requiresApproval=true
- 模糊指代（"继续"、"刚才那个"）且无进行中任务 → ask 澄清
- text 字段始终是面向用户的话（中文）`;
}

export class Orchestrator {
  private readonly gateway: LLMGateway;
  private readonly memory: MemoryEngine;
  private readonly tasks: TaskManager;
  private readonly model: string;
  private readonly systemPrompt: string;

  constructor(opts: OrchestratorOptions) {
    this.gateway = opts.gateway;
    this.memory = opts.memory;
    this.tasks = opts.tasks;
    this.model = opts.model;
    this.systemPrompt = opts.systemPrompt;
  }

  /** 主决策循环（每轮一次 LLM 意图判定；有限，无循环工具调用） */
  async handleTurn(conversationId: string, userText: string): Promise<OrchestratorTurn> {
    // 1. Load context：检索记忆 + 进行中任务（记忆注入已由 ConversationGateway 负责，
    //    此处检索供后续 Memory Update 参考）
    const _memoryHits = this.memory.search(userText, { limit: 5 });
    const openTasks = this.tasks.list().filter(
      (t) => !["COMPLETED", "FAILED", "CANCELLED"].includes(t.status),
    );

    // 2. Understand intent（结构化输出）
    const messages: ChatMessage[] = [
      { role: "system", content: this.systemPrompt },
    ];
    for (const m of this.memory.listMessages(conversationId).slice(-10)) {
      messages.push({ role: m.role === "system" ? "system" : m.role, content: m.content });
    }
    messages.push({ role: "user", content: intentPrompt(userText, openTasks) });

    const res = await this.gateway.generate({ model: this.model, messages });
    const decision = this.parseDecision(res.content);

    // 3. Execute
    let task: AgentTask | undefined;
    if (decision.type === "create_task" && decision.task) {
      task = this.tasks.create({
        title: decision.task.title,
        goal: decision.task.goal,
        requiresApproval: decision.task.requiresApproval,
        contextRefs: [conversationId],
      });
    } else if (decision.type === "continue_task" && decision.taskId) {
      const t = this.tasks.get(decision.taskId);
      if (t) {
        if (t.status === "BLOCKED") this.tasks.transition(t.id, "RUNNING");
        task = t;
      }
    }

    // 4. Memory update（决策沉淀）
    let memoriesSaved = 0;
    if (task) {
      const rec = this.memory.remember({
        kind: "decision",
        content: `创建任务「${task.title}」：${task.goal}`,
        source: "conversation",
        sourceRef: conversationId,
      });
      if (rec) memoriesSaved++;
    }

    return { decision, task, memoriesSaved };
  }

  /** 解析模型输出为 Decision（容错：剥 markdown 围栏、截 JSON 对象） */
  private parseDecision(raw: string): Decision {
    let text = raw.trim();
    const fence = text.match(/```(?:json)?\s*([\s\S]*?)```/);
    if (fence?.[1]) text = fence[1].trim();
    const start = text.indexOf("{");
    const end = text.lastIndexOf("}");
    if (start === -1 || end === -1 || end <= start) {
      return { type: "answer", text: raw.trim() };
    }
    try {
      const obj = JSON.parse(text.slice(start, end + 1)) as {
        type?: string;
        text?: string;
        taskId?: string;
        task?: { title?: string; goal?: string; requiresApproval?: boolean };
      };
      switch (obj.type) {
        case "answer":
        case "ask":
          return { type: obj.type, text: String(obj.text ?? "") };
        case "create_task": {
          const t = obj.task ?? {};
          return {
            type: "create_task",
            text: String(obj.text ?? "已创建任务。"),
            task: {
              title: t.title ?? "未命名任务",
              goal: t.goal ?? "",
              requiresApproval: Boolean(t.requiresApproval),
            },
          };
        }
        case "continue_task":
          return {
            type: "continue_task",
            text: String(obj.text ?? "继续该任务。"),
            taskId: obj.taskId ? String(obj.taskId) : undefined,
          };
        default:
          return { type: "answer", text: raw.trim() };
      }
    } catch {
      return { type: "answer", text: raw.trim() };
    }
  }
}
