/**
 * Harness Factory Skill 生成器（ADR-011 · PLAN-0.4 Step 4.3）
 *
 * 缺口 → 骨架 → 审批 → 注册：
 *  - draft(gap)：由 capability_gap 报告生成 Skill 骨架到 staging 目录
 *    （skill.json 含 input/output schema + smoke 契约；main.sh 参照实现；
 *    tests/smoke.test.sh；README；PERMISSION_REQUEST.md 权限申请单）
 *  - 骨架永远先落 staging（.jarvis-factory/staging/<name>/），不自动注册
 *  - approve(name)：用户显式批准 → 移入 skillsRoot + 注册（权限恒零授予，
 *    申请单中的权限仅是「申请」，授予需用户逐项在 capabilities.db 手工
 *    落库——Factory 不提供该路径）
 *  - develop(name, opts)：调度 LLM 把骨架 main.sh 改写为真实实现；
 *    不自动 approve（用户审阅后再 approve），不修改 PERMISSION_REQUEST.md
 *    与 skill.json 的 permissions（红线：申请单只能用户改）
 */
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import type { CapabilityRegistry } from "./registry.js";
import { SkillRunner } from "./registry.js";

/** LLM 生成函数（依赖注入；调用方适配 LLMGateway.generate，避免本包依赖 llm-gateway） */
export type LLMGenerateFn = (request: {
  model: string;
  messages: Array<{ role: "system" | "user" | "assistant"; content: string }>;
  temperature?: number;
  /** 单请求超时毫秒数（与 LLMGateway.LLMRequest.timeoutMs 对齐） */
  timeoutMs?: number;
}) => Promise<{ content: string }>;

export interface DevelopOptions {
  generate: LLMGenerateFn;
  model: string;
  /** 调用超时（毫秒，默认 5 分钟——真实代码生成可能需要较长时间） */
  timeoutMs?: number;
}

export interface DevelopResult {
  ok: boolean;
  /** 失败原因（LLM 异常 / 响应无代码块 / 需要更多权限等） */
  reason?: string;
  /** 真实实现 main.sh 路径 */
  mainShPath: string;
  /** 原骨架备份路径（main.sh.skeleton） */
  skeletonBackup: string;
  /** 诊断日志路径（DEVELOP_LOG.md，含 prompt + 原始响应 + 提取的代码） */
  logPath: string;
  /** LLM 声明需要更多权限时（不生成代码），此处携带申请项（供用户追加到 PERMISSION_REQUEST.md） */
  requestedPermissions?: Array<{ capability: string; resource: string; mode: string }>;
}

export interface RepairOptions extends DevelopOptions {
  /** 生成 + 沙箱失败后的最大总尝试轮数（含首次，默认 3） */
  maxAttempts?: number;
}

export interface RepairAttempt {
  attempt: number;
  stage: "develop" | "security" | "sandbox";
  ok: boolean;
  reason?: string;
}

export interface RepairResult extends DevelopResult {
  attempts: RepairAttempt[];
  /** 多轮诊断日志（REPAIR_LOG.md） */
  repairLogPath: string;
}

export interface GapReport {
  need: string;
  suggestedKind: string;
  suggestedName: string;
}

export interface FactoryOptions {
  skillsRoot?: string;
  /** staging 根目录（默认 ~/.local/share/jarvis/.factory-staging） */
  stagingRoot?: string;
  registry: CapabilityRegistry;
}

export interface DraftResult {
  name: string;
  version: string;
  dir: string;
  files: string[];
  permissionRequest: string[]; // 申请的权限（未授予）
}

export class SkillFactory {
  readonly skillsRoot: string;
  readonly stagingRoot: string;
  private readonly registry: CapabilityRegistry;

  constructor(opts: FactoryOptions) {
    this.registry = opts.registry;
    this.skillsRoot = opts.skillsRoot
      ?? path.join(os.homedir(), ".local/share/jarvis/skills");
    this.stagingRoot = opts.stagingRoot
      ?? path.join(os.homedir(), ".local/share/jarvis/.factory-staging");
  }

