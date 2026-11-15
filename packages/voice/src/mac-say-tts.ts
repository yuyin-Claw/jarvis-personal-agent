/**
 * MacSayTTS：macOS `say` 语音合成（0.2-③ 输出端起步实现）
 *
 * 设计要点：
 *  - 文本走参数数组，绝不拼 shell 命令；清洗控制字符并防选项注入
 *  - 支持 -o 输出 AIFF 文件（自动验收时不发声、只验证音频确实合成）
 *  - 打断：SIGTERM 杀掉当前 say 进程，结束原因标为 interrupted，
 *    上层据此不派发 tts_end（否则状态机会错误回 idle 而不是切 listening）
 *  - 非 darwin 降级为 unsupported，不抛错（Linux CI 可跑）
 */
import { spawn } from "node:child_process";

export type SpeakEndReason = "completed" | "interrupted" | "error" | "unsupported";

export interface SayProcess {
  on(
    event: "close" | "error",
    cb: (codeOrErr: number | Error | null, signal?: NodeJS.Signals | null) => void,
  ): unknown;
  kill(signal?: NodeJS.Signals): boolean;
}

export type SaySpawn = (args: string[]) => SayProcess;

export interface SpeechSynthesizer {
  speak(text: string): Promise<SpeakEndReason>;
  interrupt(): void;
  readonly speaking: boolean;
}

export interface MacSayTTSOptions {
  /** 指定系统嗓音（如 Ting-Ting）；不指定则用系统默认 */
  voice?: string;
  /** 语速（词/分钟），默认 180 */
  rate?: number;
  /** 只写 AIFF 文件不发声，用于自动验收 */
  outputFile?: string;
  /** 单段最大字符数，默认 500 */
  maxChars?: number;
  spawnImpl?: SaySpawn;
  platform?: NodeJS.Platform;
  onStart?: () => void;
  onEnd?: (reason: SpeakEndReason) => void;
}

const defaultSpawn: SaySpawn = (args) =>
  spawn("/usr/bin/say", args, { stdio: "ignore" }) as unknown as SayProcess;

/** 清洗朗读文本：去控制字符、压缩空白、限长、防 say 选项注入 */
export function sanitizeSpeechText(text: string, maxChars = 500): string {
  const clean = text
    // eslint-disable-next-line no-control-regex -- 朗读文本必须剥离控制字符，防 say 参数注入
    .replace(/[\u0000-\u001f\u007f]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, maxChars);
  return clean.startsWith("-") ? ` ${clean}` : clean;
}

export class MacSayTTS implements SpeechSynthesizer {
  private current: SayProcess | undefined;
  private interrupted = false;
  private readonly spawnImpl: SaySpawn;
  private readonly platform: NodeJS.Platform;
  private readonly opts: MacSayTTSOptions;

  constructor(opts: MacSayTTSOptions = {}) {
    this.opts = opts;
    this.spawnImpl = opts.spawnImpl ?? defaultSpawn;
    this.platform = opts.platform ?? process.platform;
  }

  get speaking(): boolean {
    return this.current !== undefined;
  }

  get args(): string[] {
    const a: string[] = [];
    if (this.opts.voice) a.push("-v", this.opts.voice);
    a.push("-r", String(this.opts.rate ?? 180));
    if (this.opts.outputFile) a.push("-o", this.opts.outputFile);
    return a;
  }

  async speak(text: string): Promise<SpeakEndReason> {
    if (this.current) this.interrupt();
    const clean = sanitizeSpeechText(text, this.opts.maxChars);
    if (!clean) return "completed";
    if (this.platform !== "darwin") {
      this.opts.onEnd?.("unsupported");
      return "unsupported";
    }

    const args = [...this.args, clean];
    let proc: SayProcess;
    try {
      proc = this.spawnImpl(args);
    } catch {
      this.opts.onEnd?.("error");
      return "error";
    }
    this.current = proc;
    this.interrupted = false;
    this.opts.onStart?.();

    return new Promise<SpeakEndReason>((resolve) => {
      let settled = false;
      const finish = (reason: SpeakEndReason) => {
        if (settled) return;
        settled = true;
        this.current = undefined;
        this.opts.onEnd?.(reason);
        resolve(reason);
      };
      proc.on("error", () => finish("error"));
      proc.on("close", () => finish(this.interrupted ? "interrupted" : "completed"));
    });
  }

  interrupt(): void {
    if (!this.current) return;
    this.interrupted = true;
    this.current.kill("SIGTERM");
  }
}
