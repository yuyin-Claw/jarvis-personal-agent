/**
 * macOS 前台应用感知源
 *
 * 方案一（默认）：Swift 单行 NSWorkspace——读 frontmostApplication，无需 TCC 权限，只有 app 名。
 * 方案二：AppleScript System Events——可带窗口标题，但需要"辅助功能"权限；
 *         权限缺失时自动降级到方案一。
 * 非 darwin 平台返回 null（优雅降级）。
 */
import { execFile } from "node:child_process";
import type { ActivityEvent, AwarenessSource } from "./context-engine.js";

export type ExecImpl = (cmd: string, args: string[]) => Promise<{ stdout: string; stderr: string }>;

const defaultExec: ExecImpl = (cmd, args) =>
  new Promise((resolve, reject) => {
    execFile(cmd, args, { timeout: 5000 }, (err, stdout, stderr) => {
      if (err) reject(err);
      else resolve({ stdout, stderr });
    });
  });

/** 尝试编译一次的 Swift 片段（缓存：同进程内只 swiftc 一次太贵——直接 swift 脚本跑，接受每次 ~0.5s） */
const SWIFT_SNIPPET = /* swift */ `
import AppKit
let app = NSWorkspace.shared.frontmostApplication
print(app?.localizedName ?? app?.bundleIdentifier ?? "unknown")
`;

export class MacForegroundSource implements AwarenessSource {
  readonly id = "macos-foreground";
  private readonly exec: ExecImpl;
  private readonly platform: NodeJS.Platform;

  constructor(exec: ExecImpl = defaultExec, platform: NodeJS.Platform = process.platform) {
    this.exec = exec;
    this.platform = platform;
  }

  async sample(): Promise<ActivityEvent | null> {
    if (this.platform !== "darwin") return null;
    // 1. Swift NSWorkspace（无权限要求）
    try {
      const { stdout } = await this.exec("swift", ["-e", SWIFT_SNIPPET]);
      const app = stdout.trim();
      if (app && app !== "unknown") {
        return {
          source: this.id,
          kind: "app_focus",
          app,
          at: new Date().toISOString(),
        };
      }
    } catch {
      // swift 不可用（未装 Xcode CLT）→ 尝试 AppleScript
    }
    // 2. AppleScript System Events（需要辅助权限；失败返回 null）
    try {
      const { stdout } = await this.exec("osascript", [
        "-e",
        'tell application "System Events" to get name of first application process whose frontmost is true',
      ]);
      const app = stdout.trim();
      if (app) {
        return { source: this.id, kind: "app_focus", app, at: new Date().toISOString() };
      }
    } catch {
      // 无权限
    }
    return null;
  }
}

/** 带窗口标题版本（需要辅助功能权限；detail 经 ContextEngine 脱敏） */
export class MacForegroundWithTitleSource implements AwarenessSource {
  readonly id = "macos-foreground";
  private readonly exec: ExecImpl;
  private readonly platform: NodeJS.Platform;

  constructor(exec: ExecImpl = defaultExec, platform: NodeJS.Platform = process.platform) {
    this.exec = exec;
    this.platform = platform;
  }

  async sample(): Promise<ActivityEvent | null> {
    if (this.platform !== "darwin") return null;
    const script = `tell application "System Events"
      set frontApp to name of first application process whose frontmost is true
      set winTitle to ""
      try
        tell process frontApp to set winTitle to name of front window
      end try
      return frontApp & "|" & winTitle
    end tell`;
    try {
      const { stdout } = await this.exec("osascript", ["-e", script]);
      const [app, title] = stdout.trim().split("|");
      return {
        source: this.id,
        kind: "app_focus",
        app: app || "unknown",
        detail: title || undefined,
        at: new Date().toISOString(),
      };
    } catch {
      // 无辅助权限：降级为只记 app 名（Swift）
      const fallback = new MacForegroundSource(this.exec, this.platform);
      return fallback.sample();
    }
  }
}
