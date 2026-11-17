import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { SqliteMemoryEngine, WikiCompiler } from "@jarvis/memory";
import { MemoryMaintenance } from "./memory-maintenance.js";

let engine: SqliteMemoryEngine;
let root: string;
beforeEach(() => {
  engine = new SqliteMemoryEngine({ path: ":memory:" });
  engine.migrate();
  root = fs.mkdtempSync(path.join(os.tmpdir(), "jarvis-maintenance-"));
});
afterEach(() => {
  engine.close();
  fs.rmSync(root, { recursive: true, force: true });
  vi.restoreAllMocks();
});

describe("MemoryMaintenance", () => {
  it("新会话自动蒸馏并编译 Wiki；无变化时不重复调用", async () => {
    const conv = engine.createConversation("偏好");
    engine.appendMessage(conv.id, "user", "我喜欢咖啡");
    let summaries = 0;
    const maintenance = new MemoryMaintenance({
      engine, rootDir: root,
      summarize: async () => {
        summaries++;
        return '[{"kind":"user_profile","content":"用户喜欢咖啡","confidence":0.95}]';
      },
      synthesize: async () => "概览",
    });
    const first = await maintenance.runOnce();
    expect(first.records).toBe(1);
    expect(first.wikiCompiled).toBe(true);
    expect(engine.list()).toHaveLength(1);
    const second = await maintenance.runOnce();
    expect(second.scanned).toBe(0);
    expect(second.wikiCompiled).toBe(false);
    expect(summaries).toBe(1);
  });

  it("蒸馏失败指数退避，到时间后重试", async () => {
    const conv = engine.createConversation("重试");
    engine.appendMessage(conv.id, "user", "喜欢咖啡");
    let now = 0;
    let calls = 0;
    const maintenance = new MemoryMaintenance({
      engine, rootDir: root, now: () => now, baseBackoffMs: 60_000,
      summarize: async () => { calls++; throw new Error("模型不可用"); },
    });
    expect((await maintenance.runOnce()).errors[0]).toContain("60s 后重试");
    now += 1_000;
    expect((await maintenance.runOnce()).scanned).toBe(0);
    expect(calls).toBe(1);
    now += 60_000;
    expect((await maintenance.runOnce()).errors[0]).toContain("120s 后重试");
    expect(calls).toBe(2);
  });

  it("Wiki 失败保留 dirty，下轮无新对话也重试", async () => {
    const conv = engine.createConversation("偏好");
    engine.appendMessage(conv.id, "user", "我喜欢咖啡");
    vi.spyOn(WikiCompiler.prototype, "compile").mockRejectedValueOnce(new Error("磁盘暂不可写"));
    const maintenance = new MemoryMaintenance({
      engine, rootDir: root,
      summarize: async () => '[{"kind":"user_profile","content":"用户喜欢咖啡","confidence":0.95}]',
    });
    const first = await maintenance.runOnce();
    expect(first.wikiCompiled).toBe(false);
    expect(first.errors[0]).toContain("wiki");
    const second = await maintenance.runOnce();
    expect(second.scanned).toBe(0);
    expect(second.wikiCompiled).toBe(true);
  });

  it("防重入：上一轮未结束时第二轮直接跳过", async () => {
    const conv = engine.createConversation("并发");
    engine.appendMessage(conv.id, "user", "我喜欢咖啡");
    let resolveSummary: ((value: string) => void) | undefined;
    const maintenance = new MemoryMaintenance({
      engine, rootDir: root,
      summarize: () => new Promise<string>((resolve) => { resolveSummary = resolve; }),
    });
    const first = maintenance.runOnce();
    const second = await maintenance.runOnce();
    expect(second.skipped).toBe(true);
    resolveSummary?.('[{"kind":"user_profile","content":"用户喜欢咖啡","confidence":0.95}]');
    expect((await first).skipped).toBe(false);
  });
});
