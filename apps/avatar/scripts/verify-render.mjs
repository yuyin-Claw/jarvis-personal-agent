#!/usr/bin/env node
// 0.2-② 渲染验收（Node 侧）：通过真实 RenderTransport 逐状态驱动宿主，
// 等待宿主 ack + 窗口截图，产出 report.json 供像素断言脚本核对。
// 用法：node verify-render.mjs <shots-dir>
import { existsSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { AvatarRenderTransport } from "../../../packages/avatar/dist/index.js";

const shots = resolve(process.argv[2] ?? "");
if (!shots || !existsSync(shots)) {
  console.error("usage: node verify-render.mjs <shots-dir>");
  process.exit(2);
}

const STATES = [
  { state: "idle", intensity: 0.15, amplitude: 0, caption: "" },
  { state: "listening", intensity: 0.6, amplitude: 0.45, caption: "聆听中" },
  { state: "thinking", intensity: 0.8, amplitude: 0, caption: "思考中" },
  { state: "speaking", intensity: 0.85, amplitude: 0.7, caption: "语音链路测试" },
  { state: "working", intensity: 0.6, amplitude: 0, caption: "执行任务" },
  { state: "responding", intensity: 0.9, amplitude: 0, caption: "任务完成" },
];

const transport = new AvatarRenderTransport();
const report = [];

for (const s of STATES) {
  const shot = join(shots, `${s.state}.png`);
  rmSync(shot, { force: true });
  rmSync(`${shot}.done`, { force: true });

  const payload = transport.setState(s.state, {
    intensity: s.intensity,
    amplitude: s.amplitude,
    caption: s.caption,
    capture: shot,
  });
  const ack = await transport.waitForAck(payload.seq, 5000, 50);
  const captured = await transport.waitForCapture(shot, 8000, 50);

  let rendered = null;
  try {
    rendered = ack?.result ? JSON.parse(ack.result) : null;
  } catch {
    rendered = null;
  }
  const row = {
    state: s.state,
    seq: payload.seq,
    ackOk: ack?.ok === true,
    rendererOk: rendered?.ok === true,
    renderedState: rendered?.state?.state ?? null,
    frame: rendered?.frame ?? 0,
    capture: captured,
  };
  report.push(row);
  console.log(
    `${s.state.padEnd(11)} ack=${row.ackOk ? "Y" : "N"} renderer=${row.rendererOk ? "Y" : "N"} ` +
      `state=${String(row.renderedState).padEnd(11)} frame=${row.frame} shot=${captured ? "Y" : "N"}`,
  );
}

writeFileSync(join(shots, "report.json"), JSON.stringify(report, null, 2));

const frames = report.map((r) => r.frame);
const ok = report.every(
  (r) => r.ackOk && r.rendererOk && r.renderedState === r.state && r.capture && r.frame > 0,
) && frames.at(-1) > frames[0];
if (!ok) {
  console.error("FAIL: 状态未全部送达渲染层或渲染帧未推进");
  process.exit(1);
}
console.log(`PASS: ${report.length} 个状态全部送达，渲染帧 ${frames[0]} → ${frames.at(-1)}`);
