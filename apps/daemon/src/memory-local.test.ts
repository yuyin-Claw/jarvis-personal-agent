import { describe, expect, it, vi } from "vitest";
import { createOllamaDistiller, withDistillerFallback } from "./memory-local.js";

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

  it("本地失败时调用 GLM fallback 并报告原因", async () => {
    const errors: string[] = [];
    const local = async () => { throw new Error("模型不可用"); };
    const fallback = async (prompt: string) => `GLM:${prompt}`;
    const distill = withDistillerFallback(local, fallback, (e) => errors.push(e.message));
    expect(await distill("对话")).toBe("GLM:对话");
    expect(errors).toEqual(["模型不可用"]);
  });
});