  /** gap → 骨架（落 staging，等审批）。同名未决骨架拒绝重复生成。 */
  draft(gap: GapReport): DraftResult {
    const name = sanitizeName(gap.suggestedName);
    const version = "0.1.0";
    const dir = path.join(this.stagingRoot, name);
    if (fs.existsSync(path.join(dir, "skill.json"))) {
      throw new Error(`同名骨架已在 staging 等待审批：${name}（先 approve 或删除）`);
    }
    fs.mkdirSync(path.join(dir, "tests"), { recursive: true });

    // 1) skill.json：input/output schema + smoke 契约（骨架行为=回显 need）
    const manifest = {
      name, version,
      description: `（Factory 骨架，待实现）${gap.need}`,
      entry: { command: "./main.sh" },
      input: {
        type: "object",
        properties: { args: { type: "object", description: "能力参数" } },
      },
      output: {
        type: "object",
        properties: {
          ok: { type: "boolean" },
          implemented: { type: "boolean", description: "骨架恒 false；实现后置 true" },
          result: { type: "object" },
        },
      },
      smoke: { input: { args: {} }, expect: { ok: true, implemented: false } },
      permissions: [],
    };
    fs.writeFileSync(path.join(dir, "skill.json"), JSON.stringify(manifest, null, 2) + "\n");

    // 2) main.sh：安全回显骨架（stdin JSON → 固定 JSON；printf 拼接防注入）
    const main = [
      "#!/bin/sh",
      `# ${name}（Factory 生成骨架）——需求：${gap.need}`,
      "# 骨架行为：读 stdin，返回 implemented=false。实现本能力时替换此文件",
      "# 并把 skill.json 的 smoke.expect.implemented 改为 true。",
      "input=$(cat)",
      "printf '{\"ok\": true, \"implemented\": false, \"result\": {\"echo\": %s}}\\n' \"$(printf %s \"$input\" | wc -c | tr -d ' ')\"",
      "",
    ].join("\n");
    fs.writeFileSync(path.join(dir, "main.sh"), main);
    fs.chmodSync(path.join(dir, "main.sh"), 0o755);

    // 3) smoke 测试（shell 契约，无 vitest 依赖；guest/宿主都能跑）
    const test = [
      "#!/bin/sh",
      "# smoke：skill.json 的 smoke 契约可执行且输出匹配",
      `cd "$(dirname "$0")/.." || exit 1`,
      `out=$(printf '%s' '{"args":{}}' | ./main.sh)`,
      `echo "$out" | grep -q '"ok": true' || { echo "FAIL: $out"; exit 1; }`,
      `echo "$out" | grep -q '"implemented": false' || { echo "FAIL: implemented 应为 false（骨架）"; exit 1; }`,
      `echo PASS`,
      "",
    ].join("\n");
    fs.writeFileSync(path.join(dir, "tests", "smoke.test.sh"), test);
    fs.chmodSync(path.join(dir, "tests", "smoke.test.sh"), 0o755);

    // 4) README
    fs.writeFileSync(path.join(dir, "README.md"),
      `# ${name}\n\n- 需求：${gap.need}\n- 形态：${gap.suggestedKind}\n- 状态：**Factory 骨架（未审批）**\n\n` +
      `## 实现步骤\n1. 审阅 PERMISSION_REQUEST.md（权限申请单）\n2. \`jarvis factory approve ${name}\` 批准并注册\n3. 替换 main.sh 为真实实现（保持 stdin JSON → stdout JSON 契约）\n4. 更新 skill.json 的 description/smoke.expect.implemented=true\n5. \`jarvis capabilities health ${name}\` 验证 healthy\n`);

    // 5) 权限申请单（本骨架申请零权限；实现涉及额外权限时在此追加并等用户逐项批准）
    fs.writeFileSync(path.join(dir, "PERMISSION_REQUEST.md"),
      `# 权限申请单：${name}\n\n- 需求：${gap.need}\n- 申请权限：**无**（骨架零权限）\n- 实现期若需要文件写入/网络等权限，追加到下表并重新请批：\n\n` +
      `| 权限 | 用途 | 状态 |\n|---|---|---|\n| （无） | | |\n\n> 授予动作只能由用户执行（capabilities.db 手工落库），Factory/Registry 无自动授予路径。\n`);

    return {
      name, version, dir,
      files: ["skill.json", "main.sh", "tests/smoke.test.sh", "README.md", "PERMISSION_REQUEST.md"],
      permissionRequest: [],
    };
  }

