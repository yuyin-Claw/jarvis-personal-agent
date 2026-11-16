import type { SqliteMemoryEngine } from "./sqlite-engine.js";
import type { MemoryCandidate, MemoryKind, MemoryRecord, MessageRecord } from "./types.js";

export type MemorySummarizer = (prompt: string) => Promise<string>;

export interface DistillOptions {
  /** 每批最多处理的“新消息”数（默认 30，形成增量水位线） */
  maxMessages?: number;
  /** 每批最多接受的长期记忆候选数（默认 8） */
  maxCandidates?: number;
}

export interface DistillResult {
  records: MemoryRecord[];
  skippedSensitive: number;
  watermark?: string;
}

const KINDS = new Set<MemoryKind>([
  "user_profile", "conversation_summary", "project", "goal", "decision", "experience",
]);

/** 对话 → 长期记忆候选 → 隐私/重要性/去重 → 语义索引。 */
export class MemoryDistiller {
  constructor(
    private readonly engine: SqliteMemoryEngine,
    private readonly summarize: MemorySummarizer,
  ) {}

  async distillConversation(conversationId: string, opts: DistillOptions = {}): Promise<DistillResult> {
    const all = this.engine.listMessages(conversationId);
    const watermark = this.engine.getDistilledMessageId(conversationId);
    const watermarkIndex = watermark ? all.findIndex((m) => m.id === watermark) : -1;
    const fresh = all.slice(watermarkIndex + 1);
    if (fresh.length === 0) return { records: [], skippedSensitive: 0, watermark };

    const batch = fresh.slice(0, opts.maxMessages ?? 30);
    const batchWatermark = batch.at(-1)!.id;
    const safe = batch.filter((m) =>
      (m.role === "user" || m.role === "assistant") && this.engine.allowsContent(m.content),
    );
    const skippedSensitive = batch.length - safe.length;
    if (safe.length === 0) {
      this.engine.markDistilled(conversationId, batchWatermark);
      return { records: [], skippedSensitive, watermark: batchWatermark };
    }

    const prompt = this.buildPrompt(safe);
    const raw = await this.summarize(prompt);
    const candidates = this.parseCandidates(raw).slice(0, opts.maxCandidates ?? 8);
    const records: MemoryRecord[] = [];
    for (const candidate of candidates) {
      const record = await this.engine.rememberSemantic({
        ...candidate,
        source: "conversation",
        sourceRef: `${conversationId}:${batchWatermark}`,
      });
      if (record) records.push(record);
    }
    // 仅当整批处理成功才推进水位线；LLM/embedding 失败可在下次安全重试。
    this.engine.markDistilled(conversationId, batchWatermark);
    return { records, skippedSensitive, watermark: batchWatermark };
  }

  private buildPrompt(messages: MessageRecord[]): string {
    const dialogue = messages.map((m) =>
      `${m.role === "user" ? "用户" : "助手"}：${m.content.slice(0, 2_000)}`,
    ).join("\n\n");
    return `你是长期记忆蒸馏器。请从对话中提取“以后仍有用”的事实，忽略寒暄、临时过程和重复内容。

只输出 JSON 数组，每项格式：
{"kind":"user_profile|conversation_summary|project|goal|decision|experience","content":"一句独立、明确的事实","confidence":0.0}

规则：
- 不输出解释或 Markdown 代码块。
- content 必须能脱离原对话理解，保留项目名、决定、偏好与约束。
- 每条只能表达一个主题；用户偏好与项目决策必须拆成不同条目，不得合并类别。
- 不提取 API Key、密码、令牌、银行卡等敏感信息。
- 无长期价值就输出 []。

【对话】
${dialogue}`;
  }

  private parseCandidates(raw: string): MemoryCandidate[] {
    const match = raw.match(/\[[\s\S]*\]/);
    if (!match) throw new Error("蒸馏响应不是 JSON 数组");
    const parsed = JSON.parse(match[0]) as unknown;
    if (!Array.isArray(parsed)) throw new Error("蒸馏响应不是 JSON 数组");
    return parsed.flatMap((item): MemoryCandidate[] => {
      if (!item || typeof item !== "object") return [];
      const value = item as { kind?: unknown; content?: unknown; confidence?: unknown };
      if (typeof value.content !== "string" || !value.content.trim()) return [];
      const kind = KINDS.has(value.kind as MemoryKind) ? value.kind as MemoryKind : "conversation_summary";
      const confidence = typeof value.confidence === "number"
        ? Math.max(0, Math.min(1, value.confidence))
        : 0.8;
      return [{ kind, content: value.content.trim(), source: "conversation", confidence }];
    });
  }
}
