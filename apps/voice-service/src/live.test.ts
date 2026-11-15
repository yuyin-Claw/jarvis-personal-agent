import { afterEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { LiveListener, windowRms } from "./live.mjs";

/**
 * 实时监听模块单元测试（ADR-012 · 任务 #52）
 * 不依赖真实麦克风：直接驱动 tick() 的 VAD 状态机 + fake 后端转写。
 */

/** 生成 PCM s16 窗口：静默 or 正弦音 */
function pcm(ms, opts = { loud: false }) {
  const samples = Math.floor((16000 * ms) / 1000);
  const buf = Buffer.alloc(samples * 2);
  for (let i = 0; i < samples; i++) {
    const t = i / 16000;
    // 220Hz 正弦，响段幅度 8000，静默段 80
    const amp = opts.loud ? 8000 : 80;
    const v = Math.round(amp * Math.sin(2 * Math.PI * 220 * t));
    buf.writeInt16LE(v, i * 2);
  }
  return buf;
}

function fakeBackend() {
  return {
    async transcribe(wav) {
      if (wav.length < 44) throw new Error("音频过短");
      return { text: "请介绍一下你自己", engine: "fake-live", latencyMs: 1 };
    },
  };
}

/** 不启动 pw-record 的会话（直接注入 raw 文件供 tick 读） */
function startFakeSession(listener) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "jarvis-live-test-"));
  const raw = path.join(dir, "stream.raw");
  fs.writeFileSync(raw, Buffer.alloc(0));
  listener.session = {
    dir, raw, target: null, startedAt: Date.now(), proc: null,
    utterances: [], state: "listening", pending: null, silenceMs: 0,
    cursor: 0, timer: null,
  };
  return { append: (buf) => fs.appendFileSync(raw, buf) };
}

describe("windowRms", () => {
  it("静默窗口 RMS 远低于阈值，语音窗口远高于", () => {
    expect(windowRms(pcm(20, { loud: false }))).toBeLessThan(350);
    expect(windowRms(pcm(20, { loud: true }))).toBeGreaterThan(350);
  });
});

describe("LiveListener VAD 状态机", () => {
  let listener;

  afterEach(async () => {
    if (listener?.session) {
      if (listener.session.timer) clearInterval(listener.session.timer);
      try { fs.rmSync(listener.session.dir, { recursive: true, force: true }); } catch { /* 临时目录清理失败可忽略 */ }
      listener.session = null;
    }
  });

  it("响段后静默 800ms 触发分段与 final 转写", async () => {
    listener = new LiveListener(fakeBackend());
    const s = startFakeSession(listener);
    s.append(pcm(200, { loud: false })); // 前导静默
    listener.tick();
    expect(listener.events.filter((e) => e.type === "speech_start")).toHaveLength(0);

    s.append(pcm(600, { loud: true })); // 说话
    listener.tick();
    expect(listener.events.some((e) => e.type === "speech_start")).toBe(true);
    expect(listener.session.pending).toBeTruthy();

    s.append(pcm(900, { loud: false })); // 静默 ≥800ms
    listener.tick();
    expect(listener.session.pending).toBeNull();
    // 转写异步完成：轮询等 final 事件（上限 2s）
    const final = await new Promise((resolve) => {
      const t0 = Date.now();
      const check = () => {
        const f = listener.events.find((e) => e.type === "final");
        if (f || Date.now() - t0 > 2000) resolve(f);
        else setTimeout(check, 20);
      };
      check();
    });
    expect(final?.text).toBe("请介绍一下你自己");
    expect(final?.engine).toBe("fake-live");
  });

  it("过短爆音（<300ms）被丢弃不转写", async () => {
    listener = new LiveListener(fakeBackend());
    const s = startFakeSession(listener);
    s.append(pcm(100, { loud: true })); // 100ms 咔哒
    listener.tick();
    s.append(pcm(900, { loud: false }));
    listener.tick();
    await new Promise((r) => setTimeout(r, 30));
    expect(listener.events.some((e) => e.type === "speech_discard")).toBe(true);
    expect(listener.events.some((e) => e.type === "final")).toBe(false);
  });

  it("status(sinceAt) 只返回新事件并汇报会话状态", async () => {
    listener = new LiveListener(fakeBackend());
    startFakeSession(listener);
    const st0 = listener.status(0);
    expect(st0.live).toBe(true);
    expect(st0.state).toBe("listening");
    await new Promise((r) => setTimeout(r, 5)); // 保证 at 递增
    listener.emit("speech_start", {});
    const since = st0.events.length ? st0.events[st0.events.length - 1].at : 0;
    const st1 = listener.status(since);
    // since 是「最后一个旧事件的时刻」，speech_start 在其后 → 应出现
    expect(st1.events.some((e) => e.type === "speech_start")).toBe(true);
    const st2 = listener.status(st1.events[st1.events.length - 1].at);
    expect(st2.events.some((e) => e.type === "speech_start")).toBe(false); // 已消费过滤
  });

  it("stop 清理会话且幂等", async () => {
    listener = new LiveListener(fakeBackend());
    startFakeSession(listener);
    const r1 = await listener.stop();
    const r2 = await listener.stop();
    expect(r1.stopped).toBe(true);
    expect(r2.stopped).toBe(false);
    expect(listener.session).toBeNull();
  });
});
