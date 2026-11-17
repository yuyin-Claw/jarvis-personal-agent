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
import os from "node:os";
import type Database from "better-sqlite3";
import { SqliteMemoryEngine, OllamaEmbeddingProvider, OpenAIEmbeddingProvider } from "@jarvis/memory";
import { LLMGateway, OpenAICompatibleProvider } from "@jarvis/llm-gateway";
import { SqliteTaskManager } from "@jarvis/task-manager";
import { ContinuousRuntime, findStagnantTasks, type NotifyChannel, type ProactiveNotice } from "@jarvis/runtime";
import { ContextEngine, type AwarenessSource } from "@jarvis/context-engine";
import { CapabilityRegistry } from "@jarvis/capability-registry";
import { loadConfig } from "./config.js";
import { initPlatform } from "./platform.js";
import { createEmbodiedRuntime } from "./embodied.js";
import { PreferenceNotifyChannel } from "./preferences.js";
import { createOllamaDistiller, createOllamaWikiWriter, withDistillerFallback } from "./memory-local.js";
import { MemoryMaintenance } from "./memory-maintenance.js";

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

  const ollamaBaseUrl = process.env.JARVIS_OLLAMA_BASE_URL ?? "http://127.0.0.1:11434";
  const memory = new SqliteMemoryEngine({
    path: config.dbPath,
    embedding: (process.env.JARVIS_MEMORY_EMBEDDING_BACKEND ?? "ollama") === "zhipu"
      ? new OpenAIEmbeddingProvider({
          baseUrl: config.baseUrl,
          apiKey: config.apiKey,
          model: process.env.JARVIS_EMBEDDING_MODEL ?? "embedding-3",
          dimensions: Number(process.env.JARVIS_EMBEDDING_DIMENSIONS ?? 256),
        })
      : new OllamaEmbeddingProvider({
          baseUrl: ollamaBaseUrl,
          model: process.env.JARVIS_OLLAMA_EMBEDDING_MODEL ?? "qwen3-embedding:0.6b",
        }),
  });
  memory.migrate();
  const taskDb = (memory as unknown as { db: Database.Database }).db;
  const tasks = new SqliteTaskManager({ db: taskDb });
  tasks.migrate();

  // ---- 能力注册表（0.4：weather cron 需要调 SkillRunner）----
  const capDbPath = process.env.JARVIS_CAP_DB
    ?? path.join(os.homedir(), ".local/share/jarvis/capabilities.db");
  const capSkillsRoot = process.env.JARVIS_SKILLS_ROOT
    ?? path.join(os.homedir(), ".local/share/jarvis/skills");
  const capRegistry = new CapabilityRegistry({ dbPath: capDbPath, skillsRoot: capSkillsRoot });

  // ---- 自动记忆维护（本地 Qwen3 主用，GLM 云端备用） ----
  const gateway = new LLMGateway();
  gateway.register(new OpenAICompatibleProvider({
    id: "zhipu",
    baseUrl: config.baseUrl,
    apiKey: config.apiKey,
    models: [{ id: config.model, provider: "zhipu", vision: true }],
  }));
  const glmDistill = async (prompt: string) => {
    const r = await gateway.generate({
      model: config.model,
      messages: [{ role: "user", content: prompt }],
      temperature: 0.1,
      timeoutMs: 120_000,
    });
    return r.content;
  };
  const localDistill = createOllamaDistiller({
    baseUrl: ollamaBaseUrl,
    model: process.env.JARVIS_OLLAMA_DISTILL_MODEL ?? "qwen3:4b",
  });
  const memoryMaintenance = new MemoryMaintenance({
    engine: memory,
    rootDir: path.join(os.homedir(), ".local/share/jarvis/memory/wiki"),
    summarize: process.env.JARVIS_MEMORY_DISTILLER === "glm"
      ? glmDistill
      : withDistillerFallback(localDistill, glmDistill, (e) => {
          console.error(`〔自动记忆：本地蒸馏不可用，降级 GLM〕${e.message}`);
        }),
    synthesize: createOllamaWikiWriter({
      baseUrl: ollamaBaseUrl,
      model: process.env.JARVIS_OLLAMA_DISTILL_MODEL ?? "qwen3:4b",
    }),
  });

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
      new PreferenceNotifyChannel(new StdoutNotifyChannel(), path.join(dataDir, "settings.json")),
      new PreferenceNotifyChannel(new FileNotifyChannel(notifyFile), path.join(dataDir, "settings.json")),
      new PreferenceNotifyChannel(
        new PlatformNotifyChannel((n) =>
          platform.notification.send({ title: "JARVIS", text: n.text, priority: n.priority }),
        ),
        path.join(dataDir, "settings.json"),
      ),
      new PreferenceNotifyChannel(embodied.proactive, path.join(dataDir, "settings.json")),
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

  // 每日天气播报 cron（0.4 能力闭环：invoke_capability → weather-briefing）
  // 每 5 分钟检查一次，仅在每天 08:00-08:05 窗口内触发；dedupeKey 含日期保证每日一次
  rt.schedule({
    id: "weather-briefing",
    name: "每日天气播报",
    intervalMs: 5 * 60_000,
    run: async () => {
      const now = new Date();
      if (now.getHours() !== 8 || now.getMinutes() >= 5) return;
      const dateKey = now.toISOString().slice(0, 10);
      const city = process.env.JARVIS_WEATHER_CITY ?? "Shanghai";
      // 仅在能力已注册且实现时才播报（否则 skip）
      const rec = capRegistry.findByName("weather-briefing");
      if (!rec || rec.enabled !== 1) return;
      try {
        // 走 capRegistry.run 安全入口（先校验权限，ADR-011 红线）
        const result = await capRegistry.run("weather-briefing", { args: { city } });
        const r = (result.output ?? {}) as { ok?: boolean; implemented?: boolean; result?: { speech?: string }; error?: string };
        if (r.ok && r.implemented && r.result?.speech) {
          await rt.notify({
            text: `早安。${r.result.speech}`,
            priority: "normal",
            dedupeKey: `weather:${dateKey}`,
            at: now.toISOString(),
          });
        } else {
          console.error(`〔weather cron〕能力返回异常：${r.error ?? "implemented=false"}`);
        }
      } catch (e) {
        console.error(`〔weather cron 失败〕${(e as Error).message}`);
      }
    },
  });

  // 自动记忆维护：有新消息的会话增量蒸馏，dirty 时统一更新 Wiki。
  const configuredMemoryInterval = Number(process.env.JARVIS_MEMORY_INTERVAL_MS ?? 15 * 60_000);
  const memoryIntervalMs = Number.isFinite(configuredMemoryInterval) && configuredMemoryInterval >= 60_000
    ? configuredMemoryInterval
    : 15 * 60_000;
  if (process.env.JARVIS_MEMORY_AUTO !== "0") {
    rt.schedule({
      id: "memory-maintenance",
      name: "自动记忆维护",
      intervalMs: memoryIntervalMs,
      run: async () => {
        const report = await memoryMaintenance.runOnce();
        if (report.records > 0 || report.wikiCompiled || report.errors.length > 0) {
          console.log(`〔自动记忆〕扫描 ${report.scanned} 会话，写入/刷新 ${report.records} 条，Wiki ${report.wikiCompiled ? `已更新（${report.overviewMode}）` : "无需更新"}`);
        }
        for (const error of report.errors) console.error(`〔自动记忆失败〕${error}`);
      },
    });
  }

  console.log(`JARVIS daemon 0.2 · 平台 ${platform.id} · 数据 ${config.dbPath} · 通知 ${notifyFile}`);
  console.log(`停滞检查 ${checkIntervalMs / 1000}s · 活动采样 120s · 空闲交流 600s · 心跳 30s · 记忆维护 ${process.env.JARVIS_MEMORY_AUTO === "0" ? "关闭" : `${memoryIntervalMs / 1000}s`} · 天气 cron 每日 08:00（城市 ${process.env.JARVIS_WEATHER_CITY ?? "Shanghai"}） · Ctrl+C 退出`);

  // 优雅退出
  let stopped = false;
  const shutdown = () => {
    if (stopped) return;
    stopped = true;
    console.log("\n〔退出〕清理定时器与数字人窗口…");
    rt.stop();
    const idleTimeout = new Promise<void>((resolve) => {
      const timer = setTimeout(resolve, 5_000);
      timer.unref();
    });
    void Promise.race([memoryMaintenance.waitForIdle(), idleTimeout])
      .then(() => embodied.stop())
      .catch(() => undefined)
      .finally(() => {
        memory.close();
        process.exit(0);
      });
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);

  // 启动即跑一次：活动首采 + 停滞检查 + 空闲问候判定
  // 空闲问候原本只由 600s 定时器驱动，宿主刚启动且已空闲 30 分钟以上时要等下一拍；
  // 与其余 job 一致，启动时先判定一次（未达阈值则立即返回，不产生额外打扰）。
  const firstSample = rt.getJob("activity-sample");
  if (firstSample) await rt.runJob(firstSample);
  const first = rt.getJob("stagnation-check");
  if (first) await rt.runJob(first);
  const firstGreeting = rt.getJob("idle-greeting");
  if (firstGreeting) await rt.runJob(firstGreeting);
  const firstMemory = rt.getJob("memory-maintenance");
  if (firstMemory) void rt.runJob(firstMemory);

  // 保持事件循环
  setInterval(() => undefined, 1 << 30);
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
});
