import { describe, expect, it, vi } from "vitest";
import { FallbackProvider } from "./fallback.js";
import { LLMError, type LLMProvider, type LLMRequest, type LLMStreamEvent } from "./types.js";

const request: LLMRequest = { model: "glm", messages: [{ role: "user", content: "你好" }] };

function makeProvider(id: string, model: string): LLMProvider & { rawChat: ReturnType<typeof vi.fn> } {
  return {
    id,
    supportsModel: (m) => m === model,
    getModels: async () => [{ id: model, provider: id }],
    healthCheck: async () => true,
    generate: vi.fn(async () => ({ model, content: `${id}-ok` })),
    stream: async function* (): AsyncIterable<LLMStreamEvent> {
      yield { type: "done", response: { model, content: `${id}-ok` } };
    },
    rawChat: vi.fn(async () => ({ role: "assistant" as const, content: `${id}-raw` })),
  };
}

describe("FallbackProvider", () => {
  it("可重试错误切换备用模型并回调", async () => {
    const primary = makeProvider("zhipu", "glm");
    const fallback = makeProvider("ollama", "qwen3:4b");
    primary.generate = vi.fn(async () => { throw new LLMError("429", "rate_limit", 429, true); });
    const onFallback = vi.fn();
    const provider = new FallbackProvider({ primary, fallback, primaryModel: "glm", fallbackModel: "qwen3:4b", onFallback });
    expect((await provider.generate(request)).content).toBe("ollama-ok");
    expect(fallback.generate).toHaveBeenCalledWith(expect.objectContaining({ model: "qwen3:4b" }));
    expect(onFallback).toHaveBeenCalledWith(expect.any(Error), "generate");
  });

  it("鉴权/内容错误不切换", async () => {
    const primary = makeProvider("zhipu", "glm");
    const fallback = makeProvider("ollama", "qwen3:4b");
    primary.generate = vi.fn(async () => { throw new LLMError("401", "auth", 401, false); });
    const provider = new FallbackProvider({ primary, fallback, primaryModel: "glm", fallbackModel: "qwen3:4b" });
    await expect(provider.generate(request)).rejects.toMatchObject({ kind: "auth" });
    expect(fallback.generate).not.toHaveBeenCalled();
  });

  it("流式首包前失败可切换", async () => {
    const primary = makeProvider("zhipu", "glm");
    const fallback = makeProvider("ollama", "qwen3:4b");
    primary.stream = async function* () { yield { type: "error", error: new LLMError("超时", "timeout", undefined, true) }; };
    fallback.stream = async function* () {
      yield { type: "delta", text: "本地" };
      yield { type: "done", response: { model: "qwen3:4b", content: "本地" } };
    };
    const provider = new FallbackProvider({ primary, fallback, primaryModel: "glm", fallbackModel: "qwen3:4b" });
    const events = [];
    for await (const event of provider.stream(request)) events.push(event);
    expect(events.map((e) => e.type)).toEqual(["delta", "done"]);
  });

  it("流式已输出后不重放，只透传错误", async () => {
    const primary = makeProvider("zhipu", "glm");
    const fallback = makeProvider("ollama", "qwen3:4b");
    primary.stream = async function* () {
      yield { type: "delta", text: "半截" };
      yield { type: "error", error: new LLMError("断流", "network", undefined, true) };
    };
    let fallbackCalled = false;
    fallback.stream = async function* () {
      fallbackCalled = true;
      yield { type: "done", response: { model: "qwen3:4b", content: "不应出现" } };
    };
    const provider = new FallbackProvider({ primary, fallback, primaryModel: "glm", fallbackModel: "qwen3:4b" });
    const events = [];
    for await (const event of provider.stream(request)) events.push(event);
    expect(events.map((e) => e.type)).toEqual(["delta", "error"]);
    expect(fallbackCalled).toBe(false);
  });

  it("rawChat 同样支持主备切换", async () => {
    const primary = makeProvider("zhipu", "glm");
    const fallback = makeProvider("ollama", "qwen3:4b");
    primary.rawChat = vi.fn(async () => { throw new LLMError("500", "server", 500, true); });
    const provider = new FallbackProvider({ primary, fallback, primaryModel: "glm", fallbackModel: "qwen3:4b" });
    expect((await provider.rawChat(request)).content).toBe("ollama-raw");
    expect(fallback.rawChat).toHaveBeenCalledWith(expect.objectContaining({ model: "qwen3:4b" }));
  });
});
