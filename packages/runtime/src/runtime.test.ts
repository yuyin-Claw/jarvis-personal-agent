import { describe, expect, it } from "vitest";
import { ContinuousRuntime, ProactiveEngine, findStagnantTasks, type ProactiveNotice, type RuntimeEvent } from "./index.js";
import type { TaskManager } from "@jarvis/task-manager";
import { SqliteTaskManager } from "@jarvis/task-manager";

function notice(over: Partial<ProactiveNotice> = {}): ProactiveNotice {
  return { text: "测试通知", priority: "normal", dedupeKey: "k1", at: new Date().toISOString(), ...over };
}

function must<T>(v: T | null | undefined): T {
  if (v === null || v === undefined) throw new Error("unexpected null");
  return v;
}

describe("ProactiveEngine 裁决", () => {
  it("正常放行并记账", () => {
    const p = new ProactiveEngine({});
    expect(p.decide(notice())).toEqual({ allow: true });
  });

  it("同 key 冷却期内拒绝", () => {
    let t = 1_000_000_000;
    const p = new ProactiveEngine({ dedupeCooldownMs: 3_600_000 }, () => new Date(t));
    expect(p.decide(notice()).allow).toBe(true);
    t += 60_000; // 1 分钟后
    expect(p.decide(notice())).toEqual({ allow: false, reason: expect.stringContaining("冷却") });
    t += 3_600_000; // 冷却过后
    expect(p.decide(notice()).allow).toBe(true);
  });

  it("每日限额", () => {
    let t = 1_000_000_000;
    const p = new ProactiveEngine({ dailyLimit: 2 }, () => new Date(t));
    expect(p.decide(notice({ dedupeKey: "a" })).allow).toBe(true);
    expect(p.decide(notice({ dedupeKey: "b" })).allow).toBe(true);
    const r = p.decide(notice({ dedupeKey: "c" }));
    expect(r.allow).toBe(false);
    if (!r.allow) expect(r.reason).toContain("上限");
    t += 24 * 3600_000; // 次日重置
    expect(p.decide(notice({ dedupeKey: "d" })).allow).toBe(true);
  });

  it("静默时段抑制 normal/low，放行 high", () => {
    const nightHour = () => new Date(2026, 0, 1, 23, 30); // 23:30
    const p = new ProactiveEngine({ quietHours: { startHour: 23, endHour: 7 } }, nightHour);
    expect(p.decide(notice({ priority: "normal" })).allow).toBe(false);
    expect(p.decide(notice({ priority: "low" })).allow).toBe(false);
    expect(p.decide(notice({ priority: "high", dedupeKey: "h1" })).allow).toBe(true);
  });

  it("跨零点静默时段（23-7）", () => {
    const at2am = () => new Date(2026, 0, 1, 2, 0);
    const p = new ProactiveEngine({ quietHours: { startHour: 23, endHour: 7 } }, at2am);
    expect(p.decide(notice()).allow).toBe(false);
  });
});

