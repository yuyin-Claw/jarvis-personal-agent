import { describe, expect, it, vi } from "vitest";
import { AvatarStateEngine } from "@jarvis/avatar";
import { MacSayTTS, sanitizeSpeechText } from "./mac-say-tts.js";
import { VoiceIO } from "./voice-io.js";
import type { SayProcess } from "./mac-say-tts.js";

/** 可控的 say 进程替身：autoClose 时异步播完；kill 时以中断结束 */
class FakeSay implements SayProcess {
  killed = false;
  closeCbs: Array<(code: number | Error | null, signal?: NodeJS.Signals | null) => void> = [];
  errorCbs: Array<(code: number | Error | null, signal?: NodeJS.Signals | null) => void> = [];
  constructor(readonly autoClose = true) {}
  on(event: "close" | "error", cb: (code: number | Error | null, signal?: NodeJS.Signals | null) => void) {
    if (event === "close") {
      this.closeCbs.push(cb);
      if (this.autoClose) queueMicrotask(() => { if (!this.killed) this.closeCbs.forEach((f) => f(0, null)); });
    } else this.errorCbs.push(cb);
    return this;
  }
  kill() {
    this.killed = true;
    queueMicrotask(() => this.closeCbs.forEach((f) => f(null, "SIGTERM")));
    return true;
  }
  fail() {
    queueMicrotask(() => this.errorCbs.forEach((f) => f(new Error("boom"))));
  }
  finish() {
    this.closeCbs.forEach((f) => f(0, null));
  }
}

function engine() {
  return new AvatarStateEngine({ now: () => 1_000, setTimeoutImpl: () => 0 });
}

describe("sanitizeSpeechText 防注入清洗", () => {
  it("去控制字符、压缩空白、限长", () => {
    expect(sanitizeSpeechText("  你好\n\t 世界  ", 500)).toBe("你好 世界");
    expect(sanitizeSpeechText("a".repeat(600), 20)).toHaveLength(20);
    expect(sanitizeSpeechText("\u0000\u0007abc", 100)).toBe("abc");
  });
  it("以 - 开头时不让文本被 say 当成选项", () => {
    expect(sanitizeSpeechText("-v Ting-Ting", 100)).toBe(" -v Ting-Ting");
  });
  it("空文本", () => {
    expect(sanitizeSpeechText("  \n ", 100)).toBe("");
  });
});

describe("MacSayTTS 输出通道", () => {
  it("文本走参数数组，voice/rate/outputFile 正确组装，事件回调齐全", async () => {
    let args: string[] = [];
    const proc = new FakeSay();
    const onStart = vi.fn();
    const onEnd = vi.fn();
    const tts = new MacSayTTS({
      voice: "Ting-Ting",
      rate: 200,
      outputFile: "/tmp/out.aiff",
      platform: "darwin",
      spawnImpl: (a) => { args = a; return proc; },
      onStart,
      onEnd,
    });
    expect(tts.args).toEqual(["-v", "Ting-Ting", "-r", "200", "-o", "/tmp/out.aiff"]);
    expect(await tts.speak("你好，JARVIS")).toBe("completed");
    expect(args).toEqual(["-v", "Ting-Ting", "-r", "200", "-o", "/tmp/out.aiff", "你好，JARVIS"]);
    expect(onStart).toHaveBeenCalledTimes(1);
    expect(onEnd).toHaveBeenCalledWith("completed");
    expect(tts.speaking).toBe(false);
  });

  it("打断：SIGTERM 杀进程，结束原因 interrupted", async () => {
    const proc = new FakeSay(false);
    const tts = new MacSayTTS({ platform: "darwin", spawnImpl: () => proc });
    const p = tts.speak("很长的一段话");
    await Promise.resolve(); // 等 spawn 与 on 注册
    tts.interrupt();
    expect(proc.killed).toBe(true);
    expect(await p).toBe("interrupted");
  });

  it("非 macOS 降级 unsupported，不 spawn 不抛错", async () => {
    const spawnImpl = vi.fn();
    const tts = new MacSayTTS({ platform: "linux", spawnImpl });
    expect(await tts.speak("hi")).toBe("unsupported");
    expect(spawnImpl).not.toHaveBeenCalled();
  });

  it("spawn 抛错 → error；进程 error 事件 → error", async () => {
    const a = new MacSayTTS({ platform: "darwin", spawnImpl: () => { throw new Error("no say"); } });
    expect(await a.speak("hi")).toBe("error");
    const proc = new FakeSay(false);
    const b = new MacSayTTS({ platform: "darwin", spawnImpl: () => proc });
    const p = b.speak("hi");
    proc.fail();
    expect(await p).toBe("error");
  });

  it("空文本直接完成，不启动进程", async () => {
    const spawnImpl = vi.fn();
    const tts = new MacSayTTS({ platform: "darwin", spawnImpl });
    expect(await tts.speak("   ")).toBe("completed");
    expect(spawnImpl).not.toHaveBeenCalled();
  });
});

