import { describe, expect, it } from "vitest";
import { OpenAICompatibleProvider } from "./openai-compatible.js";
import { LLMError } from "./types.js";

const MODELS = [{ id: "glm-5.3-flash", provider: "zhipu" }];

/** 构造 mock fetch：按 URL/状态码可编程 */
function mockFetch(
  handler: (url: string, body: Record<string, unknown>) => Response | Promise<Response>,
) {
  return (async (url: RequestInfo | URL, init?: RequestInit) => {
    const body = init?.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : {};
    return handler(String(url), body);
  }) as unknown as typeof fetch;
}

function jsonResponse(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "content-type": "application/json" },
  });
}

/** SSE 响应 */
function sseResponse(chunks: unknown[]): Response {
  const text = chunks.map((c) => `data: ${JSON.stringify(c)}\n\n`).join("") + "data: [DONE]\n\n";
  return new Response(text, {
    status: 200,
    headers: { "content-type": "text/event-stream" },
  });
}

describe("OpenAICompatibleProvider", () => {
  it("generate: 正常返回 content 与 usage", async () => {
    const p = new OpenAICompatibleProvider({
      id: "zhipu",
      baseUrl: "https://example.com/v4",
      apiKey: "sk-test",
      models: MODELS,
      fetchImpl: mockFetch((_url, body) => {
        expect(body.model).toBe("glm-5.3-flash");
        return jsonResponse({
          model: "glm-5.3-flash",
          choices: [{ message: { content: "你好" }, finish_reason: "stop" }],
          usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
        });
      }),
    });

    const res = await p.generate({
      model: "glm-5.3-flash",
      messages: [{ role: "user", content: "hi" }],
    });
    expect(res.content).toBe("你好");
    expect(res.usage?.totalTokens).toBe(15);
  });

  it("generate: 401 抛 auth 错误且不可重试", async () => {
    const p = new OpenAICompatibleProvider({
      id: "zhipu",
      baseUrl: "https://example.com/v4",
      apiKey: "bad",
      models: MODELS,
      fetchImpl: mockFetch(() => jsonResponse({ error: "unauthorized" }, 401)),
    });
    await expect(
      p.generate({ model: "glm-5.3-flash", messages: [{ role: "user", content: "x" }] }),
    ).rejects.toMatchObject({ name: "LLMError", kind: "auth", retryable: false });
  });

  it("generate: 429 抛 rate_limit 且可重试", async () => {
    const p = new OpenAICompatibleProvider({
      id: "zhipu",
      baseUrl: "https://example.com/v4",
      apiKey: "sk",
      models: MODELS,
      fetchImpl: mockFetch(() => new Response("too many", { status: 429 })),
    });
    await expect(
      p.generate({ model: "glm-5.3-flash", messages: [{ role: "user", content: "x" }] }),
    ).rejects.toMatchObject({ kind: "rate_limit", retryable: true });
  });

  it("generate: 超时抛 timeout 错误", async () => {
    const p = new OpenAICompatibleProvider({
      id: "zhipu",
      baseUrl: "https://example.com/v4",
      apiKey: "sk",
      models: MODELS,
      fetchImpl: (_url, _body) =>
        new Promise<Response>((_resolve, reject) => {
          // 直接 abort 类错误模拟：provider 侧用自己的 AbortController
          setTimeout(() => {
            const e = new Error("aborted");
            e.name = "AbortError";
            reject(e);
          }, 5);
        }) as unknown as Promise<Response>,
      timeoutMs: 50,
    });
    await expect(
      p.generate({ model: "glm-5.3-flash", messages: [{ role: "user", content: "x" }] }),
    ).rejects.toMatchObject({ kind: "timeout" });
  });

  it("stream: 逐 delta 输出并 done", async () => {
    const p = new OpenAICompatibleProvider({
      id: "zhipu",
      baseUrl: "https://example.com/v4",
      apiKey: "sk",
      models: MODELS,
      fetchImpl: mockFetch((_url, body) => {
        expect(body.stream).toBe(true);
        return sseResponse([
          { model: "glm-5.3-flash", choices: [{ delta: { content: "你" } }] },
          { model: "glm-5.3-flash", choices: [{ delta: { content: "好" } }] },
          { model: "glm-5.3-flash", choices: [{ delta: {} }], usage: { total_tokens: 9 } },
        ]);
      }),
    });

    const events: string[] = [];
    for await (const ev of p.stream({
      model: "glm-5.3-flash",
      messages: [{ role: "user", content: "hi" }],
    })) {
      if (ev.type === "delta") events.push(ev.text);
      if (ev.type === "done") {
        expect(ev.response.content).toBe("你好");
        expect(ev.response.usage?.totalTokens).toBe(9);
      }
      expect(ev.type).not.toBe("error");
    }
    expect(events).toEqual(["你", "好"]);
  });

  it("callLog: 成功与失败都记日志", async () => {
    const entries: unknown[] = [];
    const sink = { append: (e: unknown) => entries.push(e) };
    const fail = new OpenAICompatibleProvider({
      id: "zhipu",
      baseUrl: "https://example.com/v4",
      apiKey: "bad",
      models: MODELS,
      callLog: sink,
      fetchImpl: mockFetch(() => jsonResponse({}, 401)),
    });
    await fail
      .generate({ model: "glm-5.3-flash", messages: [{ role: "user", content: "x" }] })
      .catch(() => undefined);

    const ok = new OpenAICompatibleProvider({
      id: "zhipu",
      baseUrl: "https://example.com/v4",
      apiKey: "sk",
      models: MODELS,
      callLog: sink,
      fetchImpl: mockFetch(() =>
        jsonResponse({ choices: [{ message: { content: "ok" } }] }),
      ),
    });
    await ok.generate({ model: "glm-5.3-flash", messages: [{ role: "user", content: "x" }] });

    expect(entries).toHaveLength(2);
    const [failEntry, okEntry] = entries as Array<Record<string, unknown>>;
    expect(failEntry.ok).toBe(false);
    expect(failEntry.errorCode).toBe("auth");
    expect(okEntry.ok).toBe(true);
  });

  it("supportsModel: 静态清单匹配", () => {
    const p = new OpenAICompatibleProvider({
      id: "zhipu",
      baseUrl: "https://example.com/v4",
      apiKey: "sk",
      models: MODELS,
      fetchImpl: mockFetch(() => jsonResponse({})),
    });
    expect(p.supportsModel("glm-5.3-flash")).toBe(true);
    expect(p.supportsModel("deepseek-chat")).toBe(false);
  });

  it("baseUrl 末尾斜杠被规范化", () => {
    const p = new OpenAICompatibleProvider({
      id: "zhipu",
      baseUrl: "https://example.com/v4/",
      apiKey: "sk",
      models: MODELS,
      fetchImpl: mockFetch(() => jsonResponse({})),
    });
    // 私有属性验证不进测试——用一次 healthCheck 的请求 URL 间接验证
    expect((p as unknown as { baseUrl: string }).baseUrl).toBe("https://example.com/v4");
  });

  it("LLMError 分类正确", () => {
    const e = new LLMError("msg", "rate_limit", 429, true);
    expect(e.kind).toBe("rate_limit");
    expect(e.retryable).toBe(true);
    expect(e.name).toBe("LLMError");
  });
});
