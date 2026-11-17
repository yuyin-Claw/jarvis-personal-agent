import type { MemorySummarizer, WikiSynthesizer } from "@jarvis/memory";

export interface OllamaDistillerOptions {
  baseUrl?: string;
  model?: string;
  timeoutMs?: number;
}

interface OllamaChatResponse {
  message?: { content?: string };
  error?: string;
}

/** Qwen3:4b 本地蒸馏：JSON Schema 强约束，完成后立即卸载以释放 8GB guest 内存。 */
export function createOllamaDistiller(opts: OllamaDistillerOptions = {}): MemorySummarizer {
  const baseUrl = (opts.baseUrl ?? "http://127.0.0.1:11434").replace(/\/$/, "");
  const model = opts.model ?? "qwen3:4b";
  return async (prompt) => {
    const response = await fetch(`${baseUrl}/api/chat`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        model,
        messages: [{ role: "user", content: prompt }],
        stream: false,
        think: false,
        keep_alive: 0,
        options: { temperature: 0 },
        format: {
          type: "array",
          items: {
            type: "object",
            properties: {
              kind: { type: "string", enum: ["user_profile", "conversation_summary", "project", "goal", "decision", "experience"] },
              content: { type: "string" },
              confidence: { type: "number" },
            },
            required: ["kind", "content", "confidence"],
            additionalProperties: false,
          },
        },
      }),
      signal: AbortSignal.timeout(opts.timeoutMs ?? 180_000),
    });
    const body = await response.json() as OllamaChatResponse;
    if (!response.ok || !body.message?.content) {
      throw new Error(`Ollama 蒸馏失败（HTTP ${response.status}）：${body.error ?? "响应无内容"}`);
    }
    return body.message.content;
  };
}

/** Wiki overview：先用 JSON Schema 限定三段内容，再由代码组装 Markdown，杜绝思考过程。 */
export function createOllamaWikiWriter(opts: OllamaDistillerOptions = {}): WikiSynthesizer {
  const baseUrl = (opts.baseUrl ?? "http://127.0.0.1:11434").replace(/\/$/, "");
  const model = opts.model ?? "qwen3:4b";
  return async (prompt) => {
    const response = await fetch(`${baseUrl}/api/chat`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        model,
        messages: [{ role: "user", content: `按 JSON Schema 输出最终概览，字段只能填写输入记忆中的 memory id，禁止改写事实或输出分析过程。\n${prompt}` }],
        stream: false,
        think: false,
        keep_alive: 0,
        options: { temperature: 0, num_predict: 400 },
        format: {
          type: "object",
          properties: {
            currentFocus: { type: "array", items: { type: "string" } },
            decisions: { type: "array", items: { type: "string" } },
            preferences: { type: "array", items: { type: "string" } },
          },
          required: ["currentFocus", "decisions", "preferences"],
          additionalProperties: false,
        },
      }),
      signal: AbortSignal.timeout(opts.timeoutMs ?? 180_000),
    });
    const body = await response.json() as OllamaChatResponse;
    if (!response.ok || !body.message?.content) {
      throw new Error(`Ollama Wiki 摘要失败（HTTP ${response.status}）：${body.error ?? "响应无内容"}`);
    }
    const parsed = JSON.parse(body.message.content) as {
      currentFocus?: unknown;
      decisions?: unknown;
      preferences?: unknown;
    };
    // LLM 只负责选择 ID；正文必须逐字来自 SQLite，防止概览产生幻觉/错字。
    const facts = new Map<string, string>();
    for (const line of prompt.split("\n")) {
      const match = line.match(/^\[(mem_[^\]]+)\]\s+\([^)]+\)\s+(.*)$/);
      if (match) facts.set(match[1]!, match[2]!);
    }
    const sections: Array<[string, unknown]> = [
      ["当前重点", parsed.currentFocus],
      ["关键决策", parsed.decisions],
      ["用户偏好", parsed.preferences],
    ];
    let returnedIds = 0;
    let mappedIds = 0;
    const markdown = sections.map(([title, values]) => {
      const ids = Array.isArray(values) ? values.filter((v): v is string => typeof v === "string") : [];
      returnedIds += ids.length;
      const items = ids.flatMap((id) => facts.has(id) ? [facts.get(id)!] : []);
      mappedIds += items.length;
      return `## ${title}\n${items.length ? items.map((v) => `- ${v}`).join("\n") : "- 暂无"}`;
    }).join("\n\n");
    if (returnedIds > 0 && mappedIds === 0) throw new Error("Ollama Wiki 返回了无效 memory id");
    return markdown;
  };
}

/** 本地蒸馏失败时才使用 GLM；保留明确可观测性。 */
export function withDistillerFallback(
  local: MemorySummarizer,
  fallback: MemorySummarizer,
  onFallback: (error: Error) => void,
): MemorySummarizer {
  return async (prompt) => {
    try {
      return await local(prompt);
    } catch (e) {
      const error = e instanceof Error ? e : new Error(String(e));
      onFallback(error);
      return fallback(prompt);
    }
  };
}
