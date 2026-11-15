import { describe, expect, it, vi } from "vitest";
import { AvatarStateEngine } from "@jarvis/avatar";
import { EmbodiedConversation } from "./conversation.js";
import type { EmbodiedPhase, EmbodiedSpeaker, ReplyGenerator, ReplyOutcome } from "./conversation.js";

class FakeSpeaker implements EmbodiedSpeaker {
  calls: string[] = [];
  speaking = false;
  emitsStateEvents = false;
  async speak(text: string): Promise<void> {
    this.calls.push(text);
    this.speaking = true;
    await Promise.resolve();
    this.speaking = false;
  }
  interrupt(): void {
    this.speaking = false;
  }
}

/** 模拟 VoiceIO：自行派发 tts_* / user_interrupt */
class VoiceLikeSpeaker implements EmbodiedSpeaker {
  calls: string[] = [];
  speaking = false;
  emitsStateEvents = true;
  constructor(private readonly engine: AvatarStateEngine) {}
  async speak(text: string): Promise<void> {
    this.calls.push(text);
    this.engine.dispatch({ type: "tts_start" });
    await Promise.resolve();
    this.engine.dispatch({ type: "tts_end" });
  }
  interrupt(): void {
    this.engine.dispatch({ type: "user_interrupt" });
  }
}

function setup(
  reply: ReplyGenerator,
  opts: { speaker?: (engine: AvatarStateEngine) => EmbodiedSpeaker; onPhase?: (p: EmbodiedPhase) => void | Promise<void> } = {},
) {
  const engine = new AvatarStateEngine({ now: () => 1, setTimeoutImpl: () => 0 });
  const phases: EmbodiedPhase[] = [];
  const speaker = opts.speaker?.(engine) ?? new FakeSpeaker();
  const conv = new EmbodiedConversation({
    sink: engine,
    reply,
    speaker,
    onPhase: async (p) => {
      phases.push(p);
      await opts.onPhase?.(p);
    },
  });
  return { engine, conv, speaker, phases };
}

const answer = (text = "收到，已记录"): ReplyGenerator => async (_t, hooks) => {
  hooks.onDelta?.("你");
  hooks.onDelta?.("好");
  hooks.onDelta?.("吗");
  return { kind: "answer", text };
};

const tick = () => new Promise<void>((r) => setImmediate(r));

