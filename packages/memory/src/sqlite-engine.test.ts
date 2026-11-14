import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type Database from "better-sqlite3";
import {
  ALL_MIGRATIONS,
  DefaultPrivacyFilter,
  RuleBasedImportance,
  SqliteMemoryEngine,
  runMigrations,
} from "./index.js";

/** 测试辅助：访问私有 db */
function rawDb(eng: SqliteMemoryEngine): Database.Database {
  return (eng as unknown as { db: Database.Database }).db;
}

/** 测试辅助：断言非空 */
function must<T>(v: T | null | undefined): T {
  if (v === null || v === undefined) throw new Error("unexpected null");
  return v;
}

let engine: SqliteMemoryEngine;

beforeEach(() => {
  engine = new SqliteMemoryEngine({ path: ":memory:" });
  engine.migrate();
});

afterEach(() => {
  engine.close();
});

describe("迁移框架", () => {
  it("幂等：重复 migrate 不重复应用", () => {
    const ran1 = runMigrations(rawDb(engine), ALL_MIGRATIONS);
    expect(ran1).toHaveLength(0); // beforeEach 已应用
  });

  it("表结构存在", () => {
    const tables = (
      rawDb(engine).prepare("SELECT name FROM sqlite_master WHERE type='table'").all() as Array<{
        name: string;
      }>
    ).map((t) => t.name);
    for (const t of ["conversations", "messages", "memories", "memory_links", "migrations"]) {
      expect(tables).toContain(t);
    }
  });
});

describe("记忆写入管道", () => {
  it("正常入库：decision 类型带完整字段", () => {
    const rec = engine.remember({
      kind: "decision",
      content: "项目命名定为 JARVIS Personal Agent",
      source: "conversation",
      sourceRef: "conv_1/msg_1",
      confidence: 1.0,
    });
    expect(rec).not.toBeNull();
    expect(rec?.content).toContain("JARVIS");
    expect(rec?.kind).toBe("decision");
    expect(rec?.sourceRef).toBe("conv_1/msg_1");
  });

  it("隐私过滤：API 密钥被拒绝入库", () => {
    const rec = engine.remember({
      kind: "user_profile",
      content: "我的密钥是 sk-abcdefgh12345678 帮我记住",
      source: "conversation",
    });
    expect(rec).toBeNull();
    expect(engine.list()).toHaveLength(0);
  });

  it("隐私过滤：明文密码被拒绝", () => {
    expect(
      engine.remember({ kind: "user_profile", content: "密码: hunter2forever", source: "conversation" }),
    ).toBeNull();
  });

  it("重要性过滤：过短无信息量候选被丢弃", () => {
    expect(engine.remember({ kind: "experience", content: "嗯", source: "conversation" })).toBeNull();
  });

  it("去重：高相似记忆不重复入库，刷新时间戳", () => {
    const first = engine.remember({
      kind: "goal",
      content: "用户希望三个月内完成 JARVIS 0.1 版本发布",
      source: "conversation",
    });
    expect(first).not.toBeNull();
    const before = engine.list();
    expect(before).toHaveLength(1);
    const t0 = must(before[0]).updatedAt;
    const dup = engine.remember({
      kind: "goal",
      content: "用户希望三个月内完成 JARVIS 0.1 版本的发布",
      source: "conversation",
    });
    expect(engine.list()).toHaveLength(1);
    expect(dup?.id).toBe(first?.id); // 返回同一条
    expect(dup?.updatedAt >= t0).toBe(true); // 时间戳已刷新
  });

  it("用户纠正：update 修改内容", () => {
    const rec = engine.remember({ kind: "user_profile", content: "用户住在上海", source: "conversation" });
    const updated = engine.update(must(rec).id, "用户住在深圳（本人纠正）");
    expect(must(updated).content).toContain("深圳");
  });

  it("用户删除：delete 生效", () => {
    const rec = engine.remember({
      kind: "decision",
      content: "用户偏好正式直接的沟通风格",
      source: "conversation",
    });
    expect(rec).not.toBeNull();
    expect(engine.delete(must(rec).id)).toBe(true);
    expect(engine.get(must(rec).id)).toBeUndefined();
    expect(engine.delete(must(rec).id)).toBe(false);
  });
});

