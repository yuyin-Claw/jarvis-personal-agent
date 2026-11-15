#!/usr/bin/env node
/**
 * Continuous Runtime / 主动交流 真实进程验收（任务 #35）
 *
 * 不依赖真人操作电脑：用模拟 Context Event（把任务/会话时间戳拨回 48 小时前）
 * 制造「宿主崩溃后有 RUNNING 孤儿任务」「任务停滞」「对话空闲 30 分钟」三种状态，
 * 然后启动**真实 daemon 进程**，从 stdout、notifications.log、SQLite、CLI 四处读落盘证据。
 *
 * 用法：node apps/daemon/scripts/verify-runtime.mjs
 * 报告：/tmp/jarvis-runtime-report.json
 */
import { spawn, execFile } from "node:child_process";
import { promisify } from "node:util";
import fs from "node:fs";
import path from "node:path";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const exec = promisify(execFile);
const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(HERE, "../../..");
const DAEMON = join(REPO, "apps/daemon/dist/daemon.js");
const CLI = join(REPO, "apps/daemon/dist/cli.js");
const DB = "/tmp/jarvis-runtime-verify.db";
const DATA_DIR = path.dirname(DB);
const NOTIFY = join(DATA_DIR, "notifications.log");
const REPORT = "/tmp/jarvis-runtime-report.json";

for (const suffix of ["", "-shm", "-wal"]) fs.rmSync(`${DB}${suffix}`, { force: true });
fs.rmSync(NOTIFY, { force: true });

