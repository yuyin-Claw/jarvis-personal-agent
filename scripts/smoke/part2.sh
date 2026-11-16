#!/bin/sh
export HYPRLAND_INSTANCE_SIGNATURE=$(ls /run/user/1000/hypr/ | head -1)
export WAYLAND_DISPLAY=wayland-1
export JARVIS_ENV_FILE=/mnt/mac/jarvis-core.env
CORE=/home/yuyin/.local/share/jarvis/core
cd $CORE
PASS=0; FAIL=0
report() { if [ "$2" = "0" ]; then PASS=$((PASS+1)); echo "PASS  $1"; else FAIL=$((FAIL+1)); echo "FAIL  $1  ($3)"; fi; }
# 域6 数字人
echo "--- 域6 数字人 ---"
hyprctl clients -j > /tmp/smoke-clients.json
WINS=$(python3 -c "
import json
wins = [c for c in json.load(open('/tmp/smoke-clients.json')) if 'JARVIS' in str(c.get('title',''))]
print(len(wins))")
[ "$WINS" = "1" ]; report "Avatar 窗口唯一" $? "$WINS 个窗口"
python3 -c "
import socket, json
s = socket.socket(socket.AF_UNIX); s.connect('/run/user/1000/jarvis-avatar.sock')
s.sendall((json.dumps({'type':'frame','state':'thinking','intensity':0.8,'caption':'smoke'})+'\n').encode())"
sleep 1
journalctl --user -u jarvis-avatar --since '5 seconds ago' --no-pager | grep -q 'thinking'
report "socket 帧驱动（thinking）" $?
# 真实 talk 振幅帧
echo '只回答两个字：你好' | timeout 60 node apps/daemon/dist/cli.js talk >/tmp/smoke-talk.log 2>&1 &
TP=$!
FOUND=0
for i in $(seq 1 40); do
  sleep 1
  if journalctl --user -u jarvis-avatar --since '2 seconds ago' --no-pager | grep -q 'speaking'; then FOUND=1; break; fi
done
wait $TP 2>/dev/null
[ "$FOUND" = "1" ]; report "真实振幅 speaking 帧" $?
python3 -c "
import socket, json
s = socket.socket(socket.AF_UNIX); s.connect('/run/user/1000/jarvis-avatar.sock')
s.sendall((json.dumps({'type':'frame','state':'idle','intensity':0.5,'caption':''})+'\n').encode())"

# 域7 能力闭环
echo "--- 域7 能力闭环 ---"
cd $CORE
node apps/daemon/dist/cli.js capabilities list | grep -q 'sysinfo'
report "capabilities list（sysinfo）" $?
HC=$(node apps/daemon/dist/cli.js capabilities health sysinfo)
echo "$HC" | grep -q 'healthy'; report "sysinfo health healthy" $? "$HC"
RU=$(node apps/daemon/dist/cli.js capabilities run sysinfo '{"section":"load"}')
echo "$RU" | grep -q '"ok": true'; report "capabilities run 真实值" $?
node apps/daemon/dist/cli.js factory list | grep -qE 'chrome-clean|sys-cache-clean|weather-briefing'
report "factory staging 待审骨架" $?

# 域8 通知与状态机
echo "--- 域8 通知与状态机 ---"
node apps/daemon/dist/cli.js notify 2 | grep -qE '随时在|通知'
report "通知落盘" $?
ORPHAN=$(node apps/daemon/dist/cli.js tasks | grep -c 'RUNNING')
[ "$ORPHAN" = "0" ]; report "无 RUNNING 悬空（孤儿恢复）" $? "$ORPHAN 个"

# 域9 记忆库与表
echo "--- 域9 数据层 ---"
node -e "
const Database = require('/home/yuyin/.local/share/jarvis/core/node_modules/better-sqlite3');
const db = new Database('/home/yuyin/.local/share/jarvis/database/jarvis.db', {readonly:true});
const tables = db.prepare(\"SELECT name FROM sqlite_master WHERE type='table'\").all().map(r=>r.name);
const need = ['memories','messages','tasks','audit_logs','conversations'];
const missing = need.filter(t=>!tables.includes(t));
console.log('MISSING:' + missing.join(','));
const dup = db.prepare('SELECT COUNT(*) c FROM (SELECT content FROM memories GROUP BY content HAVING COUNT(*)>1)').get().c;
console.log('DUP:' + dup);
console.log('TABLES:' + tables.length);
" > /tmp/smoke-db.txt 2>&1
grep -q 'MISSING:$' /tmp/smoke-db.txt; report "核心表齐全" $? "$(cat /tmp/smoke-db.txt | head -1)"
grep -q 'DUP:0' /tmp/smoke-db.txt; report "记忆零重复" $?

# 域10 管道多轮
echo "--- 域10 管道多轮 ---"
N=$(printf '一句话介绍你自己\n用一句话总结刚才的回答\n' | timeout 120 node apps/daemon/dist/cli.js --continue 2>&1 | grep -cE 'JARVIS>')
[ "$N" -ge 2 ]; report "管道多轮对话（$N 轮回复）" $? "只有 $N 轮"

echo "======== 结果：PASS=$PASS FAIL=$FAIL ========"
