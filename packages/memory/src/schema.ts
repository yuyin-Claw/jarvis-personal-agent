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
    // 词法检索辅助：content 的小写副本（ESR 风格，够用即可，不引 FTS5 依赖面）
    db.exec(`CREATE TABLE memory_links (
      from_id TEXT NOT NULL REFERENCES memories(id) ON DELETE CASCADE,
      to_id TEXT NOT NULL REFERENCES memories(id) ON DELETE CASCADE,
      relation TEXT NOT NULL DEFAULT 'related',
      PRIMARY KEY (from_id, to_id, relation)
    )`);
  },
};

export const ALL_MIGRATIONS = [M_1763140000_CONVERSATIONS, M_1763140100_MEMORIES];
