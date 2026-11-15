/**
 * Platform Adapter 契约（ADR-007，恢复架构 §7.1）
 *
 * 本包只有类型与注册表，零平台依赖、零 I/O。
 * Core / packages/* 只依赖这里的接口；macOS 与 Omarchy 实现由 composition root 注入。
 */
export type AdapterId = "macos" | "omarchy";

export type EndpointId =
  | "avatarHost"
  | "speechOutput"
  | "speechInput"
  | "foreground"
  | "notification";

/** ready=可用；unavailable=依赖/权限缺失可重试；unsupported=该平台不具备此能力 */
export type CapabilityState = "ready" | "unavailable" | "unsupported" | "degraded";

export interface AdapterStatus {
  id: AdapterId;
  endpoint: EndpointId;
  state: CapabilityState;
  detail?: string;
}

/** 渲染帧：与 @jarvis/avatar 的 RenderPayload 结构兼容，但本包不依赖它 */
export interface AvatarFrame {
  state: string;
  intensity: number;
  amplitude?: number;
  caption?: string;
  capture?: string;
  /** seq 由平台适配器内部维护以保证递增；此处仅作透传/审计用 */
  seq?: number;
}

export interface AvatarHostOptions {
  width?: number;
  height?: number;
  x?: number;
  y?: number;
  /** 渲染层 HTML；两个平台共用同一份 */
  htmlPath?: string;
}

export interface AvatarHostAdapter {
  readonly id: AdapterId;
  start(opts?: AvatarHostOptions): Promise<void>;
  setState(frame: AvatarFrame): Promise<void>;
  /** 截取宿主自身窗口到 path；返回是否成功 */
  capture(path: string): Promise<boolean>;
  stop(): Promise<void>;
  probe(): Promise<AdapterStatus>;
}

export type SpeakEndReason = "completed" | "interrupted" | "error" | "unsupported";

export interface SpeakOptions {
  voice?: string;
  rate?: number;
  /** 只写音频文件不发声，用于自动验收 */
  outputFile?: string;
}

export interface SpeechOutputAdapter {
  readonly id: AdapterId;
  speak(text: string, opts?: SpeakOptions): Promise<SpeakEndReason>;
  interrupt(): void;
  readonly speaking: boolean;
  probe(): Promise<AdapterStatus>;
}

export type SpeechInputEventType = "status" | "ready" | "partial" | "final" | "error";

export interface SpeechInputEvent {
  type: SpeechInputEventType;
  text?: string;
  /** status 事件的授权信息 */
  speech?: string;
  mic?: string;
  available?: boolean;
  message?: string;
}

export interface SpeechInputAdapter {
  readonly id: AdapterId;
  start(): Promise<void>;
  stop(): Promise<void>;
  onEvent(cb: (e: SpeechInputEvent) => void): () => void;
  probe(): Promise<AdapterStatus>;
}

export interface ForegroundContext {
  app?: string;
  title?: string;
  at: number;
}

export interface ForegroundSourceAdapter {
  readonly id: AdapterId;
  current(): Promise<ForegroundContext | null>;
  probe(): Promise<AdapterStatus>;
}

export interface NotifyMessage {
  title?: string;
  text: string;
  priority?: "low" | "normal" | "high";
}

export interface NotificationAdapter {
  readonly id: AdapterId;
  send(message: NotifyMessage): Promise<boolean>;
  probe(): Promise<AdapterStatus>;
}

/** 每个平台必须提供全部五个端点；不具备能力时用 Null 实现返回 unsupported */
export interface PlatformAdapter {
  readonly id: AdapterId;
  avatarHost: AvatarHostAdapter;
  speechOutput: SpeechOutputAdapter;
  speechInput: SpeechInputAdapter;
  foreground: ForegroundSourceAdapter;
  notification: NotificationAdapter;
  probe(): Promise<AdapterStatus[]>;
}

export const ENDPOINTS: readonly EndpointId[] = [
  "avatarHost",
  "speechOutput",
  "speechInput",
  "foreground",
  "notification",
];
