import { beforeEach, describe, expect, it, vi } from "vitest";
import { MemoryDistiller } from "./distiller.js";
import { cosineSimilarity, OllamaEmbeddingProvider, OpenAIEmbeddingProvider, type EmbeddingProvider } from "./embedding.js";
import { SqliteMemoryEngine } from "./sqlite-engine.js";

class MockEmbedding implements EmbeddingProvider {
  readonly model = "mock-v1";
  async embed(texts: string[]): Promise<number[][]> {
    return texts.map((text) => {
      if (text.includes("咖啡") || text.includes("喝")) return [1, 0];
      if (text.includes("GLM") || text.includes("技术栈")) return [0, 1];
      return [0.5, 0.5];
    });
  }
}

let engine: SqliteMemoryEngine;
beforeEach(() => {
  engine = new SqliteMemoryEngine({ path: ":memory:", embedding: new MockEmbedding() });
  engine.migrate();
});

describe("语义向量检索", () => {
  it("词面不重叠也能按语义召回，并与词法分混合", async () => {
    await engine.rememberSemantic({ kind: "user_profile", content: "用户喜欢咖啡", source: "conversation" });
    await engine.rememberSemantic({ kind: "project", content: "JARVIS 使用 GLM 作为模型", source: "conversation" });
    const hits = await engine.semanticSearch("我喜欢喝什么");
    expect(hits.length).toBeGreaterThan(0);
    expect(hits[0]!.record.content).toContain("咖啡");
  });

  it("无 provider 时自动降级现有词法检索", () => {
    const lexical = new SqliteMemoryEngine({ path: ":memory:" });
    lexical.migrate();
    lexical.remember({ kind: "project", content: "JARVIS 使用 GLM", source: "test" });
    expect(lexical.search("GLM")[0]?.record.content).toContain("GLM");
  });

  it("embedding 服务失败不丢记忆，写入与检索均降级词法", async () => {
    const failing: EmbeddingProvider = {
      model: "failing",
      embed: async () => { throw new Error("HTTP 429 余额不足"); },
    };
    const degraded = new SqliteMemoryEngine({ path: ":memory:", embedding: failing });
    degraded.migrate();
    const record = await degraded.rememberSemantic({ kind: "user_profile", content: "用户喜欢咖啡", source: "test" });
    expect(record?.content).toContain("咖啡");
    expect((await degraded.semanticSearch("咖啡"))[0]?.record.content).toContain("咖啡");
  });

  it("编辑使旧向量失效，reindexAll 可重建", async () => {
    const record = await engine.rememberSemantic({ kind: "user_profile", content: "用户喜欢咖啡", source: "test" });
    engine.update(record!.id, "用户喜欢喝茶");
    expect(await engine.reindexAll()).toBe(1);
  });

  it("cosineSimilarity 计算正交与同向向量", () => {
    expect(cosineSimilarity([1, 0], [1, 0])).toBe(1);
    expect(cosineSimilarity([1, 0], [0, 1])).toBe(0);
  });

  it("Ollama provider 使用原生 /api/embed 并保留完整向量", async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({
      embeddings: [[1, 0, 0], [0, 1, 0]],
    }), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    const provider = new OllamaEmbeddingProvider({ baseUrl: "http://guest.test:11434" });
    expect(await provider.embed(["甲", "乙"])).toEqual([[1, 0, 0], [0, 1, 0]]);
    expect(fetchMock.mock.calls[0]![0]).toBe("http://guest.test:11434/api/embed");
    const init = fetchMock.mock.calls[0]![1] as RequestInit;
    expect(JSON.parse(String(init.body))).toEqual({ model: "qwen3-embedding:0.6b", input: ["甲", "乙"] });
    vi.unstubAllGlobals();
  });

  it("OpenAI provider 使用官方 embeddings 契约并按 index 恢复顺序", async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({
      data: [
        { index: 1, embedding: [0, 1] },
        { index: 0, embedding: [1, 0] },
      ],
    }), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    const provider = new OpenAIEmbeddingProvider({ baseUrl: "https://example.test/v4", apiKey: "secret", dimensions: 256 });
    expect(await provider.embed(["甲", "乙"])).toEqual([[1, 0], [0, 1]]);
    const init = fetchMock.mock.calls[0]![1] as RequestInit;
    expect(fetchMock.mock.calls[0]![0]).toBe("https://example.test/v4/embeddings");
    expect(JSON.parse(String(init.body))).toMatchObject({ model: "embedding-3", input: ["甲", "乙"], dimensions: 256 });
    vi.unstubAllGlobals();
  });
});

describe("对话增量蒸馏", () => {
  it("敏感消息不送 LLM，成功后推进水位线，新增消息再次蒸馏", async () => {
    const conv = engine.createConversation("偏好");
    engine.appendMessage(conv.id, "user", "我喜欢咖啡");
    engine.appendMessage(conv.id, "assistant", "JARVIS 决定使用 GLM");
    const sensitive = engine.appendMessage(conv.id, "user", "密码：abc123");
    const prompts: string[] = [];
    const distiller = new MemoryDistiller(engine, async (prompt) => {
      prompts.push(prompt);
      return JSON.stringify([
        { kind: "user_profile", content: "用户喜欢咖啡", confidence: 0.95 },
        { kind: "decision", content: "JARVIS 决定使用 GLM", confidence: 0.9 },
      ]);
    });
    const first = await distiller.distillConversation(conv.id);
    expect(first.records).toHaveLength(2);
    expect(first.skippedSensitive).toBe(1);
    expect(first.watermark).toBe(sensitive.id);
    expect(prompts[0]).not.toContain("abc123");

    expect((await distiller.distillConversation(conv.id)).records).toHaveLength(0);
    expect(prompts).toHaveLength(1);

    engine.appendMessage(conv.id, "user", "下周完成向量检索");
    const third = await distiller.distillConversation(conv.id);
    expect(third.records).toHaveLength(2); // mock 仍返回两条候选，验证新批次确实执行
    expect(prompts).toHaveLength(2);
  });

  it("蒸馏响应异常时不推进水位线，可重试", async () => {
    const conv = engine.createConversation("重试");
    engine.appendMessage(conv.id, "user", "喜欢咖啡");
    let calls = 0;
    const distiller = new MemoryDistiller(engine, async () => {
      calls++;
      return calls === 1 ? "not json" : `[{"kind":"user_profile","content":"用户喜欢咖啡","confidence":0.9}]`;
    });
    await expect(distiller.distillConversation(conv.id)).rejects.toThrow("JSON 数组");
    expect(engine.getDistilledMessageId(conv.id)).toBeUndefined();
    expect((await distiller.distillConversation(conv.id)).records).toHaveLength(1);
  });
});
