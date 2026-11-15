#!/usr/bin/env node
/**
 * 宿主侧入口：部署自包含生产适配器包到 9p 共享目录 → 经 guest-bridge 在
 * Try Omarchy guest 内跑 verify-omarchy-avatar.mjs → 用 assert-render.py 做像素断言。
 *
 * 用法：node adapters/omarchy/scripts/verify-omarchy-avatar-host.mjs
 */
import fs from "node:fs";
import os from "node:os";
import { execFileSync } from "node:child_process";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createGuestBridge } from "./guest-bridge.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(HERE, "../../..");
const SHARE = join(os.homedir(), "Omarchy", "jarvis-omarchy-probe");
const GUEST_SHARE = "/home/yuyin/Omarchy/jarvis-omarchy-probe";

function copyDir(from, to) {
  fs.mkdirSync(to, { recursive: true });
  for (const e of fs.readdirSync(from, { withFileTypes: true })) {
    const src = join(from, e.name);
    const dst = join(to, e.name);
    if (e.isDirectory()) copyDir(src, dst);
    else fs.copyFileSync(src, dst);
  }
}

function deploy() {
  copyDir(join(REPO, "adapters/omarchy/dist"), join(SHARE, "adapter/dist"));
  copyDir(join(REPO, "adapters/platform/dist"), join(SHARE, "node_modules/@jarvis/platform/dist"));
  fs.mkdirSync(join(SHARE, "adapter/scripts"), { recursive: true });
  fs.mkdirSync(join(SHARE, "avatar"), { recursive: true });
  fs.mkdirSync(join(SHARE, "shots"), { recursive: true });
  for (const f of ["avatar-host.py", "verify-omarchy-avatar.mjs"]) {
    fs.copyFileSync(join(HERE, f), join(SHARE, "adapter/scripts", f));
  }
  fs.copyFileSync(join(REPO, "apps/avatar/avatar.html"), join(SHARE, "avatar/avatar.html"));
  fs.writeFileSync(join(SHARE, "node_modules/@jarvis/platform/package.json"),
    JSON.stringify({ name: "@jarvis/platform", version: "0.0.1", type: "module", main: "./dist/index.js" }, null, 2));
  fs.writeFileSync(join(SHARE, "adapter/package.json"),
    JSON.stringify({ name: "@jarvis/adapter-omarchy", version: "0.0.1", type: "module", main: "./dist/index.js" }, null, 2));
  fs.writeFileSync(join(SHARE, "run-avatar-e2e.sh"), `#!/bin/sh
cd ${GUEST_SHARE} || exit 1
OLD=$(ps -eo pid,args | grep '[j]arvis-avatar-host.py' | awk '{print $1}' | head -5)
[ -n "$OLD" ] && kill $OLD 2>/dev/null
rm -f /tmp/jarvis-avatar-e2e.sock /tmp/jarvis-avatar-e2e.log
rm -f shots/*.png shots/*.png.done shots/report.json
export JARVIS_ADAPTER_ENTRY="$PWD/adapter/dist/index.js"
export JARVIS_AVATAR_HTML="$PWD/avatar/avatar.html"
export JARVIS_HOST_SCRIPT="$PWD/adapter/scripts/avatar-host.py"
export JARVIS_SHOTS_DIR="$PWD/shots"
export JARVIS_HOST_LOG=/tmp/jarvis-avatar-e2e.log
export JARVIS_AVATAR_LOG=/tmp/jarvis-avatar-e2e.log
export JARVIS_AVATAR_FULLSCREEN=1
export JARVIS_AVATAR_OPAQUE=1
export PATH="$HOME/.local/espeak/usr/bin:$PATH"
export LD_LIBRARY_PATH="$HOME/.local/espeak/usr/lib:$LD_LIBRARY_PATH"
export ESPEAK_DATA_PATH="$HOME/.local/espeak/usr/share/espeak-ng-data"
node "$PWD/adapter/scripts/verify-omarchy-avatar.mjs" 2>&1
echo "NODE_RC=$?"
echo "=== HOST LOG ==="
cat /tmp/jarvis-avatar-e2e.log
`);
}

async function main() {
  deploy();
  console.log("=== 在 Try Omarchy guest 内跑生产 OmarchyPlatformAdapter 六状态 ===");
  const bridge = await createGuestBridge();
  let out = "";
  try {
    const r = await bridge.exec(`sh ${GUEST_SHARE}/run-avatar-e2e.sh`, 180_000);
    out = r.out;
    console.log(out.slice(-6000));
    if (r.rc !== 0 || /NODE_RC=[^0]/.test(out)) throw new Error("guest 侧六状态验收未通过");
  } finally {
    await bridge.stop();
  }

  console.log("=== 宿主侧像素断言（assert-render.py） ===");
  const assertScript = join(REPO, "apps/avatar/scripts/assert-render.py");
  const shots = join(SHARE, "shots");
  const pixel = execFileSync("python3", [assertScript, shots], { encoding: "utf8" });
  console.log(pixel);
  fs.writeFileSync("/tmp/jarvis-omarchy-avatar-report.json", JSON.stringify({
    guestOutput: out.slice(-8000), pixel, shots, at: new Date().toISOString(),
  }, null, 2));
  console.log("PASS: Omarchy guest 生产适配器六状态真实上屏验收通过");
}

await main();
