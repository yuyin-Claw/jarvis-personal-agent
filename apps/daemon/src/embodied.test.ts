import { describe, expect, it, vi } from "vitest";
import type { PlatformAdapter } from "@jarvis/platform";
import type { SpeakEndReason } from "@jarvis/platform";
import { createEmbodiedRuntime } from "./embodied.js";
import type { ReplyGenerator } from "@jarvis/embodied";

function fakePlatform() {
  const host = {
    start: vi.fn(async () => undefined),
    setState: vi.fn(async () => undefined),
    capture: vi.fn(async () => true),
    stop: vi.fn(async () => undefined),
    probe: vi.fn(),
  };
  const speech = {
    speak: vi.fn(async (): Promise<SpeakEndReason> => "completed"),
    interrupt: vi.fn(),
    speaking: false,
    probe: vi.fn(),
  };
  const platform = {
    id: "macos",
    avatarHost: host,
    speechOutput: speech,
    speechInput: { start: vi.fn(), stop: vi.fn(), onEvent: vi.fn(), probe: vi.fn() },
    foreground: { current: vi.fn(), probe: vi.fn() },
    notification: { send: vi.fn(), probe: vi.fn() },
    probe: vi.fn(),
  } as unknown as PlatformAdapter;
  return { platform, host, speech };
}

const answer: ReplyGenerator = async () => ({ kind: "answer", text: "已记录" });

describe("具身运行时 composition root（0.2-④⑤ 接线）", () => {
  it("一轮对话把状态流推向宿主，并真实调用平台 TTS", async () => {
    const { platform, host, speech } = fakePlatform();
    const rt = createEmbodiedRuntime({ platform, reply: answer });
    await rt.start();
    const r = await rt.conversation.submit("帮我记一下");
    expect(r.ok).toBe(true);
    expect(r.state).toBe("idle");
    expect(speech.speak).toHaveBeenCalledTimes(1);
    expect(speech.speak.mock.calls[0][0]).toBe("已记录");

    const published = host.setState.mock.calls.map((c) => (c[0] as { state: string }).state);
    expect(published).toContain("listening");
    expect(published).toContain("thinking");
    expect(published).toContain("speaking");
    expect(rt.states.length).toBeGreaterThanOrEqual(4);
    expect(await rt.capture("/tmp/x.png")).toBe(true);
    expect(host.capture).toHaveBeenCalledWith("/tmp/x.png");
    await rt.stop();
    expect(host.stop).toHaveBeenCalledTimes(1);
  });

  it("静音模式完全不发声，但状态弧仍回落 idle", async () => {
    const { platform, speech } = fakePlatform();
    const rt = createEmbodiedRuntime({ platform, reply: answer, voice: false });
    await rt.start();
    const r = await rt.conversation.submit("静音测试");
    expect(r.state).toBe("idle");
    expect(speech.speak).not.toHaveBeenCalled();
    await rt.stop();
  });

  it("任务弧能把 working/responding 推给宿主", async () => {
    const { platform, host } = fakePlatform();
    const rt = createEmbodiedRuntime({
      platform,
      reply: async () => ({ kind: "task", text: "整理完成", run: async () => true }),
    });
    await rt.start();
    await rt.conversation.submit("整理下载目录");
    const published = host.setState.mock.calls.map((c) => (c[0] as { state: string }).state);
    expect(published).toContain("working");
    expect(published).toContain("responding");
    await rt.stop();
  });

  it("主动通知经 ProactiveVoiceChannel 开口，状态弧 speaking→idle", async () => {
    const { platform, speech, host } = fakePlatform();
    const rt = createEmbodiedRuntime({ platform, reply: answer });
    await rt.start();
    await rt.proactive.send({
      text: "任务停滞了，需要我检查吗？",
      priority: "normal",
      dedupeKey: "stagnant:t1",
      at: new Date().toISOString(),
    });
    expect(speech.speak).toHaveBeenCalledTimes(1);
    expect(rt.engine.aesthetic.state).toBe("idle");
    expect(rt.states.some((s) => s.state === "speaking")).toBe(true);
    expect(host.setState).toHaveBeenCalled();
    await rt.stop();
  });

  it("无窗口模式不启动宿主，也不写渲染状态", async () => {
    const { platform, host } = fakePlatform();
    const rt = createEmbodiedRuntime({ platform, reply: answer, avatar: false, voice: false });
    await rt.start();
    await rt.conversation.submit("headless");
    expect(host.start).not.toHaveBeenCalled();
    expect(host.setState).not.toHaveBeenCalled();
    expect(rt.states.length).toBeGreaterThan(0);
    await rt.stop();
    expect(host.stop).not.toHaveBeenCalled();
  });
});
