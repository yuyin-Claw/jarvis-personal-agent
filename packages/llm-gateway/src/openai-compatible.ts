/**
 * OpenAI 兼容 provider —— 国内模型主通道（ADR-004）
 *
 * 适用于任何 OpenAI /chat/completions 兼容端点：
 * - 智谱 GLM：https://open.bigmodel.cn/api/coding/paas/v4（coding plan 专用）
 * - DeepSeek：https://api.deepseek.com
 *
 * 注意：不引入 SDK，直接 fetch——减少依赖面（ADR-019 无依赖哲学的同源原则）。
 */
import {
  type CallLogSink,
  type LLMError,
  type LLMProvider,
  type LLMRequest,
  type LLMResponse,
  type LLMStreamEvent,
  type ModelInfo,
  LLMError as LLMErrorClass,
} from "./types.js";

/** OpenAI 兼容响应的原始结构（仅取需要的字段） */
interface RawChatResponse {
  model?: string;
  choices?: Array<{
    message?: { content?: string | null };
    finish_reason?: string | null;
  }>;
  usage?: {
    prompt_tokens?: number;
    completion_tokens?: number;
    total_tokens?: number;
  };
}

export interface OpenAICompatibleOptions {
  /** provider 标识，如 "zhipu" / "deepseek" */
  id: string;
  /** base URL，末尾不带斜杠，如 https://open.bigmodel.cn/api/coding/paas/v4 */
  baseUrl: string;
  /** API key（生产环境从系统 Secret Service 读取，不经手配置文件） */
  apiKey: string;
  /** 该端点可用的模型清单（静态声明；getModels 不打网络） */
  models: ModelInfo[];
  /** 默认超时毫秒 */
  timeoutMs?: number;
  /** 调用日志（可选） */
  callLog?: CallLogSink;
  /** 端点扩展字段（如 Ollama 的 think:false） */
  extraBody?: Record<string, unknown>;
  /** 注入 fetch（测试用） */
  fetchImpl?: typeof fetch;
}

function classifyStatus(status: number): LLMError {
  if (status === 401 || status === 403) {
    return new LLMErrorClass(`鉴权失败（${status}）`, "auth", status, false);
  }
  if (status === 429) {
    return new LLMErrorClass("限流（429）", "rate_limit", status, true);
  }
  if (status >= 500) {
    return new LLMErrorClass(`服务端错误（${status}）`, "server", status, true);
  }
  return new LLMErrorClass(`请求被拒绝（${status}）`, "unknown", status, false);
}

export class OpenAICompatibleProvider implements LLMProvider {
  readonly id: string;
  private readonly baseUrl: string;
  private readonly apiKey: string;
  private readonly models: ModelInfo[];
  private readonly defaultTimeoutMs: number;
  private readonly callLog?: CallLogSink;
  private readonly extraBody: Record<string, unknown>;
  private readonly fetchImpl: typeof fetch;

  constructor(opts: OpenAICompatibleOptions) {
    this.id = opts.id;
    this.baseUrl = opts.baseUrl.replace(/\/+$/, "");
    this.apiKey = opts.apiKey;
    this.models = opts.models;
    this.defaultTimeoutMs = opts.timeoutMs ?? 60_000;
    this.callLog = opts.callLog;
    this.extraBody = opts.extraBody ?? {};
    this.fetchImpl = opts.fetchImpl ?? fetch;
  }

  supportsModel(model: string): boolean {
    return this.models.some((m) => m.id === model);
  }

  /** 原始 chat 调用（含 tool_calls 等扩展字段；Harness 层使用） */
  async rawChat(
    request: LLMRequest & { tools?: unknown[] },
  ): Promise<{
    role: "assistant";
    content?: string;
    tool_calls?: Array<{ id: string; function: { name: string; arguments: string } }>;
  }> {
    const res = await this.request(
      "/chat/completions",
      {
        model: request.model,
        messages: request.messages,
        ...(request.tools ? { tools: request.tools } : {}),
        ...(request.temperature !== undefined ? { temperature: request.temperature } : {}),
        ...this.extraBody,
      },
      request.timeoutMs ?? this.defaultTimeoutMs,
    );
    const raw = (await res.json()) as {
      choices?: Array<{
        message?: {
          content?: string | null;
          tool_calls?: Array<{ id: string; function: { name: string; arguments: string } }>;
        };
      }>;
    };
    const msg = raw.choices?.[0]?.message;
    return {
      role: "assistant" as const,
      ...(msg?.content !== undefined && msg.content !== null ? { content: msg.content } : {}),
      ...(msg?.tool_calls ? { tool_calls: msg.tool_calls } : {}),
    };
  }

  getModels(): Promise<ModelInfo[]> {
    // 静态声明：模型清单由配置给定，避免每次列模型打网络
    return Promise.resolve([...this.models]);
  }

  async healthCheck(): Promise<boolean> {
    try {
      const res = await this.request(
        "/chat/completions",
        {
          model: this.models[0]?.id ?? "glm-5.3-flash",
          messages: [{ role: "user", content: "ping" }],
          max_tokens: 1,
        },
        10_000,
      );
      return res.ok;
    } catch {
      return false;
    }
  }

