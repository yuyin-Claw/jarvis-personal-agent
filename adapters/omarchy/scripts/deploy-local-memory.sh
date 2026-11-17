#!/bin/sh
# 将宿主编译的本地记忆 Provider 更新到 Omarchy Core 本地目录。
set -eu
CORE="$HOME/.local/share/jarvis/core"
mkdir -p "$CORE/apps/daemon/dist" "$CORE/packages/memory/dist" "$CORE/packages/llm-gateway/dist"
# 同步完整编译目录，禁止挑选单文件（daemon 还依赖 preferences.js 等内部模块）。
cp -r /mnt/mac/daemon-dist/. "$CORE/apps/daemon/dist/"
cp -r /mnt/mac/memory-dist/. "$CORE/packages/memory/dist/"
cp -r /mnt/mac/llm-gateway-dist/. "$CORE/packages/llm-gateway/dist/"
systemctl --user restart jarvis-core
systemctl --user is-active jarvis-core
curl -sf http://127.0.0.1:11434/api/version
cd "$CORE"
JARVIS_ENV_FILE=/mnt/mac/jarvis-core.env node apps/daemon/dist/cli.js memory list
