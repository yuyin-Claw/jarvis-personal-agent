import { beforeEach, describe, expect, it } from "vitest";
import os from "node:os";
import path from "node:path";
import fs from "node:fs";
import type Database from "better-sqlite3";
import { SqliteTaskManager, TRANSITIONS } from "./index.js";
import type { TaskStatus } from "./index.js";

function must<T>(v: T | null | undefined): T {
  if (v === null || v === undefined) throw new Error("unexpected null");
  return v;
}

let tm: SqliteTaskManager;

beforeEach(() => {
  tm = new SqliteTaskManager({ path: ":memory:" });
  tm.migrate();
});

describe("状态机", () => {
  it("转换表全覆盖：每条合法边可走、非法边抛错", () => {
    for (const from of Object.keys(TRANSITIONS) as TaskStatus[]) {
      const allowed = TRANSITIONS[from];
      const all = Object.keys(TRANSITIONS) as TaskStatus[];
      for (const to of all) {
        const t = tm.create({ title: `t-${from}-${to}`, goal: "g" });
        // 直接改库到 from 状态（绕过链式），再测单边
        const raw = (tm as unknown as { db: Database.Database }).db;
        raw.prepare("UPDATE tasks SET status = ? WHERE id = ?").run(from, t.id);
        if (from === to) {
          expect(() => tm.transition(t.id, to)).not.toThrow(); // 幂等
        } else if (allowed.includes(to)) {
          expect(() => tm.transition(t.id, to)).not.toThrow();
        } else if (to === "CANCELLED" && from !== "COMPLETED" && from !== "CANCELLED") {
          // cancel() 特例：非终态可取消——但 transition 直调仍按转换表，
          // CANCELLED 只在允许列表或有 cancel() 豁免时可达
          if (allowed.includes("CANCELLED")) {
            expect(() => tm.transition(t.id, to)).not.toThrow();
          } else {
            expect(() => tm.transition(t.id, to)).toThrow(/非法状态转换/);
          }
        } else {
          expect(() => tm.transition(t.id, to)).toThrow(/非法状态转换/);
        }
      }
    }
  });

  it("完整生命周期：CREATED→PLANNED→RUNNING→COMPLETED", () => {
    const t = tm.create({ title: "开发工具", goal: "写一个 CLI 小工具" });
    expect(t.status).toBe("CREATED");
    const t2 = tm.transition(t.id, "PLANNED");
    const t3 = tm.transition(t2.id, "RUNNING");
    const t4 = tm.transition(t3.id, "COMPLETED", {
      output: "dist/cli.js",
      finishedAt: new Date().toISOString(),
    });
    expect(t4.status).toBe("COMPLETED");
    expect(t4.result?.output).toBe("dist/cli.js");
    // 终态不可再转
    expect(() => tm.transition(t.id, "RUNNING")).toThrow(/非法状态转换/);
  });

  it("失败重试：FAILED → PLANNED → RUNNING", () => {
    const t = tm.create({ title: "x", goal: "g" });
    tm.transition(t.id, "PLANNED");
    tm.transition(t.id, "RUNNING");
    tm.transition(t.id, "FAILED", { error: "超时", finishedAt: new Date().toISOString() });
    const retried = tm.transition(t.id, "PLANNED");
    expect(retried.status).toBe("PLANNED");
    expect(tm.transition(t.id, "RUNNING").status).toBe("RUNNING");
  });

  it("审批门：requiresApproval 任务 WAITING_APPROVAL", () => {
    const t = tm.create({ title: "高危", goal: "删库", requiresApproval: true });
    const t2 = tm.transition(t.id, "PLANNED");
    const t3 = tm.transition(t2.id, "WAITING_APPROVAL");
    expect(t3.requiresApproval).toBe(true);
    expect(tm.transition(t.id, "RUNNING").status).toBe("RUNNING");
  });
});

