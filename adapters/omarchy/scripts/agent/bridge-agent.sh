#!/bin/sh
# JARVIS bridge 持久代理 v4（注册令牌制 + 命令执行 + 反向 HTTP 代理）
# - flock 单实例：已有代理在跑则新实例直接退出（杜绝竞争）
# - 启动 /register 拿 token；/cmd、/req、/out 全程带 token
# - server 重启导致 token 失效：收到空响应后定期重注册
# - 每轮同时轮询 /cmd 与 /req：前者执行 shell，后者处理 /ui/* 等 HTTP 代理
HOST=${JARVIS_BRIDGE_HOST:-10.0.2.2}
PORT=${JARVIS_BRIDGE_PORT:-9222}
BASE="http://$HOST:$PORT"
LOCK=${JARVIS_BRIDGE_AGENT_LOCK:-/tmp/jarvis-agent.lock}
LOG=${JARVIS_BRIDGE_AGENT_LOG:-/tmp/jarvis-agent.log}

# flock 单实例（fd 9 持锁，进程退出自动释放）
exec 9>"$LOCK"
if ! flock -n 9; then
  echo "$(date +%T) another agent holds lock, exit" >> "$LOG"
  exit 0
fi

TOKEN=""
register() {
  RESP=$(curl -s --max-time 3 "$BASE/register" 2>/dev/null)
  NEWTOK=$(printf %s "$RESP" | sed -n 's/.*"token": *"\([a-f0-9]*\)".*/\1/p')
  if [ -n "$NEWTOK" ]; then
    TOKEN="$NEWTOK"
    echo "$(date +%T) registered token=${TOKEN:0:8}" >> "$LOG"
  fi
}

register
IDLE=0
N=0
while :; do
  # 1. 拉命令（带 token；未注册/失效则 server 204 空）
  c=$(curl -s --max-time 3 "$BASE/cmd?token=$TOKEN" 2>/dev/null)
  if [ -n "$c" ]; then
    IDLE=0

    # 解协议：base64( base64(id) + "\n" + base64(cmd) )
    raw=$(printf %s "$c" | base64 -d 2>/dev/null)
    id=$(printf %s "$raw" | sed -n '1p' | base64 -d 2>/dev/null)
    cmd=$(printf %s "$raw" | sed -n '2p' | base64 -d 2>/dev/null)
    if [ -n "$id" ] && [ -n "$cmd" ]; then
      # 长命令走临时文件（避免内联转义损耗）
      TMP=$(mktemp /tmp/agent-cmd.XXXXXX.sh)
      printf %s "$cmd" > "$TMP"
      out=$(sh "$TMP" 2>&1; printf "\n__JARVIS_RC__%s" "$?")
      rm -f "$TMP"

      # 回传（base64(id) + "\n" + 输出；带 token）
      printf '%s\n%s' "$(printf %s "$id" | base64 | tr -d '\n')" "$out" | \
        curl -s --max-time 5 -X POST --data-binary @- "$BASE/out?token=$TOKEN" >/dev/null 2>&1
      N=$((N+1))
      [ $((N % 10)) -eq 0 ] && echo "$(date +%T) executed $N cmds" >> "$LOG"
    fi
  else
    IDLE=$((IDLE+1))
    # 每 5 次空转尝试重注册（server 可能重启清了 token 表）
    if [ $((IDLE % 5)) -eq 0 ]; then register; fi
  fi

  # 2. 拉反向 HTTP 代理任务（invoke_ui / voice-service 等）。
  # 这一步不能在 /cmd 为空时 continue 跳过，否则 /ui/render 永远无人执行。
  p=$(curl -s --max-time 3 "$BASE/req?token=$TOKEN" 2>/dev/null)
  if [ -n "$p" ]; then
    IDLE=0
    PROXY_ERR=$(mktemp /tmp/agent-proxy.XXXXXX.log)
    if ! sh -c "$p" >/dev/null 2>"$PROXY_ERR"; then
      echo "$(date +%T) proxy failed: $(tail -c 500 "$PROXY_ERR")" >> "$LOG"
    fi
    rm -f "$PROXY_ERR"
  fi

  # 两个通道都空闲时休眠；agent/server 任一侧短暂离线都会自动重试
  if [ -z "$c" ] && [ -z "$p" ]; then
    sleep 1
  fi
done
