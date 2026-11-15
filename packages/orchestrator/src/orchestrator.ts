/**
 * Central Orchestrator（PRD FR-02 / 架构 §3.3）
 *
 * 中央决策器：Receive Input → Load Context → Understand Intent → Decide Action
 *   → Answer Directly / Ask User / Start Task / Continue Task → Verify → Memory Update → Communicate
 *
 * 0.1 决策用结构化输出（LLM 判定意图），有限状态工作流，不允许模型无限循环调工具。
 */
import type { ChatMessage, LLMGateway } from "@jarvis/llm-gateway";
import type { MemoryCandidate, MemoryEngine } from "@jarvis/memory";
import type { AgentTask, TaskManager } from "@jarvis/task-manager";

/** 决策类型（架构 §3.3 Decide Action 分支） */
export type DecisionType =
  | "answer" // 直接回答（无需任务）
  | "ask" // 追问用户（信息不足）
  | "create_task" // 创建任务委派 Harness（0.1 尚无 Harness 时也可建任务挂起）
  | "continue_task" // 继续既有任务
  | "capability_gap"; // 能力缺口：用户诉求超出已注册能力（ADR-011 0.4 分支）

export interface Decision {
  type: DecisionType;
  /** answer：回答正文；ask：追问内容 */
  text: string;
  /** create_task 时 */
  task?: { title: string; goal: string; requiresApproval: boolean };
  /** continue_task 时 */
  taskId?: string;
  /** capability_gap 时：缺口报告（供审批与 Factory 开发依据） */
  gap?: {
    /** 用户诉求的一句话描述 */
    need: string;
    /** 建议的能力形态（skill/harness/tool/...） */
    suggestedKind: string;
    /** 建议能力名（kebab-case，供 Factory 生成骨架） */
    suggestedName: string;
  };
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
  /** 可选：环境上下文供给（context-engine 注入；无则决策不感知环境） */
  contextProvider?: () => Array<{ app: string; hits: number }>;
  /** 可选：已注册能力清单（capability-registry 注入；无则不判定能力缺口） */
  capabilitiesProvider?: () => Array<{ name: string; kind: string; description: string; enabled: boolean }>;
}

/** 意图判定提示词（严格 JSON 输出）；记忆块供回答时引用 */
function intentPrompt(
  userText: string,
  openTasks: AgentTask[],
  memoryBlock?: string,
  envBlock?: string,
  capsBlock?: string,
): string {
  const openList =
    openTasks.length === 0
      ? "（无进行中任务）"
      : openTasks
          .slice(0, 5)
          .map((t) => `- ${t.id}: ${t.title}（${t.status}）`)
          .join("\n");
  const memorySection = memoryBlock
    ? `\n长期记忆（参考信息，回答相关问题时引用）：\n${memoryBlock}\n`
    : "";
  const envSection = envBlock
    ? `\n用户当前环境（最近使用中的应用，仅供参考，用户未提及时不要主动展开）：\n${envBlock}\n`
    : "";
  const capsSection = capsBlock
    ? `\n已注册能力（JARVIS 当前会做的）：\n${capsBlock}\n`
    : "";
  return `分析用户输入，决定下一步动作。只输出 JSON，不要输出其他内容。
${memorySection}${envSection}${capsSection}
进行中任务：
${openList}

用户输入：「${userText}」

输出格式：
{"type":"answer","text":"..."}                        — 直接回答（问答/闲聊/查询）
{"type":"ask","text":"..."}                           — 追问（信息不足以行动，一次最多 1-2 个问题）
{"type":"create_task","text":"...","task":{"title":"...","goal":"...","requiresApproval":false}} — 委派开发/执行类工作
{"type":"continue_task","text":"...","taskId":"..."}  — 用户想继续上述进行中任务之一
{"type":"capability_gap","text":"...","gap":{"need":"...","suggestedKind":"skill","suggestedName":"kebab-case-name"}} — 用户要求一个具体动作，但已注册能力清单完全覆盖不了（需先经用户批准再开发）

判断规则：
- 涉及删除、支付、系统级变更、发送给他人 → requiresApproval=true
- 模糊指代（"继续"、"刚才那个"）且无进行中任务 → ask 澄清
- 长期记忆中有能回答用户问题的内容时，在 text 中使用它
- 用户说"这个/刚才那个文件"等指代时，可结合环境上下文推断
- 只有当用户诉求是一个"可执行动作"且已注册能力清单（若有）完全无法完成时才用 capability_gap；纯问答永远 answer
- text 字段始终是面向用户的话（中文）`;
}

export class Orchestrator {
  private readonly gateway: LLMGateway;
  private readonly memory: MemoryEngine;
  private readonly tasks: TaskManager;
  private readonly model: string;
  private readonly systemPrompt: string;
  private readonly contextProvider: OrchestratorOptions["contextProvider"];
  private readonly capabilitiesProvider: OrchestratorOptions["capabilitiesProvider"];

