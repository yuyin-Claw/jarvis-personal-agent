/**
 * Avatar Render Transport（0.2-②）
 *
 * Core（Node 侧）→ 表现层（macOS WKWebView 宿主）的单向控制通道。
 * 采用「状态文件 + 递增序号」而非 FIFO：
 *  - FIFO 在宿主一次性读取后会关闭读端，连续写入会 broken pipe；
 *  - 状态文件天然可观测、可重放、可 crash 恢复，且任意进程都能写。
 *
 * 宿主 60ms 轮询 state.json，seq 递增即注入 WebView，并回写 ack.json。
 * 渲染器只消费 AestheticState，不反向依赖 Core。
 */
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { AestheticState, AvatarState, AvatarStateEngine } from "./state-engine.js";

export interface RenderPayload {
  seq: number;
  state: AvatarState;
  intensity: number;
  amplitude?: number;
  caption?: string;
  /** 请求宿主在状态稳定后截取自身窗口到该路径 */
  capture?: string;
}

export interface RenderAck {
  seq?: number;
  ok?: boolean;
  /** 渲染器回读结果（JSON 字符串，含 state 与 frame） */
  result?: string;
  ts?: number;
}

export interface RenderTransportOptions {
  /** 默认 ~/.local/share/jarvis */
  baseDir?: string;
  /** 可注入的等待实现（测试用） */
  sleep?: (ms: number) => Promise<void>;
}

const defaultSleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

export class AvatarRenderTransport {
  readonly stateFile: string;
  readonly ackFile: string;
  private seq = 0;
  private readonly sleep: (ms: number) => Promise<void>;

  constructor(opts: RenderTransportOptions = {}) {
    const base = opts.baseDir ?? join(homedir(), ".local", "share", "jarvis");
    mkdirSync(base, { recursive: true });
    this.stateFile = join(base, "avatar.state.json");
    this.ackFile = join(base, "avatar.ack.json");
    this.sleep = opts.sleep ?? defaultSleep;
    // Core 重启后延续 seq：宿主按 seq 递增判定，回退会被当成旧指令忽略
    try {
      const prev = JSON.parse(readFileSync(this.stateFile, "utf8")) as { seq?: unknown };
      if (typeof prev.seq === "number" && Number.isFinite(prev.seq) && prev.seq > 0) {
        this.seq = Math.floor(prev.seq);
      }
    } catch {
      // 无状态文件或内容损坏：从 1 开始
    }
  }

  /** 原子写，避免宿主轮询读到半个 JSON */
  private atomicWrite(path: string, text: string): void {
    const tmp = `${path}.tmp`;
    writeFileSync(tmp, text, "utf8");
    renameSync(tmp, path);
  }

  /** 发布状态快照；返回本次载荷（含 seq，便于等待 ack） */
  publish(aesthetic: AestheticState, extra: { amplitude?: number; capture?: string } = {}): RenderPayload {
    const payload: RenderPayload = {
      seq: ++this.seq,
      state: aesthetic.state,
      intensity: aesthetic.intensity,
    };
    if (aesthetic.caption !== undefined) payload.caption = aesthetic.caption;
    if (extra.amplitude !== undefined) payload.amplitude = extra.amplitude;
    if (extra.capture !== undefined) payload.capture = extra.capture;
    this.atomicWrite(this.stateFile, JSON.stringify(payload));
    return payload;
  }

  /** 直接按状态发布（CLI / 演示 / 验收脚本用） */
  setState(
    state: AvatarState,
    opts: { intensity?: number; amplitude?: number; caption?: string; capture?: string } = {},
  ): RenderPayload {
    return this.publish(
      { state, intensity: opts.intensity ?? 0.5, enteredAt: Date.now(), caption: opts.caption },
      { amplitude: opts.amplitude, capture: opts.capture },
    );
  }

  /** 绑定状态引擎：任何状态变化自动推给渲染层 */
  bind(engine: AvatarStateEngine): () => void {
    return engine.onAesthetic((a) => this.publish(a));
  }

  /** 读取宿主最后一次确认 */
  readAck(): RenderAck | null {
    if (!existsSync(this.ackFile)) return null;
    try {
      return JSON.parse(readFileSync(this.ackFile, "utf8")) as RenderAck;
    } catch {
      return null;
    }
  }

  /** 等待宿主确认指定 seq（默认 3s） */
  async waitForAck(seq: number, timeoutMs = 3000, pollMs = 50): Promise<RenderAck | null> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const ack = this.readAck();
      if (ack?.seq === seq) return ack;
      await this.sleep(pollMs);
    }
    return null;
  }

  /** 等待宿主完成窗口截图（以 <path>.done 为准，默认 5s） */
  async waitForCapture(path: string, timeoutMs = 5000, pollMs = 50): Promise<boolean> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      if (existsSync(`${path}.done`)) return true;
      await this.sleep(pollMs);
    }
    return false;
  }
}
