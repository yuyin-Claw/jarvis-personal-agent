/** 共享迁移框架（与 memory 包同构；task-manager 独立成包故自带一份） */
import type Database from "better-sqlite3";

export interface Migration {
  id: number;
  name: string;
  up: (db: Database.Database) => void;
}

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
    db.transaction(() => {
      m.up(db);
      insert.run(m.id, m.name);
    })();
    justRan.push(`${m.id}-${m.name}`);
  }
  return justRan;
}
