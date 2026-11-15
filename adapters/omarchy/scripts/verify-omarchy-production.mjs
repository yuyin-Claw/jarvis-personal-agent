#!/usr/bin/env node
/**
 * JARVIS 语音子系统生产形态验收（Omarchy guest，ADR-009）
 *
 * 与验收模式的区别——全部按生产形态运行：
 *  1. 语音服务由 systemd --user 常驻（unit 已 install.sh 部署，崩溃自动重启）
 *  2. 数字人窗口为右下角浮动小窗（Try Omarchy Lua windowrule，非 fullscreen/opaque）
 *  3. 跨系统访问走 guest 反向代理（真机部署时换 LAN 地址即可）
 *
 * 断言：systemd 接管 / kill -9 自愈 / 服务健康 / Core 经端点调用 /
 *       浮动窗口六状态上屏（区域截图 + 像素断言）。
 *
 * 用法：node verify-omarchy-production.mjs
 */
import fs from "node:fs";
import os from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createGuestBridge } from "./guest-bridge.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const GUEST_SHARE = "/home/yuyin/Omarchy/jarvis-voice-service";
const HOST_SHARE = join(os.homedir(), "Omarchy");
const GUEST_SERVICE_PORT = 8787;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let failures = 0;
const check = (ok, label) => {
  console.log(`${ok ? "PASS" : "FAIL"}: ${label}`);
  if (!ok) failures += 1;
};

const bridge = await createGuestBridge({
  proxyTarget: `http://127.0.0.1:${GUEST_SERVICE_PORT}`,
  proxyScript: join(GUEST_SHARE, "proxy-request.mjs"),
});
const guestUrl = bridge.proxyUrl;
const report = { guestUrl, checks: [] };

/** 浮动窗口期望位置（逻辑坐标，由 jarvis.lua 的 move 表达式决定） */
async function avatarGeometry() {
  const r = await bridge.exec(
    `hyprctl clients -j | python3 -c 'import sys,json; c=[x for x in json.load(sys.stdin) if "JARVIS" in str(x.get("title",""))][0]; print(c["at"][0], c["at"][1], c["size"][0], c["size"][1])'`,
    30_000);
  const [x, y, w, h] = r.out.trim().split(/\s+/).map(Number);
  return { x, y, w, h };
}