  constructor(opts: OrchestratorOptions) {
    this.gateway = opts.gateway;
    this.memory = opts.memory;
    this.tasks = opts.tasks;
    this.model = opts.model;
    this.systemPrompt = opts.systemPrompt;
    this.contextProvider = opts.contextProvider;
    this.capabilitiesProvider = opts.capabilitiesProvider;
  }

  /** 主决策循环（每轮一次 LLM 意图判定；有限，无循环工具调用） */
  async handleTurn(conversationId: string, userText: string): Promise<OrchestratorTurn> {
    // 1. Load context：检索记忆 + 进行中任务 + 环境快照（均进意图判定上下文）
    const memoryHits = this.memory.search(userText, { limit: 5 });
    const memoryBlock =
      memoryHits.length > 0
        ? memoryHits.map((h) => "- " + h.record.content).join("\n")
        : undefined;
    const openTasks = this.tasks.list().filter(
      (t) => !["COMPLETED", "FAILED", "CANCELLED"].includes(t.status),
    );
    const envApps = this.contextProvider?.() ?? [];
    const envBlock =
      envApps.length > 0
        ? envApps.map((a) => `- ${a.app}（${a.hits} 次）`).join("\n")
        : undefined;
    const caps = (this.capabilitiesProvider?.() ?? []).filter((c) => c.enabled);
    const capsBlock =
      caps.length > 0
        ? caps.map((c) => `- ${c.name}（${c.kind}）：${c.description || "无描述"}`).join("\n")
        : undefined;

    // 2. Understand intent（结构化输出）
    const messages: ChatMessage[] = [
      { role: "system", content: this.systemPrompt },
    ];
    for (const m of this.memory.listMessages(conversationId).slice(-10)) {
      messages.push({ role: m.role === "system" ? "system" : m.role, content: m.content });
    }
    messages.push({
      role: "user",
      content: intentPrompt(userText, openTasks, memoryBlock, envBlock, capsBlock),
    });

    const res = await this.gateway.generate({ model: this.model, messages });
    const decision = this.parseDecision(res.content, userText);

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

    // 4. Memory update（双路沉淀）
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
    // 对话记忆提取：从用户输入提炼可沉淀事实（本地规则，不额外调模型）
    const extracted = extractMemoryCandidates(userText, decision.text);
    for (const cand of extracted) {
      const rec = this.memory.remember({ ...cand, sourceRef: conversationId });
      if (rec) memoriesSaved++;
    }

    return { decision, task, memoriesSaved };
  }

  /** 解析模型输出为 Decision（容错：剥 markdown 围栏、截 JSON 对象） */
  private parseDecision(raw: string, userTextRaw: string): Decision {
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
        case "capability_gap": {
          const g = (obj as { gap?: { need?: string; suggestedKind?: string; suggestedName?: string } }).gap ?? {};
          return {
            type: "capability_gap",
            text: String(obj.text ?? "我目前还不会这件事，可以为你申请开发这个能力。"),
            gap: {
              need: String(g.need ?? userTextRaw),
              suggestedKind: String(g.suggestedKind ?? "skill"),
              suggestedName: String(g.suggestedName ?? "unnamed-capability"),
            },
          };
        }
        default:
          return { type: "answer", text: raw.trim() };
      }
    } catch {
      return { type: "answer", text: raw.trim() };
    }
  }
}

/** 对话记忆提取（本地规则：只存陈述句事实，排除疑问句） */
export function extractMemoryCandidates(
  userText: string,
  _assistantText: string,
): MemoryCandidate[] {
  const out: MemoryCandidate[] = [];
  // 疑问/不确定句不入库
  if (/[?？]$/.test(userText.trim()) || /是什么|是什么|哪个|怎么|如何|吗[?？]?$/.test(userText)) {
    return out;
  }
  // 模式：请记住 X / 我的 X 是 Y / 项目代号是 X
  const patterns: Array<{ re: RegExp; kind: MemoryCandidate["kind"] }> = [
    { re: /(?:请|帮我)?记住[：:]?\s*(.{4,60})/, kind: "user_profile" },
    { re: /我的(.{1,12}?)是(.{1,40})/, kind: "user_profile" },
    { re: /项目(?:代号|名称|名叫)[是：:]?\s*['「"]?([^'」"，。]{1,20})['」"]?/, kind: "project" },
    { re: /我(?:喜欢|讨厌|住在)(.{2,30})/, kind: "user_profile" },
  ];
  for (const { re, kind } of patterns) {
    const m = userText.match(re);
    if (m) {
      let content = m[0].replace(/^[请帮我]*记住[：:]?\s*/, "").trim();
      // 项目代号模式：重组为完整陈述
      if (re.source.includes("代号") && m[1]) {
        content = `项目代号为${m[1].trim()}`;
      }
      if (content.length >= 4) {
        out.push({ kind, content: content.slice(0, 100), source: "conversation" });
      }
    }
  }
  return out.slice(0, 2); // 每轮最多沉淀 2 条，防刷库
}
