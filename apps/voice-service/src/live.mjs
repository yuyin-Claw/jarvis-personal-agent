/**
 * 实时监听模块（ADR-012 实时语音链路 · 任务 #52）
 *
 * 零依赖实现「麦克风 → VAD 分段 → 本地 ASR → 事件」：
 *  - /listen/start：拉起 pw-record（16k mono s16le raw）持续写 ring 文件
 *  - 能量 VAD：20ms 窗口 RMS，超阈值=说话开始，静默 >800ms=说完
 *  - 说完一段：截取该段 → whisper.cpp 转写 → 事件列表 partial/final
 *  - /listen/status：轮询取事件（id/state/text/startedAt/endedAt）
 *  - /listen/stop：停止采集并清理子进程
 *
 * 设计约束：
 *  - 仍是零外部依赖（child_process + fs），服务可整体复制到任何 Linux
 *  - 不做 PCM 重采样（pw-record 直接出 16k s16le raw）
 *  - fake 后端：不发真实音频，注入确定事件供 CI 验证契约
 */
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const SAMPLE_RATE = 16000;
const BYTES_PER_SAMPLE = 2;
const WINDOW_MS = 20;
const WINDOW_BYTES = (SAMPLE_RATE * BYTES_PER_SAMPLE * WINDOW_MS) / 1000;
/** RMS 阈值（s16 满量程 32767）：低于视为静默。可按环境调 */
const VAD_THRESHOLD = Number(process.env.JARVIS_VAD_RMS ?? 350);
/** 说完判定：连续静默时长（ms） */
const SILENCE_MS = Number(process.env.JARVIS_VAD_SILENCE_MS ?? 800);
/** 单段最长时间（ms），防长噪声 */
const MAX_UTTERANCE_MS = 30_000;
/** 段间最小长度（ms），过滤咔哒声 */
const MIN_UTTERANCE_MS = 300;

export class LiveListener {
  constructor(backend, opts = {}) {
    this.backend = backend; // 提供转写的后端（OmarchyBackend/FakeBackend）
    this.opts = opts;
    this.session = null;
    this.events = [];
    this.eventSeq = 0;
  }

  describe() {
    return {
      live: !!this.session,
      target: this.session?.target ?? null,
      startedAt: this.session?.startedAt ?? null,
      utterances: this.session ? this.session.utterances.length : 0,
    };
  }

