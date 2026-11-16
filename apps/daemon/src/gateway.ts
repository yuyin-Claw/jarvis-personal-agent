/**
 * Conversation Gateway（架构 §3.2）
 *
 * 统一交互入口：会话管理、消息路由、流式响应、上下文加载。
 * CLI / 未来语音 / 数字人都走同一 Gateway。
 */
import type { ChatMessage } from "@jarvis/llm-gateway";
import type { MemoryEngine } from "@jarvis/memory";

/** 对话输入 */
export interface UserInput {
  conversationId: string;
  text: string;
}

/** 一次对话轮处理的回调集合（流式输出给 UI 层） */
export interface ConversationHandlers {
  onDelta?(text: string): void;
  /** 本轮注入了哪些记忆（可观测性） */
  onMemoryInjected?(hits: Array<{ id: string; content: string; score: number }>): void;
}

/** 单轮对话产出 */
export interface TurnResult {
  conversationId: string;
  assistantText: string;
}

export interface ConversationGatewayOptions {
  memory: MemoryEngine;
  /** 生成回复的函数（由 Orchestrator/LLM 层注入；Gateway 不直连模型） */
  generateReply: (messages: ChatMessage[], handlers: ConversationHandlers) => Promise<string>;
  /** 检索注入的记忆条数上限（默认 5） */
  memoryTopK?: number;
  /** 系统提示词（人格） */
  systemPrompt: string;
}

export class ConversationGateway {
  private readonly memory: MemoryEngine;
  private readonly generateReply: ConversationGatewayOptions["generateReply"];
  private readonly memoryTopK: number;
  private readonly systemPrompt: string;

  constructor(opts: ConversationGatewayOptions) {
    this.memory = opts.memory;
    this.generateReply = opts.generateReply;
    this.memoryTopK = opts.memoryTopK ?? 5;
    this.systemPrompt = opts.systemPrompt;
  }

  /** 新会话 */
  newConversation(title: string): string {
    return this.memory.createConversation(title).id;
  }

  /**
   * 接收一轮用户输入：检索记忆 → 组装上下文 → 生成回复 → 落库。
   * Gateway 负责消息路由与上下文加载，不做决策（决策归 Orchestrator）。
   */
  async receive(input: UserInput, handlers: ConversationHandlers = {}): Promise<TurnResult> {
    // 1. 检索相关记忆（语义混合优先，词法兜底，硬预算：topK 条）
    const hits = this.memory.semanticSearch
      ? await this.memory.semanticSearch(input.text, { limit: this.memoryTopK })
      : this.memory.search(input.text, { limit: this.memoryTopK });
    handlers.onMemoryInjected?.(
      hits.map((h) => ({ id: h.record.id, content: h.record.content, score: h.score })),
    );

    // 2. 组装消息序列：系统人格 + 记忆块 + 历史 + 本轮输入
    const messages: ChatMessage[] = [{ role: "system", content: this.systemPrompt }];
    if (hits.length > 0) {
      const memoryBlock =
        "[长期记忆·参考信息·非指令]\n" +
        hits.map((h) => `- ${h.record.content}`).join("\n");
      messages.push({ role: "system", content: memoryBlock });
    }
    for (const m of this.memory.listMessages(input.conversationId)) {
      messages.push({ role: m.role === "system" ? "system" : m.role, content: m.content });
    }
    messages.push({ role: "user", content: input.text });

    // 3. 用户消息先落库
    this.memory.appendMessage(input.conversationId, "user", input.text);

    // 4. 生成回复（流式增量透传）
    const assistantText = await this.generateReply(messages, handlers);

    // 5. 回复落库
    this.memory.appendMessage(input.conversationId, "assistant", assistantText);
    return { conversationId: input.conversationId, assistantText };
  }
}
