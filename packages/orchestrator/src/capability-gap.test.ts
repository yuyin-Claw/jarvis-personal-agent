import { describe, expect, it, vi } from "vitest";
import { Orchestrator } from "./orchestrator.js";
import type { LLMGateway, ChatMessage } from "@jarvis/llm-gateway";
import type { MemoryEngine } from "@jarvis/memory";
import type { TaskManager } from "@jarvis/task-manager";

/**
 * capability_gap 分支测试（ADR-011 · 0.4 Step 4.2）
 * - LLM 判定 gap → Decision 带 gap 报告（need/kind/name）
 * - 无 capabilitiesProvider 时不注入能力清单段（向后兼容）
 * - 已有能力覆盖场景由提示词约束（模型行为），此处验证供给链路
 */

function makeOrchestrator(reply: string, caps?: Array<{ name: string; kind: string; description: string; enabled: boolean }>) {
  const gateway: LLMGateway = {
    generate: vi.fn(async () => ({ content: reply, model: "test", usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 } })),
    listModels: vi.fn(async () => []),
    chat: vi.fn(async () => ({ content: reply })),
  } as unknown as LLMGateway;
  const memory: MemoryEngine = {
    remember: vi.fn(() => null),
    search: vi.fn(() => []),
    listMessages: vi.fn(() => []),
    addMessage: vi.fn(),
  } as unknown as MemoryEngine;
  const tasks: TaskManager = {
    create: vi.fn(), get: vi.fn(), list: vi.fn(() => []),
    transition: vi.fn(), prune: vi.fn(async () => 0),
  } as unknown as TaskManager;
  return {
    orch: new Orchestrator({
      gateway, memory, tasks,
      model: "glm-4.7", systemPrompt: "test",
      ...(caps ? { capabilitiesProvider: () => caps } : {}),
    }),
    gateway,
  };
}

describe("capability_gap 分支", () => {
  it("模型输出 gap JSON → Decision 携带缺口报告", async () => {
    const { orch } = makeOrchestrator(
      JSON.stringify({
        type: "capability_gap",
        text: "我还不会清理浏览器缓存，需要先开发这个能力。",
        gap: { need: "清理 Chrome 浏览器缓存", suggestedKind: "skill", suggestedName: "chrome-cache-clean" },
      }),
    );
    const turn = await orch.handleTurn("c1", "帮我清理浏览器缓存");
    expect(turn.decision.type).toBe("capability_gap");
    expect(turn.decision.gap).toEqual({
      need: "清理 Chrome 浏览器缓存",
      suggestedKind: "skill",
      suggestedName: "chrome-cache-clean",
    });
  });

  it("gap 缺字段时用原始用户输入兜底 need", async () => {
    const { orch } = makeOrchestrator('{"type":"capability_gap","text":"..."}');
    const turn = await orch.handleTurn("c1", "帮我把屏幕调成夜间模式");
    expect(turn.decision.type).toBe("capability_gap");
    expect(turn.decision.gap?.need).toBe("帮我把屏幕调成夜间模式");
    expect(turn.decision.gap?.suggestedKind).toBe("skill");
  });

  it("capabilitiesProvider 存在时提示词包含能力清单", async () => {
    const { orch, gateway } = makeOrchestrator('{"type":"answer","text":"好的"}', [
      { name: "sysinfo", kind: "skill", description: "系统信息", enabled: true },
    ]);
    await orch.handleTurn("c1", "看看系统状态");
    const call = (gateway.generate as ReturnType<typeof vi.fn>).mock.calls[0][0] as { messages: ChatMessage[] };
    const prompt = call.messages.at(-1)?.content ?? "";
    expect(prompt).toContain("sysinfo");
    expect(prompt).toContain("已注册能力");
  });

  it("无 provider 时提示词不含能力实例（向后兼容；格式说明文字除外）", async () => {
    const { orch, gateway } = makeOrchestrator('{"type":"answer","text":"嗯"}', [
      { name: "sysinfo", kind: "skill", description: "系统信息", enabled: true },
    ]);
    await orch.handleTurn("c1", "你好");
    const withCaps = ((gateway.generate as ReturnType<typeof vi.fn>).mock.calls[0][0] as { messages: ChatMessage[] })
      .messages.at(-1)?.content ?? "";
    expect(withCaps).toMatch(/- sysinfo（skill）：系统信息/);
    // 无 provider 的对照：同一句输入不应出现能力实例行
    const bare = makeOrchestrator('{"type":"answer","text":"嗯"}');
    await bare.orch.handleTurn("c2", "你好");
    const barePrompt = ((bare.gateway.generate as ReturnType<typeof vi.fn>).mock.calls[0][0] as { messages: ChatMessage[] })
      .messages.at(-1)?.content ?? "";
    expect(barePrompt).not.toMatch(/- sysinfo（skill）/);
    expect(barePrompt).not.toContain("JARVIS 当前会做的");
  });
});
