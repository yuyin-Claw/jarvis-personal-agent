import { afterEach, describe, expect, it, vi } from "vitest";
import { VoiceServiceSpeechInput, type LiveStatus } from "./voice-service";
import type { SpeechInputEvent } from "@jarvis/platform";

/**
 * ADR-012 实时监听事件映射测试：
 * speech_start → partial（打断 TTS）；final → final（进 thinking）；
 * 轮询容错（服务暂不可达不中断）；stopLive 幂等。
 */

function makeClient(eventsQueue: LiveStatus[]) {
  return {
    listenStart: vi.fn(async () => ({ live: true, state: "listening" })),
    listenStatus: vi.fn(async (): Promise<LiveStatus> =>
      eventsQueue.shift() ?? { live: true, state: "listening", target: null, events: [] }),
    listenStop: vi.fn(async () => undefined),
  };
}

function inputWith(queue: LiveStatus[]) {
  const client = makeClient(queue);
  // @ts-expect-error 注入 fake client（构造器要求 VoiceServiceClient）
  const input = new VoiceServiceSpeechInput("omarchy", { url: "http://x" });
  // @ts-expect-error 替换私有 client
  input.client = client;
  return { input, client };
}

describe("VoiceServiceSpeechInput 实时监听", () => {
  it("speech_start 派 partial、final 派 final", async () => {
    const t0 = Date.now();
    const { input } = inputWith([
      { live: true, state: "speaking", target: null, events: [
        { type: "speech_start", at: t0 + 100 },
      ] },
      { live: true, state: "listening", target: null, events: [
        { type: "final", at: t0 + 200, text: "请介绍一下你自己", id: 1 },
      ] },
    ]);
    const got: SpeechInputEvent[] = [];
    input.onEvent((e) => got.push(e));
    await input.startLive(undefined, 10);
    await new Promise((r) => setTimeout(r, 150));
    await input.stopLive();
    expect(got.some((e) => e.type === "partial")).toBe(true);
    expect(got.find((e) => e.type === "final")).toMatchObject({ text: "请介绍一下你自己" });
  });

  it("轮询失败不中断、后续事件仍送达", async () => {
    const t0 = Date.now();
    let fail = true;
    const { input } = {
      input: (() => {
        const client = {
          listenStart: async () => ({ live: true, state: "listening" }),
          listenStatus: async (): Promise<LiveStatus> => {
            if (fail) throw new Error("暂时不可达");
            return { live: true, state: "listening", target: null,
              events: [{ type: "final", at: t0 + 50, text: "恢复后的话", id: 2 }] };
          },
          listenStop: async () => undefined,
        };
        // @ts-expect-error 注入 fake client 绕过构造器类型检查
        const i = new VoiceServiceSpeechInput("omarchy", { url: "http://x" });
        // @ts-expect-error 替换私有 client 字段为 fake 替身
        i.client = client;
        return i;
      })(),
    };
    const got: SpeechInputEvent[] = [];
    input.onEvent((e) => got.push(e));
    await input.startLive(undefined, 10);
    await new Promise((r) => setTimeout(r, 50));
    fail = false;
    await new Promise((r) => setTimeout(r, 80));
    await input.stopLive();
    expect(got.find((e) => e.type === "final")).toMatchObject({ text: "恢复后的话" });
  });

  it("stopLive 幂等且调用 listenStop 一次", async () => {
    const { input, client } = inputWith([]);
    await input.startLive(undefined, 10);
    await input.stopLive();
    await input.stopLive();
    expect(client.listenStop).toHaveBeenCalledTimes(1);
  });
});

afterEach(() => {
  vi.restoreAllMocks();
});
