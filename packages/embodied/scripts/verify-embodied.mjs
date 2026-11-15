#!/usr/bin/env node
/**
 * 0.2-④⑤ 具身对话端到端验收（macOS 专用，无需人工看图、无需联网 LLM）
 *
 * 用确定性 fake reply 驱动生产 composition root，验证：
 *  1. 一轮真实对话把 listening/thinking/speaking 推上屏（宿主自截窗口 + ack 回读）
 *  2. 任务分支把 working/responding 推上屏
 *  3. 打断不播报旧结果、LLM 故障回落 idle
 *  4. 主动通知由数字人开口；忙时排队、回 idle 补播
 *  5. 语音真实合成到 AIFF（-o 静默，不发声）
 *
 * 产物：<shots>/report.json + <state>.png，交由 assert-render.py 做像素断言。
 * 用法：node verify-embodied.mjs <shots-dir> <aiff-path>
 */
import { existsSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { initPlatform } from "../../../apps/daemon/dist/platform.js";
import { createEmbodiedRuntime } from "../../../apps/daemon/dist/embodied.js";

const shots = resolve(process.argv[2] ?? "");
const aiff = resolve(process.argv[3] ?? join(shots, "tts.aiff"));
if (!shots || !existsSync(shots)) {
  console.error("usage: node verify-embodied.mjs <shots-dir> <aiff-path>");
  process.exit(2);
}

const ACK = join(homedir(), ".local", "share", "jarvis", "avatar.ack.json");
const STATES = ["idle", "listening", "thinking", "speaking", "working", "responding"];
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const ttsStarts = (rt) => rt.voice.trail.filter((e) => e.type === "tts_start").length;
const ttsEnds = (rt) => rt.voice.trail.filter((e) => e.type === "tts_end").length;
/** 等最后一段 say 真正收尾（close 事件 → tts_end），避免断言时文件还在写 */
async function waitTtsSettled(rt, timeoutMs = 8000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (ttsStarts(rt) > 0 && ttsEnds(rt) === ttsStarts(rt)) return true;
    await sleep(80);
  }
  return false;
}
let failures = 0;

function check(ok, label) {
  console.log(`${ok ? "PASS" : "FAIL"}: ${label}`);
  if (!ok) failures += 1;
}

const platform = await initPlatform("macos");
const report = new Map();
let runtime;

/** 每个状态只截一次；截图请求经生产 PlatformAdapter.avatarHost.capture 发出 */
async function snap(phase, aesthetic) {
  const state = aesthetic.state;
  if (!STATES.includes(state) || report.has(state)) return;
  const shot = join(shots, `${state}.png`);
  rmSync(shot, { force: true });
  rmSync(`${shot}.done`, { force: true });
  const captured = await runtime.capture(shot);
  let ack = null;
  let rendered = null;
  try {
    ack = JSON.parse(readFileSync(ACK, "utf8"));
    rendered = ack?.result ? JSON.parse(ack.result) : null;
  } catch {
    // ack 尚未写出或损坏，按失败记账
  }
  const row = {
    state,
    phase,
    ackOk: ack?.ok === true,
    rendererOk: rendered?.ok === true,
    renderedState: rendered?.state?.state ?? null,
    frame: rendered?.frame ?? 0,
    capture: captured,
  };
  report.set(state, row);
  console.log(
    `  shot ${state.padEnd(11)} phase=${String(phase).padEnd(11)} ack=${row.ackOk ? "Y" : "N"} ` +
      `renderer=${row.rendererOk ? "Y" : "N"} state=${String(row.renderedState).padEnd(11)} ` +
      `frame=${row.frame} png=${captured ? "Y" : "N"}`,
  );
}

/** 确定性「LLM」：覆盖回答 / 任务 / 打断 / 故障四条路径 */
const reply = async (text, hooks) => {
  hooks.onDelta?.("思考");
  hooks.onDelta?.("中");
  hooks.onDelta?.("…");
  if (text.includes("打断")) {
    return new Promise((res) => {
      setTimeout(() => runtime.conversation.interrupt(), 20);
      setTimeout(() => res({ kind: "answer", text: "这条不该播报" }), 90);
    });
  }
  if (text.includes("错误")) throw new Error("模拟 LLM 故障");
  if (text.includes("任务")) {
    return {
      kind: "task",
      text: "文件已整理完成",
      caption: "文件整理",
      run: async () => { await sleep(60); return true; },
    };
  }
  return { kind: "answer", text: "已记录，需要我继续吗" };
};

