import { describe, expect, it, vi } from "vitest";
import { AvatarStateEngine } from "@jarvis/avatar";
import { ProactiveVoiceChannel } from "./proactive.js";
import type { ProactiveNoticeLike, ProactiveVoiceEvent } from "./proactive.js";

class FakeAnnouncer {
  calls: string[] = [];
  constructor(private readonly engine: AvatarStateEngine) {}
  async announce(text: string): Promise<void> {
    this.calls.push(text);
    this.engine.dispatch({ type: "proactive_notice" }); // idle → speaking
    await Promise.resolve();
    this.engine.dispatch({ type: "tts_start" });
    this.engine.dispatch({ type: "tts_end" }); // → idle
  }
}

const notice = (text: string, priority: ProactiveNoticeLike["priority"] = "normal"): ProactiveNoticeLike => ({
  text, priority, dedupeKey: `k:${text}`, at: "2026-11-15T10:00:00.000Z",
});

const settle = async () => {
  for (let i = 0; i < 6; i += 1) await new Promise<void>((r) => setImmediate(r));
};

function setup(opts: { enabled?: boolean; queueLimit?: number; ttlMs?: number; now?: () => number } = {}) {
  const engine = new AvatarStateEngine({ now: () => 1, setTimeoutImpl: () => 0 });
  const announcer = new FakeAnnouncer(engine);
  const events: ProactiveVoiceEvent[] = [];
  const fallback = vi.fn(async () => undefined);
  const channel = new ProactiveVoiceChannel({
    engine,
    announcer,
    fallback,
    onEvent: (e) => events.push(e),
    ...opts,
  });
  return { engine, announcer, events, fallback, channel };
}

const busy = (engine: AvatarStateEngine) => engine.dispatch({ type: "user_speech_start" }); // → listening
const free = (engine: AvatarStateEngine) => engine.dispatch({ type: "llm_error" }); // → idle

describe("ProactiveVoiceChannel（0.2-⑤ 主动交流）", () => {
  it("idle 时立即开口，播报后回到 idle", async () => {
    const { channel, announcer, engine, events } = setup();
    await channel.send(notice("任务停滞了"));
    expect(announcer.calls).toEqual(["任务停滞了"]);
    expect(engine.aesthetic.state).toBe("idle");
    expect(events.map((e) => e.type)).toEqual(["queued", "spoken"]);
  });

  it("用户说话/思考/执行期间一律排队，回到 idle 才补播", async () => {
    const { channel, announcer, engine, events } = setup();
    busy(engine);
    await channel.send(notice("A"));
    await channel.send(notice("B"));
    expect(announcer.calls).toEqual([]);
    expect(channel.pending).toBe(2);
    free(engine);
    await settle();
    expect(announcer.calls).toEqual(["A", "B"]);
    expect(channel.pending).toBe(0);
    expect(events.filter((e) => e.type === "spoken")).toHaveLength(2);
  });

  it("high 优先级插队头", async () => {
    const { channel, announcer, engine } = setup();
    busy(engine);
    await channel.send(notice("A"));
    await channel.send(notice("B"));
    await channel.send(notice("紧急", "high"));
    free(engine);
    await settle();
    expect(announcer.calls).toEqual(["紧急", "A", "B"]);
  });

  it("队列超限丢最旧的低优先级消息，不无限堆积", async () => {
    const { channel, announcer, engine, events } = setup({ queueLimit: 2 });
    busy(engine);
    await channel.send(notice("A"));
    await channel.send(notice("B"));
    await channel.send(notice("C"));
    expect(channel.pending).toBe(2);
    expect(events.some((e) => e.type === "dropped" && e.dedupeKey === "k:A")).toBe(true);
    free(engine);
    await settle();
    expect(announcer.calls).toEqual(["B", "C"]);
  });

  it("排队超时不补播陈旧消息", async () => {
    let t = 0;
    const { channel, announcer, engine, events } = setup({ ttlMs: 100, now: () => t });
    busy(engine);
    await channel.send(notice("过期提醒"));
    t = 500;
    free(engine);
    await settle();
    expect(announcer.calls).toEqual([]);
    expect(events.some((e) => e.type === "expired")).toBe(true);
  });

  it("关闭语音时降级到 fallback，不发声也不丢消息", async () => {
    const { channel, announcer, fallback, events } = setup({ enabled: false });
    await channel.send(notice("静音提醒"));
    expect(announcer.calls).toEqual([]);
    expect(fallback).toHaveBeenCalledTimes(1);
    expect(events.map((e) => e.type)).toEqual(["degraded"]);
  });

  it("播报抛错不影响后续消息，错误可观测", async () => {
    const { engine, events } = setup();
    const announcer = {
      announce: vi.fn(async () => { throw new Error("say 挂了"); }),
    };
    const channel = new ProactiveVoiceChannel({ engine, announcer, onEvent: (e) => events.push(e) });
    await channel.send(notice("A"));
    expect(events.some((e) => e.type === "error" && e.detail === "say 挂了")).toBe(true);
    expect(channel.pending).toBe(0);
  });

  it("dispose 后不再响应，订阅被清理", async () => {
    const { channel, announcer, engine } = setup();
    busy(engine);
    await channel.send(notice("A"));
    channel.dispose();
    free(engine);
    await settle();
    expect(announcer.calls).toEqual([]);
    expect(channel.pending).toBe(0);
  });
});
