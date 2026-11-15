#!/usr/bin/env node
/**
 * 在 Try Omarchy guest 内实测生产 OmarchyPlatformAdapter 的 AvatarHost：
 *   probe() → start()（真实 GTK/WebKit 窗口）→ 六状态 setState() → capture()（grim 截图）
 * → 从宿主日志回读 WebView 已执行注入 JS 的证据 → 生成 report.json 供 assert-render.py 断言。
 *
 * 运行位置：guest 内（由 guest-bridge.mjs 的 exec 触发）
 * 环境变量：
 *   JARVIS_ADAPTER_ENTRY  适配器 dist/index.js 的 guest 内绝对路径
 *   JARVIS_AVATAR_HTML   avatar.html 的 guest 内绝对路径
 *   JARVIS_HOST_SCRIPT   avatar-host.py 的 guest 内绝对路径
 *   JARVIS_SHOTS_DIR     截图/报告输出目录（9p 共享目录内，宿主可读）
 *   JARVIS_HOST_LOG      宿主进程 stdout 日志路径
 */
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

const STATES = ["idle", "listening", "thinking", "speaking", "working", "responding"];
const entry = process.env.JARVIS_ADAPTER_ENTRY;
const html = process.env.JARVIS_AVATAR_HTML;
const script = process.env.JARVIS_HOST_SCRIPT;
const shots = process.env.JARVIS_SHOTS_DIR;
const log = process.env.JARVIS_HOST_LOG;
for (const [k, v] of Object.entries({ entry, html, script, shots, log })) {
  if (!v) throw new Error(`缺环境变量 ${k}`);
}

fs.mkdirSync(shots, { recursive: true });
const { OmarchyPlatformAdapter } = await import(pathToFileURL(entry).href);
const adapter = new OmarchyPlatformAdapter({
  htmlPath: html,
  hostScript: script,
  socketPath: "/tmp/jarvis-avatar-e2e.sock",
});

console.log("=== 生产适配器五端点探测（guest 内） ===");
const statuses = await adapter.probe();
for (const s of statuses) console.log(`  ${s.endpoint.padEnd(14)} ${s.state.padEnd(12)} ${s.detail ?? ""}`);
const hostProbe = statuses.find((s) => s.endpoint === "avatarHost");
if (hostProbe?.state !== "ready") throw new Error(`avatarHost 未就绪：${hostProbe?.state} ${hostProbe?.detail ?? ""}`);

console.log("=== 真实窗口 + 六状态驱动 ===");
await adapter.avatarHost.start({ x: 80, y: 80, width: 420, height: 480 });

// WebView 首屏加载期间注入的 JS 可能还没有 window.jarvis；以宿主日志里
// [rendered] <state> 计数增长为准重试，绝不把「帧已送达」当成「已上屏」。
const renderedCount = (state) =>
  fs.existsSync(log)
    ? fs.readFileSync(log, "utf8").split("\n").filter((l) => l.includes(`[rendered] ${state}`)).length
    : 0;

const report = [];
try {
  for (const state of STATES) {
    const before = renderedCount(state);
    let renderedOk = false;
    for (let attempt = 0; attempt < 4 && !renderedOk; attempt++) {
      await adapter.avatarHost.setState({ state, intensity: 0.8, caption: state });
      await new Promise((r) => setTimeout(r, 1_000));
      renderedOk = renderedCount(state) > before;
    }
    const png = path.join(shots, `${state}.png`);
    const ok = await adapter.avatarHost.capture(png);
    console.log(
      `  ${state.padEnd(12)} rendered=${renderedOk ? "Y" : "N"} capture=${ok ? "Y" : "N"} ` +
      `bytes=${fs.existsSync(png) ? fs.statSync(png).size : 0}`,
    );
    report.push({ state, capture: ok && fs.existsSync(png), rendererOk: renderedOk, renderedState: renderedOk ? state : null });
  }
} finally {
  await adapter.avatarHost.stop();
}

// 从宿主日志确认 WebView 真的执行了注入 JS（不是只收到 socket 帧）
const lines = fs.existsSync(log) ? fs.readFileSync(log, "utf8").split("\n") : [];
const rendered = new Set();
for (const l of lines) {
  const m = l.match(/\[rendered\]\s+(\w+)/);
  if (m) rendered.add(m[1]);
}
for (const row of report) {
  row.rendererOk = rendered.has(row.state);
  row.renderedState = rendered.has(row.state) ? row.state : null;
}
console.log(`  WebView 回读状态：${[...rendered].join(",") || "（无）"}`);

console.log("=== 其余平台端点实测（speechOutput / notification / foreground） ===");
const ttsFile = path.join(shots, "guest-tts.wav");
const reason = await adapter.speechOutput.speak("JARVIS 语音端点验收", { outputFile: ttsFile });
const ttsBytes = fs.existsSync(ttsFile) ? fs.statSync(ttsFile).size : 0;
console.log(`  speechOutput.speak reason=${reason} bytes=${ttsBytes}`);
const notified = await adapter.notification.send({ title: "JARVIS", text: "Omarchy 端点验收", priority: "low" });
console.log(`  notification.send=${notified}`);
const foreground = await adapter.foreground.current();
console.log(`  foreground.current=${JSON.stringify(foreground)}`);
const endpointOk = reason === "completed" && ttsBytes > 1000 && notified;
if (!endpointOk) throw new Error("guest 其余平台端点实测未通过");

fs.writeFileSync(path.join(shots, "report.json"), JSON.stringify(report, null, 2));

const bad = report.filter((r) => !r.capture || !r.rendererOk || r.renderedState !== r.state);
if (bad.length > 0) {
  console.error(`FAIL: ${bad.length} 个状态未上屏：${bad.map((b) => b.state).join(",")}`);
  process.exit(1);
}
console.log("PASS: Omarchy guest 生产适配器六状态真实上屏并截图");