describe("ContinuousRuntime", () => {
  function fakeScheduler() {
    const timers = new Map<() => void, ReturnType<typeof setTimeout>>();
    return {
      setInterval: (fn: () => void, ms: number) => {
        const h = setTimeout(fn, ms);
        timers.set(fn, h);
        return h;
      },
      clearInterval: (h: unknown) => {
        clearTimeout(h as ReturnType<typeof setTimeout>);
      },
    };
  }

  it("schedule 注册 job 且可立即执行（事件流）", async () => {
    const events: RuntimeEvent[] = [];
    const rt = new ContinuousRuntime({ channels: [], scheduler: fakeScheduler() });
    rt.onEvent((e) => events.push(e));
    let ran = 0;
    rt.schedule({
      id: "job1",
      name: "检查",
      intervalMs: 3_600_000,
      run: async () => {
        ran++;
      },
    });
    expect(rt.jobIds).toContain("job1");
    const job = rt.getJob("job1");
    must(job);
    await rt.runJob(job);
    expect(ran).toBe(1);
    const started = events.find((e) => e.type === "job_started");
    const finished = events.find((e) => e.type === "job_finished");
    expect(started).toBeDefined();
    expect(finished && finished.type === "job_finished" && finished.ok).toBe(true);
    rt.stop();
  });

  it("job 抛错不炸 runtime，记 job_finished ok=false", async () => {
    const events: RuntimeEvent[] = [];
    const rt = new ContinuousRuntime({ channels: [], scheduler: fakeScheduler() });
    rt.onEvent((e) => events.push(e));
    rt.schedule({
      id: "bad",
      name: "会失败",
      intervalMs: 3_600_000,
      run: async () => {
        throw new Error("boom");
      },
    });
    await rt.runJob(must(rt.getJob("bad")));
    const failed = events.find((e) => e.type === "job_finished" && !e.ok);
    expect(failed).toBeDefined();
    expect(failed && failed.type === "job_finished" && failed.error).toContain("boom");
    rt.stop();
  });

  it("notify：裁决通过则送达所有通道", async () => {
    const sent: ProactiveNotice[] = [];
    const rt = new ContinuousRuntime({
      channels: [{ send: async (n) => sent.push(n) }],
    });
    const ok = await rt.notify(notice());
    expect(ok).toBe(true);
    expect(sent).toHaveLength(1);
    expect(sent[0]?.text).toBe("测试通知");
  });

  it("notify：被抑制时通道不触发", async () => {
    const sent: ProactiveNotice[] = [];
    let t = 1_000_000_000;
    const rt = new ContinuousRuntime(
      { channels: [{ send: async (n) => sent.push(n) }], policy: { dedupeCooldownMs: 3_600_000 } },
      { now: () => new Date(t) },
    );
    await rt.notify(notice());
    t += 1000;
    const ok = await rt.notify(notice());
    expect(ok).toBe(false);
    expect(sent).toHaveLength(1);
  });

  it("heartbeat 计数", () => {
    const rt = new ContinuousRuntime({ channels: [] });
    rt.heartbeat();
    rt.heartbeat();
    expect(rt.heartbeatTotal).toBe(2);
  });

  it("stop 清空任务", () => {
    const rt = new ContinuousRuntime({ channels: [], scheduler: fakeScheduler() });
    rt.schedule({ id: "j", name: "n", intervalMs: 1000, run: async () => undefined });
    rt.stop();
    expect(rt.jobIds).toHaveLength(0);
  });
});

describe("停滞检测", () => {
  function makeTm(): TaskManager {
    const tm = new SqliteTaskManager({ path: ":memory:" });
    tm.migrate();
    return tm;
  }

  it("RUNNING 超 24h 判停滞；CREATED/终态不判", () => {
    const tm = makeTm();
    const stale = tm.create({ title: "停滞任务", goal: "g" });
    tm.transition(stale.id, "PLANNED");
    tm.transition(stale.id, "RUNNING");
    const fresh = tm.create({ title: "新任务", goal: "g" });
    const done = tm.create({ title: "完成", goal: "g" });
    tm.transition(done.id, "PLANNED");
    tm.transition(done.id, "RUNNING");
    tm.transition(done.id, "COMPLETED", { finishedAt: new Date().toISOString() });
    void fresh;

    const reports = findStagnantTasks(tm, { now: () => new Date(Date.now() + 25 * 3600_000) });
    expect(reports.map((r) => r.task.id)).toContain(stale.id);
    expect(reports.map((r) => r.task.id)).not.toContain(done.id);
    expect(reports[0]?.lastEvent).toBeDefined();
  });

  it("未超阈值不判停滞", () => {
    const tm = makeTm();
    const t = tm.create({ title: "活跃", goal: "g" });
    tm.transition(t.id, "PLANNED");
    tm.transition(t.id, "RUNNING");
    const reports = findStagnantTasks(tm, { now: () => new Date() });
    expect(reports).toHaveLength(0);
  });
});
