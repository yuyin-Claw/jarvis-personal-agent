import { describe, expect, it, vi } from "vitest";
import { createOllamaDistiller, createOllamaWikiWriter, createOllamaConflictJudge, withDistillerFallback } from "./memory-local.js";

describe("Ollama 本地记忆蒸馏", () => {
  it("使用 JSON Schema、非思考和完成后卸载模型", async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({
      message: { content: '[{"kind":"user_profile","content":"用户喜欢咖啡","confidence":0.95}]' },
    }), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    const distill = createOllamaDistiller({ baseUrl: "http://guest.test:11434" });
    const result = await distill("测试对话");
    expect(result).toContain("用户喜欢咖啡");
    expect(fetchMock.mock.calls[0]![0]).toBe("http://guest.test:11434/api/chat");
    const init = fetchMock.mock.calls[0]![1] as RequestInit;
    const body = JSON.parse(String(init.body));
    expect(body).toMatchObject({ model: "qwen3:4b", stream: false, think: false, keep_alive: 0 });
    expect(body.format.type).toBe("array");
    expect(body.format.items.required).toEqual(["kind", "content", "confidence"]);
    vi.unstubAllGlobals();
  });

  it("Wiki writer 以 JSON Schema 三段生成并组装 Markdown，完成后卸载", async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({
      message: { content: JSON.stringify({ currentFocus: ["mem_1"], decisions: ["mem_2"], preferences: ["mem_3"] }) },
    }), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    const write = createOllamaWikiWriter({ baseUrl: "http://guest.test:11434" });
    const result = await write("[mem_1] (project) 本地记忆\n[mem_2] (decision) 使用 Omarchy\n[mem_3] (user_profile) 咖啡");
    expect(result).toContain("## 当前重点\n- 本地记忆");
    expect(result).toContain("## 关键决策\n- 使用 Omarchy");
    const init = fetchMock.mock.calls[0]![1] as RequestInit;
    const body = JSON.parse(String(init.body));
    expect(body.keep_alive).toBe(0);
    expect(body.think).toBe(false);
    expect(body.options.num_predict).toBe(400);
    expect(body.format.type).toBe("object");
    expect(body.format.required).toEqual(["currentFocus", "decisions", "preferences"]);
    vi.unstubAllGlobals();
  });

  it("Wiki writer 拒绝无效 memory id，避免概览改写事实", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({
      message: { content: JSON.stringify({ currentFocus: ["mem_fake"], decisions: [], preferences: [] }) },
    }), { status: 200 })));
    const write = createOllamaWikiWriter();
    await expect(write("[mem_real] (project) 原始事实")).rejects.toThrow("无效 memory id");
    vi.unstubAllGlobals();
  });

  it("冲突 judge 使用 ID 对 JSON Schema 并完成后卸载", async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({
      message: { content: '[{"ids":["mem_1","mem_2"],"conflict":true}]' },
    }), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    const judge = createOllamaConflictJudge();
    expect(await judge("记忆对")).toContain("conflict");
    const init = fetchMock.mock.calls[0]![1] as RequestInit;
    const body = JSON.parse(String(init.body));
    expect(body.format.type).toBe("array");
    expect(body.format.items.required).toEqual(["ids", "conflict"]);
    expect(body.keep_alive).toBe(0);
    vi.unstubAllGlobals();
  });

  it("本地失败时调用 GLM fallback 并报告原因", async () => {
    const errors: string[] = [];
    const local = async () => { throw new Error("模型不可用"); };
    const fallback = async (prompt: string) => `GLM:${prompt}`;
    const distill = withDistillerFallback(local, fallback, (e) => errors.push(e.message));
    expect(await distill("对话")).toBe("GLM:对话");
    expect(errors).toEqual(["模型不可用"]);
  });
});
