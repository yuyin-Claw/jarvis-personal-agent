/**
 * Memory Engine 类型定义（PRD FR-04 / 架构 §3.5）
 *
 * 首版 SQLite；记忆分类 user_profile / conversation_summary / project / goal / decision / experience。
 * 原则：原始上下文不等于长期记忆；推断必须带置信度；保留来源；用户可改可删。
 */

/** 记忆类别 */
export type MemoryKind =
  | "user_profile"
  | "conversation_summary"
  | "project"
  | "goal"
  | "decision"
  | "experience";

/** 存储的记忆条目 */
export interface MemoryRecord {
  id: string;
  kind: MemoryKind;
  /** 记忆正文（一句话事实） */
  content: string;
  /** 来源标记：conversation / activity / user_correction / system */
  source: string;
  /** 来源引用（如对话 id+消息 id） */
  sourceRef?: string;
  /** 推断置信度 0-1；事实性记忆为 1 */
  confidence: number;
  /** 创建时间 ISO */
  createdAt: string;
  /** 更新时间 ISO */
  updatedAt: string;
}

/** 记忆写入候选（进入管道前的原料） */
export interface MemoryCandidate {
  kind: MemoryKind;
  content: string;
  source: string;
  sourceRef?: string;
  confidence?: number;
}

/** 词法检索命中的结果 */
export interface MemorySearchHit {
  record: MemoryRecord;
  /** 相关度得分（越高越相关） */
  score: number;
}

/** 对话记录 */
export interface ConversationRecord {
  id: string;
  title: string;
  startedAt: string;
  lastMessageAt: string;
}

/** 消息记录 */
export interface MessageRecord {
  id: string;
  conversationId: string;
  role: "user" | "assistant" | "system";
  content: string;
  createdAt: string;
}

/** 模型调用日志（与 llm-gateway 的 CallLogEntry 结构兼容） */
export interface LLMCallLogRecord {
  id?: number;
  timestamp: string;
  providerId: string;
  model: string;
  ok: boolean;
  durationMs: number;
  usage?: { promptTokens?: number; completionTokens?: number; totalTokens?: number };
  errorCode?: string;
}

/** 隐私过滤器：内容含敏感信息时拒绝入库（架构红线） */
export interface PrivacyFilter {
  /** 返回拒绝原因；null 表示放行 */
  check(candidate: MemoryCandidate): string | null;
}

/** 重要性评估器：决定候选是否值得长期保存 */
export interface ImportanceEvaluator {
  /** 返回 0-1 重要性；低于阈值的候选被丢弃 */
  score(candidate: MemoryCandidate): number;
}

/** 记忆引擎主接口 */
export interface MemoryEngine {
  /** 迁移到最新 schema（幂等） */
  migrate(): void;
  /** 记忆写入管道：候选 → 隐私 → 重要性 → 去重 → 入库 */
  remember(candidate: MemoryCandidate): MemoryRecord | null;
  /** 词法检索 */
  search(query: string, opts?: { kind?: MemoryKind; limit?: number }): MemorySearchHit[];
  /** 可选语义混合检索（实现不支持时 Gateway 回退 search） */
  semanticSearch?(query: string, opts?: { kind?: MemoryKind; limit?: number }): Promise<MemorySearchHit[]>;
  /** 按 id 取 */
  get(id: string): MemoryRecord | undefined;
  /** 用户纠正/编辑 */
  update(id: string, content: string): MemoryRecord | undefined;
  /** 用户删除 */
  delete(id: string): boolean;
  /** 列出全部（用户查看记忆入口） */
  list(opts?: { kind?: MemoryKind }): MemoryRecord[];

  // 对话存储（与记忆分离存储，架构 §8）
  createConversation(title: string): ConversationRecord;
  appendMessage(conversationId: string, role: MessageRecord["role"], content: string): MessageRecord;
  listMessages(conversationId: string): MessageRecord[];
  listConversations(): ConversationRecord[];
}
