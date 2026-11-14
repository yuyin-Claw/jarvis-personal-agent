import { describe, expect, it, vi } from "vitest";
import { AvatarStateEngine } from "@jarvis/avatar";
import { VoiceIO } from "./voice-io.js";
import { SpeechInput, probeSpeechPermissions } from "./speech-input.js";
import type { SpeakEndReason, SpeechSynthesizer } from "./mac-say-tts.js";
import type { SpeechProcess } from "./speech-input.js";

class FakeSpeechProcess implements SpeechProcess {
  killed = false;
  dataCbs: Array<(c: Buffer | string) => void> = [];
  eventCbs: Record<string, Array<(v: number | Error | null) => void>> = {};
  stdout = { on: (_e: "data", cb: (c: Buffer | string) => void) => { this.dataCbs.push(cb); return this; } };
  on(event: "exit" | "error", cb: (v: number | Error | null) => void) {
    (this.eventCbs[event] ??= []).push(cb);
    return this;
  }
  kill() { this.killed = true; this.eventCbs.exit?.forEach((f) => f(0)); return true; }
  emit(chunk: string) { this.dataCbs.forEach((f) => f(chunk)); }
  exitWith(chunk: string) { this.emit(chunk); this.eventCbs.exit?.forEach((f) => f(0)); }
}

class FakeTTS implements SpeechSynthesizer {
  speaking = false;
  async speak(): Promise<SpeakEndReason> { return "completed"; }
  interrupt() { this.speaking = false; }
}

class HangingTTS implements SpeechSynthesizer {
  speaking = false;
  private release?: (r: SpeakEndReason) => void;
  async speak(): Promise<SpeakEndReason> {
    this.speaking = true;
    return new Promise((resolve) => { this.release = resolve; });
  }
  interrupt() {
    this.speaking = false;
    this.release?.("interrupted");
  }
}

function voice(tts: SpeechSynthesizer = new FakeTTS()) {
  const engine = new AvatarStateEngine({ now: () => 1, setTimeoutImpl: () => 0 });
  const io = new VoiceIO(tts, engine, { now: () => 1, envelope: false });
  return { engine, tts, io };
}

describe("probeSpeechPermissions 权限探测", () => {
  it("解析 --status-only 的 status 行", async () => {
    let args: string[] = [];
    const proc = new FakeSpeechProcess();
    const status = await probeSpeechPermissions({
      binaryPath: "/fake/jarvis-speech",
      spawnImpl: (cmd, a) => { args = a; queueMicrotask(() => proc.exitWith(
        '{"type":"status","speech":"notDetermined","mic":"granted","available":true,"locale":"zh-CN"}\n')); return proc; },
    });
    expect(args).toEqual(["--status-only"]);
    expect(status).toMatchObject({ speech: "notDetermined", mic: "granted", available: true });
  });

  it("无输出返回 null（降级决策交给 Core）", async () => {
    const a = await probeSpeechPermissions({
      spawnImpl: () => { const p = new FakeSpeechProcess(); queueMicrotask(() => p.exitWith("")); return p; },
    });
    expect(a).toBeNull();
    const b = await probeSpeechPermissions({
      spawnImpl: () => { const p = new FakeSpeechProcess(); queueMicrotask(() => p.exitWith("garbage\n")); return p; },
    });
    expect(b).toBeNull();
  });
});

describe("SpeechInput JSONL 解析", () => {
  it("跨 chunk 的行能正确拼接，事件各触发一次", () => {
    const proc = new FakeSpeechProcess();
    const onPartial = vi.fn();
    const onFinal = vi.fn();
    const onReady = vi.fn();
    const input = new SpeechInput({ spawnImpl: () => proc, onPartial, onFinal, onReady });
    input.start();
    proc.emit('{"type":"ready"}\n{"type":"par');
    expect(onReady).toHaveBeenCalledTimes(1);
    proc.emit('tial","text":"现在几');
    expect(onPartial).not.toHaveBeenCalled();
    proc.emit('点"}\n{"type":"final","text":"现在几点"}\n');
    expect(onPartial).toHaveBeenCalledWith("现在几点");
    expect(onFinal).toHaveBeenCalledWith("现在几点");
  });

  it("权限不足触发 onUnavailable；错误中含 permission 也触发", () => {
    const unavailable = vi.fn();
    const input = new SpeechInput({ onUnavailable: unavailable });
    input.feed('{"type":"status","speech":"notDetermined","mic":"granted","available":true}');
    input.feed('{"type":"error","message":"speech or microphone permission not granted"}');
    expect(unavailable).toHaveBeenCalledTimes(2);
  });

  it("非法 JSON 与未知类型被忽略，不抛错", () => {
    const onError = vi.fn();
    const input = new SpeechInput({ onError });
    expect(() => { input.feed("not json"); input.feed('{"type":"mystery"}'); }).not.toThrow();
    expect(onError).not.toHaveBeenCalled();
  });

  it("stop 杀掉子进程", () => {
    const proc = new FakeSpeechProcess();
    const input = new SpeechInput({ spawnImpl: () => proc });
    input.start();
    expect(input.running).toBe(true);
    input.stop();
    expect(proc.killed).toBe(true);
    expect(input.running).toBe(false);
  });
});

describe("SpeechInput → VoiceIO 打断接线", () => {
  it("首次 partial 开始聆听，final 结束并回落，状态轨迹正确", () => {
    const { engine, io } = voice();
    const input = new SpeechInput();
    input.attach(io);
    input.feed('{"type":"partial","text":"现在"}');
    input.feed('{"type":"partial","text":"现在几点"}');
    expect(engine.aesthetic.state).toBe("listening");
    input.feed('{"type":"final","text":"现在几点"}');
    expect(io.lastTranscript).toBe("现在几点");
    expect(engine.aesthetic.state).toBe("thinking");
  });

  it("TTS 播放中用户开口 → interrupt 而不是 startListening", async () => {
    const { engine, io } = voice(new HangingTTS());
    const pending = io.speak("正在播报的内容");
    expect(engine.aesthetic.state).toBe("speaking");
    const interrupt = vi.spyOn(io, "interrupt");
    const start = vi.spyOn(io, "startListening");
    const input = new SpeechInput();
    input.attach(io);
    input.feed('{"type":"partial","text":"等一下"}');
    await pending;
    expect(interrupt).toHaveBeenCalledTimes(1);
    expect(start).not.toHaveBeenCalled();
    expect(engine.aesthetic.state).toBe("listening");
  });

  it("解绑后不再驱动 VoiceIO", () => {
    const { io } = voice();
    const input = new SpeechInput();
    const off = input.attach(io);
    off();
    input.feed('{"type":"partial","text":"你好"}');
    expect(io.trail).toHaveLength(0);
  });
});
