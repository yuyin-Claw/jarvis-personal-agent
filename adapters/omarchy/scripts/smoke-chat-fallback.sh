#!/bin/sh
# 强制主端点不可达，验证主聊天自动切换 Omarchy 本地模型并落调用统计。
set -eu
CORE="$HOME/.local/share/jarvis/core"
DB=/tmp/jarvis-chat-fallback-smoke.db
rm -f "$DB" "$DB-shm" "$DB-wal"
export JARVIS_DB_PATH="$DB"
export JARVIS_LLM_BASE_URL=http://127.0.0.1:1/v1
export JARVIS_LLM_API_KEY=test-only
export JARVIS_OLLAMA_BASE_URL=http://127.0.0.1:11434
export JARVIS_CHAT_FALLBACK=1
cd "$CORE"
node apps/daemon/dist/cli.js ask '只回答两个字：你好' > /mnt/mac/chat-fallback-output.txt 2>&1
node apps/daemon/dist/cli.js llm stats > /mnt/mac/chat-fallback-stats.txt 2>&1
