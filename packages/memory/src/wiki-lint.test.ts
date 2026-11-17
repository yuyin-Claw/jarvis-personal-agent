import { afterEach, beforeEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { SqliteMemoryEngine } from "./sqlite-engine.js";
import { WikiLinter } from "./wiki-lint.js";

let engine: SqliteMemoryEngine;
let root: string;
beforeEach(() => {
  engine = new SqliteMemoryEngine({ path: ":memory:" });
  engine.migrate();
  root = fs.mkdtempSync(path.join(os.tmpdir(), "jarvis-lint-"));
});
afterEach(() => {
  engine.close();
  fs.rmSync(root, { recursive: true, force: true });
});

describe("WikiLinter", () => {
  it("识别过期决策与失效来源，不修改记忆", async () => {
    engine.remember({ kind: "decision", content: "旧决策需要复核", source: "test" });
    engine.remember({ kind: "experience", content: "来源已丢失的经验", source: "user_correction", sourceRef: "conv_missing:msg_missing" });
    // 只有 source=conversation 才校验原始消息；补一条真实失效来源。
    engine.remember({ kind: "decision", content: "来源已丢失的决策", source: "conversation", sourceRef: "conv_missing:msg_missing" });
    const before = engine.list().length;
    const report = await new WikiLinter(engine).lint({ rootDir: root, now: new Date(Date.now() + 100 * 86_400_000) });
    expect(report.issues.some((i) => i.kind === "stale")).toBe(true);
    expect(report.issues.some((i) => i.kind === "missing_source")).toBe(true);
    expect(engine.list()).toHaveLength(before);
    expect(fs.readFileSync(report.lintPath, "utf8")).toContain("Wiki Lint");
  });

  it("规则识别相似主题的正负冲突候选", async () => {
    engine.remember({ kind: "decision", content: "JARVIS 默认使用 GLM 模型", source: "test" });
    engine.remember({ kind: "decision", content: "JARVIS 不再使用 GLM 模型", source: "test" });
    const report = await new WikiLinter(engine).lint({ rootDir: root });
    expect(report.issues.some((i) => i.kind === "conflict")).toBe(true);
    expect(fs.readFileSync(report.lintPath, "utf8")).toContain("可能");
  });

  it("LLM 复核只接受合法 ID 与布尔冲突结果", async () => {
    const a = engine.remember({ kind: "decision", content: "项目默认模型是 GLM", source: "test" })!;
    const b = engine.remember({ kind: "decision", content: "项目默认模型是 DeepSeek", source: "test" })!;
    const report = await new WikiLinter(engine).lint({
      rootDir: root,
      conflictJudge: async () => JSON.stringify([
        { ids: [a.id, b.id], conflict: true },
        { ids: ["mem_fake", b.id], conflict: true },
        { ids: [a.id, b.id], conflict: false },
      ]),
    });
    const conflicts = report.issues.filter((i) => i.kind === "conflict");
    expect(conflicts).toHaveLength(1);
    expect(conflicts[0]!.memoryIds).toEqual([a.id, b.id]);
  });

  it("冲突模型失败时保留规则报告并记录 warning", async () => {
    engine.remember({ kind: "decision", content: "项目默认模型是 GLM", source: "test" });
    engine.remember({ kind: "decision", content: "项目默认模型是 DeepSeek", source: "test" });
    const report = await new WikiLinter(engine).lint({
      rootDir: root,
      conflictJudge: async () => { throw new Error("本地模型不可用"); },
    });
    expect(report.warnings[0]).toContain("本地模型不可用");
    expect(fs.existsSync(report.lintPath)).toBe(true);
  });
});
