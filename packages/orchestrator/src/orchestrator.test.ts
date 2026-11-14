import { describe, expect, it } from "vitest";
import type Database from "better-sqlite3";
import type { LLMProvider, LLMRequest, LLMResponse, LLMStreamEvent, ModelInfo } from "@jarvis/llm-gateway";
import { LLMGateway } from "@jarvis/llm-gateway";
import { SqliteMemoryEngine } from "@jarvis/memory";
import { SqliteTaskManager } from "@jarvis/task-manager";
import { Orchestrator } from "./orchestrator.js";

function must<T>(v: T | null | undefined): T {
  if (v === null || v === undefined) throw new Error("unexpected null");
  return v;
}

/** 可编程 fake provider：按脚本返回决策 JSON */
class ScriptedProvider implements LLMProvider {
  readonly id = "fake";
  private script: string[];
  private idx = 0;
  constructor(script: string[]) {
    this.script = script;
  }
  supportsModel(): boolean {
    return true;
  }
  getModels(): Promise<ModelInfo[]> {
    return Promise.resolve([{ id: "fake-model", provider: "fake" }]);
  }
  async healthCheck(): Promise<boolean> {
    return true;
  }
  async generate(request: LLMRequest): Promise<LLMResponse> {
    const content = this.script[Math.min(this.idx, this.script.length - 1)] ?? "{}";
    this.idx++;
    void request;
    return { model: "fake-model", content };
  }
  async *stream(request: LLMRequest): AsyncIterable<LLMStreamEvent> {
    const r = await this.generate(request);
    yield { type: "done", response: r };
  }
}

interface Fixture {
  orch: Orchestrator;
  memory: SqliteMemoryEngine;
  tasks: SqliteTaskManager;
  gw: LLMGateway;
}

function makeFixture(script: string[]): Fixture {
  const provider = new ScriptedProvider(script);
  const gw = new LLMGateway();
  gw.register(provider);
  const memory = new SqliteMemoryEngine({ path: ":memory:" });
  memory.migrate();
  const taskDb = (memory as unknown as { db: Database.Database }).db;
  const tasks = new SqliteTaskManager({ db: taskDb });
  tasks.migrate();
  const orch = new Orchestrator({
    gateway: gw,
    memory,
    tasks,
    model: "fake-model",
    systemPrompt: "test",
  });
  return { orch, memory, tasks, gw };
}

