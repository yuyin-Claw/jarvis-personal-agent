#!/usr/bin/env node
/**
 * JARVIS 0.2 后台守护进程（Continuous Runtime）
 *
 * 用法：jarvis-daemon [--check-interval 秒]
 *
 * 职责：
 * - 崩溃恢复：启动时 RUNNING→BLOCKED 待核实
 * - 停滞检测：定时扫描停滞任务，主动通知（stdout + 文件 + 系统通知 + 数字人开口）
 * - 主动交流：空闲超时后由数字人主动开口（ProactiveEngine 冷却/限额/静默时段裁决）
 * - Ambient 感知与任务表现：经 Platform Adapter 注入，Core 不绑定桌面
 * - 心跳：定时记账（不调模型）
 *
 * 环境变量：JARVIS_DAEMON_AVATAR=0 关闭数字人窗口，JARVIS_PROACTIVE_VOICE=0 只静默通知。
 *
 * Ctrl+C 优雅退出。macOS 开发期直接跑；Linux 上用 systemd --user 管理（Phase 3 文档化）。
 */
import { mkdirSync, appendFileSync } from "node:fs";
import path from "node:path";
import type Database from "better-sqlite3";
import { SqliteMemoryEngine } from "@jarvis/memory";
import { SqliteTaskManager } from "@jarvis/task-manager";
import { ContinuousRuntime, findStagnantTasks, type NotifyChannel, type ProactiveNotice } from "@jarvis/runtime";
import { ContextEngine, type AwarenessSource } from "@jarvis/context-engine";
import { loadConfig } from "./config.js";
import { initPlatform } from "./platform.js";
import { createEmbodiedRuntime } from "./embodied.js";

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

/** 系统通知通道（经 Platform Adapter，macOS=osascript / Omarchy=notify-send） */
class PlatformNotifyChannel implements NotifyChannel {
  constructor(private readonly sendMessage: (n: ProactiveNotice) => Promise<boolean>) {}
  async send(notice: ProactiveNotice): Promise<void> {
    await this.sendMessage(notice);
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

  // ---- 平台适配 + 具身运行时（ADR-007 / 0.2-④⑤） ----
  const platform = await initPlatform();
  const embodied = createEmbodiedRuntime({
    platform,
    tasks,
    reply: async () => ({ kind: "silent" }), // daemon 不做对话，只负责表现层与主动开口
    avatar: process.env.JARVIS_DAEMON_AVATAR !== "0",
    voice: process.env.JARVIS_PROACTIVE_VOICE !== "0",
  });
  try {
    await embodied.start();
  } catch (err) {
    console.log(`〔数字人窗口不可用，降级无窗口模式〕${err instanceof Error ? err.message : String(err)}`);
  }

  // ---- Ambient 感知（0.3：activities 表，经 Platform Adapter 注入） ----
  const context = new ContextEngine({ db: taskDb });
  context.migrate();
  const foreground: AwarenessSource = {
    id: `platform-${platform.id}-foreground`,
    async sample() {
      const c = await platform.foreground.current();
      if (!c) return null;
      return {
        source: `platform-${platform.id}-foreground`,
        kind: "app_focus",
        app: c.app ?? "unknown",
        detail: c.title,
        at: new Date(c.at).toISOString(),
      };
    },
  };

  // ---- 崩溃恢复（架构 §9.3）----
  const orphans = tasks.recoverOrphans();
  if (orphans.length > 0) {
    console.log(`〔恢复〕${orphans.length} 个 RUNNING 任务转 BLOCKED 待核实`);
  }

  // ---- Continuous Runtime ----
  const rt = new ContinuousRuntime({
    channels: [
      new StdoutNotifyChannel(),
      new FileNotifyChannel(notifyFile),
      new PlatformNotifyChannel((n) =>
        platform.notification.send({ title: "JARVIS", text: n.text, priority: n.priority }),
      ),
      embodied.proactive, // 数字人主动开口（idle 才播，忙时排队）
    ],
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

  // 活动采样 job（macOS 前台应用，默认 2 分钟一次；折叠去重在 engine 内）
  rt.schedule({
    id: "activity-sample",
    name: "活动采样",
    intervalMs: 120_000,
    run: async () => {
      await context.sampleFrom(foreground);
    },
  });

  // 空闲主动交流：30 分钟无对话后，由数字人轻声开口一次（冷却/限额/静默时段由策略裁决）
  rt.schedule({
    id: "idle-greeting",
    name: "空闲主动交流",
    intervalMs: 600_000,
    run: async () => {
      const last = memory.listConversations().find((c) => c.title !== "__audit__");
      const idleMs = last ? Date.now() - Date.parse(last.lastMessageAt) : Number.POSITIVE_INFINITY;
      if (idleMs < 30 * 60_000) return;
      await rt.notify({
        text: "有一阵子没聊了，有需要我随时在。",
        priority: "low",
        dedupeKey: `idle:${new Date().toISOString().slice(0, 13)}`,
        at: new Date().toISOString(),
      });
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

  console.log(`JARVIS daemon 0.2 · 平台 ${platform.id} · 数据 ${config.dbPath} · 通知 ${notifyFile}`);
  console.log(`停滞检查 ${checkIntervalMs / 1000}s · 活动采样 120s · 空闲交流 600s · 心跳 30s · Ctrl+C 退出`);

  // 优雅退出
  let stopped = false;
  const shutdown = () => {
    if (stopped) return;
    stopped = true;
    console.log("\n〔退出〕清理定时器与数字人窗口…");
    rt.stop();
    void embodied.stop().finally(() => {
      memory.close();
      process.exit(0);
    });
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);

  // 启动即跑一次：活动首采 + 停滞检查
  const firstSample = rt.getJob("activity-sample");
  if (firstSample) await rt.runJob(firstSample);
  const first = rt.getJob("stagnation-check");
  if (first) await rt.runJob(first);

  // 保持事件循环
  setInterval(() => undefined, 1 << 30);
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
});
