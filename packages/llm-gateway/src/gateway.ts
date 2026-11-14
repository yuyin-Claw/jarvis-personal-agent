/**
 * Gateway 门面 —— 按模型 ID 路由到 provider（多提供商支持，FR-03）
 */
import type {
  CallLogSink,
  LLMProvider,
  LLMRequest,
  LLMResponse,
  LLMStreamEvent,
  ModelInfo,
} from "./types.js";
import { LLMError } from "./types.js";

export class LLMGateway {
  private providersMap = new Map<string, LLMProvider>();

  /** 注册 provider（可多个，同 id 覆盖） */
  register(provider: LLMProvider): void {
    this.providersMap.set(provider.id, provider);
  }

  /** 全部可用模型（跨 provider 聚合） */
  async getModels(): Promise<ModelInfo[]> {
    const all: ModelInfo[] = [];
    for (const p of this.providersMap.values()) {
      all.push(...(await p.getModels()));
    }
    return all;
  }

  /** 按 provider id 健康检查 */
  async healthCheck(providerId: string): Promise<boolean> {
    const p = this.providersMap.get(providerId);
    if (!p) return false;
    return p.healthCheck();
  }

  private mustResolve(model: string): LLMProvider {
    for (const p of this.providersMap.values()) {
      if (p.supportsModel(model)) return p;
    }
    throw new LLMError(
      `未找到能服务模型 ${model} 的 provider（已注册：${[...this.providersMap.keys()].join(", ") || "无"}）`,
      "unknown",
    );
  }

  async generate(request: LLMRequest): Promise<LLMResponse> {
    return this.mustResolve(request.model).generate(request);
  }

  stream(request: LLMRequest): AsyncIterable<LLMStreamEvent> {
    return this.mustResolve(request.model).stream(request);
  }

  /** 底层 provider 访问（Harness rawChat 用；只读） */
  providers(): ReadonlyMap<string, LLMProvider> {
    return this.providersMap;
  }
}

export type {
  CallLogSink,
  LLMProvider,
  LLMRequest,
  LLMResponse,
  LLMStreamEvent,
  ModelInfo,
};
export { LLMError } from "./types.js";
export { OpenAICompatibleProvider } from "./openai-compatible.js";
export type { OpenAICompatibleOptions } from "./openai-compatible.js";
