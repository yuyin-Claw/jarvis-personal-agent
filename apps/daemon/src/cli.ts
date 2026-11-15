#!/usr/bin/env node
/**
 * JARVIS 0.1 CLI 对话入口（全链路：对话 + 意图决策 + 任务 + Coding Harness + 权限审计）
 *
 * 用法：
 *   jarvis                  # 新会话交互模式
 *   jarvis --continue       # 继续最近会话
 *   jarvis ask "问题"        # 单次问答（Orchestrator 决策 + Harness）
 *   jarvis talk "问题"       # 具身对话：数字人 + 语音 + 流式对话链路
 *   jarvis talk             # 具身对话交互模式
 *   jarvis tasks            # 任务列表
 *   jarvis capabilities [list|run|health|register|enable|disable]  # 能力注册表（0.4）
 *   jarvis factory [list|draft|approve|reject]   # Skill 工厂（0.4：缺口→骨架→审批→注册）
 *   jarvis platform         # 平台适配器五端点状态（macOS / Omarchy）
 *
 * talk 环境变量：JARVIS_TALK_NO_AVATAR=1 关闭窗口、JARVIS_TALK_NO_VOICE=1 关闭语音、
 * JARVIS_TALK_OUTPUT_FILE=<aiff> 静默合成到文件（自动验收用）。
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
import { CapabilityRegistry, SkillRunner, SkillFactory } from "@jarvis/capability-registry";
import { ContextEngine } from "@jarvis/context-engine";
import type { AwarenessSource } from "@jarvis/context-engine";
import { ConversationGateway } from "./gateway.js";
import { JARVIS_SYSTEM_PROMPT } from "./persona.js";
import { loadConfig, loadDotEnv } from "./config.js";

// env 文件合成（systemd 部署场景）：JARVIS_ENV_FILE 指定的 env 文件键
// 合入 process.env（仅补缺，不覆盖已有环境变量）。否则 initPlatform 读
// process.env.JARVIS_VOICE_URL 时 env 文件里的值不可见 → 语音服务化
// 失效（振幅口型/实时监听全链路依赖该端点）。
if (process.env.JARVIS_ENV_FILE) {
  for (const [k, v] of Object.entries(loadDotEnv(process.env.JARVIS_ENV_FILE))) {
    if (process.env[k] === undefined) process.env[k] = v;
  }
}
import { initPlatform } from "./platform.js";

async function main(): Promise<void> {
  const args = process.argv.slice(2);

  // ---- 平台探测（不加载 DB / 不需要 .env，便于在任意宿主上排查适配层） ----
  if (args[0] === "platform") {
    const platform = await initPlatform();
    const statuses = await platform.probe();
    console.log(`JARVIS 平台适配器：${platform.id}`);
    for (const s of statuses) {
      console.log(`  ${s.endpoint.padEnd(14)} ${s.state.padEnd(12)} ${s.detail ?? ""}`);
    }
    return;
  }

  // ---- 能力注册表（ADR-011 · 0.4）----
  if (args[0] === "capabilities") {
    const sub = args[1] ?? "list";
    const skillsRoot = process.env.JARVIS_SKILLS_ROOT
      ?? path.join(os.homedir(), ".local/share/jarvis/skills");
    const dbPath = process.env.JARVIS_CAP_DB
      ?? path.join(os.homedir(), ".local/share/jarvis/capabilities.db");
    const registry = new CapabilityRegistry({ dbPath, skillsRoot });
    try {
      if (sub === "list") {
        const caps = registry.list({ enabledOnly: args[2] !== "--all" });
        if (caps.length === 0) {
          console.log(`（无已${args[2] === "--all" ? "注册" : "启用"}能力；skillsRoot=${skillsRoot}）`);
        } else {
          console.log("能力名            版本     kind      状态   健康       说明");
          for (const c of caps) {
            const flag = c.enabled ? "启用" : "停用";
            console.log(`${c.name.padEnd(16)} ${c.version.padEnd(8)} ${c.kind.padEnd(9)} ${flag.padEnd(5)} ${c.health.padEnd(10)} ${c.description.slice(0, 40)}`);
          }
        }
      } else if (sub === "run" && args[2]) {
        // jarvis capabilities run <name> [json-arg]
        let inputArg: unknown = {};
        if (args[3]) { try { inputArg = JSON.parse(args[3]); } catch { console.error("输入参数不是合法 JSON"); process.exit(1); } }
        const manifest = registry.loadManifest(args[2]);
        if (!manifest) { console.error(`Skill 不存在：${args[2]}（skillsRoot=${skillsRoot}）`); process.exit(1); }
        const r = await new SkillRunner(skillsRoot).run(args[2], inputArg);
        console.log(JSON.stringify(r.output, null, 2));
        if (r.rc !== 0) console.error(`（rc=${r.rc}，${r.durationMs}ms）${r.stderr.slice(0, 200)}`);
      } else if (sub === "health" && args[2]) {
        const h = await registry.healthCheck(args[2]);
        console.log(`${args[2]}: ${h}`);
      } else if (sub === "register") {
        // 扫描 skillsRoot 下全部 skill.json 批量注册
        const fs = await import("node:fs");
        if (!fs.existsSync(skillsRoot)) { console.error(`skillsRoot 不存在：${skillsRoot}`); process.exit(1); }
        const dirs = fs.readdirSync(skillsRoot, { withFileTypes: true }).filter((d) => d.isDirectory());
        let n = 0;
        for (const d of dirs) {
          const m = registry.loadManifest(d.name);
          if (!m) { console.log(`跳过 ${d.name}（无 skill.json）`); continue; }
          const rec = registry.register({
            name: m.name, version: m.version, kind: "skill",
            entry: d.name, description: m.description ?? "",
          });
          console.log(`注册 ${rec.name}@${rec.version}（权限：${rec.permissions.length} 项）`);
          n++;
        }
        console.log(`共注册 ${n} 个能力`);
      } else if (sub === "enable" || sub === "disable") {
        if (!args[2]) { console.error("用法：capabilities enable|disable <name> <version>"); process.exit(1); }
        const ok = registry.setEnabled(args[2], args[3] ?? "*", sub === "enable");
        console.log(ok ? "已更新" : "未找到该能力");
      } else {
        console.error("用法：jarvis capabilities [list --all | run <name> '<json>' | health <name> | register | enable|disable <name> <version>]");
        process.exit(1);
      }
    } finally {
      registry.close();
    }
    return;
  }

  // ---- Harness Factory（ADR-011 · 0.4 Step 4.3）----
  if (args[0] === "factory") {
    const sub = args[1] ?? "list";
    const skillsRoot = process.env.JARVIS_SKILLS_ROOT
      ?? path.join(os.homedir(), ".local/share/jarvis/skills");
    const dbPath = process.env.JARVIS_CAP_DB
      ?? path.join(os.homedir(), ".local/share/jarvis/capabilities.db");
    const registry = new CapabilityRegistry({ dbPath, skillsRoot });
    const factory = new SkillFactory({ registry, skillsRoot });
    try {
      if (sub === "draft") {
        // jarvis factory draft "<need>" <name>
        const need = args[2];
        const name = args[3];
        if (!need || !name) { console.error("用法：jarvis factory draft \"<需求描述>\" <kebab-case-名>"); process.exit(1); }
        const r = factory.draft({ need, suggestedKind: "skill", suggestedName: name });
        console.log(`骨架已生成（staging，未注册）：`);
        console.log(`  ${r.dir}`);
        for (const f of r.files) console.log(`    - ${f}`);
        console.log(`申请权限：${r.permissionRequest.length} 项（骨架恒零）`);
        console.log(`下一步：审阅后 jarvis factory approve ${r.name}`);
      } else if (sub === "list") {
        const drafts = factory.listDrafts();
        if (drafts.length === 0) console.log("（staging 无待审批骨架）");
        else for (const d of drafts) console.log(`${d.name.padEnd(24)} ${d.need.slice(0, 40)}`);
      } else if (sub === "approve" && args[2]) {
        const rec = factory.approve(args[2]);
        console.log(`已批准并注册：${rec.name}@${rec.version}（权限：${rec.permissions.length} 项）`);
      } else if (sub === "reject" && args[2]) {
        console.log(factory.reject(args[2]) ? `已删除骨架：${args[2]}` : `staging 无此骨架：${args[2]}`);
      } else {
        console.error("用法：jarvis factory [list | draft \"<需求>\" <名> | approve <名> | reject <名>]");
        process.exit(1);
      }
    } finally {
      registry.close();
    }
    return;
  }

  const config = loadConfig();

  // ---- 存储（memory 与 task 共用一个库文件） ----
  mkdirSync(path.dirname(config.dbPath), { recursive: true });
  const memory = new SqliteMemoryEngine({ path: config.dbPath });
  memory.migrate();
  const taskDb = (memory as unknown as { db: Database.Database }).db;
  const tasks = new SqliteTaskManager({ db: taskDb });
  tasks.migrate();

  // ---- Ambient 感知（经 Platform Adapter 注入，Core 不依赖具体桌面） ----
  const platform = await initPlatform();
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
  // 启动预采一次（决策时读已入库数据；provider 里的异步补采供下一轮）
  await context.sampleFrom(foreground).catch(() => undefined);

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

  // ---- Harness（工作目录：~/jarvis-workspace，启动时确保存在） ----
  mkdirSync(envWorkDir(), { recursive: true });
  // 孤儿任务恢复：上次进程被杀死时 RUNNING 的任务无人收尾 → 转 BLOCKED
  // （用户可 jarvis run <id> 续跑；状态机不悬空）
  for (const t of tasks.list()) {
    if (t.status === "RUNNING") {
      tasks.transition(t.id, "BLOCKED");
      console.log(`〔恢复〕孤儿任务 ${t.id}（${t.title}）由 RUNNING 转 BLOCKED，可 jarvis run 续跑`);
    }
  }
  const workDir = envWorkDir();
  const harness = new CodingHarness({ gateway, model: config.model });

  // ---- Orchestrator ----
  // ---- 能力注册表 + Factory（ADR-011：能力闭环运行时）----
  const capDbPath = process.env.JARVIS_CAP_DB
    ?? path.join(os.homedir(), ".local/share/jarvis/capabilities.db");
  const capSkillsRoot = process.env.JARVIS_SKILLS_ROOT
    ?? path.join(os.homedir(), ".local/share/jarvis/skills");
  const capRegistry = new CapabilityRegistry({ dbPath: capDbPath, skillsRoot: capSkillsRoot });
  const skillFactory = new SkillFactory({ registry: capRegistry, skillsRoot: capSkillsRoot });

  const orch = new Orchestrator({
    gateway,
    memory,
    tasks,
    model: config.model,
    systemPrompt: JARVIS_SYSTEM_PROMPT,
    contextProvider: () => {
      // 决策时补采一次（有折叠去重，开销可忽略）+ 读最近 30 分钟
      void context.sampleFrom(foreground).catch(() => undefined);
      return context.currentContext(30);
    },
    capabilitiesProvider: () => capRegistry.list({ enabledOnly: true })
      .map((c) => ({ name: c.name, kind: c.kind, description: c.description, enabled: c.enabled === 1 })),
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
    // 与 TaskManager 状态机对齐：
    //   CREATED → PLANNED → RUNNING；BLOCKED / WAITING_APPROVAL → RUNNING（不可先转 PLANNED）
    const runnable = new Set(["CREATED", "BLOCKED", "WAITING_APPROVAL"]);
    if (!runnable.has(t.status)) {
      console.error(`任务状态 ${t.status} 不可执行（需 CREATED/BLOCKED/WAITING_APPROVAL）`);
      process.exitCode = 1;
      memory.close();
      return;
    }
    console.log(`〔用户确认执行：${t.title}〕目标：${t.goal}`);
    if (t.status === "CREATED") tasks.transition(t.id, "PLANNED");
    tasks.transition(t.id, "RUNNING");
    let job;
    try {
      job = await harness.execute({ workDir, goal: t.goal });
    } catch (e) {
      tasks.transition(t.id, "FAILED");
      console.log(`〔任务失败〕${(e as Error).message}`);
      return;
    }
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

  // ---- 具身对话（0.2-④）：数字人状态机 + 语音 + Core 流式对话链路 ----
  if (args[0] === "talk") {
    const { createEmbodiedRuntime } = await import("./embodied.js");
    const talkConvId = conversation.newConversation("具身对话");
    const runtime = createEmbodiedRuntime({
      platform,
      tasks,
      reply: async (text, hooks) => {
        const r = await conversation.receive(
          { conversationId: talkConvId, text },
          {
            onDelta: (t) => hooks.onDelta?.(t),
            onMemoryInjected: (hits) => hooks.onMemoryInjected?.(hits.length),
          },
        );
        return { kind: "answer", text: r.assistantText };
      },
      speechOutputFile: process.env.JARVIS_TALK_OUTPUT_FILE,
      avatar: process.env.JARVIS_TALK_NO_AVATAR !== "1",
      voice: process.env.JARVIS_TALK_NO_VOICE !== "1",
    });
    try {
      await runtime.start();
    } catch (err) {
      console.log(`〔宿主不可用，降级为无窗口模式〕${err instanceof Error ? err.message : String(err)}`);
    }
    console.log(`JARVIS 具身对话 · ${config.model} · 平台 ${platform.id} · Ctrl+C 退出`);

    const single = args.slice(1).join(" ").trim();
    const show = (r: { ok: boolean; state: string; text: string; error?: string }) => {
      console.log(`〔${r.ok ? "完成" : "失败"} · ${r.state}〕${r.text || r.error || ""}`);
    };
    try {
      if (single) {
        const r = await runtime.conversation.submit(single);
        show(r);
        if (!r.ok) process.exitCode = 1;
      } else {
        const rl = readline.createInterface({ input, output });
        try {
          for (;;) {
            const text = (await rl.question("\n你> ")).trim();
            if (!text) continue;
            if (text === "exit" || text === "quit") break;
            show(await runtime.conversation.submit(text));
          }
        } finally {
          rl.close();
        }
      }
    } finally {
      await runtime.stop();
      memory.close();
    }
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
    if (d.type === "capability_gap" && d.gap) {
      // 能力缺口：自动生成骨架（staging，零权限、不注册），等用户审批
      console.log(`〔我还不会这件事——已生成能力骨架，等你批准后开发〕`);
      console.log(`  需求：${d.gap.need}`);
      try {
        const draft = skillFactory.draft(d.gap);
        console.log(`  骨架：${draft.dir}`);
        console.log(`  申请权限：${draft.permissionRequest.length} 项（骨架恒零）`);
        console.log(`  批准：jarvis factory approve ${draft.name}`);
        console.log(`  拒绝：jarvis factory reject ${draft.name}`);
        console.log(`\n${d.text}`);
      } catch (e) {
        // 同名骨架已存在等审批：直接指路
        console.log(`  （骨架已存在：${(e as Error).message}）`);
        console.log(`\n${d.text}`);
      }
      memory.appendMessage(conversationId, "assistant", d.text);
      return;
    }
    if (d.type === "create_task" && turn.task) {
      const t = turn.task;
      // 权限裁决：任务执行
      const verdict = broker.check({
        kind: "task_execute",
        target: t.goal,
        actor: "agent",
      });
      if (t.requiresApproval || !verdict.allow) {
        // 审批门要落到状态机上（CREATED → PLANNED → WAITING_APPROVAL），
        // 否则 WAITING_APPROVAL 永远无生产者，门禁形同虚设。
        if (t.requiresApproval) {
          tasks.transition(t.id, "PLANNED");
          tasks.transition(t.id, "WAITING_APPROVAL");
        }
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
      let job;
      try {
        job = await harness.execute({ workDir, goal: t.goal });
      } catch (e) {
        // 执行失败必须落到终态，否则状态机悬空（RUNNING 无人收尾）
        tasks.transition(t.id, "FAILED");
        console.log(`〔任务失败〕${(e as Error).message}`);
        memory.appendMessage(conversationId, "assistant", `任务失败：${(e as Error).message}`);
        return;
      }
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
  // 管道输入（非 TTY）：逐行读，处理完 stdin 即退出（readline 对 EOF 后
  // 的 question 会抛 "readline was closed"，TTY 交互才走 readline）
  if (!input.isTTY) {
    const chunks: string[] = [];
    for await (const chunk of input) chunks.push(String(chunk));
    for (const line of chunks.join("").split("\n")) {
      const text = line.trim();
      if (!text) continue;
      if (text === "exit" || text === "quit") break;
      try {
        await ask(text);
      } catch (err) {
        console.error(`\n[出错] ${err instanceof Error ? err.message : String(err)}`);
      }
    }
    memory.close();
    return;
  }
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