  /** staging 骨架列表 */
  listDrafts(): Array<{ name: string; need: string; at: string }> {
    if (!fs.existsSync(this.stagingRoot)) return [];
    return fs.readdirSync(this.stagingRoot, { withFileTypes: true })
      .filter((d) => d.isDirectory())
      .map((d) => {
        let need = "";
        try {
          need = (JSON.parse(fs.readFileSync(path.join(this.stagingRoot, d.name, "skill.json"), "utf8")) as { description?: string }).description ?? "";
        } catch { /* 无清单的目录跳过 */ }
        return { name: d.name, need, at: fs.statSync(path.join(this.stagingRoot, d.name)).mtime.toISOString() };
      });
  }

  /** 用户显式批准：staging → skillsRoot + 注册（零权限）。返回注册记录。 */
  approve(name: string) {
    const src = path.join(this.stagingRoot, sanitizeName(name));
    const manifestPath = path.join(src, "skill.json");
    if (!fs.existsSync(manifestPath)) {
      throw new Error(`staging 中无此骨架：${name}（先 draft）`);
    }
    const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8")) as { name: string; version: string; description?: string };
    const dst = path.join(this.skillsRoot, manifest.name);
    fs.mkdirSync(this.skillsRoot, { recursive: true });
    fs.cpSync(src, dst, { recursive: true });
    const rec = this.registry.register({
      name: manifest.name, version: manifest.version, kind: "skill",
      entry: manifest.name, description: manifest.description ?? "",
    });
    fs.rmSync(src, { recursive: true, force: true });
    return rec;
  }

  /** 拒绝：删除 staging 骨架（不产生任何注册） */
  reject(name: string): boolean {
    const src = path.join(this.stagingRoot, sanitizeName(name));
    if (!fs.existsSync(src)) return false;
    fs.rmSync(src, { recursive: true, force: true });
    return true;
  }

  // ---- PLAN Step 4.3 三步：develop / sandbox test / security review ----

  /**
   * 安全审查（PLAN Step 4.3 · ADR-011 红线）：扫 main.sh + 校验 manifest。
   * 同步执行，纯静态扫描，不调 LLM。
   */
  securityReview(name: string): { ok: boolean; reason?: string; warnings: string[] } {
    const src = path.join(this.stagingRoot, sanitizeName(name));
    const manifestPath = path.join(src, "skill.json");
    if (!fs.existsSync(manifestPath)) {
      return { ok: false, reason: `staging 中无此骨架：${name}`, warnings: [] };
    }
    const warnings: string[] = [];
    const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8")) as {
      name: string;
      entry?: { command?: string; args?: string[] };
      permissions?: Array<{ capability: string; resource: string; mode: string }>;
    };

    // 1. entry.command 路径边界（必须在 skillsRoot 内的相对路径，禁止 PATH 逃逸）
    const cmd = manifest.entry?.command ?? "";
    if (!cmd) return { ok: false, reason: "manifest.entry.command 缺失", warnings };
    if (cmd.includes("..")) {
      return { ok: false, reason: `entry.command 含 PATH 逃逸（..）：${cmd}`, warnings };
    }
    if (cmd.startsWith("/")) {
      return { ok: false, reason: `entry.command 不允许绝对路径：${cmd}（必须 skillsRoot 内相对路径）`, warnings };
    }
    if (!cmd.startsWith("./")) {
      warnings.push(`entry.command 建议 ./ 前缀（当前 ${cmd}）`);
    }

