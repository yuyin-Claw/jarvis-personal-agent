#!/bin/sh
# 0.2-③ 语音输出链路验收（macOS）：say 只写 AIFF 文件，不播放声音
set -eu
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
REPO="$(cd "$ROOT/../.." && pwd)"

if [ "$(uname -s)" != "Darwin" ]; then
  echo "SKIP: say 合成验收仅支持 macOS"
  exit 0
fi
(cd "$REPO" && pnpm build >/dev/null)
node "$ROOT/scripts/verify-tts.mjs"

# 输入端：编译 Swift 识别助手并做权限探测（未授权时降级路径也算验收通过）
swiftc -O "$ROOT/native/speech-input.swift" -o "$ROOT/native/jarvis-speech"
node "$ROOT/scripts/verify-speech-input.mjs"