try {
  runtime = createEmbodiedRuntime({
    platform,
    reply,
    speechOutputFile: aiff,
    envelope: false, // 截图期间不得让强度包络覆盖状态文件
    onPhase: snap,
  });
  await runtime.start();
  await sleep(1800); // 等 WKWebView 宿主完成首帧渲染

  // 初始 idle 画面
  await platform.avatarHost.setState({ state: "idle", intensity: 0.15, caption: "" });
  await snap("idle", runtime.engine.aesthetic);

  console.log("\n--- 对话弧 ---");
  const r1 = await runtime.conversation.submit("帮我记一下");
  check(r1.ok && r1.state === "idle", `回答轮完成并回落 idle（${r1.events.join(">")}）`);

  const r2 = await runtime.conversation.submit("执行整理任务");
  check(r2.ok && r2.state === "idle", `任务轮完成并回落 idle（${r2.events.join(">")}）`);
  check(r2.events.includes("harness_start") && r2.events.includes("harness_end"), "任务事件桥已派发 harness_start/end");

  const beforeInterrupt = ttsStarts(runtime);
  const r3 = await runtime.conversation.submit("请打断我");
  check(r3.interrupted === true, "打断轮标记 interrupted，状态保持聆听");
  check(ttsStarts(runtime) === beforeInterrupt, "打断后不播报旧结果");

  const r4 = await runtime.conversation.submit("触发错误");
  check(!r4.ok && r4.state === "idle", `LLM 故障经 llm_error 回落 idle（${r4.error}）`);

  console.log("\n--- 主动交流 ---");
  const beforeProactive = ttsStarts(runtime);
  await runtime.proactive.send({
    text: "任务停滞了，需要我检查吗？",
    priority: "normal",
    dedupeKey: "stagnant:t1",
    at: new Date().toISOString(),
  });
  check(ttsStarts(runtime) === beforeProactive + 1, "主动通知触发一次数字人开口（TTS）");
  check(runtime.engine.aesthetic.state === "idle", "主动开口结束后回到 idle");

  runtime.engine.dispatch({ type: "user_speech_start" }); // 模拟用户正在说话
  await runtime.proactive.send({
    text: "这条要排队",
    priority: "high",
    dedupeKey: "queued:1",
    at: new Date().toISOString(),
  });
  check(runtime.proactive.pending === 1, "用户说话期间主动消息排队，不打断");
  const beforeFlush = ttsStarts(runtime);
  runtime.engine.dispatch({ type: "llm_error" }); // → idle，触发补播
  await sleep(300);
  check(runtime.proactive.pending === 0 && ttsStarts(runtime) === beforeFlush + 1, "回到 idle 后自动补播排队消息");
  const settled = await waitTtsSettled(runtime);
  check(settled, "全部 TTS 播放已收尾（tts_end 与 tts_start 配对）");

  console.log("\n--- 渲染与语音证据 ---");
  const ordered = STATES.map((s) => report.get(s)).filter(Boolean);
  writeFileSync(join(shots, "report.json"), JSON.stringify(ordered, null, 2));
  writeFileSync(join(shots, "voice-trail.json"), JSON.stringify(runtime.voice.trail, null, 2));
  writeFileSync(join(shots, "states.json"), JSON.stringify(runtime.states, null, 2));
  check(ordered.length === STATES.length, `六状态截图证据齐全（${ordered.length}/6）`);
  check(
    ordered.every((r) => r.ackOk && r.rendererOk && r.capture && r.renderedState === r.state && r.frame > 0),
    "六状态均由对话链路送达渲染层（ack + 渲染器回读 + 窗口截图）",
  );
  const seen = new Set(runtime.states.map((s) => s.state));
  check(STATES.every((s) => seen.has(s)), `状态引擎真实经历六状态（${[...seen].join(",")}）`);
  const frames = ordered.map((r) => r.frame);
  check(frames.at(-1) > frames[0], `渲染帧持续推进 ${frames[0]} → ${frames.at(-1)}`);
  const size = existsSync(aiff) ? statSync(aiff).size : 0;
  check(size > 10_000, `say 静默合成 AIFF 落盘完成（${size} 字节，未发声）`);
} finally {
  if (runtime) await runtime.stop();
}

if (failures > 0) {
  console.error(`\nFAIL: ${failures} 项断言未通过`);
  process.exit(1);
}
console.log("\nPASS: 0.2-④⑤ 具身对话端到端验收通过");