describe("词法检索", () => {
  beforeEach(() => {
    engine.remember({ kind: "project", content: "JARVIS 项目基于 TypeScript 和 pnpm 单仓开发", source: "conversation" });
    engine.remember({ kind: "goal", content: "三个月内发布 JARVIS 0.1 版本", source: "conversation" });
    engine.remember({ kind: "user_profile", content: "用户喜欢喝手冲咖啡", source: "conversation" });
  });

  it("命中相关记忆并排序", () => {
    const hits = engine.search("JARVIS 项目 用什么技术栈");
    expect(hits.length).toBeGreaterThan(0);
    expect(hits[0]?.record.kind).toBe("project");
    expect(hits[0]?.score).toBeGreaterThan(0);
  });

  it("按 kind 过滤", () => {
    const hits = engine.search("JARVIS", { kind: "goal" });
    expect(hits.every((h) => h.record.kind === "goal")).toBe(true);
  });

  it("无命中返回空", () => {
    expect(engine.search("量子物理")).toHaveLength(0);
  });

  it("中文分词检索正常", () => {
    const hits = engine.search("咖啡");
    expect(hits[0]?.record.content).toContain("咖啡");
  });
});

describe("对话存储", () => {
  it("完整对话流：创建→追加→按序读取", () => {
    const conv = engine.createConversation("测试对话");
    engine.appendMessage(conv.id, "user", "你好");
    engine.appendMessage(conv.id, "assistant", "你好，我是 JARVIS");
    engine.appendMessage(conv.id, "user", "记住我用 GLM 模型");
    const msgs = engine.listMessages(conv.id);
    expect(msgs).toHaveLength(3);
    expect(msgs[0]?.role).toBe("user");
    expect(msgs[2]?.content).toContain("GLM");
    expect(engine.listConversations()).toHaveLength(1);
  });

  it("lastMessageAt 随消息更新", async () => {
    const conv = engine.createConversation("t");
    const t0 = conv.lastMessageAt;
    await new Promise((r) => setTimeout(r, 15));
    engine.appendMessage(conv.id, "user", "hi");
    const after = must(engine.listConversations()[0]);
    expect(after.lastMessageAt > t0).toBe(true);
  });
});

describe("跨会话召回（0.1 验收场景③的存储层）", () => {
  it("会话 A 存入的事实，会话 B 检索得到", () => {
    // 会话 A
    const convA = engine.createConversation("会话A");
    engine.appendMessage(convA.id, "user", "我们项目模型用 GLM，别用别的");
    engine.remember({
      kind: "decision",
      content: "模型服务确定使用智谱 GLM（用户明确指定）",
      source: "conversation",
      sourceRef: `${convA.id}`,
    });

    // 会话 B：新对话中检索
    const hits = engine.search("模型用什么");
    expect(hits.length).toBeGreaterThan(0);
    expect(hits[0]?.record.content).toContain("GLM");
  });
});

describe("默认组件单元", () => {
  it("隐私过滤器各规则", () => {
    const f = new DefaultPrivacyFilter();
    expect(f.check({ kind: "user_profile", content: "x", source: "s" })).toBeNull();
    expect(f.check({ kind: "user_profile", content: "卡号 6222020000000000000", source: "s" })).toContain("银行卡");
    expect(f.check({ kind: "user_profile", content: "token 是 ghp_abcdefghij123456", source: "s" })).toContain("密钥");
  });

  it("重要性评估各类别", () => {
    const e = new RuleBasedImportance();
    expect(e.score({ kind: "decision", content: "正常长度的决策内容", source: "conversation" })).toBeGreaterThan(
      0.5,
    );
    expect(e.score({ kind: "experience", content: "太短", source: "conversation" })).toBeLessThan(0.5);
  });
});

describe("审计日志（0.3 独立表）", () => {
  it("追加与查询（最近在前）", () => {
    engine.appendAudit({ actor: "agent", kind: "task_execute", target: "x", risk: "write", allowed: true, reason: "基线" });
    engine.appendAudit({ actor: "harness:g", kind: "shell_exec", target: "sudo rm", risk: "legal", allowed: false, reason: "提权命令" });
    const entries = engine.listAudit(10);
    expect(entries).toHaveLength(2);
    expect(entries[0]?.allowed).toBe(false); // 最新的在前
    expect(entries[0]?.reason).toContain("提权");
    expect(entries[1]?.risk).toBe("write");
  });

  it("旧库迁移幂等：audit_logs 表随 migrate 建立", () => {
    // beforeEach 已 migrate；重复 migrate 不炸且表还在
    engine.migrate();
    const db = rawDb(engine);
    const tables = (db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='audit_logs'").all() as unknown[]);
    expect(tables).toHaveLength(1);
  });
});
