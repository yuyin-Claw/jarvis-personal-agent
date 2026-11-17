import { LLMError, type LLMProvider, type LLMRequest, type LLMResponse, type LLMStreamEvent, type ModelInfo } from "./types.js";

type RawChatRequest = LLMRequest & { tools?: unknown[] };
type RawChatResponse = {
  role: "assistant";
  content?: string;
  tool_calls?: Array<{ id: string; function: { name: string; arguments: string } }>;
};
type RawProvider = LLMProvider & { rawChat?(request: RawChatRequest): Promise<RawChatResponse> };

export interface FallbackProviderOptions {
  primary: RawProvider;
  fallback: RawProvider;
  primaryModel: string;
  fallbackModel: string;
  id?: string;
  onFallback?: (error: Error, operation: "generate" | "stream" | "rawChat") => void;
}

export function isRetryableModelError(error: unknown): boolean {
  if (error instanceof LLMError) return error.retryable;
  // fetch 网络错误/AbortError 值得切换；业务异常（JSON 解析、内容判定）不在此层重试。
  return error instanceof TypeError || (error instanceof Error && error.name === "AbortError");
}

/** 主备 Provider：仅可重试错误切换；流式已产出内容后绝不重放。 */
export class FallbackProvider implements LLMProvider {
  readonly id: string;
  constructor(private readonly opts: FallbackProviderOptions) {
    this.id = opts.id ?? "fallback";
  }

  supportsModel(model: string): boolean {
    return this.opts.primary.supportsModel(model) || this.opts.fallback.supportsModel(model);
  }
  async getModels(): Promise<ModelInfo[]> {
    return [...await this.opts.primary.getModels(), ...await this.opts.fallback.getModels()];
  }
  async healthCheck(): Promise<boolean> {
    return await this.opts.primary.healthCheck() || await this.opts.fallback.healthCheck();
  }

  private primaryRequest(request: LLMRequest): LLMRequest {
    return { ...request, model: this.opts.primaryModel };
  }
  private fallbackRequest(request: LLMRequest): LLMRequest {
    return { ...request, model: this.opts.fallbackModel };
  }
  private notify(error: unknown, operation: "generate" | "stream" | "rawChat"): void {
    this.opts.onFallback?.(error instanceof Error ? error : new Error(String(error)), operation);
  }

  async generate(request: LLMRequest): Promise<LLMResponse> {
    try {
      return await this.opts.primary.generate(this.primaryRequest(request));
    } catch (error) {
      if (!isRetryableModelError(error)) throw error;
      this.notify(error, "generate");
      return this.opts.fallback.generate(this.fallbackRequest(request));
    }
  }

  async *stream(request: LLMRequest): AsyncIterable<LLMStreamEvent> {
    let emitted = false;
    try {
      for await (const event of this.opts.primary.stream(this.primaryRequest(request))) {
        if (event.type === "delta" || event.type === "done") emitted = true;
        if (event.type === "error" && !emitted && isRetryableModelError(event.error)) throw event.error;
        yield event;
      }
      return;
    } catch (error) {
      if (emitted || !isRetryableModelError(error)) {
        yield { type: "error", error: error instanceof LLMError ? error : new LLMError((error as Error).message, "unknown") };
        return;
      }
      this.notify(error, "stream");
    }
    for await (const event of this.opts.fallback.stream(this.fallbackRequest(request))) yield event;
  }

  async rawChat(request: RawChatRequest): Promise<RawChatResponse> {
    if (typeof this.opts.primary.rawChat !== "function") throw new LLMError("主 provider 不支持 rawChat", "unknown");
    try {
      return await this.opts.primary.rawChat(this.primaryRequest(request));
    } catch (error) {
      if (!isRetryableModelError(error)) throw error;
      if (typeof this.opts.fallback.rawChat !== "function") throw new LLMError("备用 provider 不支持 rawChat", "unknown");
      this.notify(error, "rawChat");
      return this.opts.fallback.rawChat(this.fallbackRequest(request));
    }
  }
}