  /** 开始监听。target = PipeWire 源名（null = 默认麦克风） */
  async start(target = null) {
    if (this.session) throw new Error("监听会话已在进行中（先 /listen/stop）");
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "jarvis-live-"));
    const raw = path.join(dir, "stream.raw");
    this.session = {
      dir, raw, target,
      startedAt: Date.now(),
      proc: null,
      ring: null,        // 当前累积 fd（追加写）
      utterances: [],    // {start,end,bytes}
      state: "listening", // listening | speaking | transcribing
      pending: null,     // 正在积累的段
      silenceMs: 0,
      lastEmit: 0,
    };
    this.emit("listening_start", {});

    // pw-record 语法：输出文件是位置参数（无 -o 选项）
    const pwArgs = ["--rate", "16000", "--channels", "1", "--format", "s16", "--raw"];
    if (target) pwArgs.push("--target", target);
    pwArgs.push(raw);
    const proc = spawn("pw-record", pwArgs, { stdio: ["ignore", "ignore", "pipe"] });
    this.session.proc = proc;
    proc.stderr?.on("data", (c) => { if (process.env.JARVIS_LIVE_DEBUG) console.error("[live] pw-record:", String(c).trim()); });
    proc.on("exit", (code) => {
      if (this.session && this.session.proc === proc) {
        this.emit("listening_stop", { reason: "pw-record exited", code });
        this.session.proc = null;
      }
    });
    // 采集轮询：文件增长 → VAD
    this.session.timer = setInterval(() => this.tick(), 60);
    return this.describe();
  }

  /** 读增量音频 → 能量 VAD → 分段 */
  tick() {
    const s = this.session;
    if (!s) return;
    let size = 0;
    try { size = fs.statSync(s.raw).size; } catch { return; }
    if (s.cursor === undefined) s.cursor = 0;
    const fresh = size - s.cursor;
    if (fresh <= 0) return;
    const windows = Math.floor(fresh / WINDOW_BYTES);
    if (windows <= 0) return;
    const fd = fs.openSync(s.raw, "r");
    const buf = Buffer.alloc(windows * WINDOW_BYTES);
    fs.readSync(fd, buf, 0, buf.length, s.cursor);
    fs.closeSync(fd);
    s.cursor += buf.length;

    for (let i = 0; i < windows; i++) {
      const w = buf.subarray(i * WINDOW_BYTES, (i + 1) * WINDOW_BYTES);
      const rms = this.rms(w);
      const now = Date.now();
      if (rms >= VAD_THRESHOLD) {
        // 有声：开启或延续一段话
        if (!s.pending) {
          s.pending = { startByte: s.cursor - buf.length + i * WINDOW_BYTES, startAt: now, endByte: 0 };
          this.emit("speech_start", { atMs: now - s.startedAt });
        }
        s.pending.endByte = s.cursor - buf.length + (i + 1) * WINDOW_BYTES;
        s.pending.endAt = now;
        s.silenceMs = 0;
        s.state = "speaking";
        const durMs = ((s.pending.endByte - s.pending.startByte) / (SAMPLE_RATE * BYTES_PER_SAMPLE)) * 1000;
        if (durMs >= MAX_UTTERANCE_MS) {
          const seg = s.pending;
          s.pending = null;
          void this.transcribeSegment(seg, ++this.eventSeq);
          s.state = "listening";
        }
      } else if (s.pending) {
        s.silenceMs += WINDOW_MS;
        // 段时长按音频字节换算（(end-start)/32000*1000）：批量 tick 中
        // 墙上时钟几乎不流逝，用 Date.now 会把 600ms 误判为 0ms 丢弃
        const durMs = ((s.pending.endByte - s.pending.startByte) / (SAMPLE_RATE * BYTES_PER_SAMPLE)) * 1000;
        if (s.silenceMs >= SILENCE_MS || durMs >= MAX_UTTERANCE_MS) {
          if (durMs >= MIN_UTTERANCE_MS) {
            // 异步转写入队（tick 是同步定时器回调，不能 await）
            s.state = "transcribing";
            const seg = s.pending;
            s.pending = null;
            void this.transcribeSegment(seg, ++this.eventSeq);
          } else {
            s.pending = null;
            this.emit("speech_discard", { durMs });
          }
          s.state = "listening";
        }
      }
    }
  }

  /** 分段转写（closeUtterance 的内部实现，事件驱动完成） */
  async transcribeSegment(seg, eventId) {
    const s = this.session;
    if (!s) return;
    const wav = this.segToWav(seg, s);
    this.emit("transcribing", { id: eventId });
    try {
      const r = await this.backend.transcribe(wav, "wav", "zh");
      this.emit("final", { id: eventId, text: r.text, engine: r.engine, latencyMs: r.latencyMs });
    } catch (e) {
      this.emit("final", { id: eventId, text: "", error: String(e.message ?? e) });
    }
    if (this.session) this.session.state = "listening";
  }

  /** 一段说完（stop 时同步收尾用） */
  async closeUtterance() {
    const s = this.session;
    const seg = s.pending;
    s.pending = null;
    if (!seg) return;
    await this.transcribeSegment(seg, ++this.eventSeq);
  }

  /** 把 raw 分段封装成 WAV（供后端统一走 /asr 通道） */
  segToWav(seg, session = this.session) {
    const len = seg.endByte - seg.startByte;
    const fd = fs.openSync(session.raw, "r");
    const pcm = Buffer.alloc(len);
    fs.readSync(fd, pcm, 0, len, seg.startByte);
    fs.closeSync(fd);
    const header = Buffer.alloc(44);
    header.write("RIFF", 0);
    header.writeUInt32LE(36 + len, 4);
    header.write("WAVE", 8);
    header.write("fmt ", 12);
    header.writeUInt32LE(16, 16);
    header.writeUInt16LE(1, 20);       // PCM
    header.writeUInt16LE(1, 22);       // mono
    header.writeUInt32LE(SAMPLE_RATE, 24);
    header.writeUInt32LE(SAMPLE_RATE * BYTES_PER_SAMPLE, 28);
    header.writeUInt16LE(BYTES_PER_SAMPLE, 32);
    header.writeUInt16LE(16, 34);
    header.write("data", 36);
    header.writeUInt32LE(len, 40);
    return Buffer.concat([header, pcm]);
  }

  /** fake 模式：直接注入事件（CI 契约测试用） */
  injectFakeEvent(type, data) {
    this.emit(type, data);
  }

  emit(type, data) {
    this.events.push({ type, ...data, at: Date.now() });
    if (this.events.length > 200) this.events.splice(0, 100);
  }

  /** 取事件（sinceId 之后），返回并裁剪已消费 */
  status(sinceAt = 0) {
    const events = this.events.filter((e) => e.at > sinceAt);
    return { ...this.describe(), state: this.session?.state ?? "idle", events };
  }

  async stop() {
    const s = this.session;
    if (!s) return { stopped: false };
    if (s.timer) clearInterval(s.timer);
    if (s.pending) await this.closeUtterance();
    if (s.proc) { try { s.proc.kill("SIGTERM"); } catch { /* 已退出 */ } }
    try { fs.rmSync(s.dir, { recursive: true, force: true }); } catch { /* best effort */ }
    this.session = null;
    this.emit("listening_stop", { reason: "stopped" });
    return { stopped: true };
  }

  rms(buf) {
    let sum = 0;
    for (let i = 0; i < buf.length; i += 2) {
      const v = buf.readInt16LE(i);
      sum += v * v;
    }
    return Math.sqrt(sum / (buf.length / 2));
  }
}

/** s16 PCM → RMS（导出供单测） */
export function windowRms(buf) {
  let sum = 0;
  for (let i = 0; i < buf.length; i += 2) {
    const v = buf.readInt16LE(i);
    sum += v * v;
  }
  return Math.sqrt(sum / (buf.length / 2));
}
