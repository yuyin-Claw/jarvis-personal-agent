import { afterEach, beforeEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import readline from "node:readline";
import { CapabilityRegistry } from "./registry.js";
import { McpFactory } from "./mcp-factory.js";

let root: string;
let skillsRoot: string;
let dbPath: string;
let registry: CapabilityRegistry;

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "jarvis-mcp-"));
  skillsRoot = path.join(root, "skills");
  dbPath = path.join(root, "cap.db");
  fs.mkdirSync(path.join(skillsRoot, "sysinfo"), { recursive: true });
  fs.writeFileSync(path.join(skillsRoot, "sysinfo", "skill.json"), JSON.stringify({
    name: "sysinfo", version: "0.1.0", description: "系统信息",
    entry: { command: "./main.sh" }, input: { type: "object", properties: {} },
  }));
  const main = path.join(skillsRoot, "sysinfo", "main.sh");
  fs.writeFileSync(main, "#!/bin/sh\nprintf '{\"ok\":true,\"implemented\":true}\\n'\n", { mode: 0o755 });
  registry = new CapabilityRegistry({ dbPath, skillsRoot });
  registry.register({ name: "sysinfo", version: "0.1.0", kind: "skill", entry: "sysinfo" });
});
afterEach(() => {
  try { registry.close(); } catch { /* 测试中已关闭 */ }
  fs.rmSync(root, { recursive: true, force: true });
});

describe("McpFactory", () => {
  it("生成版本化 MCP stdio，initialize/tools/list/tools/call 全链路", async () => {
    const result = new McpFactory({ registry, outputRoot: path.join(root, "mcp") }).generate("sysinfo");
    expect(result.version).toBe("0.1.0");
    expect(() => new McpFactory({ registry, outputRoot: path.join(root, "mcp") }).generate("sysinfo")).toThrow("已存在");
    registry.setEnabled("sysinfo", "0.1.0", false);
    expect(() => new McpFactory({ registry, outputRoot: path.join(root, "mcp2") }).generate("sysinfo")).toThrow("已禁用");
    registry.setEnabled("sysinfo", "0.1.0", true);
    registry.close();

    const child = spawn(process.execPath, [result.serverPath], {
      env: { ...process.env, JARVIS_CORE_ROOT: process.cwd(), JARVIS_CAP_DB: dbPath, JARVIS_SKILLS_ROOT: skillsRoot },
      stdio: ["pipe", "pipe", "pipe"],
    });
    const rl = readline.createInterface({ input: child.stdout });
    const pending = new Map<number, (value: any) => void>();
    rl.on("line", (line) => {
      const msg = JSON.parse(line);
      const resolve = pending.get(msg.id);
      if (resolve) { pending.delete(msg.id); resolve(msg); }
    });
    const call = (message: Record<string, unknown>) => new Promise<any>((resolve, reject) => {
      const id = Number(message.id);
      pending.set(id, resolve);
      child.stdin.write(JSON.stringify(message) + "\n");
      setTimeout(() => reject(new Error("MCP 响应超时")), 10_000).unref();
    });
    try {
      const initialized = await call({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} });
      expect(initialized.result.serverInfo.version).toBe("0.1.0");
      const tools = await call({ jsonrpc: "2.0", id: 2, method: "tools/list", params: {} });
      expect(tools.result.tools[0].name).toBe("jarvis_sysinfo");
      const called = await call({ jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "jarvis_sysinfo", arguments: {} } });
      expect(called.result.isError).toBe(false);
      expect(called.result.content[0].text).toContain("true");
    } finally {
      child.kill();
    }
  }, 20_000);
});
