#!/bin/sh
# JARVIS 系统栈生产部署（Omarchy guest / 真机）
# 一次安装 = 开机自启的完整 JARVIS：语音服务 + 数字人窗口 + Core daemon（ADR-010）
# 用法：在 Omarchy 内执行 sh install.sh
# 前置：
#   - 仓库 apps/voice-service 已同步到 ~/Omarchy/jarvis-voice-service（9p 或 git）
#   - Core 已部署（宿主执行 adapters/omarchy/scripts/deploy-core.mjs）
set -eu

SRC="${JARVIS_VOICE_SRC:-$HOME/Omarchy/jarvis-voice-service}"
CONF="$HOME/.config"

# 1. systemd --user units（语音服务 + 数字人窗口 + Core daemon）
mkdir -p "$CONF/systemd/user"
CORE_UNIT=""
[ -d "$HOME/.local/share/jarvis/core" ] && CORE_UNIT="jarvis-core.service"
for unit in jarvis-voice.service jarvis-avatar.service $CORE_UNIT; do
  if [ -f "$SRC/deploy/$unit" ]; then
    cp "$SRC/deploy/$unit" "$CONF/systemd/user/$unit"
  else
    ROOT="${JARVIS_REPO_ROOT:-}"
    [ -n "$ROOT" ] && cp "$ROOT/apps/voice-service/deploy/$unit" "$CONF/systemd/user/"
  fi
done
systemctl --user daemon-reload

# 2. 停掉历史 nohup 进程（验收期遗留），交给 systemd 接管
pgrep -f '^node src/server.mjs --backend omarchy' | xargs -r kill 2>/dev/null || true
pgrep -f 'jarvis-avatar-host.py' | xargs -r kill 2>/dev/null || true
sleep 1

# 3. 启用并启动（崩溃自动重启；随会话/开机自启）
#    jarvis-voice  → default.target（无图形也常驻）
#    jarvis-avatar → graphical-session.target（图形会话即拉起）
#    jarvis-core   → default.target（Requires jarvis-voice，语音就绪后拉起）
systemctl --user enable --now jarvis-voice
systemctl --user enable --now jarvis-avatar
[ -n "$CORE_UNIT" ] && systemctl --user enable --now jarvis-core

# 4. Hyprland 窗口规则（Try Omarchy Lua 配置体系；幂等：按 require 行判重）
mkdir -p "$CONF/hypr"
if [ -f "$SRC/deploy/jarvis.lua" ]; then
  cp "$SRC/deploy/jarvis.lua" "$CONF/hypr/jarvis.lua"
  if ! grep -q 'hypr.jarvis' "$CONF/hypr/hyprland.lua" 2>/dev/null; then
    printf '\n-- JARVIS 数字人窗口规则（deploy 脚本追加）\nrequire("hypr.jarvis")\n' \
      >> "$CONF/hypr/hyprland.lua"
  fi
fi
command -v hyprctl >/dev/null 2>&1 && hyprctl reload || true

# 5. 自检：各 unit active + 服务健康
sleep 2
systemctl --user --no-pager is-active jarvis-voice
systemctl --user --no-pager is-active jarvis-avatar
[ -n "$CORE_UNIT" ] && systemctl --user --no-pager is-active jarvis-core
if curl -sf http://127.0.0.1:8787/health | head -c 200; then
  echo ""
else
  echo "FAIL: 语音服务健康检查未过，查 journalctl --user -u jarvis-voice" >&2
  exit 1
fi
echo "OK: JARVIS 系统栈已常驻（jarvis-voice + jarvis-avatar${CORE_UNIT:+ + jarvis-core}，开机自启）"
