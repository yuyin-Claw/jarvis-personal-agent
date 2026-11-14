import { beforeEach, describe, expect, it } from "vitest";
import Database from "better-sqlite3";
import { ContextEngine, DefaultDetailSanitizer } from "./context-engine.js";
import { MacForegroundWithTitleSource } from "./macos-foreground.js";
import type { ActivityEvent, AwarenessSource } from "./context-engine.js";

function ev(over: Partial<ActivityEvent> = {}): ActivityEvent {
  return { source: "test", kind: "app_focus", app: "Code", at: new Date().toISOString(), ...over };
}

let db: Database.Database;
let engine: ContextEngine;

beforeEach(() => {
  db = new Database(":memory:");
  engine = new ContextEngine({ db });
  engine.migrate();
});

describe("ContextEngine", () => {
  it("正常入库并计数", () => {
    expect(engine.record(ev())).toBe(true);
    expect(engine.count()).toBe(1);
  });

  it("折叠：同 source+app+kind 且 detail 相同在窗口内不重复", () => {
    const t0 = new Date("2026-11-15T10:00:00Z").toISOString();
    engine.record(ev({ at: t0, detail: "main.ts" }));
    // 2 分钟后同内容 → 折叠
    expect(engine.record(ev({ at: new Date("2026-11-15T10:02:00Z").toISOString(), detail: "main.ts" }))).toBe(false);
    expect(engine.count()).toBe(1);
    // detail 变化 → 不折叠
    expect(engine.record(ev({ at: new Date("2026-11-15T10:03:00Z").toISOString(), detail: "other.ts" }))).toBe(true);
    // 窗口外同内容 → 不折叠
    expect(engine.record(ev({ at: new Date("2026-11-15T10:30:00Z").toISOString(), detail: "main.ts" }))).toBe(true);
    expect(engine.count()).toBe(3);
  });

  it("脱敏：敏感标题整条拒收 detail（app 仍记录）", () => {
    const ok = engine.record(ev({ app: "Safari", detail: "微信 - 张三" }));
    expect(ok).toBe(true);
    const row = db.prepare("SELECT detail FROM activities").get() as { detail: string | null };
    expect(row.detail).toBeNull(); // detail 被拒 → 存 null
  });

  it("脱敏：邮箱与长数字替换", () => {
    const s = new DefaultDetailSanitizer();
    expect(s.sanitize("给 someone@example.com 的邮件")).toBe("给 [邮箱] 的邮件");
    expect(s.sanitize("订单号 123456789012")).toBe("订单号 [数字]");
    expect(s.sanitize("正常标题 README.md - 项目")).toBe("正常标题 README.md - 项目");
  });

  it("sampleFrom：源返回事件则入库", async () => {
    const src: AwarenessSource = {
      id: "fake",
      sample: async () => ev({ app: "Terminal" }),
    };
    expect(await engine.sampleFrom(src)).toBe(true);
    // 源抛错 → false 不炸
    const bad: AwarenessSource = {
      id: "bad",
      sample: async () => {
        throw new Error("nope");
      },
    };
    expect(await engine.sampleFrom(bad)).toBe(false);
  });

  it("summarize 聚合与排序", () => {
    const t = (h: number) => new Date(`2026-11-15T${String(h).padStart(2, "0")}:00:00Z`).toISOString();
    engine.record(ev({ app: "Code", at: t(9), detail: "a.ts" }));
    engine.record(ev({ app: "Code", at: t(10), detail: "b.ts" }));
    engine.record(ev({ app: "Safari", at: t(10) }));
    const sums = engine.summarize(t(9), t(11));
    expect(sums[0]?.app).toBe("Code");
    expect(sums[0]?.hits).toBe(2);
    expect(sums[0]?.details).toEqual(["a.ts", "b.ts"]);
    expect(sums[1]?.app).toBe("Safari");
  });

  it("currentContext：最近窗口内 top5", () => {
    const now = Date.now();
    engine.record(ev({ app: "Now", at: new Date(now).toISOString() }));
    engine.record(ev({ app: "Old", at: new Date(now - 2 * 3600_000).toISOString() }));
    const ctx = engine.currentContext(30);
    expect(ctx.map((c) => c.app)).toContain("Now");
    expect(ctx.map((c) => c.app)).not.toContain("Old");
  });

  it("purge：用户清空", () => {
    engine.record(ev());
    engine.record(ev({ app: "X" }));
    expect(engine.purge()).toBe(2);
    expect(engine.count()).toBe(0);
  });
});

describe("MacForegroundWithTitleSource", () => {
  it("解析 osascript 输出（注入 exec + platform 参数）", async () => {
    const src = new MacForegroundWithTitleSource(
      async () => ({
        stdout: "Safari|GitHub · scala/scala",
        stderr: "",
      }),
      "darwin",
    );
    const result = await src.sample();
    expect(result?.app).toBe("Safari");
    expect(result?.detail).toBe("GitHub · scala/scala");
  });

  it("exec 失败返回 null", async () => {
    const src = new MacForegroundWithTitleSource(
      async () => {
        throw new Error("osascript denied");
      },
      "darwin",
    );
    expect(await src.sample()).toBeNull();
  });

  it("非 darwin 平台直接 null（不 exec）", async () => {
    let called = false;
    const src = new MacForegroundWithTitleSource(
      async () => {
        called = true;
        return { stdout: "x|y", stderr: "" };
      },
      "linux",
    );
    expect(await src.sample()).toBeNull();
    expect(called).toBe(false);
  });

  it("标题源无辅助权限时降级 Swift 取 app 名", async () => {
    const src = new MacForegroundWithTitleSource(
      async (cmd) => {
        if (cmd === "osascript") throw new Error("权限违例");
        return { stdout: "WorkBuddy\n", stderr: "" }; // swift
      },
      "darwin",
    );
    const r = await src.sample();
    expect(r?.app).toBe("WorkBuddy");
    expect(r?.detail).toBeUndefined();
  });

  it("MacForegroundSource：Swift 输出直接采", async () => {
    const { MacForegroundSource } = await import("./macos-foreground.js");
    const src = new MacForegroundSource(async () => ({ stdout: "Safari\n", stderr: "" }), "darwin");
    const r = await src.sample();
    expect(r?.app).toBe("Safari");
  });
});
