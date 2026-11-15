#!/bin/sh
# 0.2-④⑤ 具身对话端到端验收（macOS 专用）
# 流程：编译宿主 → 生产 composition root 驱动对话/主动交流 → 窗口截图 → 像素断言
# 无需联网、无需人工看图；TTS 以 -o 静默合成到 AIFF。
set -eu

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
REPO="$(cd "$ROOT/../.." && pwd)"

if [ "$(uname -s)" != "Darwin" ]; then
  echo "SKIP: 具身窗口验收仅支持 macOS"
  exit 0
fi

(cd "$REPO" && pnpm build >/dev/null)
swiftc -O -framework Cocoa -framework WebKit \
  "$REPO/apps/avatar/avatar-host.swift" -o "$REPO/apps/avatar/jarvis-avatar"

# 精确关闭上一轮宿主，避免残留实例抢状态文件
for pid in $(pgrep -x jarvis-avatar 2>/dev/null || true); do
  kill "$pid" 2>/dev/null || true
done
sleep 0.5

SHOTS="$(mktemp -d /tmp/jarvis-embodied-verify.XXXXXX)"
echo "shots: ${SHOTS}"
node "$ROOT/scripts/verify-embodied.mjs" "$SHOTS" "$SHOTS/tts.aiff" || exit 1
python3 "$REPO/apps/avatar/scripts/assert-render.py" "$SHOTS" || exit 1
echo "PASS: 0.2-④⑤ 具身对话全链路验收通过（截图留存于 ${SHOTS}）"
