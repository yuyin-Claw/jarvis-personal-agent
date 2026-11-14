/**
 * SpeechInput：消费 macOS SFSpeechRecognizer 助手的 JSONL，并接到 VoiceIO。
 *
 * 权限策略（不请求手动介入）：
 *  - 启动时先 --status-only 探测；未授权/被拒 → 触发 onUnavailable，
 *    Core 自动降级到文本输入，主流程不阻塞、不弹系统授权窗。
 *  - 已授权才启动实时识别；用户开口的第一段 partial 会打断正在播放的 TTS。
 */
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import type { VoiceIO } from "./voice-io.js";

export interface SpeechStatus {
  speech: string;
  mic: string;
  available: boolean;
  locale?: string;
}

export interface SpeechProcess {
  stdout: { on(event: "data", cb: (chunk: Buffer | string) => void): unknown };
  stderr?: { on(event: "data", cb: (chunk: Buffer | string) => void): unknown };
  on(event: "exit" | "error", cb: (code: number | Error | null) => void): unknown;
  kill(signal?: NodeJS.Signals): boolean;
}

export type SpeechSpawn = (cmd: string, args: string[]) => SpeechProcess;

export interface SpeechInputOptions {
  binaryPath?: string;
  spawnImpl?: SpeechSpawn;
  onStatus?: (s: SpeechStatus) => void;
  onReady?: () => void;
  onPartial?: (text: string) => void;
  onFinal?: (text: string) => void;
  onError?: (message: string) => void;
  /** 权限不足时调用（Core 据此降级到文本输入） */
  onUnavailable?: (reason: string) => void;
}

const defaultBinary = fileURLToPath(new URL("../native/jarvis-speech", import.meta.url));
const defaultSpawn: SpeechSpawn = (cmd, args) =>
  spawn(cmd, args, { stdio: ["ignore", "pipe", "pipe"] }) as unknown as SpeechProcess;

/** 单次权限探测（--status-only，不触碰麦克风、不弹窗） */
export function probeSpeechPermissions(opts: Pick<SpeechInputOptions, "binaryPath" | "spawnImpl"> = {}): Promise<SpeechStatus | null> {
  const run = opts.spawnImpl ?? defaultSpawn;
  return new Promise((resolve) => {
    let buf = "";
    let proc: SpeechProcess;
    try {
      proc = run(opts.binaryPath ?? defaultBinary, ["--status-only"]);
    } catch {
      resolve(null);
      return;
    }
    proc.stdout.on("data", (c) => { buf += String(c); });
    proc.on("error", () => resolve(null));
    proc.on("exit", () => {
      for (const line of buf.split("\n")) {
        if (!line.trim()) continue;
        try {
          const o = JSON.parse(line) as { type?: string } & SpeechStatus;
          if (o.type === "status") return resolve(o);
        } catch { /* 忽略非 JSON 行 */ }
      }
      resolve(null);
    });
  });
}

export class SpeechInput {
  private proc: SpeechProcess | undefined;
  private buf = "";
  private inUtterance = false;
  private wires: Array<(line: string) => void> = [];
  private readonly opts: SpeechInputOptions;
  private readonly run: SpeechSpawn;
  private readonly binary: string;

  constructor(opts: SpeechInputOptions = {}) {
    this.opts = opts;
    this.run = opts.spawnImpl ?? defaultSpawn;
    this.binary = opts.binaryPath ?? defaultBinary;
  }

  get running(): boolean {
    return this.proc !== undefined;
  }

  /** 把识别事件接到 VoiceIO；返回解绑函数 */
  attach(voice: VoiceIO): () => void {
    const wire = (line: string) => {
      let o: { type?: string; text?: string };
      try { o = JSON.parse(line); } catch { return; }
      if (o.type === "partial" && o.text) {
        if (!this.inUtterance) {
          this.inUtterance = true;
          if (voice.tts.speaking) voice.interrupt();
          else voice.startListening();
        }
      } else if (o.type === "final") {
        voice.endListening(o.text ?? "");
        this.inUtterance = false;
      }
    };
    this.wires.push(wire);
    return () => { this.wires = this.wires.filter((w) => w !== wire); };
  }

  /** 启动实时识别（调用方应先 probe 确认权限） */
  start(): void {
    if (this.proc) return;
    try {
      this.proc = this.run(this.binary, []);
    } catch (e) {
      this.opts.onError?.(String(e));
      return;
    }
    const p = this.proc;
    p.stdout.on("data", (c) => {
      this.buf += String(c);
      const lines = this.buf.split("\n");
      this.buf = lines.pop() ?? "";
      for (const line of lines) this.feed(line);
    });
    p.on("error", (e) => this.opts.onError?.(String(e)));
    p.on("exit", () => { this.proc = undefined; });
  }

  /** 解析一行 JSONL（公开供测试与管道注入） */
  feed(line: string): void {
    if (!line.trim()) return;
    let o: Record<string, unknown>;
    try { o = JSON.parse(line) as Record<string, unknown>; } catch { return; }
    for (const w of this.wires) w(line);
    switch (o.type) {
      case "status":
        this.opts.onStatus?.(o as unknown as SpeechStatus);
        if (o.speech !== "authorized" || o.mic !== "granted" || o.available !== true) {
          this.opts.onUnavailable?.(`speech=${String(o.speech)} mic=${String(o.mic)} available=${String(o.available)}`);
        }
        break;
      case "ready": this.opts.onReady?.(); break;
      case "partial": this.opts.onPartial?.(String(o.text ?? "")); break;
      case "final": this.opts.onFinal?.(String(o.text ?? "")); break;
      case "error":
        this.opts.onError?.(String(o.message ?? "unknown"));
        if (String(o.message ?? "").includes("permission")) this.opts.onUnavailable?.(String(o.message));
        break;
      default: break;
    }
  }

  stop(): void {
    this.proc?.kill("SIGTERM");
    this.proc = undefined;
  }
}
