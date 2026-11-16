#!/bin/sh
# 将宿主编译的本地记忆 Provider 更新到 Omarchy Core 本地目录。
set -eu
CORE="$HOME/.local/share/jarvis/core"
mkdir -p "$CORE/apps/daemon/dist" "$CORE/packages/memory/dist"
cp /mnt/mac/cli.js /mnt/mac/daemon.js /mnt/mac/memory-local.js "$CORE/apps/daemon/dist/"
cp -r /mnt/mac/memory-dist/. "$CORE/packages/memory/dist/"
systemctl --user restart jarvis-core
systemctl --user is-active jarvis-core
curl -sf http://127.0.0.1:11434/api/version
cd "$CORE"
JARVIS_ENV_FILE=/mnt/mac/jarvis-core.env node apps/daemon/dist/cli.js memory list