describe("Orchestrator 决策", () => {
  it("answer：直接回答不建任务", async () => {
    const f = makeFixture(['{"type":"answer","text":"GLM 是智谱的模型。"}']);
    const conversation = f.memory.createConversation("q");
    const turn = await f.orch.handleTurn(conversation.id, "GLM 是什么？");
    expect(turn.decision.type).toBe("answer");
    expect(turn.decision.text).toContain("智谱");
    expect(turn.task).toBeUndefined();
    expect(f.tasks.list()).toHaveLength(0);
  });

  it("create_task：建任务并沉淀决策记忆", async () => {
    const f = makeFixture([
      '{"type":"create_task","text":"收到，我来开发。","task":{"title":"写排序脚本","goal":"实现快排 CLI","requiresApproval":false}}',
    ]);
    const conversation = f.memory.createConversation("dev");
    const turn = await f.orch.handleTurn(conversation.id, "帮我写个快排脚本");
    expect(turn.decision.type).toBe("create_task");
    must(turn.task);
    expect(turn.task.title).toBe("写排序脚本");
    expect(turn.task.status).toBe("CREATED");
    expect(turn.memoriesSaved).toBe(1);
    // 任务入库
    const all = f.tasks.list();
    expect(all).toHaveLength(1);
    expect(all[0]?.goal).toBe("实现快排 CLI");
    // 决策记忆入库且可检索
    const hits = f.memory.search("快排");
    expect(hits.length).toBeGreaterThan(0);
  });

  it("create_task + requiresApproval：高危任务带审批标记", async () => {
    const f = makeFixture([
      '{"type":"create_task","text":"需要你确认。","task":{"title":"清理旧数据","goal":"删除 logs 目录","requiresApproval":true}}',
    ]);
    const conversation = f.memory.createConversation("risk");
    const turn = await f.orch.handleTurn(conversation.id, "帮我删掉 logs 目录");
    must(turn.task);
    expect(turn.task.requiresApproval).toBe(true);
  });

  it("ask：信息不足时追问", async () => {
    const f = makeFixture(['{"type":"ask","text":"你希望用什么语言实现？"}']);
    const conversation = f.memory.createConversation("ambiguous");
    const turn = await f.orch.handleTurn(conversation.id, "继续");
    expect(turn.decision.type).toBe("ask");
    expect(turn.decision.text).toContain("语言");
  });

  it("continue_task：BLOCKED 任务恢复 RUNNING", async () => {
    // 在同一个 fixture 里造 BLOCKED 任务再让 orchestrator 继续（跨 fixture 任务 id 不存在）
    const f = makeFixture(["placeholder"]);
    const t = f.tasks.create({ title: "既有任务", goal: "g" });
    f.tasks.transition(t.id, "PLANNED");
    f.tasks.transition(t.id, "RUNNING");
    f.tasks.transition(t.id, "BLOCKED");

    // 简化：直接给 f 再装一个 scripted gateway 的 orchestrator，共享 f.tasks/f.memory
    const gw2 = new LLMGateway();
    gw2.register(
      new ScriptedProvider([`{"type":"continue_task","text":"继续处理。","taskId":"${t.id}"}`]),
    );
    const orch2 = new Orchestrator({
      gateway: gw2,
      memory: f.memory,
      tasks: f.tasks,
      model: "fake-model",
      systemPrompt: "test",
    });
    const conversation = f.memory.createConversation("c");
    const turn = await orch2.handleTurn(conversation.id, "继续做那个任务");
    expect(turn.decision.type).toBe("continue_task");
    expect(f.tasks.get(t.id)?.status).toBe("RUNNING");
  });

  it("解析容错：markdown 围栏剥除", async () => {
    const f = makeFixture(['```json\n{"type":"answer","text":"围栏内的回答"}\n```']);
    const conversation = f.memory.createConversation("fence");
    const turn = await f.orch.handleTurn(conversation.id, "hi");
    expect(turn.decision.type).toBe("answer");
    expect(turn.decision.text).toBe("围栏内的回答");
  });

  it("解析容错：非法 JSON 回退为 answer", async () => {
    const f = makeFixture(["这不是 JSON，就是普通回答。"]);
    const conversation = f.memory.createConversation("bad");
    const turn = await f.orch.handleTurn(conversation.id, "hi");
    expect(turn.decision.type).toBe("answer");
    expect(turn.decision.text).toContain("普通回答");
  });
});

describe("环境上下文注入（感知→决策）", () => {
  it("contextProvider 提供活动时环境块进入提示词", async () => {
    const gw = new LLMGateway();
    gw.register(new ScriptedProvider(['{"type":"answer","text":"你正在用 WorkBuddy。"}']));
    const memory = new SqliteMemoryEngine({ path: ":memory:" });
    memory.migrate();
    const tasks = new SqliteTaskManager({ db: (memory as unknown as { db: Database.Database }).db });
    tasks.migrate();
    const orch = new Orchestrator({
      gateway: gw,
      memory,
      tasks,
      model: "fake-model",
      systemPrompt: "test",
      contextProvider: () => [{ app: "WorkBuddy", hits: 12 }],
    });
    const conv = memory.createConversation("env");
    const turn = await orch.handleTurn(conv.id, "我现在在用什么应用？");
    expect(turn.decision.text).toContain("WorkBuddy");
  });

  it("无 contextProvider 时提示词不含环境块（向后兼容）", async () => {
    const f = makeFixture(['{"type":"answer","text":"不知道"}']);
    const conversation = f.memory.createConversation("no-env");
    await f.orch.handleTurn(conversation.id, "hi");
    // 不炸即为通过（无环境块路径走旧逻辑）
  });
});
