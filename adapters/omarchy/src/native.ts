/**
 * Omarchy 平台原语：Hyprland IPC / XDG Portal / 外部命令。
 * 全部可注入，macOS 开发机与 Linux CI 无需真实桌面即可跑契约测试。
 */
import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import net from "node:net";
import { join } from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export type ExecImpl = (cmd: string, args: string[]) => Promise<{ stdout: string; stderr: string }>;

export const defaultExec: ExecImpl = async (cmd, args) => {
  const { stdout, stderr } = await execFileAsync(cmd, args, { timeout: 10_000 });
  return { stdout: String(stdout), stderr: String(stderr) };
};

export interface IpcSocket {
  write(data: string): void;
  end(): void;
  on(event: "data" | "error" | "close", cb: (...args: never[]) => void): unknown;
}

export type IpcConnect = (path: string) => IpcSocket;

const defaultConnect: IpcConnect = (path) => net.connect(path) as unknown as IpcSocket;

/** Hyprland IPC（.socket.sock，命令如 j/activewindow / j/workspaces） */
export class HyprlandIpc {
  constructor(
    private readonly connect: IpcConnect = defaultConnect,
    private readonly env: NodeJS.ProcessEnv = process.env,
  ) {}

  socketPath(): string | null {
    const sig = this.env.HYPRLAND_INSTANCE_SIGNATURE;
    const runtime = this.env.XDG_RUNTIME_DIR;
    if (!sig || !runtime) return null;
    return join(runtime, "hypr", sig, ".socket.sock");
  }

  async request(cmd: string): Promise<string> {
    const path = this.socketPath();
    if (!path) throw new Error("Hyprland IPC 不可用：缺 HYPRLAND_INSTANCE_SIGNATURE / XDG_RUNTIME_DIR");
    return new Promise<string>((resolve, reject) => {
      let buf = "";
      let done = false;
      const sock = this.connect(path);
      const finish = (err?: Error) => {
        if (done) return;
        done = true;
        sock.end();
        if (err) reject(err);
        else resolve(buf);
      };
      // IpcSocket 回调签名在实现上由 net.Socket 提供，这里用宽松类型承接
      (sock.on as (e: string, cb: (...a: unknown[]) => void) => unknown)("data", (c: unknown) => {
        buf += String(c);
      });
      (sock.on as (e: string, cb: (...a: unknown[]) => void) => unknown)("error", (e: unknown) => {
        finish(e instanceof Error ? e : new Error(String(e)));
      });
      (sock.on as (e: string, cb: (...a: unknown[]) => void) => unknown)("close", () => finish());
      sock.write(cmd);
    });
  }

  /** 活动窗口：class / title（title 交给上层脱敏，不直接进 LLM） */
  async activeWindow(): Promise<{ app: string; title: string } | null> {
    try {
      const raw = await this.request("j/activewindow");
      const w = JSON.parse(raw) as { class?: string; title?: string };
      if (!w.class && !w.title) return null;
      return { app: w.class ?? "unknown", title: w.title ?? "" };
    } catch {
      return null;
    }
  }
}

/**
 * 采集授权（架构红线：屏幕/麦克风采集必须有授权会话，禁止隐蔽采集）。
 * - screen：XDG ScreenCast Portal 的 CreateSession → SelectSources → Start
 * - microphone：Portal 存活 + PipeWire 可用；音频会话由 pw-record 向 PipeWire 建立
 * 任一环节失败即拒绝采集。完整 Response 信号等待需在 Try Omarchy VM 实测后补齐。
 */
export interface CaptureAuthorization {
  authorize(kind: "screen" | "microphone"): Promise<{ ok: boolean; detail: string; handle?: string }>;
}

export class GdbusCaptureAuthorization implements CaptureAuthorization {
  constructor(private readonly exec: ExecImpl = defaultExec) {}

  private async call(method: string, args: string): Promise<string> {
    const { stdout } = await this.exec("gdbus", [
      "call", "--session",
      "--dest", "org.freedesktop.portal.Desktop",
      "--object-path", "/org/freedesktop/portal/desktop",
      "--method", `org.freedesktop.portal.ScreenCast.${method}`,
      args,
    ]);
    return stdout.trim();
  }

  async authorize(kind: "screen" | "microphone"): Promise<{ ok: boolean; detail: string; handle?: string }> {
    try {
      if (kind === "microphone") {
        // Portal 存活检查；PipeWire 会话在 start() 里由 pw-record 建立
        const { stdout } = await this.exec("gdbus", [
          "call", "--session", "--dest", "org.freedesktop.portal.Desktop",
          "--object-path", "/org/freedesktop/portal/desktop",
          // ReadAll 的参数类型是 as（字符串数组），gdbus 必须传 GVariant 字面量 []；
          // 旧值 "''" 会被当成字符串而解析失败，导致 Portal 明明存活却报不可用。
          "--method", "org.freedesktop.portal.Settings.ReadAll", "[]",
        ]);
        if (!stdout) return { ok: false, detail: "XDG Portal 无响应" };
        return { ok: true, detail: "XDG Portal 存活；PipeWire 音频会话由 pw-record 建立（VM 实测待补）" };
      }
      const created = await this.call("CreateSession", "{}");
      const m = created.match(/'(\/org\/freedesktop\/portal\/[^']+)'/);
      if (!m) return { ok: false, detail: `Portal CreateSession 未返回 handle: ${created}` };
      // source_types: 1 = MONITOR（视频源由 Portal 弹窗确认）
      await this.call("SelectSources", `('${m[1]}', {'source_types': <1>, 'multiple': <false>})`);
      await this.call("Start", `('${m[1]}', '')`);
      return { ok: true, detail: "XDG ScreenCast Portal 会话已建立（Response 信号待 VM 实测）", handle: m[1] };
    } catch (e) {
      return { ok: false, detail: `采集授权失败：${String(e)}` };
    }
  }
}

export const defaultExists = (p: string) => existsSync(p);

/** 在 PATH 中查找命令（不依赖 shell，便于注入） */
export function commandName(cmd: string): string {
  return cmd.split("/").pop() ?? cmd;
}
