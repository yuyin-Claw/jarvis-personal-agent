import { describe, expect, it, vi } from "vitest";
import { AvatarStateEngine } from "./state-engine.js";
import { TaskEventWatcher, conversationEvents, taskEventFor } from "./event-bridge.js";
import type { CoreEvent } from "./state-engine.js";
import type { TaskStatus } from "@jarvis/task-manager";

function must<T>(v: T | null | undefined): T {
  if (v === null || v === undefined) throw new Error("unexpected null");
  return v;
}

/** 按序投递事件，返回状态轨迹 */
function run(engine: AvatarStateEngine, events: CoreEvent[]): string[] {
  const states: string[] = [engine.aesthetic.state];
  for (const ev of events) states.push(engine.dispatch(ev));
  return states;
}

describe("AvatarStateEngine 状态机", () => {
  function engine() {
    return new AvatarStateEngine({ now: () => 1_000, setTimeoutImpl: () => 0 });
  }

  it("完整对话弧：聆听→思考→说话→待机", () => {
    const e = engine();
    const trail = run(e, [
      { type: "user_speech_start" },
      { type: "user_speech_end" },
      { type: "llm_request_start" },
      { type: "llm_response_done" },
      { type: "tts_start" },
      { type: "tts_end" },
    ]);
    expect(trail).toEqual(["idle", "listening", "thinking", "thinking", "speaking", "speaking", "idle"]);
  });

  it("打断：说话中用户开口 → 立即切 listening", () => {
    const e = engine();
    e.dispatch({ type: "tts_start" }); // idle → speaking
    expect(e.dispatch({ type: "user_interrupt" })).toBe("listening");
    // 打断后 TTS 端事件被忽略（不再回 speaking）
    expect(e.dispatch({ type: "tts_end" })).toBe("listening");
  });

  it("任务执行弧：思考→执行→回应→超时回待机", () => {
    const e = engine();
    run(e, [
      { type: "llm_request_start" }, // thinking
      { type: "harness_start" }, // working
      { type: "harness_end", ok: true }, // responding
    ]);
    expect(e.aesthetic.state).toBe("responding");
    expect(e.aesthetic.caption).toBeUndefined();
    // responding 保持后超时回 idle
    expect(e.dispatch({ type: "activity_timeout" })).toBe("idle");
  });

  it("任务失败：harness_end ok=false → responding + 失败标注", () => {
    const e = engine();
    e.dispatch({ type: "harness_start" });
    e.dispatch({ type: "harness_end", ok: false });
    expect(e.aesthetic.state).toBe("responding");
    expect(e.aesthetic.caption).toBe("任务失败");
  });

  it("执行中用户插话 → listening，任务继续不被打断", () => {
    const e = engine();
    e.dispatch({ type: "harness_start" });
    expect(e.dispatch({ type: "user_speech_start" })).toBe("listening");
  });

  it("主动通知：idle 直接 speaking（数字人主动开口）", () => {
    const e = engine();
    expect(e.dispatch({ type: "proactive_notice" })).toBe("speaking");
  });

  it("未定义转换被忽略（如 idle 收到 tts_end）", () => {
    const e = engine();
    expect(e.dispatch({ type: "tts_end" })).toBe("idle");
    expect(e.trail).toHaveLength(0);
  });

  it("强度外部驱动不改变状态；基线随状态切换", () => {
    const e = engine();
    e.setIntensity(0.9);
    expect(e.aesthetic.intensity).toBe(0.9);
    e.dispatch({ type: "user_speech_start" });
    expect(e.aesthetic.intensity).toBe(0.5); // listening 基线
  });

  it("表现订阅流：状态变化即推送", () => {
    const e = engine();
    const seen: string[] = [];
    e.onAesthetic((a) => seen.push(a.state));
    e.dispatch({ type: "user_speech_start" });
    e.setIntensity(0.7);
    expect(seen).toEqual(["listening", "listening"]);
  });

  it("responding 自动回 idle 用定时器（holdMs 可配）", () => {
    vi.useFakeTimers();
    try {
      const e = new AvatarStateEngine({ respondingHoldMs: 3000 });
      e.dispatch({ type: "harness_start" });
      e.dispatch({ type: "harness_end", ok: true });
      expect(e.aesthetic.state).toBe("responding");
      vi.advanceTimersByTime(3100);
      expect(e.aesthetic.state).toBe("idle");
    } finally {
      vi.useRealTimers();
    }
  });
  it("llm_error：生成失败时任意非 idle 状态立即回 idle，不卡死", () => {
    const paths: CoreEvent[][] = [
      [{ type: "user_speech_start" }, { type: "user_speech_end" }], // thinking
      [{ type: "user_speech_start" }, { type: "user_speech_end" }, { type: "harness_start" }], // working
      [{ type: "user_speech_start" }, { type: "user_speech_end" }, { type: "harness_start" }, { type: "harness_end", ok: true }], // responding
      [{ type: "user_speech_start" }, { type: "user_speech_end" }, { type: "llm_response_done" }], // speaking
      [{ type: "proactive_notice" }], // 主动开口中说错话
    ];
    for (const path of paths) {
      const e = new AvatarStateEngine({ now: () => 1, setTimeoutImpl: () => 0 });
      for (const ev of path) e.dispatch(ev);
      expect(e.aesthetic.state).not.toBe("idle");
      expect(run(e, [{ type: "llm_error" }]).at(-1)).toBe("idle");
    }
  });

  it("user_interrupt：思考/执行/回应/播报中打断都转聆听", () => {
    const paths: CoreEvent[][] = [
      [{ type: "user_speech_start" }, { type: "user_speech_end" }],
      [{ type: "user_speech_start" }, { type: "user_speech_end" }, { type: "harness_start" }],
      [{ type: "user_speech_start" }, { type: "user_speech_end" }, { type: "llm_response_done" }],
      [{ type: "proactive_notice" }],
    ];
    for (const path of paths) {
      const e = new AvatarStateEngine({ now: () => 1, setTimeoutImpl: () => 0 });
      for (const ev of path) e.dispatch(ev);
      expect(run(e, [{ type: "user_interrupt" }]).at(-1)).toBe("listening");
    }
  });
});

