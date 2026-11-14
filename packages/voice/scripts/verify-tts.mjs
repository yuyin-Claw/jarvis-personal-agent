#!/usr/bin/env node
// 0.2-③ 语音链路真实验收（macOS）：say 合成到 AIFF 文件（不发声），
// 同时驱动 VoiceIO → AvatarStateEngine → AvatarRenderTransport，
// 核对音频产物、状态轨迹与渲染状态文件三方一致。
import { existsSync, mkdtempSync, readFileSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MacSayTTS, VoiceIO } from "../dist/index.js";
import { AvatarStateEngine, AvatarRenderTransport } from "@jarvis/avatar";

const dir = mkdtempSync(join(tmpdir(), "jarvis-voice-verify-"));
const audio = join(dir, "tts.aiff");
const failures = [];
const check = (ok, msg) => {
  console.log(`${ok ? "PASS" : "FAIL"}  ${msg}`);
  if (!ok) failures.push(msg);
};

const engine = new AvatarStateEngine({ respondingHoldMs: 50 });
const transport = new AvatarRenderTransport({ baseDir: dir });
transport.bind(engine);
const tts = new MacSayTTS({ outputFile: audio, rate: 200, platform: "darwin" });
const io = new VoiceIO(tts, engine, { envelope: false });

io.startListening();
io.endListening("现在几点");
const reason = await tts.speak("JARVIS 语音链路已就绪");
// 上面直接用 tts 验证音频；下面再用 VoiceIO 完整驱动一次，覆盖事件闭环
await io.speak("链路正常");

const audioOk = existsSync(audio) && statSync(audio).size > 1000;
check(audioOk, `say 合成音频产物存在且非空（${existsSync(audio) ? statSync(audio).size : 0} bytes）`);
check(reason === "completed", `say 正常结束（reason=${reason}）`);

const stateFile = JSON.parse(readFileSync(transport.stateFile, "utf8"));
check(stateFile.state === "idle", `渲染状态最终回落 idle（实际 ${stateFile.state}）`);
check(engine.trail.map((t) => t.to).join(">") === "listening>thinking>speaking>idle",
  `状态轨迹正确（${engine.trail.map((t) => t.to).join(">")}）`);
const types = io.trail.map((e) => e.type);
check(types.includes("tts_start") && types.includes("tts_end"), "tts_start / tts_end 事件齐备");

io.dispose();
console.log(`\n产物目录：${dir}`);
if (failures.length) {
  console.error(`FAIL: ${failures.length} 项未通过`);
  process.exit(1);
}
console.log("PASS: 语音输出链路端到端验收通过");
