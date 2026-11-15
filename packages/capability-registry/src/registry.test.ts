import { describe, expect, it, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { CapabilityRegistry, SkillRunner } from "./registry.js";

/**
 * 能力注册表测试（ADR-011 Step 4.1）
 * 覆盖：注册幂等 / 权限红线（注册忽略 permissions）/ 启停回滚 /
 * 健康检查 / SkillRunner 契约执行（stdin JSON → stdout JSON）。
 */

let tmpRoot: string;
let registry: CapabilityRegistry;

function writeSkill(name: string, manifest: object, main: string): string {
  const dir = path.join(tmpRoot, name);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "skill.json"), JSON.stringify(manifest, null, 2));
  fs.writeFileSync(path.join(dir, "main.sh"), main);
  fs.chmodSync(path.join(dir, "main.sh"), 0o755);
  return dir;
}

beforeEach(() => {
  tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "jarvis-skills-"));
  registry = new CapabilityRegistry({ dbPath: ":memory:", skillsRoot: tmpRoot });
});

afterEach(() => {
  registry.close();
  fs.rmSync(tmpRoot, { recursive: true, force: true });
});

describe("CapabilityRegistry", () => {
  it("注册 → 查询 → 列表；默认零权限且启用", () => {
    const rec = registry.register({
      name: "sysinfo", version: "0.1.0", kind: "skill",
      entry: "sysinfo", description: "系统信息",
    });
    expect(rec.enabled).toBe(1);
    expect(rec.permissions).toEqual([]); // 红线：默认零权限
    expect(registry.findByName("sysinfo")?.version).toBe("0.1.0");
    expect(registry.list({ enabledOnly: true })).toHaveLength(1);
  });

  it("注册携带 permissions 被强制忽略（权限只能走申请单）", () => {
    const rec = registry.register({
      name: "greedy", version: "0.1.0", kind: "skill",
      entry: "greedy", permissions: ["fs:read:/etc/shadow", "net:*"],
    });
    expect(rec.permissions).toEqual([]);
  });

  it("同名同版本幂等；同版本禁用后 register 不复活", () => {
    registry.register({ name: "a", version: "1", kind: "skill", entry: "a" });
    registry.setEnabled("a", "1", false);
    const again = registry.register({ name: "a", version: "1", kind: "skill", entry: "a" });
    expect(again.enabled).toBe(0); // 幂等返回既有（含禁用状态）
  });

  it("禁用 = 回滚（不删文件，可再启用）", () => {
    registry.register({ name: "b", version: "1", kind: "skill", entry: "b" });
    expect(registry.setEnabled("b", "1", false)).toBe(true);
    expect(registry.list({ enabledOnly: true })).toHaveLength(0);
    expect(registry.get("b", "1")).toBeDefined(); // 记录还在
    registry.setEnabled("b", "1", true);
    expect(registry.list({ enabledOnly: true })).toHaveLength(1);
  });
});

describe("SkillRunner（skill.json 契约执行）", () => {
  it("stdin JSON → stdout JSON 全链路", async () => {
    // 输出 JSON 用 printf 拼接（避免嵌套引号转义歧义）
    writeSkill("echo-skill", {
      name: "echo-skill", version: "0.1.0",
      entry: { command: "./main.sh" },
    }, `#!/bin/sh
input=$(cat)
printf '{"len": %s}\\n' "$(printf %s "$input" | wc -c | tr -d ' ')"
`);
    const r = await new SkillRunner(tmpRoot).run("echo-skill", { hello: "world" });
    expect(r.rc).toBe(0);
    expect(r.output).toEqual({ len: 17 }); // {"hello":"world"} 的字节数
  });

  it("健康检查 smoke：期望匹配 → healthy；坏 Skill → degraded", async () => {
    writeSkill("good", {
      name: "good", version: "0.1.0",
      entry: { command: "./main.sh" },
      smoke: { input: {}, expect: { ok: true } },
    }, `#!/bin/sh
cat > /dev/null
echo '{"ok": true}'
`);
    writeSkill("bad", {
      name: "bad", version: "0.1.0",
      entry: { command: "./main.sh" },
      smoke: { input: {}, expect: { ok: true } },
    }, `#!/bin/sh
cat > /dev/null
echo '{"ok": false}'
`);
    registry.register({ name: "good", version: "0.1.0", kind: "skill", entry: "good" });
    registry.register({ name: "bad", version: "0.1.0", kind: "skill", entry: "bad" });
    expect(await registry.healthCheck("good")).toBe("healthy");
    expect(await registry.healthCheck("bad")).toBe("degraded");
  });

  it("不存在清单时 run 报错、healthCheck 报 unknown", async () => {
    registry.register({ name: "ghost", version: "1", kind: "skill", entry: "ghost" });
    expect(await registry.healthCheck("ghost")).toBe("unknown");
    await expect(new SkillRunner(tmpRoot).run("ghost", {}))
      .rejects.toThrow(/不存在或清单缺失/);
  });
});
