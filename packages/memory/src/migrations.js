/** 迁移记录表 + 按序应用 */
export function runMigrations(db, migrations) {
    db.exec(`CREATE TABLE IF NOT EXISTS migrations (
    id INTEGER PRIMARY KEY,
    name TEXT NOT NULL,
    applied_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
  )`);
    const applied = new Set(db.prepare("SELECT id FROM migrations").all().map((r) => r.id));
    const justRan = [];
    const insert = db.prepare("INSERT INTO migrations (id, name) VALUES (?, ?)");
    for (const m of [...migrations].sort((a, b) => a.id - b.id)) {
        if (applied.has(m.id))
            continue;
        const tx = db.transaction(() => {
            m.up(db);
            insert.run(m.id, m.name);
        });
        tx();
        justRan.push(`${m.id}-${m.name}`);
    }
    return justRan;
}
//# sourceMappingURL=migrations.js.map