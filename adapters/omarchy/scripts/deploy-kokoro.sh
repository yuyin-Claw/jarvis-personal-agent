#!/bin/sh
set -eu
ROOT="$HOME/.local/share/jarvis"
# 395MB 模型常驻 guest 本地磁盘，不从 macOS 计算/播放。
if [ ! -f "$ROOT/kokoro-multi-lang-v1_0/model.onnx" ]; then
  cp -r /mnt/mac/kokoro-multi-lang-v1_0 "$ROOT/"
fi
cp -r /mnt/mac/voice-service/. "$ROOT/jarvis-voice-service/"
python3 /mnt/mac/smoke-kokoro.py
python3 - <<'PY'
import json
from pathlib import Path
r = json.loads(Path('/mnt/mac/kokoro-smoke-result.json').read_text())
if not r.get('ok'):
    raise SystemExit('Kokoro 样音验收失败，保持现有服务不切换')
PY
systemctl --user stop jarvis-live-acceptance 2>/dev/null || true
systemctl --user restart jarvis-voice
