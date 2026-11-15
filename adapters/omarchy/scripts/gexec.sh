#!/bin/sh
# JARVIS 持久通道执行器：固定端口 9222 + WAIT 模式，自动重试
# 用法：gexec.sh "命令" [超时秒]
CMD="${1:?用法: gexec.sh 命令}"
TMO="${2:-120}"
cd /Users/yuyin/WorkBuddy/jevis
n=0
while [ $n -lt 3 ]; do
  n=$((n+1))
  JARVIS_BRIDGE_PORT=9222 JARVIS_BRIDGE_WAIT=1 timeout "$TMO" \
    node adapters/omarchy/scripts/guest-bridge.mjs exec "$CMD" 2>/dev/null && exit 0
  sleep 2
done
echo "GEXEC_FAILED_AFTER_3_TRIES" >&2
exit 1
