#!/bin/sh
# 0.2-② 全息渲染端到端验收（macOS 专用）
# 用法：apps/avatar/scripts/verify-render.sh
# 流程：编译宿主 → 启动独立窗口 → 六状态驱动 + 窗口截图 → 像素断言
set -eu

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
REPO="$(cd "$ROOT/../.." && pwd)"
BASE="$HOME/.local/share/jarvis"

if [ "$(uname -s)" != "Darwin" ]; then
  echo "SKIP: 全息窗口验收仅支持 macOS"
  exit 0
fi

mkdir -p "$BASE"
SHOTS="$(mktemp -d /tmp/jarvis-avatar-verify.XXXXXX)"
echo "shots: $SHOTS"

# 保证用最新源码的产物
swiftc -O -framework Cocoa -framework WebKit "$ROOT/avatar-host.swift" -o "$ROOT/jarvis-avatar"
if command -v pnpm >/dev/null 2>&1; then
  (cd "$REPO" && pnpm --filter @jarvis/avatar build >/dev/null)
fi
if [ ! -f "$REPO/packages/avatar/dist/index.js" ]; then
  echo "FAIL: 缺少 packages/avatar/dist/index.js，请先执行 pnpm build"
  exit 1
fi

# 关闭上一轮宿主（精确进程名，避免误杀）
for pid in $(pgrep -x jarvis-avatar 2>/dev/null || true); do
  kill "$pid" 2>/dev/null || true
done
sleep 0.5

"$ROOT/jarvis-avatar" "$ROOT/avatar.html" --x 80 --y 80 --width 420 --height 480 \
  > "$SHOTS/host.log" 2>&1 &
HOST_PID=$!
trap 'kill "$HOST_PID" 2>/dev/null || true' EXIT INT TERM
sleep 2

if ! kill -0 "$HOST_PID" 2>/dev/null; then
  echo "FAIL: 宿主进程启动失败"
  cat "$SHOTS/host.log"
  exit 1
fi

node "$ROOT/scripts/verify-render.mjs" "$SHOTS" || { cat "$SHOTS/host.log"; exit 1; }
python3 "$ROOT/scripts/assert-render.py" "$SHOTS" || { cat "$SHOTS/host.log"; exit 1; }
echo "PASS: 端到端渲染验收通过（截图留存于 ${SHOTS}）"
