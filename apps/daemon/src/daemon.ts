#!/usr/bin/env node
/**
 * JARVIS 0.2 后台守护进程（Continuous Runtime）
 *
 * 用法：jarvis-daemon [--check-interval 秒]
 *
 * 职责：
 * - 崩溃恢复：启动时 RUNNING→BLOCKED 待核实
 * - 停滞检测：定时扫描停滞任务，主动通知（stdout + 通知文件）
 * - 心跳：定时记账（不调模型）
 *
 * Ctrl+C 优雅退出。macOS 开发期直接跑；Linux 上用 systemd --user 管理（Phase 3 文档化）。
 */
import { mkdirSync, appendFileSync } from "node:fs";
import path from "node:path";
import type Database from "better-sqlite3";
import { SqliteMemoryEngine } from "@jarvis/memory";
import { SqliteTaskManager } from "@jarvis/task-manager";
import { ContinuousRuntime, findStagnantTasks, type NotifyChannel, type ProactiveNotice } from "@jarvis/runtime";
import { loadConfig } from "./config.js";

/** 通知文件通道（跨进程可读：CLI/未来 UI 轮询此文件展示通知） */
class FileNotifyChannel implements NotifyChannel {
  constructor(private readonly file: string) {}
  async send(notice: ProactiveNotice): Promise<void> {
    appendFileSync(
      this.file,
      `[${notice.at}] (${notice.priority}) ${notice.text}\n`,
      "utf8",
    );
  }
}

/** stdout 通道（开发期观察） */
class StdoutNotifyChannel implements NotifyChannel {
  async send(notice: ProactiveNotice): Promise<void> {
    process.stdout.write(`🔔 [${notice.priority}] ${notice.text}\n`);
  }
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const checkIdx = args.indexOf("--check-interval");
  const checkIntervalMs = checkIdx >= 0 ? Number(args[checkIdx + 1] ?? 60) * 1000 : 60_000;

  const config = loadConfig();
  const dataDir = path.dirname(config.dbPath);
  mkdirSync(dataDir, { recursive: true });
  const notifyFile = path.join(dataDir, "notifications.log");

  const memory = new SqliteMemoryEngine({ path: config.dbPath });
  memory.migrate();
  const taskDb = (memory as unknown as { db: Database.Database }).db;
  const tasks = new SqliteTaskManager({ db: taskDb });
  tasks.migrate();

  // ---- 崩溃恢复（架构 §9.3）----
  const orphans = tasks.recoverOrphans();
  if (orphans.length > 0) {
    console.log(`〔恢复〕${orphans.length} 个 RUNNING 任务转 BLOCKED 待核实`);
  }

  // ---- Continuous Runtime ----
  const rt = new ContinuousRuntime({
    channels: [new StdoutNotifyChannel(), new FileNotifyChannel(notifyFile)],
    policy: {
      dedupeCooldownMs: 3_600_000, // 同主题 1 小时最多提醒一次
      dailyLimit: 20,
      quietHours: { startHour: 23, endHour: 7 },
    },
  });

  rt.onEvent((ev) => {
    if (ev.type === "job_finished" && !ev.ok) {
      console.error(`〔job 失败〕${ev.name}: ${ev.error}`);
    }
  });

  // 停滞检测 job
  rt.schedule({
    id: "stagnation-check",
    name: "停滞任务检查",
    intervalMs: checkIntervalMs,
    run: async () => {
      const reports = findStagnantTasks(tasks);
      for (const r of reports.slice(0, 3)) {
        await rt.notify({
          text: `任务「${r.task.title}」已 ${Math.round(r.idleMs / 3600_000)} 小时无进展（状态 ${r.task.status}）。需要我检查或取消吗？`,
          priority: "normal",
          dedupeKey: `stagnant:${r.task.id}`,
          at: new Date().toISOString(),
        });
      }
    },
  });

  // 心跳 job（纯计数，不调模型）
  rt.schedule({
    id: "heartbeat",
    name: "心跳",
    intervalMs: 30_000,
    run: async () => {
      rt.heartbeat();
    },
  });

  console.log(`JARVIS daemon 0.2 · 数据 ${config.dbPath} · 通知 ${notifyFile}`);
  console.log(`检查间隔 ${checkIntervalMs / 1000}s · 心跳 30s · Ctrl+C 退出`);

  // 优雅退出
  let stopped = false;
  const shutdown = () => {
    if (stopped) return;
    stopped = true;
    console.log("\n〔退出〕清理定时器…");
    rt.stop();
    memory.close();
    process.exit(0);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);

  // 启动即跑一次检查
  const first = rt.getJob("stagnation-check");
  if (first) await rt.runJob(first);

  // 保持事件循环
  setInterval(() => undefined, 1 << 30);
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
});