    // 2. 权限声明合理性（禁止通配、根目录）
    for (const p of manifest.permissions ?? []) {
      if (p.resource === "*" || p.resource === "/*" || p.resource === "/") {
        return { ok: false, reason: `权限声明 resource 过宽：${p.resource}（禁止 * / / 根）`, warnings };
      }
    }

    // 3. main.sh 危险命令静态扫描
    const mainPath = path.join(src, "main.sh");
    if (fs.existsSync(mainPath)) {
      const code = fs.readFileSync(mainPath, "utf8");
      const dangerous = scanDangerous(code);
      if (dangerous.length > 0) {
        return { ok: false, reason: `main.sh 含危险命令：${dangerous.join("; ")}`, warnings };
      }
    }

    return { ok: true, warnings };
  }

  /**
   * 沙箱测试（PLAN Step 4.3）：在 staging 目录内跑 skill.json 声明的 smoke 契约。
   * 不依赖 registry.register（staging 骨架未注册）；直接 SkillRunner 在 staging 内跑。
   */
  async sandboxTest(
    name: string,
    options: { expect?: Record<string, unknown> } = {},
  ): Promise<{ ok: boolean; reason?: string }> {
    const sanitized = sanitizeName(name);
    const src = path.join(this.stagingRoot, sanitized);
    const manifestPath = path.join(src, "skill.json");
    if (!fs.existsSync(manifestPath)) {
      return { ok: false, reason: `staging 中无此骨架：${name}` };
    }
    const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8")) as {
      smoke?: { input: unknown; expect?: Record<string, unknown> };
    };
    if (!manifest.smoke) {
      return { ok: false, reason: "skill.json 未声明 smoke 契约" };
    }
    // 用 stagingRoot 作为临时 skillsRoot 跑 smoke（目录结构 staging/<name>/ 与 skills/<name>/ 同形）
    const runner = new SkillRunner(this.stagingRoot);
    try {
      const r = await runner.run(sanitized, manifest.smoke.input, { timeoutMs: 15_000 });
      if (r.rc !== 0) {
        return { ok: false, reason: `smoke 执行失败 rc=${r.rc}：${r.stderr.slice(0, 200)}` };
      }
      const out = (r.output ?? {}) as Record<string, unknown>;
      const expect = { ...(manifest.smoke.expect ?? {}), ...(options.expect ?? {}) };
      for (const [k, v] of Object.entries(expect)) {
        if (out[k] !== v) {
          return { ok: false, reason: `smoke 期望不匹配：${k} 期望 ${JSON.stringify(v)} 实际 ${JSON.stringify(out[k])}` };
        }
      }
      return { ok: true };
    } catch (e) {
      return { ok: false, reason: `smoke 执行异常：${(e as Error).message}` };
    }
  }

  /**
   * 完整批准流水线（PLAN Step 4.3 + Step 4.4）：
   * security review → sandbox test → register
   * 任一步失败：拒绝注册并返回诊断；骨架保留在 staging 供修复后重试。
   */
  async approveWithReview(name: string): Promise<{
    ok: boolean;
    stage: "security" | "sandbox" | "register" | "done";
    reason?: string;
    warnings?: string[];
    record?: ReturnType<CapabilityRegistry["register"]>;
  }> {
    // 1. 安全审查
    const sr = this.securityReview(name);
    if (!sr.ok) {
      return { ok: false, stage: "security", reason: sr.reason, warnings: sr.warnings };
    }
    // 2. 沙箱测试
    const st = await this.sandboxTest(name);
    if (!st.ok) {
      return { ok: false, stage: "sandbox", reason: st.reason, warnings: sr.warnings };
    }
    // 3. 注册（复用 approve 的移入 + 注册逻辑）
    try {
      const rec = this.approve(name);
      return { ok: true, stage: "done", record: rec, warnings: sr.warnings };
    } catch (e) {
      return { ok: false, stage: "register", reason: (e as Error).message, warnings: sr.warnings };
    }
  }

  /**
   * 调度 LLM 把 staging 骨架 main.sh 改写为真实实现（PLAN Step 4.3 develop 步）。
   *
   * 最小版（用户裁决 2026-11-16）：
   * - 不自动 approve——生成后用户审阅 main.sh，再 factory approve
   * - 不修改 PERMISSION_REQUEST.md / skill.json 的 permissions（红线：申请单只能用户改）
   * - LLM 声明需要更多权限时不生成代码，返回 requestedPermissions 供用户追加
   * - 失败时 main.sh 不变（骨架保留）
   *
   * 流程：
   * 1. 加载 staging/<name>/{skill.json, main.sh, PERMISSION_REQUEST.md}
   * 2. 备份 main.sh → main.sh.skeleton（幂等）
   * 3. 构造 prompt（需求 + 契约 + 当前骨架 + 已声明权限）
   * 4. 调 generate
   * 5. 提取 ```sh ... ``` 代码块
   * 6. 写回 main.sh + 落 DEVELOP_LOG.md 诊断
   */
  async develop(name: string, opts: DevelopOptions): Promise<DevelopResult> {
    const sanitized = sanitizeName(name);
    const src = path.join(this.stagingRoot, sanitized);
    const manifestPath = path.join(src, "skill.json");
    const mainShPath = path.join(src, "main.sh");
    const skeletonBackup = path.join(src, "main.sh.skeleton");
    const logPath = path.join(src, "DEVELOP_LOG.md");
    const permRequestPath = path.join(src, "PERMISSION_REQUEST.md");

    if (!fs.existsSync(manifestPath)) {
      return {
        ok: false, reason: `staging 中无此骨架：${name}`,
        mainShPath, skeletonBackup, logPath,
      };
    }
    const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8")) as {
      name: string;
      description?: string;
      input?: Record<string, unknown>;
      output?: Record<string, unknown>;
      smoke?: { input: unknown; expect?: Record<string, unknown> };
      permissions?: Array<{ capability: string; resource: string; mode: string }>;
    };
    const skeletonCode = fs.existsSync(mainShPath) ? fs.readFileSync(mainShPath, "utf8") : "";
    const permRequest = fs.existsSync(permRequestPath)
      ? fs.readFileSync(permRequestPath, "utf8")
      : "（无权限申请单）";

    // 1. 备份骨架（幂等）
    if (!fs.existsSync(skeletonBackup) && skeletonCode) {
      fs.writeFileSync(skeletonBackup, skeletonCode, "utf8");
    }

    // 2. 构造 prompt
    const systemPrompt = `你是 JARVIS Skill 开发者。任务：把 staging 中的 main.sh 骨架（implemented=false）改写为真实实现（implemented=true）。

【契约要求】
- 输入：stdin JSON（结构见 skill.json.input）
- 输出：stdout JSON，必须含 ok/implemented/result 三键
- 必须设置 "implemented": true
- 必须满足 skill.json.smoke.expect 声明的所有键值
- 保持 POSIX sh 兼容（guest 内是 dash/bash）
- 工作目录 cwd 已是 skill 目录，使用相对路径

【红线（必须遵守）】
- 只能使用 skill.json.permissions 中已声明的权限
- 不得读写权限声明外的路径
- 不得访问权限声明外的网络/主机
- 禁止危险命令：rm -rf /, dd if=, mkfs, curl|sh, wget|sh, eval \$(...), chmod 777 /, > /dev/sd*
- entry.command 必须是 ./main.sh 或 skillsRoot 内相对路径（禁止 .. 与绝对路径）

【输出格式】
- 成功：仅输出一个 \`\`\`sh ... \`\`\` 代码块，含完整 main.sh（#!/bin/sh 开头）
- 无法在当前权限内实现：输出 \`\`\`json ... \`\`\` 块：
  {"error":"needs_more_permissions","requested":[{"capability":"...","resource":"...","mode":"..."}],"reason":"..."}`;

    const userPrompt = `【需求】${manifest.description ?? name}

【skill.json.input 契约】
${JSON.stringify(manifest.input ?? {}, null, 2)}

【skill.json.output 契约】
${JSON.stringify(manifest.output ?? {}, null, 2)}

【skill.json.smoke 契约】
${JSON.stringify(manifest.smoke ?? {}, null, 2)}

【已声明权限】
${JSON.stringify(manifest.permissions ?? [], null, 2)}

【PERMISSION_REQUEST.md】
${permRequest}

【当前骨架 main.sh】
\`\`\`sh
${skeletonCode}
\`\`\`

请输出真实实现的 main.sh（一个 \`\`\`sh 代码块）。`;

    // 3. 调 LLM
    let llmContent = "";
    let llmError = "";
    try {
      const timeoutMs = opts.timeoutMs ?? 5 * 60_000;
      let timeout: ReturnType<typeof setTimeout> | undefined;
      try {
        const result = await Promise.race([
          opts.generate({
            model: opts.model,
            messages: [
              { role: "system", content: systemPrompt },
              { role: "user", content: userPrompt },
            ],
            temperature: 0.2,
            timeoutMs,
          }),
          new Promise<never>((_, reject) => {
            timeout = setTimeout(() => reject(new Error(`LLM 调用超时（${timeoutMs}ms）`)), timeoutMs);
          }),
        ]);
        llmContent = result.content ?? "";
      } finally {
        // Promise.race 不会自动取消另一个分支；成功后必须清理超时定时器，
        // 否则 CLI 会被空定时器保活满 timeoutMs（实测 develop 成功仍挂 5 分钟）。
        if (timeout) clearTimeout(timeout);
      }
    } catch (e) {
      llmError = (e as Error).message;
    }

    // 4. 诊断日志
    const logSections = [
      `# DEVELOP_LOG · ${name}`,
      ``,
      `- 时间：${new Date().toISOString()}`,
      `- 模型：${opts.model}`,
      `- 状态：${llmError ? `LLM 异常：${llmError}` : "已收到响应"}`,
      ``,
      `## System Prompt`,
      `\`\`\``,
      systemPrompt,
      `\`\`\``,
      ``,
      `## User Prompt`,
      `\`\`\``,
      userPrompt,
      `\`\`\``,
      ``,
      `## LLM 原始响应`,
      `\`\`\``,
      llmContent || "（空）",
      `\`\`\``,
    ];

    if (llmError) {
      fs.writeFileSync(logPath, logSections.join("\n"), "utf8");
      return { ok: false, reason: `LLM 异常：${llmError}`, mainShPath, skeletonBackup, logPath };
    }

    // 5. 尝试提取 needs_more_permissions 响应
    const permBlockMatch = llmContent.match(/```json\s*([\s\S]*?)```/);
    if (permBlockMatch) {
      try {
        const parsed = JSON.parse(permBlockMatch[1]!) as {
          error?: string;
          requested?: Array<{ capability: string; resource: string; mode: string }>;
          reason?: string;
        };
        if (parsed.error === "needs_more_permissions") {
          logSections.push(``, `## 结论`, `LLM 声明需要更多权限：${parsed.reason ?? ""}`, ``, `申请项：`, `\`\`\`json`, JSON.stringify(parsed.requested ?? [], null, 2), `\`\`\``);
          fs.writeFileSync(logPath, logSections.join("\n"), "utf8");
          return {
            ok: false,
            reason: `需要更多权限：${parsed.reason ?? "未说明"}（请追加到 PERMISSION_REQUEST.md 后重新 develop）`,
            mainShPath, skeletonBackup, logPath,
            requestedPermissions: parsed.requested ?? [],
          };
        }
      } catch { /* JSON 块不是 needs_more_permissions，继续找 sh 块 */ }
    }

    // 6. 提取 sh 代码块
    const shMatch = llmContent.match(/```sh\s*([\s\S]*?)```/);
    if (!shMatch) {
      logSections.push(``, `## 结论`, `LLM 响应中未找到 \`\`\`sh 代码块`);
      fs.writeFileSync(logPath, logSections.join("\n"), "utf8");
      return {
        ok: false, reason: "LLM 响应中未找到 ```sh 代码块（详见 DEVELOP_LOG.md）",
        mainShPath, skeletonBackup, logPath,
      };
    }
    const newCode = shMatch[1]!.trim() + "\n";
    if (!newCode.startsWith("#!")) {
      logSections.push(``, `## 结论`, `提取的代码块缺 shebang（#! 开头）`);
      fs.writeFileSync(logPath, logSections.join("\n"), "utf8");
      return {
        ok: false, reason: "提取的 main.sh 缺 #! shebang",
        mainShPath, skeletonBackup, logPath,
      };
    }

    // 7. 写回 main.sh
    fs.writeFileSync(mainShPath, newCode, "utf8");
    fs.chmodSync(mainShPath, 0o755);
    logSections.push(``, `## 提取的 main.sh`, `\`\`\`sh`, newCode, `\`\`\``, ``, `## 结论`, `✓ 已写回 main.sh（原骨架备份于 main.sh.skeleton）。请审阅后 \`factory approve ${name}\`。`);
    fs.writeFileSync(logPath, logSections.join("\n"), "utf8");

    return { ok: true, mainShPath, skeletonBackup, logPath };
  }

  /**
   * 多轮 develop：生成 → security review → 真实 sandbox → 失败诊断 → 自动重写。
   *
   * - 复用 develop 的权限红线、超时清理与 LLM 响应解析；每轮把上一失败原因
   *   追加到 user prompt，当前 main.sh 由 develop 重新读取。
   * - 沙箱校验时仅临时覆盖 expect.implemented=true；成功后才写回 skill.json。
   * - 不自动 approve；最终失败恢复最初 main.sh，所有尝试代码与日志另存供审阅。
   */
  async developWithRepair(name: string, opts: RepairOptions): Promise<RepairResult> {
    const sanitized = sanitizeName(name);
    const src = path.join(this.stagingRoot, sanitized);
    const manifestPath = path.join(src, "skill.json");
    const mainShPath = path.join(src, "main.sh");
    const skeletonBackup = path.join(src, "main.sh.skeleton");
    const logPath = path.join(src, "DEVELOP_LOG.md");
    const repairLogPath = path.join(src, "REPAIR_LOG.md");
    const originalCode = fs.existsSync(mainShPath) ? fs.readFileSync(mainShPath, "utf8") : "";
    const attempts: RepairAttempt[] = [];
    const requestedMax = opts.maxAttempts ?? 3;
    const maxAttempts = Number.isFinite(requestedMax) ? Math.max(1, Math.floor(requestedMax)) : 3;
    let lastReason = "尚未执行";

    fs.writeFileSync(repairLogPath, `# REPAIR_LOG · ${sanitized}\n\n- 最大尝试轮数：${maxAttempts}\n`, "utf8");

    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      const previousFailure = lastReason;
      const result = await this.develop(sanitized, {
        ...opts,
        generate: async (request) => {
          if (attempt === 1) return opts.generate(request);
          const messages = request.messages.map((m) => ({ ...m }));
          const last = messages.length - 1;
          if (last >= 0) {
            messages[last]!.content += `\n\n【上一轮自动修复上下文】\n上一轮未通过，原因：${previousFailure}\n请针对该原因修复当前 main.sh，保持全部权限红线，只输出完整 sh 代码块。`;
          }
          return opts.generate({ ...request, messages });
        },
      });

      if (fs.existsSync(logPath)) {
        fs.copyFileSync(logPath, path.join(src, `DEVELOP_LOG.attempt-${attempt}.md`));
      }
      fs.appendFileSync(repairLogPath, `\n## 第 ${attempt} 轮\n\n`, "utf8");

      if (result.requestedPermissions) {
        attempts.push({ attempt, stage: "develop", ok: false, reason: result.reason });
        fs.appendFileSync(repairLogPath, `需要更多权限：${result.reason}\n`, "utf8");
        return { ...result, attempts, repairLogPath };
      }
      if (!result.ok) {
        lastReason = result.reason ?? "develop 失败";
        attempts.push({ attempt, stage: "develop", ok: false, reason: lastReason });
        fs.appendFileSync(repairLogPath, `develop 失败：${lastReason}\n`, "utf8");
        continue;
      }

      fs.copyFileSync(mainShPath, path.join(src, `main.sh.attempt-${attempt}`));
      const sr = this.securityReview(sanitized);
      if (!sr.ok) {
        lastReason = sr.reason ?? "安全审查失败";
        attempts.push({ attempt, stage: "security", ok: false, reason: lastReason });
        fs.appendFileSync(repairLogPath, `security 失败：${lastReason}\n`, "utf8");
        continue;
      }

      const st = await this.sandboxTest(sanitized, { expect: { implemented: true } });
      if (st.ok) {
        const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8")) as {
          smoke?: { input?: unknown; expect?: Record<string, unknown> };
        };
        if (manifest.smoke) {
          manifest.smoke.expect = { ...(manifest.smoke.expect ?? {}), implemented: true };
          fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + "\n", "utf8");
        }
        attempts.push({ attempt, stage: "sandbox", ok: true });
        fs.appendFileSync(repairLogPath, `✓ security + sandbox 通过；已更新 smoke.expect.implemented=true。请审阅后 factory approve ${sanitized}。\n`, "utf8");
        return { ...result, ok: true, attempts, repairLogPath };
      }

      lastReason = st.reason ?? "沙箱测试失败";
      attempts.push({ attempt, stage: "sandbox", ok: false, reason: lastReason });
      fs.appendFileSync(repairLogPath, `sandbox 失败：${lastReason}\n`, "utf8");
    }

    // 最终失败：恢复最初骨架，失败代码仅保留在 attempt 文件中，避免误 approve。
    if (originalCode) {
      fs.writeFileSync(mainShPath, originalCode, "utf8");
      fs.chmodSync(mainShPath, 0o755);
    } else if (fs.existsSync(mainShPath)) {
      fs.rmSync(mainShPath, { force: true });
    }
    fs.appendFileSync(repairLogPath, `\n## 最终结果\n\n✗ ${maxAttempts} 轮后仍未通过，已恢复最初 main.sh。最后原因：${lastReason}\n`, "utf8");
    return {
      ok: false,
      reason: `多轮修复失败（${maxAttempts} 轮）：${lastReason}`,
      mainShPath,
      skeletonBackup,
      logPath,
      attempts,
      repairLogPath,
    };
  }
}