  async generate(request: LLMRequest): Promise<LLMResponse> {
    const started = Date.now();
    try {
      const res = await this.request(
        "/chat/completions",
        {
          model: request.model,
          messages: request.messages,
          ...(request.temperature !== undefined
            ? { temperature: request.temperature }
            : {}),
          ...this.extraBody,
        },
        request.timeoutMs ?? this.defaultTimeoutMs,
      );
      const raw = (await res.json()) as RawChatResponse;
      const response = this.toResponse(request.model, raw);
      this.log(request.model, true, Date.now() - started, response.usage);
      return response;
    } catch (err) {
      this.log(request.model, false, Date.now() - started, undefined, err);
      throw err;
    }
  }

  async *stream(request: LLMRequest): AsyncIterable<LLMStreamEvent> {
    const started = Date.now();
    let usage: LLMResponse["usage"];
    let actualModel: string | undefined;
    let full = "";
    try {
      const res = await this.request(
        "/chat/completions",
        {
          model: request.model,
          messages: request.messages,
          stream: true,
          stream_options: { include_usage: true },
          ...(request.temperature !== undefined
            ? { temperature: request.temperature }
            : {}),
          ...this.extraBody,
        },
        request.timeoutMs ?? this.defaultTimeoutMs,
      );

      if (!res.body) {
        throw new LLMErrorClass("流式响应无 body", "server", undefined, true);
      }

      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";

      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });

        // SSE：按双换行切事件，逐行解析 "data: ..."
        let sep: number;
        while ((sep = buffer.indexOf("\n\n")) !== -1) {
          const chunkEvent = buffer.slice(0, sep);
          buffer = buffer.slice(sep + 2);
          for (const line of chunkEvent.split("\n")) {
            if (!line.startsWith("data:")) continue;
            const data = line.slice(5).trim();
            if (data === "[DONE]") continue;
            const parsed = JSON.parse(data) as {
              model?: string;
              usage?: RawChatResponse["usage"];
              choices?: Array<{
                delta?: { content?: string | null };
              }>;
            };
            if (parsed.model) actualModel = parsed.model;
            if (parsed.usage) usage = this.toUsage(parsed.usage);
            const delta = parsed.choices?.[0]?.delta?.content;
            if (delta) {
              full += delta;
              yield { type: "delta", text: delta };
            }
          }
        }
      }

      const response: LLMResponse = {
        model: request.model,
        content: full,
        ...(actualModel ? { actualModel } : {}),
        ...(usage ? { usage } : {}),
      };
      this.log(request.model, true, Date.now() - started, usage);
      yield { type: "done", response };
    } catch (err) {
      this.log(request.model, false, Date.now() - started, undefined, err);
      if (err instanceof LLMErrorClass) {
        yield { type: "error", error: err };
        return;
      }
      yield {
        type: "error",
        error: new LLMErrorClass(
          err instanceof Error ? err.message : String(err),
          "unknown",
        ),
      };
    }
  }

  /** 统一请求出口：超时 + 状态码分类 */
  private async request(
    path: string,
    body: Record<string, unknown>,
    timeoutMs: number,
  ): Promise<Response> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    let res: Response;
    try {
      res = await this.fetchImpl(`${this.baseUrl}${path}`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${this.apiKey}`,
        },
        body: JSON.stringify(body),
        signal: controller.signal,
      });
    } catch (err) {
      if (err instanceof Error && err.name === "AbortError") {
        throw new LLMErrorClass(
          `请求超时（${timeoutMs}ms）`,
          "timeout",
          undefined,
          true,
        );
      }
      throw new LLMErrorClass(
        err instanceof Error ? err.message : "网络错误",
        "network",
        undefined,
        true,
      );
    } finally {
      clearTimeout(timer);
    }
    if (!res.ok) {
      throw classifyStatus(res.status);
    }
    return res;
  }

  private toResponse(model: string, raw: RawChatResponse): LLMResponse {
    const content = raw.choices?.[0]?.message?.content;
    if (content == null) {
      throw new LLMErrorClass("响应缺少 choices[0].message", "server");
    }
    return {
      model,
      content,
      ...(raw.model ? { actualModel: raw.model } : {}),
      ...(raw.usage ? { usage: this.toUsage(raw.usage) } : {}),
    };
  }

  private toUsage(u: NonNullable<RawChatResponse["usage"]>): NonNullable<LLMResponse["usage"]> {
    return {
      ...(u.prompt_tokens !== undefined
        ? { promptTokens: u.prompt_tokens }
        : {}),
      ...(u.completion_tokens !== undefined
        ? { completionTokens: u.completion_tokens }
        : {}),
      ...(u.total_tokens !== undefined ? { totalTokens: u.total_tokens } : {}),
    };
  }

  private log(
    model: string,
    ok: boolean,
    durationMs: number,
    usage?: LLMResponse["usage"],
    err?: unknown,
  ): void {
    if (!this.callLog) return;
    this.callLog.append({
      timestamp: new Date().toISOString(),
      providerId: this.id,
      model,
      ok,
      durationMs,
      ...(usage ? { usage } : {}),
      ...(err instanceof LLMErrorClass ? { errorCode: err.kind } : {}),
    });
  }
}
