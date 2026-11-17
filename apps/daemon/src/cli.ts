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
 *   jarvis llm stats        # 主备模型调用、耗时与 token 统计
 *   jarvis memory [list|search|distill|reindex|wiki|lint|correct|delete]  # 长期记忆、Wiki 编译与纠正
 *   jarvis capabilities [list|run|health|register|enable|disable]  # 能力注册表（0.4）
 *   jarvis capabilities grant <name> <cap> <res> <mode>   # 授予权限（必须已在 skill.json 声明）
 *   jarvis capabilities revoke <name> <cap> <res>          # 撤销权限
 *   jarvis capabilities permissions <name>                 # 权限对照（已声明 vs 已授予）
 *   jarvis factory [list|draft|approve|reject|mcp]   # Skill/MCP 工厂（审批与权限边界不变）
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
import { LLMGateway, OpenAICompatibleProvider, FallbackProvider, type CallLogEntry } from "@jarvis/llm-gateway";
import { SqliteMemoryEngine, OpenAIEmbeddingProvider, OllamaEmbeddingProvider, MemoryDistiller, WikiCompiler, WikiLinter } from "@jarvis/memory";
import { SqliteTaskManager } from "@jarvis/task-manager";
import { Orchestrator } from "@jarvis/orchestrator";
import { CodingHarness, PermissionBroker, type AuditEntry } from "@jarvis/harness-runtime";
import { CapabilityRegistry, SkillFactory, McpFactory } from "@jarvis/capability-registry";
import { createOllamaDistiller, createOllamaWikiWriter, createOllamaConflictJudge, withDistillerFallback } from "./memory-local.js";
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
      } else if (sub === "versions" && args[2]) {
        const versions = registry.list().filter((c) => c.name === args[2]);
        if (versions.length === 0) console.log("（无版本记录）");
        for (const c of versions) console.log(`${c.version.padEnd(10)} ${c.enabled ? "启用" : "停用"}  ${c.created_at}  ${c.health}`);
      } else if (sub === "run" && args[2]) {
        // jarvis capabilities run <name> [json-arg]
        // 走 registry.run 安全入口（先校验权限再执行，ADR-011 红线）
        let inputArg: unknown = {};
        if (args[3]) { try { inputArg = JSON.parse(args[3]); } catch { console.error("输入参数不是合法 JSON"); process.exit(1); } }
        const manifest = registry.loadManifest(args[2]);
        if (!manifest) { console.error(`Skill 不存在：${args[2]}（skillsRoot=${skillsRoot}）`); process.exit(1); }
        try {
          const r = await registry.run(args[2], inputArg);
          console.log(JSON.stringify(r.output, null, 2));
          if (r.rc !== 0) console.error(`（rc=${r.rc}，${r.durationMs}ms）${r.stderr.slice(0, 200)}`);
        } catch (e) {
          console.error(`✗ ${(e as Error).message}`);
          process.exit(1);
        }
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
      } else if (sub === "grant") {
        // jarvis capabilities grant <name> <capability> <resource> <mode>
        // 例：jarvis capabilities grant weather-briefing network wttr.in:80 connect
        if (args.length < 6) {
          console.error("用法：capabilities grant <name> <capability> <resource> <mode>");
          console.error("  例：capabilities grant weather-briefing network wttr.in:80 connect");
          console.error("  红线：权限必须已在 skill.json 的 permissions 数组中声明");
          process.exit(1);
        }
        const r = registry.grantPermission(args[2]!, {
          capability: args[3]!, resource: args[4]!, mode: args[5]!,
        });
        if (r.ok) {
          console.log(`✓ 已授予 ${args[2]} 权限：${args[3]}/${args[4]}/${args[5]}${r.reason ? `（${r.reason}）` : ""}`);
          console.log(`  当前权限：${JSON.stringify(registry.getPermissions(args[2]!), null, 2)}`);
        } else {
          console.error(`✗ 授予失败：${r.reason}`);
          process.exit(1);
        }
      } else if (sub === "revoke") {
        // jarvis capabilities revoke <name> <capability> <resource>
        // 例：jarvis capabilities revoke weather-briefing network wttr.in:80
        if (args.length < 5) {
          console.error("用法：capabilities revoke <name> <capability> <resource>");
          console.error("  例：capabilities revoke weather-briefing network wttr.in:80");
          process.exit(1);
        }
        const r = registry.revokePermission(args[2]!, args[3]!, args[4]!);
        if (r.ok) {
          console.log(`✓ 已撤销 ${r.removed} 项权限${r.reason ? `（${r.reason}）` : ""}`);
        } else {
          console.error(`✗ 撤销失败：${r.reason}`);
          process.exit(1);
        }
      } else if (sub === "permissions" && args[2]) {
        // 显示已声明 vs 已授予权限对照
        const declared = registry.getDeclaredPermissions(args[2]);
        const granted = registry.getPermissions(args[2]);
        console.log(`能力 ${args[2]} 权限对照：\n`);
        console.log(`已声明（skill.json，${declared.length} 项）：`);
        for (const p of declared) console.log(`  - ${p.capability}/${p.resource}/${p.mode}`);
        if (declared.length === 0) console.log("  （无）");
        console.log(`\n已授予（capabilities.db，${granted.length} 项）：`);
        for (const p of granted) console.log(`  - ${p.capability}/${p.resource}/${p.mode}`);
        if (granted.length === 0) console.log("  （无）");
        const undeclared = granted.filter((g) => !declared.some((d) =>
          d.capability === g.capability && d.resource === g.resource && d.mode === g.mode));
        if (undeclared.length > 0) {
          console.log(`\n⚠️  已授予但未声明的权限（异常状态，建议 revoke）：`);
          for (const p of undeclared) console.log(`  - ${p.capability}/${p.resource}/${p.mode}`);
        }
      } else {
        console.error("用法：jarvis capabilities [list --all | run <name> '<json>' | health <name> | register | enable|disable <name> <version> | grant <name> <cap> <res> <mode> | revoke <name> <cap> <res> | permissions <name>]");
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
    const stagingRoot = process.env.JARVIS_STAGING_ROOT
      ?? path.join(os.homedir(), ".local/share/jarvis/.factory-staging");
    const registry = new CapabilityRegistry({ dbPath, skillsRoot });
    const factory = new SkillFactory({ registry, skillsRoot, stagingRoot });
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
      } else if (sub === "mcp" && args[2]) {
        const outputRoot = process.env.JARVIS_MCP_ROOT ?? path.join(os.homedir(), ".local/share/jarvis/mcp");
        const result = new McpFactory({ registry, outputRoot }).generate(args[2]);
        console.log(`已生成 MCP：${result.name}@${result.version}`);
        console.log(`  ${result.serverPath}`);
        console.log("  启动：node " + result.serverPath);
      } else if (sub === "approve" && args[2]) {
        // PLAN Step 4.3 + Step 4.4 完整流水线：security review → sandbox test → register
        // 红线默认开启：未通过任一步则拒绝注册
        const r = await factory.approveWithReview(args[2]);
        if (r.ok) {
          const rec = r.record!;
          console.log(`✓ 已批准并注册：${rec.name}@${rec.version}（权限：${rec.permissions.length} 项）`);
          if (r.warnings && r.warnings.length > 0) {
            console.log(`  警告：${r.warnings.join("; ")}`);
          }
        } else {
          console.error(`✗ 批准失败（阶段 ${r.stage}）：${r.reason}`);
          if (r.warnings && r.warnings.length > 0) {
            console.error(`  警告：${r.warnings.join("; ")}`);
          }
          console.error(`  骨架保留在 staging，修复后重试`);
          process.exit(1);
        }
      } else if (sub === "reject" && args[2]) {
        console.log(factory.reject(args[2]) ? `已删除骨架：${args[2]}` : `staging 无此骨架：${args[2]}`);
      } else if (sub === "develop" && args[2]) {
        // PLAN Step 4.3 develop：调度 LLM 把骨架改写为真实实现
        // 需要 LLM key（其他 factory 子命令不需要）
        const config = loadConfig();
        const gateway = new LLMGateway();
        gateway.register(new OpenAICompatibleProvider({
          id: "zhipu",
          baseUrl: config.baseUrl,
          apiKey: config.apiKey,
          models: [{ id: config.model, provider: "zhipu", vision: true }],
        }));
        console.log(`〔develop ${args[2]}〕调度 ${config.model} 生成真实实现（最长 5 分钟）...`);
        const r = await factory.develop(args[2], {
          model: config.model,
          generate: async (req) => {
            const resp = await gateway.generate({
              model: req.model,
              messages: req.messages.map((m) => ({ role: m.role, content: m.content })),
              temperature: req.temperature,
              timeoutMs: req.timeoutMs,
            });
            return { content: resp.content };
          },
        });
        if (r.ok) {
          console.log(`✓ 已生成真实实现：${r.mainShPath}`);
          console.log(`  骨架备份：${r.skeletonBackup}`);
          console.log(`  诊断日志：${r.logPath}`);
          console.log(`\n下一步：`);
          console.log(`  1. 审阅 main.sh（对照 main.sh.skeleton）`);
          console.log(`  2. 更新 skill.json 的 description 与 smoke.expect.implemented=true`);
          console.log(`  3. jarvis factory approve ${args[2]}`);
        } else {
          console.error(`✗ develop 失败：${r.reason}`);
          if (r.requestedPermissions && r.requestedPermissions.length > 0) {
            console.error(`\nLLM 申请以下权限（请追加到 PERMISSION_REQUEST.md 与 skill.json.permissions 后重新 develop）：`);
            console.error(JSON.stringify(r.requestedPermissions, null, 2));
          }
          console.error(`诊断日志：${r.logPath}`);
          process.exit(1);
        }
      } else if (sub === "repair" && args[2]) {
        // PLAN Step 4.3 多轮 develop：生成 → 沙箱 → 失败诊断 → 自动重写
        const config = loadConfig();
        const gateway = new LLMGateway();
        gateway.register(new OpenAICompatibleProvider({
          id: "zhipu",
          baseUrl: config.baseUrl,
          apiKey: config.apiKey,
          models: [{ id: config.model, provider: "zhipu", vision: true }],
        }));
        console.log(`〔repair ${args[2]}〕最多 3 轮：生成 → 安全审查 → 沙箱 → 自动修复...`);
        const r = await factory.developWithRepair(args[2], {
          model: config.model,
          generate: async (req) => {
            const resp = await gateway.generate({
              model: req.model,
              messages: req.messages.map((m) => ({ role: m.role, content: m.content })),
              temperature: req.temperature,
              timeoutMs: req.timeoutMs,
            });
            return { content: resp.content };
          },
        });
        if (r.ok) {
          console.log(`✓ 已通过安全审查与沙箱（${r.attempts.length} 轮）`);
          console.log(`  实现：${r.mainShPath}`);
          console.log(`  多轮日志：${r.repairLogPath}`);
          console.log(`下一步：审阅后 jarvis factory approve ${args[2]}`);
        } else {
          console.error(`✗ ${r.reason}`);
          for (const a of r.attempts) console.error(`  第 ${a.attempt} 轮 ${a.stage}: ${a.reason ?? "通过"}`);
          if (r.requestedPermissions) {
            console.error(`  LLM 申请权限：${JSON.stringify(r.requestedPermissions)}`);
          }
          console.error(`  多轮日志：${r.repairLogPath}`);
          process.exit(1);
        }
      } else if (sub === "review" && args[2]) {
        // 独立安全审查（不注册）：调试骨架用
        const sr = factory.securityReview(args[2]);
        if (sr.ok) {
          console.log(`✓ 安全审查通过${sr.warnings.length > 0 ? `（${sr.warnings.length} 条警告）` : ""}`);
          for (const w of sr.warnings) console.log(`  ⚠ ${w}`);
        } else {
          console.error(`✗ 安全审查失败：${sr.reason}`);
          process.exit(1);
        }
      } else if (sub === "test" && args[2]) {
        // 独立沙箱测试（不注册）：调试骨架用
        const st = await factory.sandboxTest(args[2]);
        if (st.ok) console.log(`✓ 沙箱测试通过`);
        else { console.error(`✗ 沙箱测试失败：${st.reason}`); process.exit(1); }
      } else {
        console.error("用法：jarvis factory [list | draft \"<需求>\" <名> | develop <名> | repair <名> | approve <名> | reject <名> | review <名> | test <名>]");
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

  // ---- LLM：GLM 主用 + Omarchy 本地备用（可重试错误才切换） ----
  const gateway = new LLMGateway();
  const callLog = { append: (e: CallLogEntry) => memory.appendLLMCall(e) };
  const zhipu = new OpenAICompatibleProvider({
    id: "zhipu",
    baseUrl: config.baseUrl,
    apiKey: config.apiKey,
    models: [{ id: config.model, provider: "zhipu", vision: true }],
    callLog,
  });
  const localChatModel = process.env.JARVIS_OLLAMA_CHAT_MODEL ?? "qwen3:4b";
  const localChat = new OpenAICompatibleProvider({
    id: "ollama",
    baseUrl: `${ollamaBaseUrl}/v1`,
    apiKey: "ollama",
    models: [{ id: localChatModel, provider: "ollama", toolCalling: true }],
    extraBody: { think: false },
    callLog,
  });
  gateway.register(process.env.JARVIS_CHAT_FALLBACK === "0" ? zhipu : new FallbackProvider({
    primary: zhipu,
    fallback: localChat,
    primaryModel: config.model,
    fallbackModel: localChatModel,
    onFallback: (e, operation) => {
      console.error(`〔主模型失败，切换本地 ${localChatModel}〕${operation}: ${e.message}`);
    },
  }));

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

  // ---- 长期记忆：列表 / 语义检索 / 增量蒸馏 / 向量重建 ----
  if (args[0] === "memory") {
    const sub = args[1] ?? "list";
    const defaultWikiRoot = process.env.JARVIS_WIKI_ROOT ?? path.join(os.homedir(), ".local/share/jarvis/memory/wiki");
    const compileWikiAt = async (rootDir: string) => new WikiCompiler(memory).compile({
      rootDir,
      synthesize: createOllamaWikiWriter({
        baseUrl: ollamaBaseUrl,
        model: process.env.JARVIS_OLLAMA_DISTILL_MODEL ?? "qwen3:4b",
      }),
    });
    if (sub === "list") {
      const records = memory.list();
      if (records.length === 0) console.log("（无长期记忆）");
      for (const r of records) console.log(`${r.kind.padEnd(22)} ${r.id}  ${r.content}`);
    } else if (sub === "search") {
      const lexicalOnly = args[2] === "--lexical";
      const query = args.slice(lexicalOnly ? 3 : 2).join(" ").trim();
      if (!query) { console.error("用法：memory search [--lexical] <query>"); process.exit(1); }
      const hits = lexicalOnly ? memory.search(query) : await memory.semanticSearch(query);
      if (hits.length === 0) console.log("（无命中）");
      for (const h of hits) console.log(`${h.score.toFixed(3)} ${h.record.kind.padEnd(22)} ${h.record.content}`);
    } else if (sub === "distill") {
      const conversationId = args[2] ?? memory.listConversations()[0]?.id;
      if (!conversationId) { console.error("无可蒸馏会话"); process.exit(1); }
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
      const summarizer = process.env.JARVIS_MEMORY_DISTILLER === "glm"
        ? glmDistill
        : withDistillerFallback(localDistill, glmDistill, (e) => {
            console.error(`〔本地蒸馏不可用，降级 GLM〕${e.message}`);
          });
      const distiller = new MemoryDistiller(memory, summarizer);
      const r = await distiller.distillConversation(conversationId);
      console.log(`蒸馏完成：写入/刷新 ${r.records.length} 条，敏感消息跳过 ${r.skippedSensitive} 条，水位线 ${r.watermark ?? "无"}`);
      for (const record of r.records) console.log(`  ${record.kind.padEnd(22)} ${record.content}`);
    } else if (sub === "reindex") {
      const count = await memory.reindexAll();
      console.log(`已为 ${count} 条记忆重建向量索引`);
    } else if (sub === "wiki") {
      const rootDir = path.resolve(args[2] ?? defaultWikiRoot);
      const result = await compileWikiAt(rootDir);
      console.log(`Wiki 编译完成：${result.recordCount} 条记忆，${result.files.length} 个页面，概览模式 ${result.overviewMode}`);
      console.log(`  ${result.rootDir}`);
    } else if (sub === "lint") {
      const rootDir = path.resolve(args[2] ?? defaultWikiRoot);
      const report = await new WikiLinter(memory).lint({
        rootDir,
        conflictJudge: createOllamaConflictJudge({
          baseUrl: ollamaBaseUrl,
          model: process.env.JARVIS_OLLAMA_DISTILL_MODEL ?? "qwen3:4b",
        }),
      });
      console.log(`Lint 完成：${report.issues.length} 项问题，${report.warnings.length} 项警告`);
      console.log(`  ${report.lintPath}`);
    } else if (sub === "correct") {
      const id = args[2];
      const content = args.slice(3).join(" ").trim();
      if (!id || !content) { console.error("用法：memory correct <id> <content>"); process.exit(1); }
      const updated = memory.update(id, content);
      if (!updated) { console.error(`记忆不存在：${id}`); process.exit(1); }
      await memory.reindexAll();
      await compileWikiAt(defaultWikiRoot);
      console.log(`已纠正并重建索引/Wiki：${updated.id}`);
    } else if (sub === "delete") {
      const id = args[2];
      if (!id) { console.error("用法：memory delete <id>"); process.exit(1); }
      if (!memory.delete(id)) { console.error(`记忆不存在：${id}`); process.exit(1); }
      await compileWikiAt(defaultWikiRoot);
      console.log(`已删除并刷新 Wiki：${id}`);
    } else {
      console.error("用法：jarvis memory [list | search [--lexical] <query> | distill [conversationId] | reindex | wiki [path] | lint [path] | correct <id> <content> | delete <id>]");
      process.exit(1);
    }
    memory.close();
    return;
  }

  // ---- 模型调用统计（主备分别聚合） ----
  if (args[0] === "llm" && (args[1] ?? "stats") === "stats") {
    const logs = memory.listLLMCalls(1_000);
    const ok = logs.filter((l) => l.ok).length;
    const tokens = logs.reduce((sum, l) => sum + (l.usage?.totalTokens ?? 0), 0);
    const avg = logs.length ? Math.round(logs.reduce((sum, l) => sum + l.durationMs, 0) / logs.length) : 0;
    console.log(`近 ${logs.length} 次调用：成功 ${ok}，失败 ${logs.length - ok}，平均 ${avg}ms，总 tokens ${tokens}`);
    const byModel = new Map<string, { calls: number; failed: number; duration: number; tokens: number }>();
    for (const log of logs) {
      const current = byModel.get(log.model) ?? { calls: 0, failed: 0, duration: 0, tokens: 0 };
      current.calls++;
      if (!log.ok) current.failed++;
      current.duration += log.durationMs;
      current.tokens += log.usage?.totalTokens ?? 0;
      byModel.set(log.model, current);
    }
    for (const [model, s] of byModel) {
      console.log(`  ${model}: ${s.calls} 次，失败 ${s.failed}，平均 ${Math.round(s.duration / s.calls)}ms，tokens ${s.tokens}`);
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
    if (d.type === "invoke_capability" && d.invoke) {
      // 已注册能力的真实执行（能力闭环最后一环：对话→能力→结果）
      // 走 capRegistry.run 安全入口（先校验权限，ADR-011 红线）
      try {
        const rec = capRegistry.findByName(d.invoke.name);
        if (!rec) {
          console.log(`〔能力未注册：${d.invoke.name}〕`);
          output.write(d.text + "\n");
          memory.appendMessage(conversationId, "user", text);
          memory.appendMessage(conversationId, "assistant", d.text);
          return;
        }
        if (d.text) console.log(`〔${d.text}〕`);
        const result = await capRegistry.run(d.invoke.name, { args: d.invoke.args ?? {} });
        // RunResult.output 是 skill 的 stdout JSON：{ok, implemented, result}
        const r = (result.output ?? {}) as { ok?: boolean; implemented?: boolean; result?: { speech?: string }; error?: string };
        let reply: string;
        if (r.ok && r.result?.speech) {
          reply = r.result.speech;
        } else if (r.ok) {
          reply = JSON.stringify(r.result ?? r, null, 2);
        } else {
          reply = `能力执行失败：${r.error ?? result.stderr ?? "未知错误"}`;
        }
        console.log(reply);
        memory.appendMessage(conversationId, "user", text);
        memory.appendMessage(conversationId, "assistant", reply);
      } catch (e) {
        const msg = `能力执行异常：${(e as Error).message}`;
        console.log(msg);
        memory.appendMessage(conversationId, "assistant", msg);
      }
      return;
    }
    if (d.type === "invoke_ui" && d.ui) {
      // FR-12 Dynamic UI Host：生成交互界面（设置/任务列表/确认/进度条）
      // 通过 bridge server 透传到 guest 内的 UI Host（/ui/* → 8788）
      try {
        const bridgePort = process.env.JARVIS_BRIDGE_PORT ?? "9222";
        const timeoutMs = Number(process.env.JARVIS_UI_TIMEOUT_MS ?? 12_000);
        const res = await fetch(`http://localhost:${bridgePort}/ui/render`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          signal: AbortSignal.timeout(timeoutMs),
          body: JSON.stringify({
            type: d.ui.type,
            title: d.ui.title,
            data: d.ui.data ?? {},
            actions: d.ui.actions ?? [{ id: "ok", label: "确定" }],
          }),
        });
        const r = await res.json() as { ok?: boolean; windowId?: string; error?: string };
        if (r.ok) {
          console.log(`〔已弹出窗口：${d.ui.title}〕（windowId=${r.windowId}）`);
          if (d.text) console.log(d.text);
          memory.appendMessage(conversationId, "user", text);
          memory.appendMessage(conversationId, "assistant", d.text || `已弹出窗口：${d.ui.title}`);
        } else {
          console.log(`〔窗口弹出失败：${r.error ?? "未知错误"}〕`);
          console.log(d.text);
          memory.appendMessage(conversationId, "assistant", d.text);
        }
      } catch (e) {
        const err = e as Error & { cause?: { message?: string } };
        const reason = err.cause?.message ? `${err.message}（${err.cause.message}）` : err.message;
        console.log(`〔UI Host 不可用：${reason}〕`);
        console.log(d.text);
        memory.appendMessage(conversationId, "assistant", d.text);
      }
      return;
    }
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
