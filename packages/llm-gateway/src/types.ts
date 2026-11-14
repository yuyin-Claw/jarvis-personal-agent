/**
 * LLM Gateway — 统一模型接入层（PRD FR-03 / 架构 §3.4）
 *
 * 职责：OpenAI 兼容接口、多提供商、流式生成、健康检查、调用日志与成本统计、超时故障处理。
 * 红线：业务逻辑不得直接绑定某个厂商（ADR-004 反锁定）。
 */

/** 聊天消息角色 */
export type ChatRole = "system" | "user" | "assistant" | "tool";

/** 对话消息 */
export interface ChatMessage {
  role: ChatRole;
  content: string;
}

/** 生成请求 */
export interface LLMRequest {
  /** 模型 ID（由 Orchestrator 决定，如 glm-5.3-flash） */
  model: string;
  messages: ChatMessage[];
  /** 采样温度，默认由 provider 决定 */
  temperature?: number;
  /** 单请求超时毫秒数 */
  timeoutMs?: number;
}

/** 生成结果（非流式终态） */
export interface LLMResponse {
  model: string;
  content: string;
  /** token 用量（若端点返回） */
  usage?: LLMUsage;
  /** 实际返回的模型（端点可能重定向） */
  actualModel?: string;
}

/** token 用量 */
export interface LLMUsage {
  promptTokens?: number;
  completionTokens?: number;
  totalTokens?: number;
}

/** 流式生成的事件分片 */
export type LLMStreamEvent =
  | { type: "delta"; text: string }
  | { type: "done"; response: LLMResponse }
  | { type: "error"; error: LLMError };

/** 模型元信息 */
export interface ModelInfo {
  id: string;
  /** 提供商标识，如 "zhipu" / "deepseek" */
  provider: string;
  /** 是否支持视觉输入 */
  vision?: boolean;
  /** 是否支持工具调用 */
  toolCalling?: boolean;
}

/** 网关错误（含分类，供重试策略使用） */
export class LLMError extends Error {
  constructor(
    message: string,
    /** 错误类别：网络/超时/限流/鉴权/服务端/未知 */
    public readonly kind:
      | "network"
      | "timeout"
      | "rate_limit"
      | "auth"
      | "server"
      | "unknown",
    /** HTTP 状态码（若有） */
    public readonly status?: number,
    /** 是否值得重试 */
    public readonly retryable = false,
  ) {
    super(message);
    this.name = "LLMError";
  }
}

/**
 * LLM 提供商接口（架构 §3.4 LLMProvider）
 * 实现方：OpenAICompatibleProvider（GLM/DeepSeek 等国内端点）等。
 */
export interface LLMProvider {
  /** 提供商标识 */
  readonly id: string;
  /** 同步判断该 provider 是否能服务此模型（静态清单匹配） */
  supportsModel(model: string): boolean;
  /** 该 provider 可用的模型清单 */
  getModels(): Promise<ModelInfo[]>;
  /** 健康检查：端点可达且鉴权有效 */
  healthCheck(): Promise<boolean>;
  /** 非流式生成 */
  generate(request: LLMRequest): Promise<LLMResponse>;
  /** 流式生成 */
  stream(request: LLMRequest): AsyncIterable<LLMStreamEvent>;
}

/** 调用日志条目（FR-03：模型调用日志和成本统计） */
export interface CallLogEntry {
  timestamp: string;
  providerId: string;
  model: string;
  ok: boolean;
  /** 耗时毫秒 */
  durationMs: number;
  usage?: LLMUsage;
  errorCode?: string;
}

/** 调用日志接收器（由宿主注入；0.1 写 SQLite，测试用内存实现） */
export interface CallLogSink {
  append(entry: CallLogEntry): void;
}
