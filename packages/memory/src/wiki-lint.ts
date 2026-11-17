import fs from "node:fs";
import path from "node:path";
import type { SqliteMemoryEngine } from "./sqlite-engine.js";
import type { MemoryRecord } from "./types.js";
import { wikiPageFor } from "./wiki.js";

export type WikiLintIssueKind = "conflict" | "stale" | "missing_source" | "duplicate";
export interface WikiLintIssue {
  kind: WikiLintIssueKind;
  memoryIds: string[];
  summary: string;
  severity: "high" | "medium" | "low";
}
export interface WikiLintReport {
  issues: WikiLintIssue[];
  warnings: string[];
  checkedAt: string;
  lintPath: string;
}
export type WikiConflictJudge = (prompt: string) => Promise<string>;

function normalized(text: string): string {
  return text.toLowerCase().replace(/\s+/g, "");
}
function dice(a: string, b: string): number {
  const aa = normalized(a);
  const bb = normalized(b);
  if (aa.length < 2 || bb.length < 2) return 0;
  const grams = new Set<string>();
  for (let i = 0; i < aa.length - 1; i++) grams.add(aa.slice(i, i + 2));
  let overlap = 0;
  for (let i = 0; i < bb.length - 1; i++) if (grams.has(bb.slice(i, i + 2))) overlap++;
  return (2 * overlap) / (aa.length + bb.length - 2);
}
function hasNegation(text: string): boolean {
  return /不再|不得|不能|不要|不使用|禁止|无法/.test(text);
}

/** 只读 Lint：不自动删除/修改记忆，冲突与过期均需用户确认。 */
export class WikiLinter {
  constructor(private readonly engine: SqliteMemoryEngine) {}