describe("VoiceIO → AvatarStateEngine 事件闭环", () => {
  function setup(autoClose = true) {
    const e = engine();
    const proc = new FakeSay(autoClose);
    const tts = new MacSayTTS({ platform: "darwin", spawnImpl: () => proc });
    const io = new VoiceIO(tts, e, { now: () => 1, envelope: false });
    return { e, proc, tts, io };
  }

  it("完整对话弧：聆听→思考→说话→待机，事件序列正确", async () => {
    const { e, io } = setup();
    const states = [e.aesthetic.state];
    io.startListening(); states.push(e.aesthetic.state);
    expect(io.endListening("现在几点")).toBe("现在几点");
    states.push(e.aesthetic.state);
    await io.speak("现在是凌晨两点");
    states.push(e.aesthetic.state);
    expect(states).toEqual(["idle", "listening", "thinking", "idle"]);
    expect(io.trail.map((x) => x.type)).toEqual([
      "user_speech_start", "user_speech_end", "tts_start", "tts_end",
    ]);
    expect(e.trail.map((t) => t.to)).toEqual(["listening", "thinking", "speaking", "idle"]);
  });

  it("打断：TTS 立即停，状态切 listening，绝不派发 tts_end", async () => {
    const { e, proc, io } = setup(false);
    const speaking = io.speak("这段话会被打断");
    await Promise.resolve();
    io.interrupt();
    await speaking;
    expect(proc.killed).toBe(true);
    expect(e.aesthetic.state).toBe("listening");
    const types = io.trail.map((x) => x.type);
    expect(types).toContain("user_interrupt");
    expect(types).not.toContain("tts_end");
  });

  it("打断后用户继续说话：聆听→思考→说话完整弧仍成立", async () => {
    const { e, proc, io } = setup(false);
    const p = io.speak("被打断的话");
    await Promise.resolve();
    io.interrupt();
    await p;
    io.endListening("换个问题");
    expect(e.aesthetic.state).toBe("thinking");
    const p2 = io.speak("好的");
    expect(e.aesthetic.state).toBe("speaking");
    await Promise.resolve();
    proc.finish();
    await p2;
    expect(e.aesthetic.state).toBe("idle");
  });

  it("主动开口：proactive_notice 后进入 speaking 并回落", async () => {
    const { e, io } = setup();
    await io.announce("检测到任务停滞，需要我处理吗");
    expect(e.trail[0].to).toBe("speaking");
    expect(e.aesthetic.state).toBe("idle");
  });

  it("TTS 失败/降级不会把状态卡在 speaking", async () => {
    const e = engine();
    const tts = new MacSayTTS({ platform: "linux", spawnImpl: vi.fn() });
    const io = new VoiceIO(tts, e, { now: () => 1, envelope: false });
    await io.speak("无音频环境");
    expect(e.aesthetic.state).toBe("idle");
  });

  it("强度包络：播放期间持续推送，结束后停止", async () => {
    const e = engine();
    const setIntensity = vi.spyOn(e, "setIntensity");
    const clearTimer = vi.fn();
    let tick: (() => void) | undefined;
    const tts = new MacSayTTS({ platform: "darwin", spawnImpl: () => new FakeSay() });
    const io = new VoiceIO(tts, e, {
      now: () => 1,
      setIntervalImpl: (fn) => { tick = fn; return 42; },
      clearIntervalImpl: clearTimer,
    });
    const p = io.speak("波动测试");
    expect(tick).toBeDefined();
    tick?.(); tick?.();
    expect(setIntensity).toHaveBeenCalledTimes(2);
    expect(e.aesthetic.intensity).toBeGreaterThan(0.5);
    await p;
    expect(clearTimer).toHaveBeenCalledWith(42);
  });
});
