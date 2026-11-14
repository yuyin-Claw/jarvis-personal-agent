/**
 * Memory Engine SQLite 实现（PRD FR-04）
 *
 * 写入管道：候选 → 隐私检查 → 重要性评估 → 去重 → 入库
 * 检索：词法打分（token 重叠 + 长度惩罚），0.1 规模下足够（ADR-006 同源思路）
 */
import Database from "better-sqlite3";
import { runMigrations, type Migration } from "./migrations.js";
import { ALL_MIGRATIONS } from "./schema.js";
import type {
  ConversationRecord,
  ImportanceEvaluator,
  MemoryCandidate,
  MemoryEngine,
  MemoryRecord,
  MemorySearchHit,
  MessageRecord,
  PrivacyFilter,
} from "./types.js";

/** 默认隐私过滤器：拦截明显敏感内容（红线的最小实现） */
export class DefaultPrivacyFilter implements PrivacyFilter {
  private readonly patterns: Array<{ re: RegExp; reason: string }> = [
    { re: /\b(sk-[A-Za-z0-9]{8,}|ghp_[A-Za-z0-9]{10,}|AKIA[A-Z0-9]{12,})\b/, reason: "疑似 API 密钥" },
    { re: /\b\d{16,19}\b/, reason: "疑似银行卡号" },
    { re: /(?:密码|password|passwd|passphrase)\s*[:：=]\s*\S+/i, reason: "疑似明文密码" },
  ];

  check(candidate: MemoryCandidate): string | null {
    for (const { re, reason } of this.patterns) {
      if (re.test(candidate.content)) return reason;
    }
    return null;
  }
}

/** 默认重要性评估：规则启发式（0.1 不调模型） */
export class RuleBasedImportance implements ImportanceEvaluator {
  score(candidate: MemoryCandidate): number {
    let s = 0.4;
    // 决策与用户画像天然重要
    if (candidate.kind === "decision" || candidate.kind === "user_profile" || candidate.kind === "goal") s += 0.4;
    if (candidate.kind === "project") s += 0.2;
    // 用户纠正的来源权重高
    if (candidate.source === "user_correction") s += 0.2;
    // 太短的候选信息量不足
    if (candidate.content.length < 6) s -= 0.3;
    return Math.max(0, Math.min(1, s));
  }
}

export interface SqliteMemoryOptions {
  /** 数据库文件路径；":memory:" 用于测试 */
  path: string;
  /** 追加迁移（测试/扩展用） */
  extraMigrations?: Migration[];
  privacyFilter?: PrivacyFilter;
  importance?: ImportanceEvaluator;
  /** 重要性低于此值的候选被丢弃（默认 0.5） */
  importanceThreshold?: number;
  /** 去重相似阈值（0-1，默认 0.9 视为重复） */
  duplicateThreshold?: number;
}

function tokenize(text: string): string[] {
  // 英文/数字按词切；CJK 按单字切 + 2-gram（中文无空格分界，字级 n-gram 是词法检索的最小可行方案）
  const latin = text
    .toLowerCase()
    .split(/[^\p{L}\p{N}]+/u)
    .filter((t) => t.length >= 2);
  const cjkChars: string[] = [];
  const cjkBigrams: string[] = [];
  const matches = text.matchAll(/[\u4e00-\u9fff]/gu);
  for (const m of matches) cjkChars.push(m[0]);
  for (let i = 0; i + 1 < cjkChars.length; i++) {
    const a = cjkChars[i];
    const b = cjkChars[i + 1];
    if (a !== undefined && b !== undefined) cjkBigrams.push(a + b);
  }
  return [...latin, ...cjkChars, ...cjkBigrams];
}

function jaccard(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 || b.size === 0) return 0;
  let inter = 0;
  for (const t of a) if (b.has(t)) inter++;
  return inter / (a.size + b.size - inter);
}