const report = { startedAt: new Date().toISOString(), checks: [] };
let failures = 0;
function check(ok, label, detail = "") {
  report.checks.push({ ok: Boolean(ok), label, detail: String(detail).slice(0, 300) });
  console.log(`${ok ? "PASS" : "FAIL"}: ${label}${detail ? ` — ${String(detail).slice(0, 200)}` : ""}`);
  if (!ok) failures += 1;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function seed() {
  const { SqliteMemoryEngine } = await import(new URL("../../../packages/memory/dist/index.js", import.meta.url));
  const { SqliteTaskManager } = await import(new URL("../../../packages/task-manager/dist/index.js", import.meta.url));
  const memory = new SqliteMemoryEngine({ path: DB });
  memory.migrate();
  const db = memory.db;
  const tasks = new SqliteTaskManager({ db });
  tasks.migrate();

  // ① 崩溃前遗留的 RUNNING 任务
  const orphan = tasks.create({ title: "崩溃前遗留任务", goal: "模拟宿主崩溃" });
  tasks.transition(orphan.id, "PLANNED");
  tasks.transition(orphan.id, "RUNNING");
  // ② 48 小时无进展的 PLANNED 任务（停滞检测阈值为 24h）
  const stagnant = tasks.create({ title: "长期停滞任务", goal: "模拟停滞" });
  tasks.transition(stagnant.id, "PLANNED");
  const old = new Date(Date.now() - 48 * 3600_000).toISOString();
  db.prepare("UPDATE tasks SET updated_at = ?, created_at = ? WHERE id IN (?, ?)").run(old, old, orphan.id, stagnant.id);

  // ③ 48 小时没有对话（空闲主动交流阈值 30 分钟）
  db.prepare("INSERT INTO conversations (id, title, started_at, last_message_at) VALUES (?,?,?,?)")
    .run("conv-runtime-verify", "上次会话", old, old);
  db.prepare("INSERT INTO messages (id, conversation_id, role, content, created_at) VALUES (?,?,?,?,?)")
    .run("msg-runtime-verify", "conv-runtime-verify", "user", "上一轮对话", old);
  memory.close();
  return { orphanId: orphan.id, stagnantId: stagnant.id };
}

async function runDaemon() {
  const env = {
    ...process.env,
    JARVIS_DB_PATH: DB,
    JARVIS_ENV_FILE: join(REPO, ".env"),
    JARVIS_DAEMON_AVATAR: "0",
    JARVIS_PROACTIVE_VOICE: "0",
  };
  const child = spawn(process.execPath, [DAEMON, "--check-interval", "2"], {
    cwd: REPO,
    env,
    stdio: ["ignore", "pipe", "pipe"],
  });
  let out = "";
  child.stdout.on("data", (c) => { out += String(c); });
  child.stderr.on("data", (c) => { out += String(c); });
  await sleep(7_000);
  const alive = child.exitCode === null;
  child.kill("SIGTERM");
  const exited = await Promise.race([
    new Promise((r) => child.on("exit", (code) => r(code))),
    sleep(8_000).then(() => "TIMEOUT"),
  ]);
  return { out, alive, exited };
}

async function cli(args) {
  const { stdout, stderr } = await exec(process.execPath, [CLI, ...args], {
    cwd: REPO,
    env: { ...process.env, JARVIS_DB_PATH: DB, JARVIS_ENV_FILE: join(REPO, ".env") },
    timeout: 30_000,
  });
  return `${stdout}${stderr}`;
}

async function main() {
  const ids = await seed();
  console.log("=== 真实 daemon 进程（模拟事件：孤儿任务 / 停滞 / 空闲会话） ===");
  const d = await runDaemon();
  report.daemonOutput = d.out.slice(0, 4000);
  check(d.alive, "daemon 持续存活 7 秒且未崩溃");
  check(d.exited === 0, "SIGTERM 优雅退出", `exit=${d.exited}`);
  check(/JARVIS daemon 0.2/.test(d.out), "真实 daemon 启动横幅");
  check(/〔恢复〕1 个 RUNNING 任务转 BLOCKED/.test(d.out), "崩溃恢复：RUNNING 孤儿任务转 BLOCKED");

  const notices = fs.existsSync(NOTIFY) ? fs.readFileSync(NOTIFY, "utf8") : "";
  report.notifications = notices;
  const stagnantLines = notices.split("\n").filter((l) => l.includes("无进展"));
  const idleLines = notices.split("\n").filter((l) => l.includes("有一阵子没聊了"));
  check(stagnantLines.length === 1, "停滞检测真实发通知，且冷却去重只发一次", `stagnant=${stagnantLines.length}`);
  check(idleLines.length >= 1, "空闲 30 分钟后主动开口（通知落盘）", `idle=${idleLines.length}`);
  check(/🔔/.test(d.out), "stdout 通知通道同步输出");

  const { default: Database } = await import("better-sqlite3");
  const db = new Database(DB, { readonly: true });
  const orphan = db.prepare("SELECT status FROM tasks WHERE id = ?").get(ids.orphanId);
  const recovered = db.prepare("SELECT count(*) c FROM task_events WHERE task_id = ? AND type = 'recovered'").get(ids.orphanId);
  const activities = db.prepare("SELECT count(*) c FROM activities").get();
  db.close();
  check(orphan?.status === "BLOCKED" && recovered.c > 0, "SQLite 落盘：孤儿任务 BLOCKED + recovered 事件", `status=${orphan?.status}`);
  check(activities.c > 0, "启动首采真实写入 activities", `activities=${activities.c}`);

  const notifyCli = await cli(["notify"]);
  const statusCli = await cli(["status"]);
  report.cliNotify = notifyCli.trim();
  report.cliStatus = statusCli.trim();
  check(/无进展/.test(notifyCli) && /有一阵子没聊了/.test(notifyCli), "跨进程：CLI notify 读到 daemon 写入的通知");
  check(/通知：[1-9]/.test(statusCli), "跨进程：CLI status 汇总通知条数", statusCli.trim().replace(/\n/g, " | ").slice(0, 180));

  report.finishedAt = new Date().toISOString();
  report.failures = failures;
  report.total = report.checks.length;
  fs.writeFileSync(REPORT, JSON.stringify(report, null, 2));
  console.log(`\n=== 汇总：${report.total - failures}/${report.total} 通过，报告 ${REPORT} ===`);
  process.exitCode = failures > 0 ? 1 : 0;
}

await main();
