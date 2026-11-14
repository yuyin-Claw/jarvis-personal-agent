/** Task Manager schema：tasks / task_dependencies / task_events（架构 §8） */
import type { Migration } from "./migration-framework.js";

export const M_1763140200_TASKS: Migration = {
  id: 1763140200,
  name: "tasks_dependencies_events",
  up: (db) => {
    db.exec(`CREATE TABLE tasks (
      id TEXT PRIMARY KEY,
      title TEXT NOT NULL,
      goal TEXT NOT NULL,
      status TEXT NOT NULL CHECK (status IN ('CREATED','PLANNED','WAITING_APPROVAL','RUNNING','BLOCKED','COMPLETED','FAILED','CANCELLED')),
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      harness_id TEXT,
      harness_job_id TEXT,
      context_refs TEXT NOT NULL DEFAULT '[]',
      requires_approval INTEGER NOT NULL DEFAULT 0,
      result TEXT
    )`);
    db.exec("CREATE INDEX idx_tasks_status ON tasks(status)");
    db.exec(`CREATE TABLE task_dependencies (
      task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
      depends_on TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
      PRIMARY KEY (task_id, depends_on)
    )`);
    db.exec(`CREATE TABLE task_events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
      type TEXT NOT NULL,
      detail TEXT NOT NULL,
      at TEXT NOT NULL
    )`);
    db.exec("CREATE INDEX idx_task_events_task ON task_events(task_id, id)");
  },
};
