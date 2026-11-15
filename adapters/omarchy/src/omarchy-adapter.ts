/**
 * Omarchy 平台适配器（ADR-007，架构 §7.1 的 Omarchy 落点）
 *
 * 端点映射：
 *  - AvatarHost  → Wayland 透明窗口（GTK4/WebKitGTK，复用同一 avatar.html）
 *  - Foreground  → Hyprland IPC（j/activewindow，标题交上层脱敏）
 *  - SpeechOutput→ espeak-ng / 可配置 TTS 命令
 *  - SpeechInput → XDG Portal 授权 + PipeWire(pw-record) + 可配置 ASR
 *  - Notification→ notify-send
 *
 * 全部系统交互可注入；VM 内依赖状态由 probe() 明确报告，不静默假装成功。
 */
import { writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { probePlatform } from "@jarvis/platform";
import type {
  AdapterStatus,
  AvatarFrame,
  AvatarHostAdapter,
  AvatarHostOptions,
  ForegroundContext,
  ForegroundSourceAdapter,
  NotifyMessage,
  NotificationAdapter,
  PlatformAdapter,
  SpeakEndReason,
  SpeakOptions,
  SpeechInputAdapter,
  SpeechInputEvent,
  SpeechOutputAdapter,
} from "@jarvis/platform";
import {
  GdbusCaptureAuthorization,
  HyprlandIpc,
  defaultExec,
  defaultExists,
} from "./native.js";
import type { CaptureAuthorization, ExecImpl } from "./native.js";

const ROOT = fileURLToPath(new URL("../../../", import.meta.url));
const DEFAULT_HTML = `${ROOT}apps/avatar/avatar.html`;
const DEFAULT_HOST_SCRIPT = fileURLToPath(new URL("../scripts/avatar-host.py", import.meta.url));

export interface OmarchyProc {
  stdout?: { on(event: "data", cb: (c: string) => void): unknown };
  on(event: "error" | "close", cb: (v?: unknown) => void): unknown;
  kill(signal?: NodeJS.Signals): boolean;
}

export interface OmarchyPlatformOptions {
  platform?: NodeJS.Platform;
  env?: NodeJS.ProcessEnv;
  exec?: ExecImpl;
  exists?: (path: string) => boolean;
  spawnImpl?: (cmd: string, args: string[]) => OmarchyProc;
  ipc?: HyprlandIpc;
  authorization?: CaptureAuthorization;
  hasCommand?: (cmd: string) => Promise<boolean>;
  hasAudio?: () => boolean;
  htmlPath?: string;
  hostScript?: string;
  socketPath?: string;
  socketWrite?: (path: string, line: string) => Promise<void>;
  writeDone?: (path: string) => void;
  ttsCmd?: string;
  asrCmd?: string;
}

const defaultHasCommand = async (cmd: string) => {
  try { await defaultExec("which", [cmd]); return true; } catch { return false; }
};

const st = (endpoint: AdapterStatus["endpoint"], state: AdapterStatus["state"], detail: string): AdapterStatus =>
  ({ id: "omarchy", endpoint, state, detail });

class OmarchyAvatarHost implements AvatarHostAdapter {
  readonly id = "omarchy" as const;
  private proc: OmarchyProc | undefined;
  private geometry = { x: 80, y: 80, width: 420, height: 480 };

  constructor(private readonly o: OmarchyPlatformOptions) {}

  private get socket() {
    return this.o.socketPath ?? `${this.o.env?.XDG_RUNTIME_DIR ?? "/run/user/1000"}/jarvis-avatar.sock`;
  }

  async start(opts: AvatarHostOptions = {}): Promise<void> {
    if ((this.o.platform ?? process.platform) !== "linux") throw new Error("Omarchy avatar host requires Linux/Wayland");
    this.geometry = {
      x: opts.x ?? 80, y: opts.y ?? 80,
      width: opts.width ?? 420, height: opts.height ?? 480,
    };
    const script = this.o.hostScript ?? DEFAULT_HOST_SCRIPT;
    const html = this.o.htmlPath ?? DEFAULT_HTML;
    this.proc = (this.o.spawnImpl ?? (() => { throw new Error("spawnImpl 未注入"); }))("python3", [
      script, "--html", html, "--socket", this.socket,
      "--x", String(this.geometry.x), "--y", String(this.geometry.y),
      "--width", String(this.geometry.width), "--height", String(this.geometry.height),
    ]);
  }

  async setState(frame: AvatarFrame): Promise<void> {
    const write = this.o.socketWrite;
    if (!write) return; // 宿主未连接时静默丢弃（ack 由宿主侧补充）
    await write(this.socket, JSON.stringify({ type: "frame", ...frame }) + "\n");
  }

  async capture(path: string): Promise<boolean> {
    const exec = this.o.exec ?? defaultExec;
    const g = this.geometry;
    try {
      await exec("grim", ["-g", `${g.x},${g.y} ${g.width}x${g.height}`, path]);
      (this.o.writeDone ?? ((p: string) => writeFileSync(p, "")))(`${path}.done`);
      return true;
    } catch {
      return false;
    }
  }

  async stop(): Promise<void> {
    this.proc?.kill("SIGTERM");
    this.proc = undefined;
  }

  async probe(): Promise<AdapterStatus> {
    if ((this.o.platform ?? process.platform) !== "linux") return st("avatarHost", "unsupported", "requires Linux/Wayland");
    const exists = this.o.exists ?? defaultExists;
    const ok = exists(this.o.hostScript ?? DEFAULT_HOST_SCRIPT) && exists(this.o.htmlPath ?? DEFAULT_HTML);
    return ok
      ? st("avatarHost", "degraded", "GTK4/WebKitGTK 宿主脚本就绪，渲染与截图待 Try Omarchy VM 实测")
      : st("avatarHost", "unavailable", "缺 avatar-host.py 或 avatar.html");
  }
}

class OmarchySpeechOutput implements SpeechOutputAdapter {
  readonly id = "omarchy" as const;
  private proc: OmarchyProc | undefined;
  private interrupted = false;

  constructor(private readonly o: OmarchyPlatformOptions) {}

  get speaking(): boolean { return this.proc !== undefined; }

  async speak(text: string, opts: SpeakOptions = {}): Promise<SpeakEndReason> {
    if ((this.o.platform ?? process.platform) !== "linux") return "unsupported";
    if (this.proc) this.interrupt();
    this.interrupted = false;
    const cmd = this.o.ttsCmd ?? "espeak-ng";
    const args = opts.outputFile ? ["-w", opts.outputFile, text] : [text];
    let proc: OmarchyProc;
    try {
      proc = (this.o.spawnImpl ?? (() => { throw new Error("spawnImpl 未注入"); }))(cmd, args);
    } catch {
      return "error";
    }
    this.proc = proc;
    return new Promise<SpeakEndReason>((resolve) => {
      let settled = false;
      const finish = (r: SpeakEndReason) => {
        if (settled) return;
        settled = true;
        this.proc = undefined;
        resolve(r);
      };
      proc.on("error", () => finish("error"));
      proc.on("close", () => finish(this.interrupted ? "interrupted" : "completed"));
    });
  }

  interrupt(): void {
    if (!this.proc) return;
    this.interrupted = true;
    this.proc.kill("SIGTERM");
  }

  async probe(): Promise<AdapterStatus> {
    if ((this.o.platform ?? process.platform) !== "linux") return st("speechOutput", "unsupported", "requires Linux");
    const has = this.o.hasCommand ?? defaultHasCommand;
    return (await has(this.o.ttsCmd ?? "espeak-ng"))
      ? st("speechOutput", "ready", this.o.ttsCmd ?? "espeak-ng")
      : st("speechOutput", "unavailable", `${this.o.ttsCmd ?? "espeak-ng"} 未安装`);
  }
}

class OmarchySpeechInput implements SpeechInputAdapter {
  readonly id = "omarchy" as const;
  private readonly listeners = new Set<(e: SpeechInputEvent) => void>();
  private proc: OmarchyProc | undefined;

  constructor(private readonly o: OmarchyPlatformOptions) {}

  private emit(e: SpeechInputEvent): void { for (const l of this.listeners) l(e); }

  async start(): Promise<void> {
    if ((this.o.platform ?? process.platform) !== "linux") {
      this.emit({ type: "error", message: "requires Linux" });
      return;
    }
    // 架构红线：授权会话失败绝不启动采集
    const auth = this.o.authorization ?? new GdbusCaptureAuthorization(this.o.exec ?? defaultExec);
    const granted = await auth.authorize("microphone");
    if (!granted.ok) {
      this.emit({ type: "error", message: granted.detail });
      return;
    }
    const has = this.o.hasCommand ?? defaultHasCommand;
    if (!(await has("pw-record")) || !(await has(this.o.asrCmd ?? "whisper"))) {
      this.emit({ type: "error", message: "缺 PipeWire(pw-record) 或 ASR 命令" });
      return;
    }
    try {
      this.proc = (this.o.spawnImpl ?? (() => { throw new Error("spawnImpl 未注入"); }))(
        "pw-record", ["--rate", "16000", "--channels", "1", "--format", "s16", "-"],
      );
      this.proc.stdout?.on("data", (chunk) => {
        const text = String(chunk).trim();
        if (text) this.emit({ type: "partial", text });
      });
      this.proc.on("error", (e) => this.emit({ type: "error", message: String(e ?? "pw-record failed") }));
      this.emit({ type: "ready" });
      this.emit({ type: "status", speech: "portal-authorized", mic: "pipewire", available: true });
    } catch (e) {
      this.emit({ type: "error", message: String(e) });
    }
  }

  async stop(): Promise<void> {
    this.proc?.kill("SIGTERM");
    this.proc = undefined;
  }

  onEvent(cb: (e: SpeechInputEvent) => void): () => void {
    this.listeners.add(cb);
    return () => this.listeners.delete(cb);
  }

  async probe(): Promise<AdapterStatus> {
    if ((this.o.platform ?? process.platform) !== "linux") return st("speechInput", "unsupported", "requires Linux");
    const has = this.o.hasCommand ?? defaultHasCommand;
    const ok = (this.o.hasAudio?.() ?? true) && (await has("pw-record"));
    return ok
      ? st("speechInput", "degraded", "Portal 授权 + PipeWire 就绪；ASR 引擎与会话待 VM 实测")
      : st("speechInput", "unavailable", "缺 PipeWire 或音频设备");
  }
}

class OmarchyForeground implements ForegroundSourceAdapter {
  readonly id = "omarchy" as const;
  private readonly ipc: HyprlandIpc;

  constructor(private readonly o: OmarchyPlatformOptions) {
    this.ipc = o.ipc ?? new HyprlandIpc(undefined, o.env);
  }

  async current(): Promise<ForegroundContext | null> {
    const w = await this.ipc.activeWindow();
    return w ? { ...w, at: Date.now() } : null;
  }

  async probe(): Promise<AdapterStatus> {
    if ((this.o.platform ?? process.platform) !== "linux") return st("foreground", "unsupported", "requires Linux");
    return this.ipc.socketPath()
      ? st("foreground", "ready", this.ipc.socketPath() ?? "")
      : st("foreground", "unavailable", "HYPRLAND_INSTANCE_SIGNATURE / XDG_RUNTIME_DIR 缺失");
  }
}

class OmarchyNotification implements NotificationAdapter {
  readonly id = "omarchy" as const;

  constructor(private readonly o: OmarchyPlatformOptions) {}

  async send(msg: NotifyMessage): Promise<boolean> {
    if ((this.o.platform ?? process.platform) !== "linux") return false;
    const urgency = msg.priority === "high" ? "critical" : msg.priority === "low" ? "low" : "normal";
    try {
      await (this.o.exec ?? defaultExec)("notify-send", [
        "-u", urgency, "-a", "JARVIS", msg.title ?? "JARVIS", msg.text,
      ]);
      return true;
    } catch {
      return false;
    }
  }

  async probe(): Promise<AdapterStatus> {
    if ((this.o.platform ?? process.platform) !== "linux") return st("notification", "unsupported", "requires Linux");
    const has = this.o.hasCommand ?? defaultHasCommand;
    return (await has("notify-send"))
      ? st("notification", "ready", "notify-send")
      : st("notification", "unavailable", "notify-send 未安装");
  }
}

export class OmarchyPlatformAdapter implements PlatformAdapter {
  readonly id = "omarchy" as const;
  readonly avatarHost: AvatarHostAdapter;
  readonly speechOutput: SpeechOutputAdapter;
  readonly speechInput: SpeechInputAdapter;
  readonly foreground: ForegroundSourceAdapter;
  readonly notification: NotificationAdapter;

  constructor(opts: OmarchyPlatformOptions = {}) {
    this.avatarHost = new OmarchyAvatarHost(opts);
    this.speechOutput = new OmarchySpeechOutput(opts);
    this.speechInput = new OmarchySpeechInput(opts);
    this.foreground = new OmarchyForeground(opts);
    this.notification = new OmarchyNotification(opts);
  }

  probe(): Promise<AdapterStatus[]> { return probePlatform(this); }
}
