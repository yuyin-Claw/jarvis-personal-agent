/**
 * 沙箱化文件/命令工具集（Coding Harness 的手和脚）
 *
 * 红线（架构 §6）：工具只能操作 workDir 内路径；命令经黑白名单；
 * 不获得全局文件系统/网络 shell。
 */
import fs from "node:fs";
import path from "node:path";

/** 命令白名单前缀（0.1 最小集；扩白名单需评审） */
const COMMAND_ALLOWLIST = [
  "node", "npm", "pnpm", "npx", "tsc", "vitest", "eslint",
  "python3", "pip",
  "git", "ls", "cat", "grep", "find", "head", "tail", "wc",
  "mkdir", "cp", "mv", "touch",
  "echo", "sed", "awk", "sort", "uniq", "diff",
  "curl",  // 仅限下载；网络访问在 PermissionBroker 再分级
];

/** 绝对禁止的命令模式（即使在白名单内也拦截） */
const FORBIDDEN_PATTERNS = [
  /\brm\s+-rf?\b/,             // rm -r 任何形式走专门审批，不给工具
  /\bsudo\b/,
  /\bchmod\s+777\b/,
  /\bmkfs\b/,
  /\bdd\b.*of=\/dev\//,
  />\s*\/dev\/sd/,              // 直写块设备
  /\bgit\s+push\b/,            // 推送需用户自己来（提交授权纪律）
  /[$]\(/,                      // 命令注入：$( ) 替换
  /`[^`]*`/,                    // 反引号命令替换（shell 表达式）
  /\|\s*sh\b/, /\|\s*bash\b/, /\|\s*zsh\b/, // 管道到 shell
  /;\s*(sudo|rm)\b/,
];

export class ToolError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ToolError";
  }
}

/** 路径越界检查：解析后必须在 workDir 内 */
export function assertInside(workDir: string, target: string): string {
  const resolved = path.resolve(workDir, target);
  const normalizedWork = path.resolve(workDir);
  if (resolved !== normalizedWork && !resolved.startsWith(normalizedWork + path.sep)) {
    throw new ToolError(`路径越界：${target} 不在工作目录 ${workDir} 内`);
  }
  return resolved;
}

/** read_file 工具 */
export function toolReadFile(workDir: string, relPath: string, maxBytes = 512 * 1024): string {
  const abs = assertInside(workDir, relPath);
  const stat = fs.statSync(abs);
  if (stat.size > maxBytes) {
    return `[文件过大 ${stat.size} 字节，截断至 ${maxBytes}]`;
  }
  return fs.readFileSync(abs, "utf8");
}

/** write_file 工具 */
export function toolWriteFile(workDir: string, relPath: string, content: string): string {
  const abs = assertInside(workDir, relPath);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, content, "utf8");
  return `已写入 ${relPath}（${content.length} 字符）`;
}

/** list_files 工具 */
export function toolListFiles(workDir: string, relDir = "."): string {
  const abs = assertInside(workDir, relDir);
  const entries = fs.readdirSync(abs, { withFileTypes: true });
  return entries
    .map((e) => (e.isDirectory() ? `${e.name}/` : e.name))
    .join("\n");
}

/** 命令安全检查 */
export function checkCommand(command: string): void {
  for (const pat of FORBIDDEN_PATTERNS) {
    if (pat.test(command)) {
      throw new ToolError(`命令被安全策略拦截：${command.slice(0, 80)}`);
    }
  }
  const first = command.trim().split(/\s+/)[0] ?? "";
  if (!COMMAND_ALLOWLIST.includes(first)) {
    throw new ToolError(`命令不在白名单：${first}（白名单：${COMMAND_ALLOWLIST.join(",")}）`);
  }
}

export { COMMAND_ALLOWLIST, FORBIDDEN_PATTERNS };