/** 字符 bigram 的 Dice 系数（对中文短句去重比 token Jaccard 稳） */
function diceBigrams(a: string, b: string): number {
  const gramsOf = (s: string): Map<string, number> => {
    const m = new Map<string, number>();
    const norm = s.replace(/\s+/g, "");
    for (let i = 0; i < norm.length - 1; i++) {
      const g = norm.slice(i, i + 2);
      m.set(g, (m.get(g) ?? 0) + 1);
    }
    return m;
  };
  const ma = gramsOf(a);
  const mb = gramsOf(b);
  if (ma.size === 0 || mb.size === 0) return 0;
  let overlap = 0;
  let total = 0;
  for (const [, n] of ma) total += n;
  for (const [, n] of mb) total += n;
  for (const [g, n] of ma) {
    const nb = mb.get(g);
    if (nb) overlap += Math.min(n, nb);
  }
  return (2 * overlap) / total;
}

function rowToMemory(r: Record<string, unknown>): MemoryRecord {
  return {
    id: r.id as string,
    kind: r.kind as MemoryRecord["kind"],
    content: r.content as string,
    source: r.source as string,
    sourceRef: (r.source_ref as string | null) ?? undefined,
    confidence: r.confidence as number,
    createdAt: r.created_at as string,
    updatedAt: r.updated_at as string,
  };
}

export class SqliteMemoryEngine implements MemoryEngine {
  private readonly db: Database.Database;
  private readonly privacy: PrivacyFilter;
  private readonly importance: ImportanceEvaluator;
  private readonly threshold: number;
  private readonly dupThreshold: number;

  constructor(opts: SqliteMemoryOptions) {
    this.db = new Database(opts.path);
    this.db.pragma("journal_mode = WAL");
    this.db.pragma("foreign_keys = ON");
    this.privacy = opts.privacyFilter ?? new DefaultPrivacyFilter();
    this.importance = opts.importance ?? new RuleBasedImportance();
    this.threshold = opts.importanceThreshold ?? 0.5;
    this.dupThreshold = opts.duplicateThreshold ?? 0.9;
  }

  migrate(): void {
    runMigrations(this.db, [...ALL_MIGRATIONS, ...(this.extra ?? [])]);
  }
  private extra: Migration[] = [];

