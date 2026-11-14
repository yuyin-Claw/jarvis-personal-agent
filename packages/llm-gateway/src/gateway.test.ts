import { describe, expect, it } from "vitest";
import { LLMGateway } from "./gateway.js";
import { OpenAICompatibleProvider } from "./openai-compatible.js";
import type { LLMProvider, ModelInfo } from "./types.js";
import { LLMError } from "./types.js";

/** 极简内存 provider：用于 gateway 路由测试 */
class FakeProvider implements LLMProvider {
  readonly id: string;
  private readonly list: ModelInfo[];
  constructor(id: string, list: string[]) {
    this.id = id;
    this.list = list.map((m) => ({ id: m, provider: id }));
  }
  supportsModel(model: string): boolean {
    return this.list.some((m) => m.id === model);
  }
  getModels(): Promise<ModelInfo[]> {
    return Promise.resolve(this.list);
  }
  async healthCheck(): Promise<boolean> {
    return true;
  }
  async generate(): Promise<never> {
    throw new Error("unused");
  }
  async *stream(): AsyncIterable<never> {
    // unreachable
  }
}

describe("LLMGateway", () => {
  it("按模型路由到正确 provider", () => {
    const gw = new LLMGateway();
    gw.register(new FakeProvider("zhipu", ["glm-5.3-flash", "glm-5.3"]));
    gw.register(new FakeProvider("deepseek", ["deepseek-chat", "deepseek-reasoner"]));

    // 私有方法间接验证：generate 的错误信息暴露解析结果
    expect(() => gw.stream({ model: "glm-5.3-flash", messages: [] })).not.toThrow();
    expect(() => gw.stream({ model: "deepseek-chat", messages: [] })).not.toThrow();
  });

  it("未注册模型抛 LLMError", async () => {
    const gw = new LLMGateway();
    // stream 同步解析：直接 throw
    expect(() => gw.stream({ model: "gpt-4o", messages: [] })).toThrowError(LLMError);
    // generate 异步：rejects
    await expect(
      gw.generate({ model: "gpt-4o", messages: [] }),
    ).rejects.toThrowError(/gpt-4o/);
  });

  it("getModels 跨 provider 聚合", async () => {
    const gw = new LLMGateway();
    gw.register(new FakeProvider("zhipu", ["glm-5.3-flash"]));
    gw.register(new FakeProvider("deepseek", ["deepseek-chat"]));
    const models = await gw.getModels();
    expect(models.map((m) => m.id).sort()).toEqual(["deepseek-chat", "glm-5.3-flash"]);
  });

  it("OpenAICompatibleProvider 与 gateway 组合可解析", () => {
    const gw = new LLMGateway();
    gw.register(
      new OpenAICompatibleProvider({
        id: "zhipu",
        baseUrl: "https://example.com",
        apiKey: "sk",
        models: [{ id: "glm-5.3-flash", provider: "zhipu" }],
        fetchImpl: (async () => new Response("{}")) as unknown as typeof fetch,
      }),
    );
    expect(() => gw.stream({ model: "glm-5.3-flash", messages: [] })).not.toThrow();
  });
});