/** 危险命令模式（PLAN Step 4.3 security review） */
const DANGEROUS_PATTERNS: Array<{ re: RegExp; label: string }> = [
  { re: /\brm\s+(-[a-zA-Z]*f[a-zA-Z]*\s+)?\/(\s|$|\*)/, label: "rm -rf /" },
  { re: /\bdd\s+if=/, label: "dd 磁盘写" },
  { re: /\bmkfs\./, label: "mkfs 格式化" },
  { re: /:\(\)\s*\{.*\|.*&\s*\}\s*;:/, label: "fork 炸弹" },
  { re: /\bchmod\s+(-R\s+)?777\s+\/(\s|$)/, label: "chmod 777 /" },
  { re: /\bcurl[^|]*\|\s*(ba|z)?sh/, label: "curl|sh 远程执行" },
  { re: /\bwget[^|]*\|\s*(ba|z)?sh/, label: "wget|sh 远程执行" },
  { re: />\s*\/dev\/sd[a-z]/, label: "直接写磁盘" },
  { re: /\beval\s+\$\(/, label: "eval 命令注入" },
  { re: /\bnc\s+-[a-z]*l/, label: "nc 监听后门" },
];

function scanDangerous(code: string): string[] {
  const hits: string[] = [];
  // 去掉注释行，避免误报
  const lines = code.split("\n").filter((l) => !l.trim().startsWith("#"));
  const body = lines.join("\n");
  for (const { re, label } of DANGEROUS_PATTERNS) {
    if (re.test(body)) hits.push(label);
  }
  return hits;
}

function sanitizeName(raw: string): string {
  const n = raw.toLowerCase().replace(/[^a-z0-9-]+/g, "-").replace(/^-+|-+$/g, "");
  if (!n) throw new Error("能力名不能为空");
  if (n.length > 48) throw new Error("能力名过长（≤48）");
  return n;
}
