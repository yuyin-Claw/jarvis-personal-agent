/**
 * SQLite 实现：Task Manager（状态机 + 持久化 + 恢复）
 */
import Database from "better-sqlite3";
import { runMigrations, type Migration } from "./migration-framework.js";
import { M_1763140200_TASKS } from "./schema.js";
import { TRANSITIONS } from "./types.js";
import type { AgentTask, TaskEvent, TaskFilter, TaskManager } from "./types.js";

function rowToTask(r: Record<string, unknown>): AgentTask {
  const result = r.result as string | null;
  return {
    id: r.id as string,
    title: r.title as string,
    goal: r.goal as string,
    status: r.status as AgentTask["status"],
    createdAt: r.created_at as string,
    updatedAt: r.updated_at as string,
    harnessId: (r.harness_id as string | null) ?? null,
    harnessJobId: (r.harness_job_id as string | null) ?? null,
    contextRefs: JSON.parse((r.context_refs as string) || "[]") as string[],
    dependencies: [],
    requiresApproval: Boolean(r.requires_approval),
    result: result ? (JSON.parse(result) as AgentTask["result"]) : null,
  };
}

export interface SqliteTaskManagerOptions {
  path: string;
  /** 复用已打开的连接（与 memory 共库时；接管迁移职责需显式传 extraMigrations=[]） */
  db?: Database.Database;
  extraMigrations?: Migration[];
}

export class SqliteTaskManager implements TaskManager {
  private readonly db: Database.Database;
  private readonly ownsDb: boolean;

  constructor(opts: SqliteTaskManagerOptions) {
    if (opts.db) {
      this.db = opts.db;
      this.ownsDb = false;
    } else {
      this.db = new Database(opts.path);
      this.db.pragma("journal_mode = WAL");
      this.ownsDb = true;
    }
  }

  migrate(): void {
    runMigrations(this.db, [M_1763140200_TASKS]);
  }

  create(input: {
    title: string;
    goal: string;
    requiresApproval?: boolean;
    dependencies?: string[];
    contextRefs?: string[];
  }): AgentTask {
    const now = new Date().toISOString();
    const id = `task_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
    const tx = this.db.transaction(() => {
      this.db
        .prepare(
          "INSERT INTO tasks (id, title, goal, status, created_at, updated_at, context_refs, requires_approval) VALUES (?,?,?,?,?,?,?,?)",
        )
        .run(
          id,
          input.title,
          input.goal,
          "CREATED",
          now,
          now,
          JSON.stringify(input.contextRefs ?? []),
          input.requiresApproval ? 1 : 0,
        );
      for (const dep of input.dependencies ?? []) {
        this.db
          .prepare("INSERT INTO task_dependencies (task_id, depends_on) VALUES (?,?)")
          .run(id, dep);
      }
      this.appendEvent(id, "created", input.goal);
    });
    tx();
    const task = this.get(id);
    if (!task) throw new Error("task 创建后读取失败");
    return task;
  }

  get(id: string): AgentTask | undefined {
    const row = this.db.prepare("SELECT * FROM tasks WHERE id = ?").get(id) as
      | Record<string, unknown>
      | undefined;
    if (!row) return undefined;
    const task = rowToTask(row);
    task.dependencies = (
      this.db
        .prepare("SELECT depends_on FROM task_dependencies WHERE task_id = ?")
        .all(id) as Array<{ depends_on: string }>
    ).map((r) => r.depends_on);
    return task;
  }

  list(filter?: TaskFilter): AgentTask[] {
    let rows: Array<Record<string, unknown>>;
    if (filter?.status) {
      rows = this.db.prepare("SELECT * FROM tasks WHERE status = ? ORDER BY created_at DESC").all(
        filter.status,
      ) as Array<Record<string, unknown>>;
    } else {
      rows = this.db.prepare("SELECT * FROM tasks ORDER BY created_at DESC").all() as Array<
        Record<string, unknown>
      >;
    }
    let tasks = rows.map(rowToTask);
    if (filter?.blockedByDependencies) {
      tasks = tasks.filter((t) => !this.dependenciesMet(t.id));
    }
    return tasks;
  }

  transition(id: string, to: AgentTask["status"], result?: AgentTask["result"]): AgentTask {
    const current = this.get(id);
    if (!current) throw new Error(`任务不存在: ${id}`);
    if (current.status === to) return current; // 幂等：同状态无操作
    const allowed = TRANSITIONS[current.status];
    if (!allowed.includes(to)) {
      throw new Error(`非法状态转换: ${current.status} → ${to}（允许: ${allowed.join(",") || "无"}）`);
    }
    const now = new Date().toISOString();
    this.db
      .prepare("UPDATE tasks SET status = ?, updated_at = ?, result = COALESCE(?, result) WHERE id = ?")
      .run(to, now, result ? JSON.stringify(result) : null, id);
    this.appendEvent(id, "transition", `${current.status} → ${to}`);
    const updated = this.get(id);
    if (!updated) throw new Error("unreachable");
    return updated;
  }

  assign(id: string, harnessId: string, harnessJobId: string): AgentTask {
    this.db
      .prepare("UPDATE tasks SET harness_id = ?, harness_job_id = ?, updated_at = ? WHERE id = ?")
      .run(harnessId, harnessJobId, new Date().toISOString(), id);
    this.appendEvent(id, "assigned", `${harnessId}/${harnessJobId}`);
    const t = this.get(id);
    if (!t) throw new Error("unreachable");
    return t;
  }

  dependenciesMet(id: string): boolean {
    const deps = (
      this.db
        .prepare("SELECT depends_on FROM task_dependencies WHERE task_id = ?")
        .all(id) as Array<{ depends_on: string }>
    ).map((r) => r.depends_on);
    if (deps.length === 0) return true;
    for (const dep of deps) {
      const row = this.db
        .prepare("SELECT status FROM tasks WHERE id = ?")
        .get(dep) as { status: string } | undefined;
      if (!row || row.status !== "COMPLETED") return false;
    }
    return true;
  }

  cancel(id: string): AgentTask {
    const t = this.get(id);
    if (!t) throw new Error(`任务不存在: ${id}`);
    if (t.status === "COMPLETED" || t.status === "CANCELLED") return t; // 终态幂等
    return this.transition(id, "CANCELLED");
  }

  recoverOrphans(): AgentTask[] {
    // 宿主重启后：所有 RUNNING 任务转 BLOCKED（进程状态已失联，等宿主核实）
    const running = this.list({ status: "RUNNING" });
    const blocked: AgentTask[] = [];
    for (const t of running) {
      blocked.push(this.transition(t.id, "BLOCKED"));
      this.appendEvent(t.id, "recovered", "宿主重启，RUNNING → BLOCKED 待核实");
    }
    return blocked;
  }

  appendEvent(taskId: string, type: string, detail: string): void {
    this.db
      .prepare("INSERT INTO task_events (task_id, type, detail, at) VALUES (?,?,?,?)")
      .run(taskId, type, detail, new Date().toISOString());
  }

  listEvents(taskId: string): TaskEvent[] {
    const rows = this.db
      .prepare("SELECT * FROM task_events WHERE task_id = ? ORDER BY id")
      .all(taskId) as Array<Record<string, unknown>>;
    return rows.map((r) => ({
      taskId: r.task_id as string,
      type: r.type as string,
      detail: r.detail as string,
      at: r.at as string,
    }));
  }

  close(): void {
    if (this.ownsDb) this.db.close();
  }
}
