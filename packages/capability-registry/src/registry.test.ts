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
      entry: "greedy",
      permissions: [
        { capability: "fs_read", resource: "/etc/shadow", mode: "read" },
        { capability: "network", resource: "*", mode: "connect" },
      ],
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

describe("CapabilityRegistry 权限授予（PLAN Step 4.4 红线）", () => {
  const manifestWithDecl = {
    name: "weather-briefing", version: "0.1.0",
    entry: { command: "./main.sh" },
    permissions: [
      { capability: "network", resource: "wttr.in:80", mode: "connect" },
      { capability: "fs_read", resource: "~/.cache/jarvis", mode: "read" },
    ],
  };

  it("grant 已声明权限成功且落库", () => {
    writeSkill("weather-briefing", manifestWithDecl, `#!/bin/sh\ncat > /dev/null\necho '{"ok":true}'\n`);
    registry.register({ name: "weather-briefing", version: "0.1.0", kind: "skill", entry: "weather-briefing" });
    const r = registry.grantPermission("weather-briefing", {
      capability: "network", resource: "wttr.in:80", mode: "connect",
    });
    expect(r.ok).toBe(true);
    const granted = registry.getPermissions("weather-briefing");
    expect(granted).toHaveLength(1);
    expect(granted[0]).toEqual({ capability: "network", resource: "wttr.in:80", mode: "connect" });
  });

  it("grant 未声明权限被拒绝（红线：防止越权授予）", () => {
    writeSkill("weather-briefing", manifestWithDecl, `#!/bin/sh\ncat > /dev/null\necho '{"ok":true}'\n`);
    registry.register({ name: "weather-briefing", version: "0.1.0", kind: "skill", entry: "weather-briefing" });
    const r = registry.grantPermission("weather-briefing", {
      capability: "fs_write", resource: "/etc/passwd", mode: "write",
    });
    expect(r.ok).toBe(false);
    expect(r.reason).toMatch(/未在 skill\.json 中声明/);
    expect(registry.getPermissions("weather-briefing")).toHaveLength(0);
  });

  it("grant 部分字段不匹配也被拒（capability 对但 resource 不同）", () => {
    writeSkill("weather-briefing", manifestWithDecl, `#!/bin/sh\ncat > /dev/null\necho '{"ok":true}'\n`);
    registry.register({ name: "weather-briefing", version: "0.1.0", kind: "skill", entry: "weather-briefing" });
    const r = registry.grantPermission("weather-briefing", {
      capability: "network", resource: "evil.com:443", mode: "connect",
    });
    expect(r.ok).toBe(false);
    expect(registry.getPermissions("weather-briefing")).toHaveLength(0);
  });

  it("grant 幂等：重复授予同一权限不重复追加", () => {
    writeSkill("weather-briefing", manifestWithDecl, `#!/bin/sh\ncat > /dev/null\necho '{"ok":true}'\n`);
    registry.register({ name: "weather-briefing", version: "0.1.0", kind: "skill", entry: "weather-briefing" });
    const p = { capability: "network", resource: "wttr.in:80", mode: "connect" };
    registry.grantPermission("weather-briefing", p);
    const r2 = registry.grantPermission("weather-briefing", p);
    expect(r2.ok).toBe(true);
    expect(r2.reason).toMatch(/已存在/);
    expect(registry.getPermissions("weather-briefing")).toHaveLength(1);
  });

  it("revoke 撤销匹配 capability+resource 的所有 mode", () => {
    writeSkill("weather-briefing", manifestWithDecl, `#!/bin/sh\ncat > /dev/null\necho '{"ok":true}'\n`);
    registry.register({ name: "weather-briefing", version: "0.1.0", kind: "skill", entry: "weather-briefing" });
    registry.grantPermission("weather-briefing", { capability: "network", resource: "wttr.in:80", mode: "connect" });
    registry.grantPermission("weather-briefing", { capability: "fs_read", resource: "~/.cache/jarvis", mode: "read" });
    expect(registry.getPermissions("weather-briefing")).toHaveLength(2);
    const r = registry.revokePermission("weather-briefing", "network", "wttr.in:80");
    expect(r.ok).toBe(true);
    expect(r.removed).toBe(1);
    const rest = registry.getPermissions("weather-briefing");
    expect(rest).toHaveLength(1);
    expect(rest[0].capability).toBe("fs_read");
  });

  it("revoke 无匹配权限返回 removed=0（不报错）", () => {
    writeSkill("weather-briefing", manifestWithDecl, `#!/bin/sh\ncat > /dev/null\necho '{"ok":true}'\n`);
    registry.register({ name: "weather-briefing", version: "0.1.0", kind: "skill", entry: "weather-briefing" });
    const r = registry.revokePermission("weather-briefing", "network", "nonexistent.com");
    expect(r.ok).toBe(true);
    expect(r.removed).toBe(0);
  });

  it("grant/revoke 未注册能力报错", () => {
    const r = registry.grantPermission("ghost", { capability: "network", resource: "x", mode: "connect" });
    expect(r.ok).toBe(false);
    expect(r.reason).toMatch(/未注册/);
    const r2 = registry.revokePermission("ghost", "network", "x");
    expect(r2.ok).toBe(false);
    expect(r2.reason).toMatch(/未注册/);
  });

  it("getDeclaredPermissions 返回 skill.json 声明", () => {
    writeSkill("weather-briefing", manifestWithDecl, `#!/bin/sh\ncat > /dev/null\necho '{"ok":true}'\n`);
    registry.register({ name: "weather-briefing", version: "0.1.0", kind: "skill", entry: "weather-briefing" });
    const declared = registry.getDeclaredPermissions("weather-briefing");
    expect(declared).toHaveLength(2);
    expect(declared.map((d) => d.capability)).toEqual(["network", "fs_read"]);
  });
});

