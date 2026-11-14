/**
 * SQLite 迁移框架（AGENTS.md 迁移规范）
 *
 * - epoch 时间戳命名的迁移列表，按序应用
 * - 幂等：已应用的记录在 migrations 表，重复执行跳过
 * - 每个迁移包在事务里
 */
import type Database from "better-sqlite3";

/** 单个迁移定义 */
export interface Migration {
  /** epoch 秒（同时是排序键与版本号） */
  id: number;
  /** 人类可读名 */
  name: string;
  up: (db: Database.Database) => void;
}

/** 迁移记录表 + 按序应用 */
export function runMigrations(db: Database.Database, migrations: Migration[]): string[] {
  db.exec(`CREATE TABLE IF NOT EXISTS migrations (
    id INTEGER PRIMARY KEY,
    name TEXT NOT NULL,
    applied_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
  )`);

  const applied = new Set(
    (db.prepare("SELECT id FROM migrations").all() as Array<{ id: number }>).map((r) => r.id),
  );

  const justRan: string[] = [];
  const insert = db.prepare("INSERT INTO migrations (id, name) VALUES (?, ?)");

  for (const m of [...migrations].sort((a, b) => a.id - b.id)) {
    if (applied.has(m.id)) continue;
    const tx = db.transaction(() => {
      m.up(db);
      insert.run(m.id, m.name);
    });
    tx();
    justRan.push(`${m.id}-${m.name}`);
  }
  return justRan;
}
