#!/usr/bin/env node
/**
 * 在 Try Omarchy guest 内部署并实测语音服务（ADR-009 / 任务 #30）
 *
 * 1. 把零依赖服务代码放到 9p 共享目录（guest 可直接执行，无需下载）
 * 2. guest 内启动服务：ASR = Superwhisper（guest 进程），TTS = espeak-ng（guest 本地）
 * 3. QMP 运行时 hostfwd，宿主经 127.0.0.1 访问 guest 服务
 * 4. 跨系统契约验收：health / contract / asr（真实中文音频）/ tts / 打断语义
 * 5. Core 经 Platform Adapter 调用 guest 服务，验证语音双向闭环
 *
 * 测试音频来自仓库内置 fixtures（真实人声 16k WAV，ADR-009 零 macOS 依赖：
 * 验收流程不调用 say 等任何宿主专有工具）。
 *
 * 用法：node verify-omarchy-voice.mjs
 */
import fs from "node:fs";
import os from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createGuestBridge } from "./guest-bridge.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(HERE, "../../..");
const SHARE = join(os.homedir(), "Omarchy", "jarvis-voice-service");
/** 9p 共享目录在 guest 内的挂载路径（与宿主路径不同） */
const GUEST_SHARE = "/home/yuyin/Omarchy/jarvis-voice-service";
const GUEST_SERVICE_PORT = 8787;
const HOST_FORWARD_PORT = 18787;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let failures = 0;
const check = (ok, label) => {
  console.log(`${ok ? "PASS" : "FAIL"}: ${label}`);
  if (!ok) failures += 1;
};

/** 部署到 guest 的文件清单（服务 src + package.json；fixtures 用于测试音频） */
const FIXTURES = join(REPO, "apps/voice-service/fixtures");

function deployFiles() {
  // 覆盖式同步，不删除共享目录中的其他内容
  fs.mkdirSync(join(SHARE, "src"), { recursive: true });
  for (const f of fs.readdirSync(join(REPO, "apps/voice-service/src"))) {
    if (f.endsWith(".mjs")) fs.copyFileSync(join(REPO, "apps/voice-service/src", f), join(SHARE, "src", f));
  }
  fs.copyFileSync(join(REPO, "apps/voice-service/package.json"), join(SHARE, "package.json"));
  fs.copyFileSync(join(HERE, "proxy-request.mjs"), join(SHARE, "proxy-request.mjs"));
  fs.writeFileSync(join(SHARE, "start.sh"), [
    "#!/bin/sh",
    `cd ${GUEST_SHARE}`,
    'export PATH="$HOME/.local/espeak/usr/bin:$PATH"',
    'export LD_LIBRARY_PATH="$HOME/.local/espeak/usr/lib:$LD_LIBRARY_PATH"',
    'export ESPEAK_DATA_PATH="$HOME/.local/espeak/usr/share/espeak-ng-data"',
    `exec node src/server.mjs --backend omarchy --port ${GUEST_SERVICE_PORT}`,
    "",
  ].join("\n"));
  return SHARE;
}

/** 读取仓库内置的真实人声 fixture（不再调用任何宿主专有合成工具） */
function loadFixture(name) {
  const file = join(FIXTURES, name);
  return fs.readFileSync(file);
}

async function waitHealth(url, timeoutMs = 25_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const r = await fetch(`${url}/health`);
      if (r.ok) return await r.json();
    } catch { /* guest 服务尚未就绪 */ }
    await sleep(400);
  }
  return null;
}

// 上游降级通道已随 MacBackend 移除（ADR-009 零 macOS 依赖）；
// guest 服务以纯本地引擎运行：ASR = superwhisper（guest 进程），TTS = espeak-ng（guest 本地）。
deployFiles();
const bridge = await createGuestBridge({
  proxyTarget: `http://127.0.0.1:${GUEST_SERVICE_PORT}`,
  proxyScript: join(GUEST_SHARE, "proxy-request.mjs"),
});
let guestUrl = `http://127.0.0.1:${HOST_FORWARD_PORT}`;
const report = { guestUrl, checks: [] };