describe("事件桥", () => {
  it("任务状态映射：RUNNING→start、COMPLETED→task_completed、FAILED→harness_end(false)", () => {
    expect(taskEventFor("PLANNED", "RUNNING")).toEqual({ type: "harness_start" });
    expect(taskEventFor("RUNNING", "COMPLETED")).toEqual({ type: "task_completed" });
    expect(taskEventFor("RUNNING", "FAILED")).toEqual({ type: "harness_end", ok: false });
    expect(taskEventFor("CREATED", "PLANNED")).toBeNull();
    expect(taskEventFor("RUNNING", "RUNNING")).toBeNull();
  });

  it("TaskEventWatcher：状态 diff 翻译投递到引擎", async () => {
    const states = new Map<string, TaskStatus>([["t1", "PLANNED"]]);
    const tm = {
      list: () => [...states.entries()].map(([id, status]) => ({ id, status })),
    };
    const engine = new AvatarStateEngine({ now: () => 1, setTimeoutImpl: () => 0 });
    const watcher = new TaskEventWatcher(tm, engine, 60_000);
    watcher.start(); // 基线 PLANNED

    states.set("t1", "RUNNING");
    await watcher.poll();
    expect(engine.aesthetic.state).toBe("working");

    states.set("t1", "COMPLETED");
    await watcher.poll();
    expect(engine.aesthetic.state).toBe("responding");
    watcher.stop();
  });

  it("conversationEvents 工厂产出正确事件", () => {
    const c = conversationEvents();
    expect(c.onLLMStart().type).toBe("llm_request_start");
    expect(c.onTTSStart().type).toBe("tts_start");
    expect(must(c.onLLMDone()).type).toBe("llm_response_done");
  });
});
