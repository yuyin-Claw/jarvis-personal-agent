#!/usr/bin/env node
/**
 * JARVIS 0.1 CLI 对话入口（全链路：对话 + 意图决策 + 任务 + Coding Harness + 权限审计）
 *
 * 用法：
 *   jarvis                  # 新会话交互模式
 *   jarvis --continue       # 继续最近会话
 *   jarvis ask "问题"        # 单次问答
 *   jarvis tasks            # 任务列表
 *
 * 环境变量见 config.ts。Ctrl+C 退出（状态已持久化，重进 --continue 恢复）。
 */
import readline from "node:readline/promises";
import { stdin as input, stdout as output } from "node:process";
import { mkdirSync, readFileSync } from "node:fs";
import path from "node:path";
import os from "node:os";
import type Database from "better-sqlite3";
import { LLMGateway, OpenAICompatibleProvider } from "@jarvis/llm-gateway";
import { SqliteMemoryEngine } from "@jarvis/memory";
import { SqliteTaskManager } from "@jarvis/task-manager";
import { Orchestrator } from "@jarvis/orchestrator";
import { CodingHarness, PermissionBroker, type AuditEntry } from "@jarvis/harness-runtime";
import { ConversationGateway } from "./gateway.js";
import { JARVIS_SYSTEM_PROMPT } from "./persona.js";
import { loadConfig } from "./config.js";

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const config = loadConfig();

  // ---- 存储（memory 与 task 共用一个库文件） ----
  mkdirSync(path.dirname(config.dbPath), { recursive: true });
  const memory = new SqliteMemoryEngine({ path: config.dbPath });
  memory.migrate();
  const taskDb = (memory as unknown as { db: Database.Database }).db;
  const tasks = new SqliteTaskManager({ db: taskDb });
  tasks.migrate();

  // ---- 审计落库（0.3：独立 audit_logs 表） ----
  const broker = new PermissionBroker({
    audit: {
      append: (e: AuditEntry) => {
        memory.appendAudit(e);
      },
    },
  });

  // ---- LLM ----
  const gateway = new LLMGateway();
  gateway.register(
    new OpenAICompatibleProvider({
      id: "zhipu",
      baseUrl: config.baseUrl,
      apiKey: config.apiKey,
      models: [{ id: config.model, provider: "zhipu", vision: true }],
    }),
  );

  // ---- Harness（工作目录：~/jarvis-workspace） ----
  const workDir = envWorkDir();
  const harness = new CodingHarness({ gateway, model: config.model });

  // ---- Orchestrator ----
  const orch = new Orchestrator({
    gateway,
    memory,
    tasks,
    model: config.model,
    systemPrompt: JARVIS_SYSTEM_PROMPT,
  });

  // ---- 对话 Gateway ----
  const conversation = new ConversationGateway({
    memory,
    systemPrompt: JARVIS_SYSTEM_PROMPT,
    generateReply: async (messages, handlers) => {
      let full = "";
      for await (const ev of gateway.stream({ model: config.model, messages })) {
        if (ev.type === "delta") {
          full += ev.text;
          handlers.onDelta?.(ev.text);
        } else if (ev.type === "error") {
          throw ev.error;
        }
      }
      output.write("\n");
      return full;
    },
  });

  // ---- 命令：tasks / run <id> / audit / notify / status ----
  if (args[0] === "tasks") {
    const all = tasks.list();
    if (all.length === 0) {
      console.log("（无任务）");
    } else {
      for (const t of all) {
        console.log(`${t.status.padEnd(18)} ${t.id}  ${t.title}`);
      }
    }
    memory.close();
    return;
  }

  if (args[0] === "audit") {
    const limit = Number(args[1] ?? 30);
    const entries = memory.listAudit(limit);
    if (entries.length === 0) {
      console.log("（无审计记录）");
    } else {
      for (const e of entries) {
        const flag = e.allowed ? "✓" : "✕";
        console.log(
          `${e.timestamp.slice(11, 19)} ${flag} [${e.risk}] ${e.actor} ${e.kind} — ${e.reason} :: ${e.target.slice(0, 60)}`,
        );
      }
    }
    memory.close();
    return;
  }

  if (args[0] === "notify") {
    const dataDir = path.dirname(config.dbPath);
    const notifyFile = path.join(dataDir, "notifications.log");
    try {
      const content = readFileSync(notifyFile, "utf8").trim();
      if (!content) {
        console.log("（无通知）");
      } else {
        const lines = content.split("\n");
        for (const line of lines.slice(-Number(args[1] ?? 20))) {
          console.log(line);
        }
      }
    } catch {
      console.log("（无通知文件——daemon 尚未产生通知）");
    }
    memory.close();
    return;
  }

  if (args[0] === "status") {
    const openTasks = tasks.list().filter(
      (t) => !["COMPLETED", "FAILED", "CANCELLED"].includes(t.status),
    );
    const conversations = memory.listConversations().filter((c) => c.title !== "__audit__");
    const memories = memory.list();
    const audits = memory.listAudit(1000);
    const blocked = audits.filter((a) => !a.allowed).length;
    console.log(`JARVIS 状态`);
    console.log(`  进行中任务：${openTasks.length}${openTasks.length > 0 ? `（${openTasks.map((t) => t.title).slice(0, 3).join("、")}…）` : ""}`);
    console.log(`  会话：${conversations.length} · 记忆：${memories.length} 条`);
    console.log(`  审计：${audits.length} 条（拦截 ${blocked} 次）`);
    const dataDir = path.dirname(config.dbPath);
    const notifyFile = path.join(dataDir, "notifications.log");
    try {
      const n = readFileSync(notifyFile, "utf8").trim().split("\n").filter(Boolean).length;
      console.log(`  通知：${n} 条`);
    } catch {
      console.log(`  通知：0 条`);
    }
    memory.close();
    return;
  }

  if (args[0] === "run" && args[1]) {
    const t = tasks.get(String(args[1]));
    if (!t) {
      console.error(`任务不存在：${args[1]}`);
      process.exitCode = 1;
      memory.close();
      return;
    }
    if (t.status !== "CREATED" && t.status !== "BLOCKED") {
      console.error(`任务状态 ${t.status} 不可执行（需 CREATED/BLOCKED）`);
      process.exitCode = 1;
      memory.close();
      return;
    }
    console.log(`〔用户确认执行：${t.title}〕目标：${t.goal}`);
    tasks.transition(t.id, "PLANNED");
    tasks.transition(t.id, "RUNNING");
    const job = await harness.execute({ workDir, goal: t.goal });
    tasks.assign(t.id, harness.id, job.jobId);
    for await (const ev of harness.streamEvents(job.jobId)) {
      if (ev.type === "progress") {
        output.write(`  ${ev.text.slice(0, 120)}\n`);
      } else if (ev.type === "completed") {
        tasks.transition(t.id, "COMPLETED", {
          output: ev.status.output ?? "",
          finishedAt: new Date().toISOString(),
        });
        console.log(`〔完成 · ${ev.status.steps} 步〕\n${ev.status.output ?? ""}`);
      } else if (ev.type === "failed") {
        tasks.transition(t.id, "FAILED", {
          error: ev.status.error ?? "",
          finishedAt: new Date().toISOString(),
        });
        console.error(`〔失败〕${ev.status.error ?? ""}`);
        process.exitCode = 1;
      }
    }
    memory.close();
    return;
  }

  // ---- 会话选择 ----
  let conversationId: string;
  if (args[0] === "--continue") {
    const last = memory
      .listConversations()
      .find((c) => c.title !== "__audit__");
    if (!last) {
      conversationId = conversation.newConversation("新会话");
    } else {
      conversationId = last.id;
      console.log(`（继续会话：${last.title}）`);
    }
  } else {
    conversationId = conversation.newConversation(
      args[0] === "ask" && args[1] ? String(args[1]).slice(0, 30) : "新会话",
    );
  }

  // ---- 单轮处理：决策 → 必要时启动 Harness ----
  async function ask(text: string): Promise<void> {
    process.stdout.write("JARVIS> ");

    // 1. Orchestrator 决策
    const turn = await orch.handleTurn(conversationId, text);
    const d = turn.decision;

    // 2. 按决策执行
    if (d.type === "create_task" && turn.task) {
      const t = turn.task;
      // 权限裁决：任务执行
      const verdict = broker.check({
        kind: "task_execute",
        target: t.goal,
        actor: "agent",
      });
      if (t.requiresApproval || !verdict.allow) {
        console.log(`〔任务已创建，等待你确认后执行〕`);
        console.log(`  任务 ${t.id}：${t.title}`);
        console.log(`  目标：${t.goal}`);
        console.log(`  原因：${t.requiresApproval ? "高危任务" : verdict.reason}`);
        console.log(`  确认执行：jarvis run ${t.id}`);
        return;
      }
      // 3. 派 Harness 执行
      console.log(`〔委派 ${harness.id} 执行：${t.title}…〕`);
      tasks.transition(t.id, "PLANNED");
      tasks.transition(t.id, "RUNNING");
      const job = await harness.execute({ workDir, goal: t.goal });
      tasks.assign(t.id, harness.id, job.jobId);
      // 等待作业完成
      for await (const ev of harness.streamEvents(job.jobId)) {
        if (ev.type === "progress") {
          output.write(`  ${ev.text.slice(0, 120)}\n`);
        } else if (ev.type === "completed") {
          tasks.transition(t.id, "COMPLETED", {
            output: ev.status.output ?? "",
            finishedAt: new Date().toISOString(),
          });
          console.log(`〔任务完成 · ${ev.status.steps} 步〕`);
          console.log(ev.status.output ?? "");
          return;
        } else if (ev.type === "failed") {
          tasks.transition(t.id, "FAILED", {
            error: ev.status.error ?? "未知错误",
            finishedAt: new Date().toISOString(),
          });
          console.log(`〔任务失败〕${ev.status.error ?? ""}`);
          return;
        }
      }
      return;
    }

    if (d.type === "continue_task" && turn.task) {
      console.log(`〔继续任务 ${turn.task.id}：${turn.task.title}〕`);
      return;
    }

    // answer / ask：直接输出
    output.write(d.text + "\n");
    // 同时落对话记录（决策文本作为 assistant 消息）
    memory.appendMessage(conversationId, "user", text);
    memory.appendMessage(conversationId, "assistant", d.text);
  }

  if (args[0] === "ask" && args[1]) {
    await ask(String(args[1]));
    memory.close();
    return;
  }

  // 交互模式
  console.log(`JARVIS 0.1 · ${config.model} · 工作目录 ${workDir} · Ctrl+C 退出`);
  const rl = readline.createInterface({ input, output });
  try {
    for (;;) {
      const text = (await rl.question("\n你> ")).trim();
      if (!text) continue;
      if (text === "exit" || text === "quit") break;
      try {
        await ask(text);
      } catch (err) {
        console.error(`\n[出错] ${err instanceof Error ? err.message : String(err)}`);
      }
    }
  } finally {
    rl.close();
    memory.close();
  }
}

function envWorkDir(): string {
  return process.env.JARVIS_WORK_DIR ?? path.join(os.homedir(), "jarvis-workspace");
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
});
