/** capabilities 表迁移（ADR-011 Step 4.1） */
import type Database from "better-sqlite3";

/** 单个迁移定义（与 memory 包同构；独立定义避免跨包源码 import） */
export interface Migration {
  id: number;
  name: string;
  up: (db: Database.Database) => void;
}

export const ALL_MIGRATIONS: Migration[] = [
  {
    id: 1763232000,
    name: "capabilities 基础表",
    up: (db) => {
      db.exec(`CREATE TABLE capabilities (
        name TEXT NOT NULL,
        version TEXT NOT NULL,
        kind TEXT NOT NULL DEFAULT 'skill',
        entry TEXT NOT NULL,
        description TEXT NOT NULL DEFAULT '',
        enabled INTEGER NOT NULL DEFAULT 1,
        permissions TEXT NOT NULL DEFAULT '[]',
        created_at TEXT NOT NULL,
        health TEXT NOT NULL DEFAULT 'unknown',
        PRIMARY KEY (name, version)
      )`);
      db.exec("CREATE INDEX idx_capabilities_enabled ON capabilities (enabled)");
    },
  },
];
