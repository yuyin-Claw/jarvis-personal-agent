/**
 * macOS 原生通知通道：osascript display notification
 *
 * 标题 JARVIS；high 带默认提示音，normal/low 静音（有分寸）。
 * 非 darwin 或 osascript 失败时静默降级（文件通道仍兜底）。
 */
import { execFile } from "node:child_process";
import type { NotifyChannel, ProactiveNotice } from "./runtime.js";

export type NotifyExecImpl = (cmd: string, args: string[]) => Promise<{ stdout: string; stderr: string }>;

const defaultExec: NotifyExecImpl = (cmd, args) =>
  new Promise((resolve, reject) => {
    execFile(cmd, args, { timeout: 5000 }, (err, stdout, stderr) => {
      if (err) reject(err);
      else resolve({ stdout, stderr });
    });
  });

/** AppleScript 字符串转义（防注入：反斜杠与双引号） */
export function escapeAppleScript(text: string): string {
  return text.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
}

export class MacNotifyChannel implements NotifyChannel {
  private readonly exec: NotifyExecImpl;
  private readonly platform: NodeJS.Platform;

  constructor(exec: NotifyExecImpl = defaultExec, platform: NodeJS.Platform = process.platform) {
    this.exec = exec;
    this.platform = platform;
  }

  async send(notice: ProactiveNotice): Promise<void> {
    if (this.platform !== "darwin") return; // 静默跳过（文件通道兜底）
    const title = notice.priority === "high" ? "JARVIS · 重要" : "JARVIS";
    const body = escapeAppleScript(notice.text.slice(0, 200));
    const sound = notice.priority === "high" ? " sound name \"default\"" : "";
    try {
      await this.exec("osascript", [
        "-e",
        `display notification "${body}" with title "${title}"${sound}`,
      ]);
    } catch {
      // 通知失败不阻塞主流程（notifications.log 仍有记录）
    }
  }
}
