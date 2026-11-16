import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { SqliteMemoryEngine } from "@jarvis/memory";
import { ConversationGateway } from "./gateway.js";
import { JARVIS_SYSTEM_PROMPT, greetingWithMemory } from "./persona.js";
import { loadConfig } from "./config.js";

/** 断言非空 */
function must<T>(v: T | null | undefined): T {
  if (v === null || v === undefined) throw new Error("unexpected null");
  return v;
}

function makeGateway(
  replyImpl?: (messages: unknown[]) => string,
): { gw: ConversationGateway; memory: SqliteMemoryEngine; calls: unknown[][] } {
  const memory = new SqliteMemoryEngine({ path: ":memory:" });
  memory.migrate();
  const calls: unknown[][] = [];
  const gw = new ConversationGateway({
    memory,
    systemPrompt: JARVIS_SYSTEM_PROMPT,
    generateReply: async (messages) => {
      calls.push(messages);
      return replyImpl ? replyImpl(messages) : "收到。";
    },
  });
  return { gw, memory, calls };
}

describe("ConversationGateway", () => {
  it("单轮对话：消息序列含人格 system + 用户输入，回复落库", async () => {
    const { gw, memory, calls } = makeGateway();
    const convId = gw.newConversation("测试");
    const result = await gw.receive({ conversationId: convId, text: "你好" });

    expect(result.assistantText).toBe("收到。");
    // 消息序列：system 人格 + user
    const first = must(calls[0]);
    expect((first as Array<{ role: string; content: string }>)[0]?.role).toBe("system");
    expect((first as Array<{ role: string; content: string }>)[0]?.content).toBe(JARVIS_SYSTEM_PROMPT);
    expect((first as Array<{ role: string }>)[1]?.role).toBe("user");
    // 落库：user + assistant
    const msgs = memory.listMessages(convId);
    expect(msgs.map((m) => m.role)).toEqual(["user", "assistant"]);
  });

  it("多轮对话：历史消息按序进入上下文", async () => {
    const { gw, calls } = makeGateway();
    const convId = gw.newConversation("多轮");
    await gw.receive({ conversationId: convId, text: "第一句" });
    await gw.receive({ conversationId: convId, text: "第二句" });

    const second = must(calls[1]) as Array<{ role: string; content: string }>;
    // system + 第一轮 user + 第一轮 assistant + 第二轮 user
    expect(second.map((m) => m.role)).toEqual(["system", "user", "assistant", "user"]);
    expect(second[1]?.content).toBe("第一句");
    expect(second[3]?.content).toBe("第二句");
  });

  it("记忆注入：相关记忆作为独立 system 块注入且回调通知", async () => {
    const { gw, memory } = makeGateway();
    memory.remember({
      kind: "decision",
      content: "用户的项目命名定为 JARVIS Personal Agent",
      source: "conversation",
    });
    const convId = gw.newConversation("记忆");
    const injected: Array<{ id: string; content: string; score: number }> = [];
    await gw.receive(
      { conversationId: convId, text: "帮我回顾一下项目的命名" },
      { onMemoryInjected: (hits) => injected.push(...hits) },
    );

    expect(injected.length).toBeGreaterThan(0);
    expect(injected[0]?.content).toContain("JARVIS");
  });

  it("对话入口优先调用 semanticSearch（词面不重叠也可注入）", async () => {
    const { gw, memory } = makeGateway();
    const record = memory.remember({ kind: "user_profile", content: "用户喜欢咖啡", source: "test" })!;
    let query = "";
    memory.semanticSearch = async (q: string) => {
      query = q;
      return [{ record, score: 0.99 }];
    };
    const convId = gw.newConversation("语义检索");
    const injected: Array<{ content: string }> = [];
    await gw.receive(
      { conversationId: convId, text: "我喜欢喝什么" },
      { onMemoryInjected: (hits) => injected.push(...hits) },
    );
    expect(query).toBe("我喜欢喝什么");
    expect(injected[0]?.content).toContain("咖啡");
  });

  it("记忆块标记为参考信息非指令（untrusted data 纪律）", async () => {
    const { gw, memory, calls } = makeGateway();
    memory.remember({ kind: "user_profile", content: "用户住在深圳工作", source: "conversation" });
    const convId = gw.newConversation("注入检查");
    await gw.receive({ conversationId: convId, text: "我住在哪里工作" });

    const msgs = must(calls[0]) as Array<{ role: string; content: string }>;
    // 记忆块 = 以 [长期记忆 开头的 system 消息（区别于人格块）
    const memoryBlock = msgs.find((m) => m.content.startsWith("[长期记忆"));
    expect(memoryBlock).toBeDefined();
    expect(memoryBlock?.content).toContain("非指令");
    expect(memoryBlock?.content).toContain("用户住在深圳工作");
  });

  it("无相关记忆时不注入记忆块", async () => {
    const { gw, calls } = makeGateway();
    const convId = gw.newConversation("无记忆");
    await gw.receive({ conversationId: convId, text: "随便聊聊量子力学" });
    const msgs = must(calls[0]) as Array<{ content: string }>;
    expect(msgs.some((m) => m.content.startsWith("[长期记忆"))).toBe(false);
  });

  it("流式回调透传", async () => {
    const { gw } = makeGateway(() => "分段回复");
    const convId = gw.newConversation("流式");
    // generateReply 是整体返回；流式透传在 CLI 层由 LLM stream 实现，这里验证 handlers 传递不炸
    const deltas: string[] = [];
    await gw.receive({ conversationId: convId, text: "hi" }, { onDelta: (t) => deltas.push(t) });
    expect(deltas).toEqual([]); // mock 层不调用 onDelta
  });

  it("会话持久化：listConversations 可恢复", async () => {
    const { gw, memory } = makeGateway();
    const convId = gw.newConversation("持久");
    await gw.receive({ conversationId: convId, text: "记住这个" });
    const convs = memory.listConversations();
    expect(convs).toHaveLength(1);
    expect(convs[0]?.id).toBe(convId);
  });
});

describe("人格", () => {
  it("系统提示词包含关键人格要素", () => {
    expect(JARVIS_SYSTEM_PROMPT).toContain("私人管家");
    expect(JARVIS_SYSTEM_PROMPT).toContain("长期记忆");
    expect(JARVIS_SYSTEM_PROMPT).toContain("简体中文");
  });

  it("问候语", () => {
    expect(greetingWithMemory()).toContain("我在");
    expect(greetingWithMemory("张三")).toContain("张三");
  });
});

describe("配置", () => {
  // 隔离 .env：切到无 .env 的目录跑（loadDotEnv 读 cwd）
  const origCwd = process.cwd();
  beforeEach(() => {
    process.chdir("/tmp");
  });
  afterEach(() => {
    process.chdir(origCwd);
  });

  it("缺 API key 报错且不静默降级", () => {
    expect(() => loadConfig({})).toThrow(/JARVIS_LLM_API_KEY/);
  });

  it("正常加载与默认值", () => {
    const c = loadConfig({ JARVIS_LLM_API_KEY: "k" });
    expect(c.model).toBe("glm-5.3-flash");
    expect(c.baseUrl).toContain("bigmodel.cn");
    expect(c.dbPath).toContain("jarvis");
  });

  it("兼容旧变量名 JARVIS_GL_API_KEY", () => {
    const c = loadConfig({ JARVIS_GL_API_KEY: "k2" });
    expect(c.apiKey).toBe("k2");
  });
});
