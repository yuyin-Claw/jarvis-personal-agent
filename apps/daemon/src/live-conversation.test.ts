import { describe, expect, it, vi } from "vitest";
import type { SpeechInputEvent } from "@jarvis/platform";
import { LiveConversation } from "./live-conversation.js";
import type { EmbodiedRuntime } from "./embodied.js";

function setup(submitImpl?: () => Promise<{ ok: boolean; state: string; text: string }>) {
  let listener: ((e: SpeechInputEvent) => void) | undefined;
  const input = {
    onEvent: vi.fn((cb: (e: SpeechInputEvent) => void) => { listener = cb; return () => { listener = undefined; }; }),
    startLive: vi.fn(async () => undefined),
    stopLive: vi.fn(async () => undefined),
  };
  const runtime = {
    voice: {
      tts: { speaking: true },
      interrupt: vi.fn(),
      startListening: vi.fn(),
      endListening: vi.fn(),
      speak: vi.fn(async () => undefined),
    },
    conversation: { submit: vi.fn(submitImpl ?? (async () => ({ ok: true, state: "done", text: "回复" }))) },
    start: vi.fn(async () => undefined),
    stop: vi.fn(async () => undefined),
  } as unknown as EmbodiedRuntime;
  return { input, runtime, emit: (e: SpeechInputEvent) => listener?.(e) };
}

describe("LiveConversation", () => {
  it("空 partial 也立即打断 TTS，final 进入完整对话", async () => {
    const { input, runtime, emit } = setup();
    const live = new LiveConversation(input, runtime);
    await live.start();
    emit({ type: "partial", text: "" });
    expect(runtime.voice.interrupt).toHaveBeenCalledTimes(1);
    emit({ type: "final", text: "你好贾维斯" });
    await vi.waitFor(() => expect(runtime.conversation.submit).toHaveBeenCalledWith("你好贾维斯"));
    expect(runtime.voice.endListening).toHaveBeenCalledWith("你好贾维斯");
    await live.stop();
    expect(input.stopLive).toHaveBeenCalledTimes(1);
    expect(runtime.stop).toHaveBeenCalledTimes(1);
  });

  it("唤醒会话超时直接播放退出提示，不调用模型", async () => {
    const { input, runtime, emit } = setup();
    const live = new LiveConversation(input, runtime);
    await live.start();
    emit({ type: "session_end", text: "有事请随时叫我" });
    await vi.waitFor(() => expect(runtime.voice.speak).toHaveBeenCalledWith("有事请随时叫我"));
    expect(runtime.conversation.submit).not.toHaveBeenCalled();
    await live.stop();
  });

  it("同一时刻只处理一轮，完成后才接受新 final", async () => {
    let resolveTurn: ((value: { ok: boolean; state: string; text: string }) => void) | undefined;
    const { input, runtime, emit } = setup(() => new Promise((resolve) => { resolveTurn = resolve; }));
    const live = new LiveConversation(input, runtime);
    await live.start();
    emit({ type: "final", text: "第一句" });
    emit({ type: "final", text: "第二句" });
    expect(runtime.conversation.submit).toHaveBeenCalledTimes(1);
    resolveTurn?.({ ok: true, state: "done", text: "完成" });
    await vi.waitFor(() => {
      emit({ type: "final", text: "第三句" });
      expect(runtime.conversation.submit).toHaveBeenCalledTimes(2);
    });
    await live.stop();
  });
});