  remember(candidate: MemoryCandidate): MemoryRecord | null {
    // 1. 隐私检查（红线：拒绝即不入库）
    const reject = this.privacy.check(candidate);
    if (reject) return null;

    // 2. 重要性评估
    if (this.importance.score(candidate) < this.threshold) return null;

    // 3. 去重：与同 kind 现有记忆比对（字符级相似 + token 相似取大者，
    //    CJK 字级 token 化会稀释 Jaccard，字符 bigram 归一化 Dice 兜底）
    const existing = this.db
      .prepare("SELECT * FROM memories WHERE kind = ?")
      .all(candidate.kind) as Array<Record<string, unknown>>;
    const candTokens = new Set(tokenize(candidate.content));
    for (const row of existing) {
      const tokenSim = jaccard(candTokens, new Set(tokenize(row.content as string)));
      const charSim = diceBigrams(candidate.content, row.content as string);
      if (Math.max(tokenSim, charSim) >= this.dupThreshold) {
        // 重复：刷新时间戳，不新增
        this.db.prepare("UPDATE memories SET updated_at = ? WHERE id = ?").run(
          new Date().toISOString(),
          row.id as string,
        );
        return this.get(row.id as string) ?? null;
      }
    }

    // 4. 入库
    const now = new Date().toISOString();
    const id = `mem_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
    this.db
      .prepare(
        "INSERT INTO memories (id, kind, content, source, source_ref, confidence, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?)",
      )
      .run(
        id,
        candidate.kind,
        candidate.content,
        candidate.source,
        candidate.sourceRef ?? null,
        candidate.confidence ?? 1.0,
        now,
        now,
      );
    return this.get(id) ?? null;
  }

  search(query: string, opts?: { kind?: MemoryRecord["kind"]; limit?: number }): MemorySearchHit[] {
    const qTokens = tokenize(query);
    if (qTokens.length === 0) return [];
    const qSet = new Set(qTokens);

    const rows = (
      opts?.kind
        ? this.db.prepare("SELECT * FROM memories WHERE kind = ?").all(opts.kind)
        : this.db.prepare("SELECT * FROM memories").all()
    ) as Array<Record<string, unknown>>;

    const hits: MemorySearchHit[] = [];
    for (const row of rows) {
      const tokens = new Set(tokenize(row.content as string));
      let score = jaccard(qSet, tokens);
      // 完整短语包含加分
      if ((row.content as string).toLowerCase().includes(query.toLowerCase())) score += 0.3;
      if (score > 0.05) hits.push({ record: rowToMemory(row), score: Math.min(1, score) });
    }
    hits.sort((a, b) => b.score - a.score);
    return hits.slice(0, opts?.limit ?? 10);
  }

  get(id: string): MemoryRecord | undefined {
    const row = this.db.prepare("SELECT * FROM memories WHERE id = ?").get(id) as
      | Record<string, unknown>
      | undefined;
    return row ? rowToMemory(row) : undefined;
  }

  update(id: string, content: string): MemoryRecord | undefined {
    const res = this.db
      .prepare("UPDATE memories SET content = ?, updated_at = ? WHERE id = ?")
      .run(content, new Date().toISOString(), id);
    if (res.changes === 0) return undefined;
    return this.get(id);
  }

  delete(id: string): boolean {
    return this.db.prepare("DELETE FROM memories WHERE id = ?").run(id).changes > 0;
  }

  list(opts?: { kind?: MemoryRecord["kind"] }): MemoryRecord[] {
    const rows = (
      opts?.kind
        ? this.db.prepare("SELECT * FROM memories WHERE kind = ? ORDER BY updated_at DESC").all(opts.kind)
        : this.db.prepare("SELECT * FROM memories ORDER BY updated_at DESC").all()
    ) as Array<Record<string, unknown>>;
    return rows.map(rowToMemory);
  }

  // ---- 对话存储 ----

  createConversation(title: string): ConversationRecord {
    const now = new Date().toISOString();
    const id = `conv_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
    this.db
      .prepare("INSERT INTO conversations (id, title, started_at, last_message_at) VALUES (?,?,?,?)")
      .run(id, title, now, now);
    return { id, title, startedAt: now, lastMessageAt: now };
  }

  appendMessage(conversationId: string, role: MessageRecord["role"], content: string): MessageRecord {
    const now = new Date().toISOString();
    const id = `msg_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
    this.db
      .prepare("INSERT INTO messages (id, conversation_id, role, content, created_at) VALUES (?,?,?,?,?)")
      .run(id, conversationId, role, content, now);
    this.db
      .prepare("UPDATE conversations SET last_message_at = ? WHERE id = ?")
      .run(now, conversationId);
    return { id, conversationId, role, content, createdAt: now };
  }

  listMessages(conversationId: string): MessageRecord[] {
    const rows = this.db
      .prepare("SELECT * FROM messages WHERE conversation_id = ? ORDER BY created_at")
      .all(conversationId) as Array<Record<string, unknown>>;
    return rows.map((r) => ({
      id: r.id as string,
      conversationId: r.conversation_id as string,
      role: r.role as MessageRecord["role"],
      content: r.content as string,
      createdAt: r.created_at as string,
    }));
  }

  listConversations(): ConversationRecord[] {
    const rows = this.db
      .prepare("SELECT * FROM conversations ORDER BY last_message_at DESC")
      .all() as Array<Record<string, unknown>>;
    return rows.map((r) => ({
      id: r.id as string,
      title: r.title as string,
      startedAt: r.started_at as string,
      lastMessageAt: r.last_message_at as string,
    }));
  }

  close(): void {
    this.db.close();
  }
}
