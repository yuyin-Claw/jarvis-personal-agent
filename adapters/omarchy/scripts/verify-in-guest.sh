#!/bin/sh
# Try Omarchy guest 内一键验收（ADR-007 / ADR-005）
# 在 VM 终端执行：sh /path/to/verify-in-guest.sh
# 结果同时写入 9p 共享目录 ~/Omarchy/jarvis-verify-report.json（若已挂载）
set -u
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
REPORT="$HOME/Omarchy/jarvis-verify-report.json"

echo "=== Try Omarchy 平台依赖盘点 ==="
for cmd in python3 hyprctl grim gdbus pw-record espeak-ng notify-send node; do
  if command -v "$cmd" >/dev/null 2>&1; then
    printf '  %-12s OK   %s\n' "$cmd" "$(command -v "$cmd")"
  else
    printf '  %-12s MISS\n' "$cmd"
  fi
done

echo "=== GTK4 / WebKitGTK ==="
python3 - <<'PY' 2>&1 || true
import gi
gi.require_version("Gtk", "4.0")
from gi.repository import Gtk
print("  Gtk 4.0 OK")
for mod, v in (("WebKit", "6.0"), ("WebKit2", "4.1")):
    try:
        gi.require_version(mod, v)
        __import__("gi.repository", fromlist=[mod])
        print(f"  {mod} {v} OK")
        break
    except Exception as e:
        print(f"  {mod} {v} MISS: {e}")
PY

echo "=== Platform Adapter 探测 ==="
if command -v node >/dev/null 2>&1 && [ -f "$SCRIPT_DIR/../dist/index.js" ]; then
  node "$SCRIPT_DIR/probe.mjs" | tee /tmp/jarvis-platform-probe.txt
  if [ -d "$(dirname "$REPORT")" ]; then
    cp /tmp/jarvis-platform-probe.txt "$REPORT"
    echo "报告已写入 $REPORT"
  fi
else
  echo "SKIP: 缺 node 或未构建 dist（guest 内可先 pnpm build）"
fi