describe("EmbodiedConversation（0.2-④ 对话连接）", () => {
  it("回答弧：listening→thinking→speaking→idle，回复真实交给 TTS", async () => {
    const { engine, conv, speaker, phases } = setup(answer());
    const r = await conv.submit("帮我记一下");
    expect(r.ok).toBe(true);
    expect(r.state).toBe("idle");
    expect(engine.trail.map((t) => t.to)).toEqual(["listening", "thinking", "speaking", "idle"]);
    expect(phases).toEqual(["listening", "thinking", "speaking", "idle"]);
    expect((speaker as FakeSpeaker).calls).toEqual(["收到，已记录"]);
    expect(r.events).toEqual([
      "user_speech_start", "user_speech_end", "llm_request_start",
      "llm_response_done", "tts_start", "tts_end",
    ]);
  });

  it("任务弧：working→responding→speaking，结果被播报", async () => {
    const run = vi.fn(async () => true);
    const reply: ReplyGenerator = async () => ({ kind: "task", text: "文件已整理", caption: "文件整理", run });
    const { engine, conv, speaker, phases } = setup(reply);
    const r = await conv.submit("整理下载目录");
    expect(run).toHaveBeenCalledTimes(1);
    expect(engine.trail.map((t) => t.to)).toEqual([
      "listening", "thinking", "working", "responding", "speaking", "idle",
    ]);
    expect(phases).toEqual(["listening", "thinking", "working", "responding", "speaking", "idle"]);
    expect(r.events).toContain("harness_start");
    expect(r.events).toContain("harness_end");
    expect((speaker as FakeSpeaker).calls).toEqual(["文件已整理"]);
  });

  it("任务失败也走 responding，并把失败写进表现层 caption", async () => {
    const reply: ReplyGenerator = async () => ({
      kind: "task", text: "任务失败了", run: async () => { throw new Error("disk full"); },
    });
    const { engine, conv } = setup(reply);
    const r = await conv.submit("清理磁盘");
    expect(r.ok).toBe(true);
    expect(engine.trail.map((t) => t.to)).toContain("responding");
    expect(engine.trail.at(-2)?.to).toBe("speaking");
    expect(engine.aesthetic.caption).toBe("任务失败");
  });

  it("LLM 抛错：llm_error 立即回 idle，不卡在 thinking，也不播报", async () => {
    const reply: ReplyGenerator = async () => { throw new Error("GLM 503"); };
    const { engine, conv, speaker, phases } = setup(reply);
    const r = await conv.submit("在吗");
    expect(r.ok).toBe(false);
    expect(r.error).toBe("GLM 503");
    expect(r.state).toBe("idle");
    expect(engine.trail.map((t) => t.to)).toEqual(["listening", "thinking", "idle"]);
    expect(phases).toEqual(["listening", "thinking", "error", "idle"]);
    expect((speaker as FakeSpeaker).calls).toEqual([]);
  });

  it("生成中打断：旧结果不播报，状态停在 listening", async () => {
    let resolveReply!: (v: ReplyOutcome) => void;
    const reply: ReplyGenerator = () => new Promise<ReplyOutcome>((r) => { resolveReply = r; });
    const { engine, conv, speaker } = setup(reply);
    const pending = conv.submit("讲个长故事");
    await tick();
    conv.interrupt();
    resolveReply({ kind: "answer", text: "旧回复" });
    const r = await pending;
    expect(r.interrupted).toBe(true);
    expect(engine.aesthetic.state).toBe("listening");
    expect((speaker as FakeSpeaker).calls).toEqual([]);
  });

  it("新一轮提交会打断上一轮，串行接管而不会并发说话", async () => {
    let resolveFirst!: (v: ReplyOutcome) => void;
    let n = 0;
    const reply: ReplyGenerator = () => {
      n += 1;
      if (n === 1) return new Promise<ReplyOutcome>((r) => { resolveFirst = r; });
      return Promise.resolve({ kind: "answer", text: "新回复" });
    };
    const { conv, speaker } = setup(reply);
    const p1 = conv.submit("旧问题");
    await tick();
    const p2 = conv.submit("新问题");
    resolveFirst({ kind: "answer", text: "旧回复" });
    const [r1, r2] = await Promise.all([p1, p2]);
    expect(r1.interrupted).toBe(true);
    expect(r2.ok).toBe(true);
    expect((speaker as FakeSpeaker).calls).toEqual(["新回复"]);
  });

  it("VoiceIO 风格 speaker：不重复派 tts_end，状态弧仍完整", async () => {
    const { engine, conv, speaker } = setup(answer("你好"), {
      speaker: (engine) => new VoiceLikeSpeaker(engine),
    });
    const r = await conv.submit("打个招呼");
    expect(engine.trail.map((t) => t.to)).toEqual(["listening", "thinking", "speaking", "idle"]);
    expect((speaker as VoiceLikeSpeaker).calls).toEqual(["你好"]);
    expect(r.state).toBe("idle");
  });

  it("静默轮：无需播报也回落 idle", async () => {
    const reply: ReplyGenerator = async () => ({ kind: "silent" });
    const { engine, conv, speaker } = setup(reply);
    const r = await conv.submit("仅记录");
    expect(r.ok).toBe(true);
    expect(engine.aesthetic.state).toBe("idle");
    expect((speaker as FakeSpeaker).calls).toEqual([]);
  });

  it("onPhase 是真正的异步暂停点", async () => {
    let released = false;
    const seen: string[] = [];
    const { conv } = setup(answer(), {
      onPhase: async (p) => {
        if (p === "thinking") {
          await new Promise<void>((r) => setTimeout(() => { released = true; r(); }, 5));
        }
        seen.push(`${p}:${released}`);
      },
    });
    await conv.submit("等一下");
    expect(seen[0]).toBe("listening:false");
    expect(seen[1]).toBe("thinking:true");
    expect(seen[2]).toBe("speaking:true");
  });
});
