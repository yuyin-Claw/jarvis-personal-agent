/**
 * macOS 平台适配器（ADR-007）
 *
 * 把散落在 apps/avatar、packages/voice、context-engine、runtime 的 macOS 原生端点
 * 收编到统一 Platform Adapter 契约下。Core 不再直接 import 这些实现。
 */
import { execFile, spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { AvatarRenderTransport } from "@jarvis/avatar";
import type { AvatarState } from "@jarvis/avatar";
import { MacForegroundSource } from "@jarvis/context-engine";
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
import { MacNotifyChannel } from "@jarvis/runtime";
import { MacSayTTS, SpeechInput, probeSpeechPermissions } from "@jarvis/voice";
import type { SaySpawn } from "@jarvis/voice";

const execFileAsync = promisify(execFile);
const ROOT = fileURLToPath(new URL("../../../", import.meta.url));
const DEFAULT_BINARY = `${ROOT}apps/avatar/jarvis-avatar`;
const DEFAULT_HTML = `${ROOT}apps/avatar/avatar.html`;
const DEFAULT_SWIFT = `${ROOT}apps/avatar/avatar-host.swift`;

export interface MacPlatformOptions {
  baseDir?: string;
  binaryPath?: string;
  htmlPath?: string;
  platform?: NodeJS.Platform;
  exists?: (path: string) => boolean;
  spawnImpl?: (cmd: string, args: string[]) => { kill(signal?: NodeJS.Signals): boolean };
  saySpawn?: SaySpawn;
  foregroundExec?: ConstructorParameters<typeof MacForegroundSource>[0];
  notifyExec?: ConstructorParameters<typeof MacNotifyChannel>[0];
  speechProcess?: ConstructorParameters<typeof SpeechInput>[0];
  compile?: (swift: string, output: string) => Promise<void>;
  /** 截图等待超时（验收脚本默认 8s，测试可缩短） */
  captureTimeoutMs?: number;
}

const defaultCompile = async (swift: string, output: string) => {
  await execFileAsync("swiftc", ["-O", "-framework", "Cocoa", "-framework", "WebKit", swift, "-o", output]);
};

function st(id: "macos", endpoint: AdapterStatus["endpoint"], state: AdapterStatus["state"], detail: string): AdapterStatus {
  return { id, endpoint, state, detail };
}

class MacAvatarHost implements AvatarHostAdapter {
  readonly id = "macos" as const;
  private readonly transport: AvatarRenderTransport;
  private proc: { kill(signal?: NodeJS.Signals): boolean } | undefined;
  private last: AvatarFrame = { state: "idle", intensity: 0.15 };

  constructor(private readonly o: MacPlatformOptions) {
    this.transport = new AvatarRenderTransport({ baseDir: o.baseDir });
  }

  private get binary() { return this.o.binaryPath ?? DEFAULT_BINARY; }
  private get html() { return this.o.htmlPath ?? DEFAULT_HTML; }

  async start(opts: AvatarHostOptions = {}): Promise<void> {
    if ((this.o.platform ?? process.platform) !== "darwin") {
      throw new Error("macOS avatar host requires darwin");
    }
    const exists = this.o.exists ?? existsSync;
    if (!exists(this.binary)) await (this.o.compile ?? defaultCompile)(DEFAULT_SWIFT, this.binary);
    const args = [
      opts.htmlPath ?? this.html,
      "--x", String(opts.x ?? 80), "--y", String(opts.y ?? 80),
      "--width", String(opts.width ?? 420), "--height", String(opts.height ?? 480),
    ];
    this.proc = (this.o.spawnImpl ?? ((cmd, a) => spawn(cmd, a, { stdio: "ignore" })))(this.binary, args);
  }

  async setState(frame: AvatarFrame): Promise<void> {
    this.last = frame;
    this.transport.setState(frame.state as AvatarState, {
      intensity: frame.intensity,
      amplitude: frame.amplitude,
      caption: frame.caption,
      capture: frame.capture,
    });
  }

  async capture(path: string): Promise<boolean> {
    this.transport.setState(this.last.state as AvatarState, {
      intensity: this.last.intensity,
      amplitude: this.last.amplitude,
      caption: this.last.caption,
      capture: path,
    });
    return this.transport.waitForCapture(path, this.o.captureTimeoutMs ?? 8000);
  }

  async stop(): Promise<void> {
    this.proc?.kill("SIGTERM");
    this.proc = undefined;
  }

  async probe(): Promise<AdapterStatus> {
    if ((this.o.platform ?? process.platform) !== "darwin") {
      return st("macos", "avatarHost", "unsupported", "requires macOS");
    }
    const exists = this.o.exists ?? existsSync;
    return exists(this.binary)
      ? st("macos", "avatarHost", "ready", this.binary)
      : st("macos", "avatarHost", "degraded", "宿主二进制未编译，start() 会现场编译");
  }
}

class MacSpeechOutput implements SpeechOutputAdapter {
  readonly id = "macos" as const;
  private tts: MacSayTTS;
  private key = "";

  constructor(private readonly o: MacPlatformOptions) {
    this.tts = this.build({});
  }

  private build(opts: SpeakOptions): MacSayTTS {
    return new MacSayTTS({
      voice: opts.voice,
      rate: opts.rate,
      outputFile: opts.outputFile,
      spawnImpl: this.o.saySpawn,
      platform: this.o.platform,
    });
  }

  get speaking(): boolean { return this.tts.speaking; }

  async speak(text: string, opts: SpeakOptions = {}): Promise<SpeakEndReason> {
    const key = `${opts.voice ?? ""}|${opts.rate ?? ""}|${opts.outputFile ?? ""}`;
    if (key !== this.key) { this.tts = this.build(opts); this.key = key; }
    return this.tts.speak(text);
  }

  interrupt(): void { this.tts.interrupt(); }

  async probe(): Promise<AdapterStatus> {
    const plat = this.o.platform ?? process.platform;
    if (plat !== "darwin") return st("macos", "speechOutput", "unsupported", "requires macOS say");
    const exists = this.o.exists ?? existsSync;
    return exists("/usr/bin/say")
      ? st("macos", "speechOutput", "ready", "/usr/bin/say")
      : st("macos", "speechOutput", "unavailable", "/usr/bin/say 缺失");
  }
}

class MacSpeechInput implements SpeechInputAdapter {
  readonly id = "macos" as const;
  private readonly listeners = new Set<(e: SpeechInputEvent) => void>();
  private readonly inner: SpeechInput;

  constructor(private readonly o: MacPlatformOptions) {
    const emit = (e: SpeechInputEvent) => { for (const l of this.listeners) l(e); };
    this.inner = new SpeechInput({
      ...o.speechProcess,
      onStatus: (s) => emit({ type: "status", speech: s.speech, mic: s.mic, available: s.available }),
      onReady: () => emit({ type: "ready" }),
      onPartial: (text) => emit({ type: "partial", text }),
      onFinal: (text) => emit({ type: "final", text }),
      onError: (message) => emit({ type: "error", message }),
    });
  }

  async start(): Promise<void> { this.inner.start(); }
  async stop(): Promise<void> { this.inner.stop(); }
  onEvent(cb: (e: SpeechInputEvent) => void): () => void {
    this.listeners.add(cb);
    return () => this.listeners.delete(cb);
  }

  async probe(): Promise<AdapterStatus> {
    if ((this.o.platform ?? process.platform) !== "darwin") {
      return st("macos", "speechInput", "unsupported", "requires macOS SFSpeechRecognizer");
    }
    const s = await probeSpeechPermissions(this.o.speechProcess ?? {});
    if (!s) return st("macos", "speechInput", "unavailable", "识别助手不可用");
    const ok = s.speech === "authorized" && s.mic === "granted" && s.available;
    return st("macos", "speechInput", ok ? "ready" : "unavailable",
      `speech=${s.speech} mic=${s.mic}（未授权时降级文本输入）`);
  }
}

class MacForeground implements ForegroundSourceAdapter {
  readonly id = "macos" as const;
  private readonly src: MacForegroundSource;

  constructor(private readonly o: MacPlatformOptions) {
    this.src = new MacForegroundSource(o.foregroundExec, o.platform);
  }

  async current(): Promise<ForegroundContext | null> {
    const ev = await this.src.sample();
    if (!ev) return null;
    return { app: ev.app, title: ev.detail, at: Date.parse(ev.at) || Date.now() };
  }

  async probe(): Promise<AdapterStatus> {
    return (this.o.platform ?? process.platform) === "darwin"
      ? st("macos", "foreground", "ready", "NSWorkspace / AppleScript")
      : st("macos", "foreground", "unsupported", "requires macOS");
  }
}

class MacNotification implements NotificationAdapter {
  readonly id = "macos" as const;
  private readonly channel: MacNotifyChannel;

  constructor(private readonly o: MacPlatformOptions) {
    this.channel = new MacNotifyChannel(o.notifyExec, o.platform);
  }

  async send(msg: NotifyMessage): Promise<boolean> {
    if ((this.o.platform ?? process.platform) !== "darwin") return false;
    await this.channel.send({
      text: msg.text,
      priority: msg.priority ?? "normal",
      dedupeKey: `platform:${msg.text.slice(0, 40)}`,
      at: new Date().toISOString(),
    });
    return true;
  }

  async probe(): Promise<AdapterStatus> {
    return (this.o.platform ?? process.platform) === "darwin"
      ? st("macos", "notification", "ready", "osascript display notification")
      : st("macos", "notification", "unsupported", "requires macOS");
  }
}

export class MacPlatformAdapter implements PlatformAdapter {
  readonly id = "macos" as const;
  readonly avatarHost: AvatarHostAdapter;
  readonly speechOutput: SpeechOutputAdapter;
  readonly speechInput: SpeechInputAdapter;
  readonly foreground: ForegroundSourceAdapter;
  readonly notification: NotificationAdapter;

  constructor(opts: MacPlatformOptions = {}) {
    this.avatarHost = new MacAvatarHost(opts);
    this.speechOutput = new MacSpeechOutput(opts);
    this.speechInput = new MacSpeechInput(opts);
    this.foreground = new MacForeground(opts);
    this.notification = new MacNotification(opts);
  }

  probe(): Promise<AdapterStatus[]> { return probePlatform(this); }
}