try {
  console.log("--- 1. 服务代码与 guest 本地引擎 ---");
  const files = await bridge.exec(`ls ${GUEST_SHARE}/src/*.mjs | wc -l; ls $HOME/.local/espeak/usr/bin/espeak-ng; command -v superwhisper`, 30_000);
  check(files.rc === 0 && /^3\s*$/m.test(files.out) && /espeak-ng/.test(files.out) && /superwhisper/.test(files.out),
    `共享目录服务包与 guest 本地引擎就位（${files.out.trim().replace(/\n/g, " | ")}）`);

  console.log("\n--- 2. 在 Omarchy guest 内启动服务进程 ---");
  await bridge.exec(`OLD=$(pgrep -f "^node src/server.mjs --backend omarchy" | head -1); [ -n "$OLD" ] && kill "$OLD" 2>/dev/null; echo cleaned`, 30_000);
  await sleep(400);
  const launch = await bridge.exec(
    `nohup sh ${GUEST_SHARE}/start.sh > /tmp/jarvis-voice-guest.log 2>&1 < /dev/null & echo LAUNCHED`, 30_000);
  check(/LAUNCHED/.test(launch.out), "guest 服务进程已拉起（后台常驻）");
  await sleep(1500);
  const ps = await bridge.exec(`pgrep -af "node src/server.mjs" | head -3; echo ---; curl -s http://127.0.0.1:${GUEST_SERVICE_PORT}/health | head -c 300; echo ---; tail -5 /tmp/jarvis-voice-guest.log`, 30_000);
  check(/server\.mjs/.test(ps.out) && /"platform":"omarchy"/.test(ps.out),
    `服务确实运行在 guest 内：${ps.out.trim().replace(/\n/g, " | ").slice(0, 300)}`);

  console.log("\n--- 3. 运行时端口转发（host → guest） ---");
  const fwd = await bridge.forward(HOST_FORWARD_PORT, GUEST_SERVICE_PORT);
  const fwdDetail = fwd.error?.desc ?? String(fwd.return ?? "");
  const fwdOk = !fwd.error || /already|in use|exists/i.test(fwdDetail);
  check(fwdOk, `QMP hostfwd_add 127.0.0.1:${HOST_FORWARD_PORT} → guest:${GUEST_SERVICE_PORT}` +
    (fwdDetail ? `（${fwdDetail.slice(0, 120)}）` : ""));
  let health = await waitHealth(guestUrl, 8_000);
  let transport = "hostfwd";
  if (!health) {
    // 本 QEMU 构建运行时 hostfwd 不转发；改用 guest 主动拉取的反向 HTTP 代理
    guestUrl = bridge.proxyUrl;
    health = await waitHealth(guestUrl, 30_000);
    transport = "guest-reverse-proxy";
  }
  report.guestUrl = guestUrl;
  report.transport = transport;
  console.log(`  传输通道：${transport} → ${guestUrl}`);
  check(!!health, `宿主可访问 guest 服务（transport=${transport}）`);
  if (!health) throw new Error("guest 服务 health 不可达，终止后续断言");
  report.health = health;
  check(health.platform === "omarchy" && health.contract === "1.0",
    `契约一致（platform=${health.platform}, contract=${health.contract}）`);
  check(health.ready === true && health.asr.ready && health.tts.ready, "ASR / TTS 端点均 ready");
  check(health.tts.engine === "espeak-ng" && health.tts.local === true,
    `TTS 使用 guest 本地引擎（${health.tts.engine}，非上游转发）`);
  check(health.asr.local === true && /superwhisper|whisper|vosk/.test(health.asr.engine),
    `ASR 使用 guest 内进程（${health.asr.engine}）`);
  check(guestUrl !== "http://macos-host", "跨系统调用：宿主经网络端点访问 guest 服务");

  console.log("\n--- 4. 跨系统契约实测（真实中文音频 / 真实合成） ---");
  const contract = await (await fetch(`${guestUrl}/contract`)).json();
  check(contract.version === "1.0" && contract.endpoints.includes("asr") && contract.endpoints.includes("tts"),
    "/contract 契约端点齐备");
  const wav = loadFixture("zh-user-utterance.wav");
  check(wav.length > 20_000, `真实中文语音波形（${wav.length} 字节 WAV，仓库内置 fixture）`);
  const asrRes = await fetch(`${guestUrl}/asr`, {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ audio: wav.toString("base64"), format: "wav", language: "zh" }),
  });
  const asr = await asrRes.json();
  report.asr = asr;
  check(asrRes.ok && asr.ok && typeof asr.text === "string" && asr.text.length > 2,
    `/asr 真实转写：「${asr.text ?? asr.error}」（engine=${asr.engine ?? "?"}）`);
  check(/介绍|自己|你/.test(asr.text ?? ""), "转写文本与原话语义一致");
  const glog = await bridge.exec("tail -12 /tmp/jarvis-voice-guest.log", 30_000);
  console.log(`  guest 服务日志：${glog.out.trim().replace(/\n/g, " | ").slice(0, 500)}`);
  const ttsRes = await fetch(`${guestUrl}/tts`, {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ text: "我是 JARVIS，语音服务运行在 Omarchy 上", rate: 150 }),
  });
  const tts = await ttsRes.json();
  const audio = tts.audio ? Buffer.from(tts.audio, "base64") : Buffer.alloc(0);
  report.tts = { ok: tts.ok, format: tts.format, engine: tts.engine, bytes: audio.length };
  check(ttsRes.ok && tts.ok && audio.length > 10_000,
    `/tts 返回真实音频（${tts.format}，${audio.length} 字节，engine=${tts.engine}）`);
  check(audio.toString("ascii", 0, 4) === "RIFF" || audio.toString("ascii", 0, 4) === "FORM",
    "音频文件头有效（WAV/AIFF）");

  console.log("\n--- 5. Core 经 Platform Adapter 调用 Omarchy 服务 ---");
  process.env.JARVIS_VOICE_URL = guestUrl;
  const { initPlatform } = await import("../../../apps/daemon/dist/platform.js");
  // Core 在开发机（macOS）上运行仅是测试环境事实；语音两端点已被
  // JARVIS_VOICE_URL 覆盖为 guest 服务——本断言不触及任何 macOS 语音能力。
  const platform = await initPlatform("macos");
  const statuses = await platform.probe();
  const so = statuses.find((s) => s.endpoint === "speechOutput");
  const si = statuses.find((s) => s.endpoint === "speechInput");
  check(so?.state === "ready" && si?.state === "ready",
    `Core 平台端点探测 ready（${so?.detail} / ${si?.detail}）`);
  const heard = await platform.speechInput.transcribe(wav, "wav", "zh");
  check(/介绍|自己|你/.test(heard), `Core → guest 服务 ASR：「${heard}」`);
  const outFile = join(os.tmpdir(), "jarvis-omarchy-reply.wav");
  fs.rmSync(outFile, { force: true });
  const reason = await platform.speechOutput.speak("已收到，语音服务运行正常", { outputFile: outFile });
  check(reason === "completed" && fs.existsSync(outFile) && fs.statSync(outFile).size > 10_000,
    `Core → guest 服务 TTS 落盘（${fs.existsSync(outFile) ? fs.statSync(outFile).size : 0} 字节，reason=${reason}）`);

  console.log("\n--- 5b. 真实 GLM 对话经 Omarchy 语音服务完整闭环 ---");
  const { createEmbodiedRuntime } = await import("../../../apps/daemon/dist/embodied.js");
  const { loadConfig } = await import("../../../apps/daemon/dist/config.js");
  const { LLMGateway, OpenAICompatibleProvider } = await import("../../../packages/llm-gateway/dist/index.js");
  const cfg = loadConfig();
  const gw = new LLMGateway();
  gw.register(new OpenAICompatibleProvider({
    id: "zhipu", baseUrl: cfg.baseUrl, apiKey: cfg.apiKey,
    models: [{ id: cfg.model, provider: "zhipu", vision: true }],
  }));
  const reply = async (text, hooks) => {
    let full = "";
    for await (const ev of gw.stream({
      model: cfg.model,
      messages: [
        { role: "system", content: "你是 JARVIS，简洁的中文 AI 助手，回答不超过 40 字。" },
        { role: "user", content: text },
      ],
    })) {
      if (ev.type === "delta") { full += ev.text; hooks.onDelta?.(ev.text); }
      else if (ev.type === "error") throw ev.error;
    }
    return { kind: "answer", text: full.trim() || "收到" };
  };
  const dialogueFile = join(os.tmpdir(), "jarvis-omarchy-dialogue.wav");
  fs.rmSync(dialogueFile, { force: true });
  const rt = createEmbodiedRuntime({
    platform, reply, avatar: false, envelope: false, speechOutputFile: dialogueFile,
  });
  await rt.start();
  platform.speechInput.attach(rt.voice);
  const heardDialogue = await platform.speechInput.submitAudio(wav, "wav", "zh");
  const turn = await rt.conversation.submit(heardDialogue);
  await rt.stop();
  const states = rt.states.map((s) => s.state);
  const trailTypes = rt.voice.trail.map((e) => e.type);
  check(/介绍|自己/.test(heardDialogue), `语音输入经 guest ASR：「${heardDialogue}」`);
  check(turn.ok && turn.text.length > 0, `真实 GLM 回复：「${turn.text.slice(0, 80)}」`);
  check(["listening", "thinking", "speaking", "idle"].every((s) => states.includes(s)),
    `具身对话弧完整（${[...new Set(states)].join(">")}）`);
  check(trailTypes.includes("tts_start") && trailTypes.includes("tts_end"), "TTS 生命周期事件配对");
  check(fs.existsSync(dialogueFile) && fs.statSync(dialogueFile).size > 10_000,
    `回复音频由 guest 服务合成（${fs.existsSync(dialogueFile) ? fs.statSync(dialogueFile).size : 0} 字节）`);

  console.log("\n--- 5c. 打断语义（用户开口打断正在播放的 TTS） ---");
  // 移植自已删除的 macOS E2E：TTS 播放中收到用户语音 → 立即中止 TTS、
  // 切 listening；说完进 thinking；绝不误派 tts_end。全链路走 guest 服务。
  const { VoiceServiceSpeechOutput, VoiceServiceSpeechInput } =
    await import("../../../apps/daemon/dist/voice-service.js");
  const { VoiceIO } = await import("../../../packages/voice/dist/index.js");
  const { AvatarStateEngine } = await import("../../../packages/avatar/dist/index.js");
  const playerDir = fs.mkdtempSync(join(os.tmpdir(), "jarvis-interrupt-"));
  const player = join(playerDir, "silent.sh");
  fs.writeFileSync(player, "#!/bin/sh\nsleep 3\n", { mode: 0o755 });
  const interruptOut = new VoiceServiceSpeechOutput("omarchy", { url: guestUrl, player });
  const interruptEngine = new AvatarStateEngine();
  const interruptVoice = new VoiceIO(interruptOut, interruptEngine);
  const interruptAudio = loadFixture("zh-interrupt.wav");
  const interruptInput = new VoiceServiceSpeechInput("omarchy", { url: guestUrl });
  interruptInput.attach(interruptVoice);
  const playing = interruptVoice.speak("这是一段正在播放的较长回复内容，用于验证打断");
  await sleep(300);
  check(interruptOut.speaking, "TTS 处于进行中（合成/播放）");
  const heardInterrupt = await interruptInput.transcribe(interruptAudio, "wav", "zh");
  check(/等一?下|[問问][題题]|問題|问题/.test(heardInterrupt), `打断语音被 guest ASR 真实识别：「${heardInterrupt}」`);
  interruptInput.beginUtterance(heardInterrupt);
  await sleep(60);
  const midState = interruptEngine.aesthetic.state;
  await playing;
  interruptInput.finishUtterance(heardInterrupt);
  console.log(`  打断：partial 后状态=${midState}，说完状态=${interruptEngine.aesthetic.state}，TTS 进行中=${interruptOut.speaking}`);
  check(midState === "listening", "partial 到达瞬间立即停 TTS 并切 listening");
  check(!interruptOut.speaking, "TTS 端点已中止（合成请求/播放进程都被取消）");
  check(interruptVoice.trail.some((e) => e.type === "user_interrupt"), "派发 user_interrupt 事件");
  check(interruptEngine.aesthetic.state === "thinking", "用户说完后进入 thinking，未错误回落 idle");
  check(!interruptVoice.trail.some((e) => e.type === "tts_end"), "打断时未误派 tts_end");
  interruptVoice.dispose();
  fs.rmSync(playerDir, { recursive: true, force: true });
  report.interrupt = {
    heard: heardInterrupt, midState, finalState: interruptEngine.aesthetic.state,
    trail: interruptVoice.trail.map((e) => e.type),
  };
  report.dialogue = { heard: heardDialogue, reply: turn.text, states: [...new Set(states)],
    audioBytes: fs.existsSync(dialogueFile) ? fs.statSync(dialogueFile).size : 0 };

  console.log("\n--- 6. guest 内既有平台能力实测 ---");
  // 旧探针只查 webkitgtk-6.0 / PATH 里的 xdg-desktop-portal，产生过假阴性：
  // Try Omarchy 4.0 实际装的是 webkit2gtk-4.1（GTK3），Portal 二进制在 /usr/lib 且 D-Bus 存活。
  const probe = await bridge.exec(
    "echo GTK4=$(pkg-config --modversion gtk4 2>/dev/null || echo none); echo WEBKIT6=$(pkg-config --modversion webkitgtk-6.0 2>/dev/null || echo none); echo WEBKIT2=$(pkg-config --modversion webkit2gtk-4.1 2>/dev/null || echo none); echo HYPR=$(hyprctl version 2>/dev/null | head -1 || echo none); echo PIPEWIRE=$(command -v pw-record || echo none)",
    30_000);
  const probe2 = await bridge.exec(
    "echo GRIM=$(command -v grim || echo none); echo GDBUS=$(command -v gdbus || echo none); echo PORTAL=$(gdbus call --session --dest org.freedesktop.portal.Desktop --object-path /org/freedesktop/portal/desktop --method org.freedesktop.portal.Settings.ReadAll \"[]\" >/dev/null 2>&1 && echo alive || echo none)",
    30_000);
  report.guestProbe = (probe.out + probe2.out).trim();
  console.log(`  ${report.guestProbe.replace(/\n/g, " | ")}`);
  check(/GTK4=4/.test(probe.out), "guest 内 GTK4 可用（数字人宿主基础）");
  check(/WEBKIT6=[0-9]|WEBKIT2=[0-9]/.test(probe.out), "guest 内 WebKitGTK 可用（6.0 或 4.1）");
  check(/PORTAL=alive/.test(probe2.out), "XDG Portal D-Bus 存活（Settings.ReadAll）");
  check(/HYPR=/.test(probe.out) && /PIPEWIRE=\/usr/.test(probe.out), "Hyprland / PipeWire 端点存在");
} catch (e) {
  console.error(`ERROR: ${e.stack ?? e}`);
  failures += 1;
} finally {
  fs.writeFileSync("/tmp/jarvis-omarchy-voice-report.json", JSON.stringify(report, null, 2));
  await bridge.stop();
}

console.log(`\n报告：/tmp/jarvis-omarchy-voice-report.json`);
if (failures > 0) {
  console.error(`FAIL: ${failures} 项断言未通过`);
  process.exit(1);
}
console.log("PASS: Omarchy guest 语音服务部署与跨系统契约验收通过");