describe("registry.run 安全入口（ADR-011 红线：未授予权限拒绝执行）", () => {
  const manifestZeroPerm = {
    name: "sysinfo", version: "0.1.0",
    entry: { command: "./main.sh" },
    permissions: [],
  };
  const manifestNetworkDecl = {
    name: "weather-briefing", version: "0.1.0",
    entry: { command: "./main.sh" },
    permissions: [{ capability: "network", resource: "wttr.in:80", mode: "connect" }],
  };
  const mainOk = `#!/bin/sh\ncat > /dev/null\necho '{"ok":true,"implemented":true,"result":{"speech":"晴"}}'\n`;

  it("零权限能力（无声明）直接放行", async () => {
    writeSkill("sysinfo", manifestZeroPerm, mainOk);
    registry.register({ name: "sysinfo", version: "0.1.0", kind: "skill", entry: "sysinfo" });
    const r = await registry.run("sysinfo", {});
    expect(r.rc).toBe(0);
    expect((r.output as { ok?: boolean }).ok).toBe(true);
  });

  it("声明权限但未授予 → 拒绝执行（红线）", async () => {
    writeSkill("weather-briefing", manifestNetworkDecl, mainOk);
    registry.register({ name: "weather-briefing", version: "0.1.0", kind: "skill", entry: "weather-briefing" });
    await expect(registry.run("weather-briefing", {}))
      .rejects.toThrow(/权限未授予.*wttr\.in:80/);
  });

  it("声明权限已全部授予 → 放行", async () => {
    writeSkill("weather-briefing", manifestNetworkDecl, mainOk);
    registry.register({ name: "weather-briefing", version: "0.1.0", kind: "skill", entry: "weather-briefing" });
    registry.grantPermission("weather-briefing", { capability: "network", resource: "wttr.in:80", mode: "connect" });
    const r = await registry.run("weather-briefing", {});
    expect(r.rc).toBe(0);
    expect((r.output as { ok?: boolean }).ok).toBe(true);
  });

  it("部分授予（声明 2 项只 grant 1 项）→ 拒绝执行", async () => {
    const twoDecl = {
      name: "two-perm", version: "0.1.0",
      entry: { command: "./main.sh" },
      permissions: [
        { capability: "network", resource: "wttr.in:80", mode: "connect" },
        { capability: "fs_read", resource: "~/.cache/jarvis", mode: "read" },
      ],
    };
    writeSkill("two-perm", twoDecl, mainOk);
    registry.register({ name: "two-perm", version: "0.1.0", kind: "skill", entry: "two-perm" });
    registry.grantPermission("two-perm", { capability: "network", resource: "wttr.in:80", mode: "connect" });
    await expect(registry.run("two-perm", {}))
      .rejects.toThrow(/权限未授予.*fs_read.*~\/\.cache\/jarvis/);
  });

  it("revoke 后再 run 又被拒绝（撤销即生效）", async () => {
    writeSkill("weather-briefing", manifestNetworkDecl, mainOk);
    registry.register({ name: "weather-briefing", version: "0.1.0", kind: "skill", entry: "weather-briefing" });
    registry.grantPermission("weather-briefing", { capability: "network", resource: "wttr.in:80", mode: "connect" });
    const r1 = await registry.run("weather-briefing", {});
    expect(r1.rc).toBe(0);
    registry.revokePermission("weather-briefing", "network", "wttr.in:80");
    await expect(registry.run("weather-briefing", {}))
      .rejects.toThrow(/权限未授予/);
  });
});
