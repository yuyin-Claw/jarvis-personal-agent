#!/usr/bin/env node
/**
 * 把 JARVIS Core 部署进 Omarchy guest（宿主编译 → guest 装运行依赖）
 *
 * 1. 宿主：pnpm build（TS 构建出各包 dist）+ 打包源码与 dist（排除 node_modules）
 * 2. guest：解包到 ~/Omarchy/jarvis-core
 * 3. guest：npm install 装根 package.json 运行依赖（better-sqlite3 现场编译
 *    aarch64 Linux 原生模块）。仓库是 pnpm workspace，npm 不解析 workspace:*
 *    协议——所以不在 guest 内 tsc（@jarvis/tsconfig 无法 link），
 *    而是宿主编好 dist、guest 只装运行依赖 + 手动 symlink @jarvis/*。
 * 4. guest：为 @jarvis/* 建 symlink（packages/*、adapters/* → node_modules/@jarvis/）
 * 5. 冒烟：node apps/daemon/dist/cli.js status
 *
 * 用法：node deploy-core.mjs（宿主执行）
 */
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createGuestBridge } from "./guest-bridge.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(HERE, "../../..");
const SHARE = join(os.homedir(), "Omarchy");
// 部署到 guest 本地磁盘（symlink 在 9p 上解析异常，且 9p 慢）；
// tar 经 9p 共享目录中转（/mnt/mac ↔ 宿主 ~/Omarchy）
const GUEST_DIR = "/home/yuyin/.local/share/jarvis/core";

console.log("--- 1. 宿主构建 + 打包（源码 + dist，排除 node_modules） ---");
execFileSync("pnpm", ["build"], { cwd: REPO, stdio: "inherit" });
const tar = join(SHARE, "jarvis-core-src.tar");
execFileSync("tar", [
  "-cf", tar,
  "--exclude", "./node_modules",
  "--exclude", "./**/node_modules",
  "--exclude", "./.git",
  "--exclude", "./.workbuddy",
  "-C", REPO, ".",
]);
console.log(`  ${tar}（${(fs.statSync(tar).size / 1024 / 1024).toFixed(1)} MB）`);

const bridge = await createGuestBridge({
  proxyTarget: "http://127.0.0.1:8787",
  proxyScript: "/home/yuyin/Omarchy/jarvis-voice-service/proxy-request.mjs",
});

try {
  console.log("\n--- 2. guest 解包（清旧重建） ---");
  let r = await bridge.exec(`rm -rf ${GUEST_DIR} && mkdir -p ${GUEST_DIR} && tar -xf /mnt/mac/jarvis-core-src.tar -C ${GUEST_DIR} && ls ${GUEST_DIR}/apps/daemon/dist/cli.js && echo UNPACK_OK`, 120_000);
  if (!/UNPACK_OK/.test(r.out)) throw new Error(`解包失败：${r.out.slice(-200)}`);
  console.log("  UNPACK_OK");

  console.log("\n--- 3. guest npm install（运行依赖 + better-sqlite3 aarch64 编译） ---");
  r = await bridge.exec(
    `cd ${GUEST_DIR} && export PATH="$HOME/.local/share/mise/shims:$PATH" && ` +
    `npm install --omit=dev --no-audit --no-fund --install-scripts=false 2>&1 | tail -2; ` +
    `cd ${GUEST_DIR} && npm rebuild better-sqlite3 2>&1 | tail -1; ` +
    `node -e "require('better-sqlite3');console.log('SQLITE_NATIVE_OK')"`,
    900_000);
  console.log(`  ${r.out.trim().slice(-150)}`);
  if (!/SQLITE_NATIVE_OK/.test(r.out)) throw new Error("better-sqlite3 不可用");

  console.log("\n--- 4. 链接 @jarvis/* workspace 包（脚本文件方式） ---");
  // guest 代理对含 for/引号的长命令有转义损耗；改为落一个 sh 文件再执行
  const linkSh = `#!/bin/sh
set -e
cd ${GUEST_DIR}
mkdir -p node_modules/@jarvis
for p in avatar context-engine embodied harness-runtime llm-gateway memory orchestrator runtime task-manager tsconfig voice; do
  ln -sfn ../../packages/$p node_modules/@jarvis/$p
done
ln -sfn ../../adapters/platform node_modules/@jarvis/platform
ln -sfn ../../adapters/omarchy node_modules/@jarvis/adapter-omarchy
ln -sfn ../../adapters/macos node_modules/@jarvis/adapter-macos
ln -sfn ../../apps/daemon node_modules/@jarvis/daemon
`;
  fs.writeFileSync(join(SHARE, "jarvis-link.sh"), linkSh);
  r = await bridge.exec(`sh /mnt/mac/jarvis-link.sh && ls ${GUEST_DIR}/node_modules/@jarvis/ | wc -l`, 60_000);
  console.log(`  links: ${r.out.trim().slice(-60)}`);
  r = await bridge.exec(
    `cd ${GUEST_DIR} && node -e "import('./apps/daemon/dist/config.js').then(()=>console.log('LINK_OK')).catch(e=>{console.error('IMPORT',e.message);process.exit(1)})"`,
    60_000);
  console.log(`  ${r.out.trim().slice(-150)}`);
  if (!/LINK_OK/.test(r.out)) throw new Error(`链接失败：${r.out.slice(-300)}`);

  console.log("\n--- 5. 冒烟：cli status ---");
  r = await bridge.exec(
    `cd ${GUEST_DIR} && JARVIS_ENV_FILE=/mnt/mac/jarvis-core.env node apps/daemon/dist/cli.js status 2>&1 | head -6`,
    60_000);
  console.log(`  ${r.out.trim().slice(-300)}`);
  if (!/JARVIS 状态/.test(r.out)) throw new Error(`cli 冒烟失败：${r.out.slice(-250)}`);

  console.log("\nPASS: Core 已部署进 guest（宿主编译 + guest 运行依赖），冒烟通过");
} catch (e) {
  console.error(`ERROR: ${e.message}`);
  process.exitCode = 1;
} finally {
  await bridge.stop();
}
