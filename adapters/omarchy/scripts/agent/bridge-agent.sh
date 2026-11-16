#!/bin/sh
# JARVIS bridge 持久代理 v3（注册令牌制，通道根治）
# - flock 单实例：已有代理在跑则新实例直接退出（杜绝竞争）
# - 启动 /register 拿 token；/cmd、/out 全程带 token
# - 旧代理（无 token）永远拿不到命令（server 204）→ 自然淘汰
# - server 重启导致 token 失效：/cmd 返回 204 时空转，定期重注册
HOST=${JARVIS_BRIDGE_HOST:-10.0.2.2}
PORT=${JARVIS_BRIDGE_PORT:-9222}
BASE="http://$HOST:$PORT"
LOCK=/tmp/jarvis-agent.lock
LOG=/tmp/jarvis-agent.log

# flock 单实例（fd 9 持锁，进程退出自动释放）
exec 9>"$LOCK"
if ! flock -n 9; then
  echo "$(date +%T) another agent holds lock, exit" >> "$LOG"
  exit 0
fi

TOKEN=""
register() {
  RESP=$(curl -s --max-time 8 "$BASE/register" 2>/dev/null)
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
  # 拉命令（带 token；未注册/失效则 server 204 空）
  c=$(curl -s --max-time 8 "$BASE/cmd?token=$TOKEN" 2>/dev/null)
  if [ -z "$c" ]; then
    IDLE=$((IDLE+1))
    # 每 30 次空转尝试重注册（server 可能重启清了 token 表）
    if [ $((IDLE % 5)) -eq 0 ]; then register; fi
    sleep 1
    continue
  fi
  IDLE=0

  # 解协议：base64( base64(id) + "\n" + base64(cmd) )
  raw=$(printf %s "$c" | base64 -d 2>/dev/null)
  id=$(printf %s "$raw" | sed -n '1p' | base64 -d 2>/dev/null)
  cmd=$(printf %s "$raw" | sed -n '2p' | base64 -d 2>/dev/null)
  [ -n "$id" ] || { sleep 0.3; continue; }
  [ -n "$cmd" ] || { sleep 0.3; continue; }

  # 长命令走临时文件（避免内联转义损耗）
  TMP=$(mktemp /tmp/agent-cmd.XXXXXX.sh)
  printf %s "$cmd" > "$TMP"
  out=$(sh "$TMP" 2>&1; printf "\n__JARVIS_RC__%s" "$?")
  rm -f "$TMP"

  # 回传（base64(id) + "\n" + 输出；带 token）
  printf '%s\n%s' "$(printf %s "$id" | base64 -w0)" "$out" | \
    curl -s --max-time 10 -X POST --data-binary @- "$BASE/out?token=$TOKEN" >/dev/null 2>&1
  N=$((N+1))
  [ $((N % 10)) -eq 0 ] && echo "$(date +%T) executed $N cmds" >> "$LOG"
done