try {
  console.log("--- 1. systemd 生产常驻（语音服务 + 数字人窗口） ---");
  const unit = await bridge.exec(
    "systemctl --user is-enabled jarvis-voice; systemctl --user is-active jarvis-voice; systemctl --user show -p MainPID,NRestarts --value jarvis-voice",
    30_000);
  const [enabled, active, pid, restarts] = unit.out.trim().split(/\s+/);
  check(enabled === "enabled", "语音服务已设开机自启（is-enabled）");
  check(active === "active", `语音服务 active（MainPID=${pid}）`);
  report.unit = { enabled, active, pid, restarts };

  const unitAvatar = await bridge.exec(
    "systemctl --user is-enabled jarvis-avatar; systemctl --user is-active jarvis-avatar; systemctl --user show -p MainPID --value jarvis-avatar",
    30_000);
  const [avatarEnabled, avatarActive, avatarPid] = unitAvatar.out.trim().split(/\s+/);
  check(avatarEnabled === "enabled", "数字人窗口 unit 已设随图形会话自启（ADR-010 开机自启动）");
  check(avatarActive === "active", `数字人窗口 active（MainPID=${avatarPid}，由 systemd 拉起非手动）`);
  report.unitAvatar = { enabled: avatarEnabled, active: avatarActive, pid: avatarPid };

  console.log("\n--- 2. 崩溃自愈（kill -9 → systemd 拉起） ---");
  await bridge.exec(`kill -9 ${pid}`, 30_000);
  await sleep(4_000);
  const after = await bridge.exec(
    "systemctl --user is-active jarvis-voice; systemctl --user show -p MainPID,NRestarts --value jarvis-voice", 30_000);
  const [active2, pid2, restarts2] = after.out.trim().split(/\s+/);
  check(active2 === "active" && pid2 !== pid, `kill -9 后自动拉起（PID ${pid} → ${pid2}，NRestarts=${restarts2}）`);
  report.selfHeal = { oldPid: pid, newPid: pid2, restarts: restarts2 };

  console.log("\n--- 3. 服务健康（经生产传输通道） ---");
  let health = null;
  const deadline = Date.now() + 20_000;
  while (Date.now() < deadline && !health) {
    try { const r = await fetch(`${guestUrl}/health`); if (r.ok) health = await r.json(); } catch { /* retry */ }
    if (!health) await sleep(500);
  }
  check(!!health && health.ok, "宿主可访问 guest 服务（systemd 常驻端口）");
  if (!health) throw new Error("health 不可达");
  report.health = health;
  check(health.platform === "omarchy" && health.contract === "1.0", `契约一致（${health.platform} v${health.contract}）`);
  check(health.asr.ready && health.tts.ready, `ASR/TTS ready（${health.asr.engine} / ${health.tts.engine}）`);

  console.log("\n--- 4. Core 经 Platform Adapter 走生产服务 ---");
  process.env.JARVIS_VOICE_URL = guestUrl;
  const { initPlatform } = await import("../../../apps/daemon/dist/platform.js");
  const platform = await initPlatform("macos");
  const statuses = await platform.probe();
  const so = statuses.find((s) => s.endpoint === "speechOutput");
  const si = statuses.find((s) => s.endpoint === "speechInput");
  check(so?.state === "ready" && si?.state === "ready", "Core 语音端点 ready（指向生产服务）");
  const fixture = fs.readFileSync(resolve(HERE, "../../../apps/voice-service/fixtures/zh-user-utterance.wav"));
  const heard = await platform.speechInput.transcribe(fixture, "wav", "zh");
  check(/介绍|自己|你/.test(heard), `生产服务 ASR：「${heard}」`);
  const outFile = join(os.tmpdir(), "jarvis-prod-tts.wav");
  fs.rmSync(outFile, { force: true });
  const reason = await platform.speechOutput.speak("语音子系统生产形态验证", { outputFile: outFile });
  check(reason === "completed" && fs.statSync(outFile).size > 10_000,
    `生产服务 TTS（${fs.statSync(outFile).size} 字节）`);
  report.core = { heard, ttsBytes: fs.statSync(outFile).size };

  console.log("\n--- 5. 数字人浮动窗口六状态（生产形态，systemd 拉起） ---");
  // 窗口已由 jarvis-avatar.service 常驻；清掉旧 socket 遗留状态即可

  const { x, y, w, h } = await avatarGeometry();
  check(w === 420 && h === 480, `窗口生产尺寸 420x480（实际 ${w}x${h}）`);
  // 逻辑屏 1728x1117：右下角 ≈ (1268, 597)
  check(x > 1000 && y > 300, `窗口位于右下角（at ${x},${y}）`);

  const STATES = ["idle", "listening", "thinking", "speaking", "working", "responding"];
  const RULES = {
    idle: (r, g, b) => b > r + 8,
    listening: (r, g, b) => g > b && b > r && (g - b) < 90,
    thinking: (r, g, b) => b > r && r > g && (r - g) > 6,
    speaking: (r, g, b) => b >= g && g > r,
    working: (r, g, b) => r > g && g > b && (r - b) > 30,
    // 浮动小窗（420x480）+ 透明合成会把背景像素混进平均色：次序不变、幅度被稀释。
    // 全屏验收模式（assert-render.py）用 >20；此处按窗口形态放宽到 >10，只认次序+下限。
    responding: (r, g, b) => g > b && b > r && (g - b) > 10,
  };
  const shotsDir = join(HOST_SHARE, "jarvis-prod-shots");
  fs.mkdirSync(shotsDir, { recursive: true });
  const rows = [];
  for (const state of STATES) {
    await bridge.exec(
      `python3 -c '
import socket, json
s = socket.socket(socket.AF_UNIX); s.connect("/run/user/1000/jarvis-avatar.sock")
s.sendall((json.dumps({"type":"frame","state":"${state}","intensity":0.8,"caption":"${state}"})+"\\n").encode())
s.close()'`, 30_000);
    await sleep(1_400);
    const png = `${shotsDir}/${state}.png`;
    fs.rmSync(png, { force: true });
    await bridge.exec(`grim -g '${x},${y} ${w}x${h}' /home/yuyin/Omarchy/jarvis-prod-shots/${state}.png`, 30_000);
    if (!fs.existsSync(png)) { rows.push({ state, ok: false, why: "无截图" }); continue; }
    // 宿主侧像素断言（发光像素 + 状态主色）
    const { execFileSync } = await import("node:child_process");
    const stat = JSON.parse(execFileSync("python3", ["-c", `
from PIL import Image
import json
im = Image.open("${png}").convert("RGBA")
px = list(im.getdata())
lit = [p for p in px if p[3] > 20 and max(p[:3]) > 55]
avg = tuple(round(sum(p[i] for p in lit)/max(1,len(lit)),1) for i in range(3)) if lit else (0,0,0)
print(json.dumps({"lit": len(lit), "avg": avg}))`], { encoding: "utf8" }));
    const [r, g, b] = stat.avg;
    const ok = stat.lit > 500 && RULES[state](r, g, b);
    rows.push({ state, ok, lit: stat.lit, avg: stat.avg });
    console.log(`  ${state.padEnd(11)} lit=${String(stat.lit).padEnd(6)} avg=${JSON.stringify(stat.avg)} ${ok ? "PASS" : "FAIL"}`);
  }
  report.states = rows;
  check(rows.every((r) => r.ok), "六状态浮动窗口全部上屏且主色正确");
  fs.writeFileSync(join(shotsDir, "report.json"), JSON.stringify(report, null, 2));

  await bridge.exec("pgrep -f 'jarvis-avatar-host.py' | xargs -r kill 2>/dev/null; echo ok", 30_000);
} catch (e) {
  console.error(`ERROR: ${e.stack ?? e}`);
  failures += 1;
} finally {
  fs.writeFileSync("/tmp/jarvis-omarchy-production-report.json", JSON.stringify(report, null, 2));
  await bridge.stop();
}

console.log(`\n报告：/tmp/jarvis-omarchy-production-report.json`);
if (failures > 0) {
  console.error(`FAIL: ${failures} 项断言未通过`);
  process.exit(1);
}
console.log("PASS: Omarchy 生产形态（systemd 常驻 + 浮动窗口）验收通过");
