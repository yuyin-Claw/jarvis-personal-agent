/** 首批 schema 迁移（架构 §8 核心表子集：0.1 所需） */
import type { Migration } from "./migrations.js";

export const M_1763140000_CONVERSATIONS: Migration = {
  id: 1763140000,
  name: "conversations_messages",
  up: (db) => {
    db.exec(`CREATE TABLE conversations (
      id TEXT PRIMARY KEY,
      title TEXT NOT NULL,
      started_at TEXT NOT NULL,
      last_message_at TEXT NOT NULL
    )`);
    db.exec(`CREATE TABLE messages (
      id TEXT PRIMARY KEY,
      conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
      role TEXT NOT NULL CHECK (role IN ('user','assistant','system')),
      content TEXT NOT NULL,
      created_at TEXT NOT NULL
    )`);
    db.exec("CREATE INDEX idx_messages_conversation ON messages(conversation_id, created_at)");
  },
};

export const M_1763140100_MEMORIES: Migration = {
  id: 1763140100,
  name: "memories_links_decisions",
  up: (db) => {
    db.exec(`CREATE TABLE memories (
      id TEXT PRIMARY KEY,
      kind TEXT NOT NULL CHECK (kind IN ('user_profile','conversation_summary','project','goal','decision','experience')),
      content TEXT NOT NULL,
      source TEXT NOT NULL,
      source_ref TEXT,
      confidence REAL NOT NULL DEFAULT 1.0 CHECK (confidence >= 0 AND confidence <= 1),
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    )`);
    db.exec("CREATE INDEX idx_memories_kind ON memories(kind)");
    db.exec(`CREATE TABLE memory_links (
      from_id TEXT NOT NULL REFERENCES memories(id) ON DELETE CASCADE,
      to_id TEXT NOT NULL REFERENCES memories(id) ON DELETE CASCADE,
      relation TEXT NOT NULL DEFAULT 'related',
      PRIMARY KEY (from_id, to_id, relation)
    )`);
  },
};

/** 0.3：审计独立表（替代 __audit__ 会话 hack） */
export const M_1763140300_AUDIT: Migration = {
  id: 1763140300,
  name: "audit_logs",
  up: (db) => {
    db.exec(`CREATE TABLE audit_logs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      timestamp TEXT NOT NULL,
      actor TEXT NOT NULL,
      kind TEXT NOT NULL,
      target TEXT NOT NULL,
      risk TEXT NOT NULL,
      allowed INTEGER NOT NULL,
      reason TEXT NOT NULL
    )`);
    db.exec("CREATE INDEX idx_audit_time ON audit_logs(timestamp)");
    db.exec("CREATE INDEX idx_audit_allowed ON audit_logs(allowed, timestamp)");
  },
};

/** 0.5：语义向量索引与对话蒸馏水位线 */
export const M_1763140400_MEMORY_SEMANTIC: Migration = {
  id: 1763140400,
  name: "memory_embeddings_distillations",
  up: (db) => {
    db.exec(`CREATE TABLE memory_embeddings (
      memory_id TEXT PRIMARY KEY REFERENCES memories(id) ON DELETE CASCADE,
      model TEXT NOT NULL,
      dimensions INTEGER NOT NULL,
      vector TEXT NOT NULL,
      updated_at TEXT NOT NULL
    )`);
    db.exec(`CREATE TABLE memory_distillations (
      conversation_id TEXT PRIMARY KEY REFERENCES conversations(id) ON DELETE CASCADE,
      last_message_id TEXT NOT NULL,
      created_at TEXT NOT NULL
    )`);
  },
};

export const ALL_MIGRATIONS = [
  M_1763140000_CONVERSATIONS,
  M_1763140100_MEMORIES,
  M_1763140300_AUDIT,
  M_1763140400_MEMORY_SEMANTIC,
];