describe("依赖关系", () => {
  it("依赖未完成时 dependenciesMet=false", () => {
    const a = tm.create({ title: "A", goal: "ga" });
    const b = tm.create({ title: "B", goal: "gb", dependencies: [a.id] });
    expect(tm.dependenciesMet(b.id)).toBe(false);
    tm.transition(a.id, "PLANNED");
    tm.transition(a.id, "RUNNING");
    expect(tm.dependenciesMet(b.id)).toBe(false);
    tm.transition(a.id, "COMPLETED", { finishedAt: new Date().toISOString() });
    expect(tm.dependenciesMet(b.id)).toBe(true);
  });

  it("无依赖任务恒满足", () => {
    const t = tm.create({ title: "solo", goal: "g" });
    expect(tm.dependenciesMet(t.id)).toBe(true);
  });

  it("blockedByDependencies 过滤器", () => {
    const a = tm.create({ title: "A", goal: "ga" });
    tm.create({ title: "B", goal: "gb", dependencies: [a.id] });
    const blocked = tm.list({ blockedByDependencies: true });
    // A 自身无依赖满足；B 被 A 阻塞（A 未完成，A 也会出现在 blocked 列表？不会——A 无依赖）
    expect(blocked.map((t) => t.title)).toContain("B");
    expect(blocked.map((t) => t.title)).not.toContain("A");
  });
});

describe("持久化与恢复（0.1 验收：重启后状态恢复）", () => {
  it("新实例读旧库：状态与事件完整", () => {
    const dbFile = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "jarvis-tm-")), "tasks.db");
    const fileTm = new SqliteTaskManager({ path: dbFile });
    fileTm.migrate();
    const t = fileTm.create({ title: "持久", goal: "g" });
    fileTm.transition(t.id, "PLANNED");
    fileTm.assign(t.id, "glm-coding", "job_123");
    fileTm.close(); // 模拟进程退出

    // 模拟重启：新实例开同一个库
    const tm2 = new SqliteTaskManager({ path: dbFile });
    tm2.migrate();
    const restored = tm2.get(t.id);
    expect(restored?.status).toBe("PLANNED");
    expect(restored?.harnessId).toBe("glm-coding");
    expect(restored?.harnessJobId).toBe("job_123");
    expect(tm2.listEvents(t.id).length).toBeGreaterThanOrEqual(3);
    tm2.close();
    fs.rmSync(path.dirname(dbFile), { recursive: true, force: true });
  });

  it("recoverOrphans：宿主重启后 RUNNING → BLOCKED", () => {
    const a = tm.create({ title: "运行中", goal: "g" });
    tm.transition(a.id, "PLANNED");
    tm.transition(a.id, "RUNNING");
    const b = tm.create({ title: "已完成", goal: "g" });
    tm.transition(b.id, "PLANNED");
    tm.transition(b.id, "RUNNING");
    tm.transition(b.id, "COMPLETED", { finishedAt: new Date().toISOString() });

    const orphans = tm.recoverOrphans();
    expect(orphans).toHaveLength(1);
    expect(orphans[0]?.id).toBe(a.id);
    expect(orphans[0]?.status).toBe("BLOCKED");
    // 完成任务不受影响
    expect(must(tm.get(b.id)).status).toBe("COMPLETED");
    // BLOCKED 可恢复执行
    expect(tm.transition(a.id, "RUNNING").status).toBe("RUNNING");
  });
});

describe("取消", () => {
  it("非终态任务可取消，终态幂等", () => {
    const t = tm.create({ title: "c", goal: "g" });
    expect(tm.cancel(t.id).status).toBe("CANCELLED");
    expect(tm.cancel(t.id).status).toBe("CANCELLED"); // 幂等
    const t2 = tm.create({ title: "c2", goal: "g" });
    tm.transition(t2.id, "PLANNED");
    tm.transition(t2.id, "RUNNING");
    expect(tm.cancel(t2.id).status).toBe("CANCELLED");
  });
});

describe("事件审计", () => {
  it("全生命周期事件按序记录", () => {
    const t = tm.create({ title: "e", goal: "g" });
    tm.transition(t.id, "PLANNED");
    tm.transition(t.id, "RUNNING");
    const events = tm.listEvents(t.id);
    expect(events.map((e) => e.type)).toEqual(["created", "transition", "transition"]);
  });
});
