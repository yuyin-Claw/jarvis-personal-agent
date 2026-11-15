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
 */
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import type { CapabilityRegistry } from "./registry.js";

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
}

function sanitizeName(raw: string): string {
  const n = raw.toLowerCase().replace(/[^a-z0-9-]+/g, "-").replace(/^-+|-+$/g, "");
  if (!n) throw new Error("能力名不能为空");
  if (n.length > 48) throw new Error("能力名过长（≤48）");
  return n;
}
