import fs from "node:fs";
import path from "node:path";
import type { CapabilityRegistry } from "./registry.js";

export interface McpFactoryOptions {
  registry: CapabilityRegistry;
  outputRoot: string;
}
export interface McpGenerateResult {
  name: string;
  version: string;
  dir: string;
  serverPath: string;
}

/** 已注册 Skill → MCP stdio 包装；同版本目录不覆盖，权限仍由 Registry 裁决。 */
export class McpFactory {
  constructor(private readonly opts: McpFactoryOptions) {}

  generate(name: string): McpGenerateResult {
    const capability = this.opts.registry.findByName(name);
    if (!capability) throw new Error(`能力未注册：${name}`);
    if (capability.enabled !== 1) throw new Error(`能力已禁用，不能生成 MCP：${name}`);
    const manifest = this.opts.registry.loadManifest(name);
    if (!manifest) throw new Error(`Skill manifest 不存在：${name}`);
    const dir = path.join(this.opts.outputRoot, `${name}@${capability.version}`);
    if (fs.existsSync(dir)) throw new Error(`MCP 版本目录已存在：${dir}（新版本请提升 skill.json version）`);
    fs.mkdirSync(dir, { recursive: true });
    const serverPath = path.join(dir, "server.mjs");
    fs.writeFileSync(serverPath, this.serverSource(name, capability.version, manifest.input ?? { type: "object" }), "utf8");
    fs.writeFileSync(path.join(dir, "package.json"), JSON.stringify({
      name: `jarvis-${name}-mcp`, version: capability.version, type: "module", private: true,
      scripts: { start: "node server.mjs" },
    }, null, 2) + "\n", "utf8");
    return { name, version: capability.version, dir, serverPath };
  }

  private serverSource(name: string, version: string, inputSchema: Record<string, unknown>): string {
    return `#!/usr/bin/env node
import readline from "node:readline";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

const SKILL_NAME = ${JSON.stringify(name)};
const SKILL_VERSION = ${JSON.stringify(version)};
const TOOL_NAME = "jarvis_" + SKILL_NAME.replace(/[^a-zA-Z0-9_-]/g, "_");
const INPUT_SCHEMA = ${JSON.stringify(inputSchema)};
const coreRoot = process.env.JARVIS_CORE_ROOT ?? path.join(os.homedir(), ".local/share/jarvis/core");
const { CapabilityRegistry } = await import(pathToFileURL(path.join(coreRoot, "packages/capability-registry/dist/index.js")).href);
const registry = new CapabilityRegistry({
  dbPath: process.env.JARVIS_CAP_DB ?? path.join(os.homedir(), ".local/share/jarvis/capabilities.db"),
  skillsRoot: process.env.JARVIS_SKILLS_ROOT ?? path.join(os.homedir(), ".local/share/jarvis/skills"),
});
const rl = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
const reply = (id, result) => process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id, result }) + "\\n");
const replyError = (id, code, message) => process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id, error: { code, message } }) + "\\n");

rl.on("line", async (line) => {
  let message;
  try { message = JSON.parse(line); } catch { return; }
  const { id, method, params } = message;
  try {
    if (method === "initialize") {
      reply(id, { protocolVersion: "2024-11-05", capabilities: { tools: {} }, serverInfo: { name: "jarvis-" + SKILL_NAME, version: SKILL_VERSION } });
    } else if (method === "notifications/initialized") {
      // 通知无需响应。
    } else if (method === "ping") {
      reply(id, {});
    } else if (method === "tools/list") {
      reply(id, { tools: [{ name: TOOL_NAME, description: ${JSON.stringify(`JARVIS capability: ${name}`)}, inputSchema: INPUT_SCHEMA }] });
    } else if (method === "tools/call") {
      if (params?.name !== TOOL_NAME) return replyError(id, -32602, "未知工具");
      const current = registry.findByName(SKILL_NAME);
      if (!current || current.enabled !== 1 || current.version !== SKILL_VERSION) {
        return reply(id, { content: [{ type: "text", text: "能力版本已变化或已禁用，请重新生成/启用 MCP" }], isError: true });
      }
      try {
        const result = await registry.run(SKILL_NAME, params?.arguments ?? {});
        reply(id, { content: [{ type: "text", text: JSON.stringify(result.output ?? {}) }], isError: result.rc !== 0 });
      } catch (e) {
        reply(id, { content: [{ type: "text", text: e instanceof Error ? e.message : String(e) }], isError: true });
      }
    } else if (method === "shutdown") {
      reply(id, {});
    } else if (id !== undefined) {
      replyError(id, -32601, "method not found");
    }
  } catch (e) {
    if (id !== undefined) replyError(id, -32603, e instanceof Error ? e.message : String(e));
  }
});
process.on("SIGINT", () => { registry.close(); process.exit(0); });
process.on("SIGTERM", () => { registry.close(); process.exit(0); });
`;
  }
}
