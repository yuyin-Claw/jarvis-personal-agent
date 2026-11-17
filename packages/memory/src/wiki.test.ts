import { afterEach, beforeEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { SqliteMemoryEngine } from "./sqlite-engine.js";
import { WikiCompiler } from "./wiki.js";

let engine: SqliteMemoryEngine;
let root: string;

beforeEach(() => {
  engine = new SqliteMemoryEngine({ path: ":memory:" });
  engine.migrate();
  root = fs.mkdtempSync(path.join(os.tmpdir(), "jarvis-wiki-"));
});

afterEach(() => {
  engine.close();
  fs.rmSync(root, { recursive: true, force: true });
});

describe("WikiCompiler", () => {
  it("生成项目/决策/经验/偏好页面、来源与 wikilink，并使用 LLM 概览", async () => {
    const decision = engine.remember({ kind: "decision", content: "JARVIS 决定使用本地模型", source: "conversation", sourceRef: "conv_1:msg_1" })!;
    engine.remember({ kind: "experience", content: "invoke_ui 超时必须全链有界", source: "user_correction", sourceRef: "conv_1:msg_2" });
    engine.remember({ kind: "project", content: "JARVIS 是 Omarchy 个人助理", source: "test" });
    engine.remember({ kind: "user_profile", content: "用户喜欢咖啡", source: "test" });
    const compiler = new WikiCompiler(engine);
    const result = await compiler.compile({ rootDir: root, synthesize: async () => "## 当前重点\n本地模型" });
    expect(result.overviewMode).toBe("llm");
    expect(result.recordCount).toBe(4);
    const decisionPage = fs.readFileSync(path.join(root, "decisions", `${decision.id}.md`), "utf8");
    expect(decisionPage).toContain("source_ref: \"conv_1:msg_1\"");
    expect(decisionPage).toContain("invoke_ui 超时必须全链有界");
    expect(decisionPage).toContain("[[experiences/");
    expect(fs.readFileSync(path.join(root, "user", "preferences.md"), "utf8")).toContain("用户喜欢咖啡");
    expect(fs.readFileSync(path.join(root, "overview.md"), "utf8")).toContain("本地模型");
    expect(fs.existsSync(path.join(root, ".jarvis-wiki-manifest.json"))).toBe(true);
  });

  it("LLM 失败时回退确定性概览，不影响页面生成", async () => {
    engine.remember({ kind: "project", content: "JARVIS 项目", source: "test" });
    const result = await new WikiCompiler(engine).compile({
      rootDir: root,
      synthesize: async () => { throw new Error("本地模型不可用"); },
    });
    expect(result.overviewMode).toBe("deterministic-fallback");
    expect(fs.readFileSync(path.join(root, "overview.md"), "utf8")).toContain("当前共有 1 条长期记忆");
  });

  it("重编译只清理旧 manifest 页面，保留用户自定义文件", async () => {
    const record = engine.remember({ kind: "decision", content: "待删除决策", source: "test" })!;
    const compiler = new WikiCompiler(engine);
    await compiler.compile({ rootDir: root });
    const custom = path.join(root, "notes.md");
    fs.writeFileSync(custom, "我的笔记");
    engine.delete(record.id);
    await compiler.compile({ rootDir: root });
    expect(fs.existsSync(path.join(root, "decisions", `${record.id}.md`))).toBe(false);
    expect(fs.readFileSync(custom, "utf8")).toBe("我的笔记");
  });

  it("记忆正文中的 HTML 与伪 wikilink 被转义", async () => {
    const record = engine.remember({ kind: "experience", content: "<script>alert(1)</script> [[恶意链接]]", source: "user_correction" })!;
    await new WikiCompiler(engine).compile({ rootDir: root });
    const page = fs.readFileSync(path.join(root, "experiences", `${record.id}.md`), "utf8");
    expect(page).not.toContain("<script>");
    expect(page).toContain("&lt;script&gt;");
    expect(page).toContain("\\[\\[恶意链接\\]\\]");
  });
});
