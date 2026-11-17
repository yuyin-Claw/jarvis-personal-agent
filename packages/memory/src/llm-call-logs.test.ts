import { describe, expect, it } from "vitest";
import { SqliteMemoryEngine } from "./sqlite-engine.js";

describe("LLM 调用日志", () => {
  it("主备调用与 token 用量持久化", () => {
    const engine = new SqliteMemoryEngine({ path: ":memory:" });
    engine.migrate();
    engine.appendLLMCall({ timestamp: "2026-11-17T00:00:00Z", providerId: "zhipu", model: "glm", ok: false, durationMs: 1200, errorCode: "rate_limit" });
    engine.appendLLMCall({ timestamp: "2026-11-17T00:00:01Z", providerId: "ollama", model: "qwen3:4b", ok: true, durationMs: 500, usage: { promptTokens: 20, completionTokens: 8, totalTokens: 28 } });
    const logs = engine.listLLMCalls(10);
    expect(logs).toHaveLength(2);
    expect(logs[0]).toMatchObject({ providerId: "ollama", ok: true, usage: { totalTokens: 28 } });
    expect(logs[1]).toMatchObject({ providerId: "zhipu", ok: false, errorCode: "rate_limit" });
    engine.close();
  });
});