  async lint(opts: {
    rootDir: string;
    staleDays?: number;
    now?: Date;
    conflictJudge?: WikiConflictJudge;
  }): Promise<WikiLintReport> {
    const records = this.engine.list();
    const now = opts.now ?? new Date();
    const staleDays = opts.staleDays ?? 90;
    const issues: WikiLintIssue[] = [];
    const warnings: string[] = [];
    const byId = new Map(records.map((r) => [r.id, r]));

    // 1. 完全重复（跨来源/跨时间仍保留时的冗余）。
    const exact = new Map<string, MemoryRecord[]>();
    for (const r of records) {
      const key = `${r.kind}:${normalized(r.content)}`;
      exact.set(key, [...(exact.get(key) ?? []), r]);
    }
    for (const group of exact.values()) {
      if (group.length > 1) issues.push({
        kind: "duplicate", memoryIds: group.map((r) => r.id), severity: "low",
        summary: `完全重复：${group[0]!.content}`,
      });
    }

    // 2. conversation 来源是否仍存在。
    const conversations = new Map(this.engine.listConversations().map((c) => [c.id, c]));
    const messageCache = new Map<string, Set<string>>();
    for (const r of records.filter((r) => r.source === "conversation" && r.sourceRef)) {
      const [conversationId, messageId] = r.sourceRef!.split(":");
      if (!conversationId || !messageId) continue;
      if (!messageCache.has(conversationId)) {
        messageCache.set(conversationId, new Set(this.engine.listMessages(conversationId).map((m) => m.id)));
      }
      if (!conversations.has(conversationId) || !messageCache.get(conversationId)!.has(messageId)) {
        issues.push({ kind: "missing_source", memoryIds: [r.id], severity: "high", summary: `来源消息不存在：${r.sourceRef}` });
      }
    }

    // 3. 过期决策/目标（只提示，不自动作废）。
    for (const r of records.filter((r) => r.kind === "decision" || r.kind === "goal")) {
      const ageDays = (now.getTime() - Date.parse(r.updatedAt)) / 86_400_000;
      if (ageDays > staleDays) issues.push({
        kind: "stale", memoryIds: [r.id], severity: "medium",
        summary: `已 ${Math.floor(ageDays)} 天未复核：${r.content}`,
      });
    }

    // 4. 相似主题冲突候选：规则初筛，可选 LLM 复核（只接受布尔判定和合法 ID）。
    const pairs: Array<[MemoryRecord, MemoryRecord]> = [];
    for (let i = 0; i < records.length; i++) {
      for (let j = i + 1; j < records.length; j++) {
        const a = records[i]!;
        const b = records[j]!;
        if (a.kind !== b.kind || !["decision", "project", "user_profile"].includes(a.kind)) continue;
        if (dice(a.content, b.content) >= 0.25) pairs.push([a, b]);
        if (pairs.length >= 20) break;
      }
      if (pairs.length >= 20) break;
    }
    const conflictKeys = new Set<string>();
    for (const [a, b] of pairs) {
      if (hasNegation(a.content) !== hasNegation(b.content) && dice(a.content, b.content) >= 0.45) {
        conflictKeys.add(`${a.id}|${b.id}`);
        issues.push({ kind: "conflict", memoryIds: [a.id, b.id], severity: "high", summary: `可能存在正负冲突：${a.content} ↔ ${b.content}` });
      }
    }
    if (opts.conflictJudge && pairs.length) {
      const prompt = `判断下列同主题记忆是否构成事实冲突。只输出 JSON 数组 [{"ids":["id1","id2"],"conflict":true}]。只能使用输入 ID，不得输出解释。\n${pairs.map(([a, b], i) => `${i + 1}. [${a.id}] ${a.content}\n   [${b.id}] ${b.content}`).join("\n")}`;
      try {
        const raw = await opts.conflictJudge(prompt);
        const match = raw.match(/\[[\s\S]*\]/);
        const parsed = match ? JSON.parse(match[0]) as unknown : [];
        if (!Array.isArray(parsed)) throw new Error("响应不是数组");
        for (const item of parsed) {
          const value = item as { ids?: unknown; conflict?: unknown };
          if (!Array.isArray(value.ids) || value.ids.length !== 2 || value.conflict !== true) continue;
          const [aId, bId] = value.ids;
          if (typeof aId !== "string" || typeof bId !== "string" || !byId.has(aId) || !byId.has(bId)) continue;
          const key = `${aId}|${bId}`;
          const reverse = `${bId}|${aId}`;
          if (conflictKeys.has(key) || conflictKeys.has(reverse)) continue;
          conflictKeys.add(key);
          issues.push({ kind: "conflict", memoryIds: [aId, bId], severity: "high", summary: `模型复核为可能冲突：${byId.get(aId)!.content} ↔ ${byId.get(bId)!.content}` });
        }
      } catch (e) {
        warnings.push(`冲突模型复核不可用：${(e as Error).message}`);
      }
    }

    const checkedAt = now.toISOString();
    const lines = ["<!-- GENERATED BY JARVIS · 只读检查，不自动修改记忆 -->", "# Wiki Lint", "", `- 检查时间：${checkedAt}`, `- 问题：${issues.length} 项`, ""];
    for (const warning of warnings) lines.push(`> ${warning}`, "");
    if (!issues.length) lines.push("未发现冲突、过期、失效来源或完全重复记忆。", "");
    for (const issue of issues) {
      lines.push(`## [${issue.severity}] ${issue.kind}`, "", issue.summary, "");
      for (const id of issue.memoryIds) {
        const record = byId.get(id);
        if (record) lines.push(`- [[${wikiPageFor(record).replace(/\.md$/, "")}|${record.content}]]`);
      }
      lines.push("");
    }
    fs.mkdirSync(opts.rootDir, { recursive: true });
    const lintPath = path.join(opts.rootDir, "lint.md");
    const tmp = `${lintPath}.tmp-${process.pid}`;
    fs.writeFileSync(tmp, lines.join("\n"), "utf8");
    fs.renameSync(tmp, lintPath);
    return { issues, warnings, checkedAt, lintPath };
  }
}
