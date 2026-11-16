#!/bin/sh
# Omarchy ARM64 用户级 Ollama 安装：零 sudo、guest localhost、本地模型持久化。
set -eu
LOG="${JARVIS_OLLAMA_INSTALL_LOG:-/tmp/ollama-install.log}"
REPORT="${JARVIS_OLLAMA_INSTALL_REPORT:-/tmp/ollama-install-report.txt}"
: > "$LOG"
exec > "$LOG" 2>&1
trap 'rc=$?; printf "rc=%s\n" "$rc" > "$REPORT"' EXIT

[ "$(uname -m)" = "aarch64" ]
FREE_KB=$(df -k "$HOME" | awk 'NR==2 {print $4}')
[ "${FREE_KB:-0}" -gt 8000000 ] || { echo "磁盘可用空间不足 8GB"; exit 1; }
command -v tar >/dev/null
command -v zstd >/dev/null

PREFIX="$HOME/.local"
MODELS="$HOME/.local/share/ollama/models"
mkdir -p "$PREFIX/bin" "$PREFIX/lib" "$MODELS" "$HOME/.config/systemd/user"

if [ ! -x "$PREFIX/bin/ollama" ]; then
  curl -fL --retry 3 --max-time 600 \
    https://ollama.com/download/ollama-linux-arm64.tar.zst \
    -o /tmp/ollama-linux-arm64.tar.zst
  tar --zstd -xf /tmp/ollama-linux-arm64.tar.zst -C "$PREFIX"
fi
chmod +x "$PREFIX/bin/ollama"

cat > "$HOME/.config/systemd/user/ollama.service" <<EOF
[Unit]
Description=Ollama（JARVIS guest 本地向量与蒸馏）
After=network-online.target

[Service]
Type=simple
WorkingDirectory=%h/.local
Environment=HOME=%h
Environment=PATH=%h/.local/bin:/usr/local/bin:/usr/bin
Environment=LD_LIBRARY_PATH=%h/.local/lib/ollama
Environment=OLLAMA_HOST=127.0.0.1:11434
Environment=OLLAMA_MODELS=%h/.local/share/ollama/models
ExecStart=%h/.local/bin/ollama serve
Restart=on-failure
RestartSec=3

[Install]
WantedBy=default.target
EOF

systemctl --user daemon-reload
systemctl --user enable --now ollama
curl -sf --retry 30 --retry-connrefused --retry-delay 1 \
  http://127.0.0.1:11434/api/version

export PATH="$PREFIX/bin:$PATH"
export LD_LIBRARY_PATH="$PREFIX/lib/ollama${LD_LIBRARY_PATH:+:$LD_LIBRARY_PATH}"
export OLLAMA_HOST=127.0.0.1:11434
export OLLAMA_MODELS="$MODELS"

ollama pull qwen3-embedding:0.6b
ollama pull qwen3:4b
ollama list
