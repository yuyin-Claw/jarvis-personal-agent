import type { MemorySummarizer } from "@jarvis/memory";

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
