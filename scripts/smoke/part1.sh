#!/bin/sh
# JARVIS 全面冒烟质检（十域，逐项 PASS/FAIL）
# 用法：sh /mnt/mac/smoke-full.sh
export HYPRLAND_INSTANCE_SIGNATURE=$(ls /run/user/1000/hypr/ | head -1)
export WAYLAND_DISPLAY=wayland-1
export JARVIS_ENV_FILE=/mnt/mac/jarvis-core.env
CORE=/home/yuyin/.local/share/jarvis/core
PASS=0; FAIL=0
report() { if [ "$2" = "0" ]; then PASS=$((PASS+1)); echo "PASS  $1"; else FAIL=$((FAIL+1)); echo "FAIL  $1  ($3)"; fi; }

echo "======== JARVIS 冒烟质检 $(date '+%H:%M:%S') ========"

# 域1 systemd 四 unit
echo "--- 域1 systemd ---"
for u in jarvis-voice jarvis-core jarvis-avatar jarvis-bridge-agent; do
  A=$(systemctl --user is-active $u); E=$(systemctl --user is-enabled $u)
  [ "$A" = "active" ] && [ "$E" = "enabled" ]; report "unit $u active+enabled" $? "got $A/$E"
done

# 域2 config 零错误
echo "--- 域2 config ---"
ERR=$(hyprctl configerrors | grep -v '^\s*$' | wc -l)
[ "$ERR" = "0" ]; report "hyprland configerrors 空" $? "$ERR 行错误"

# 域3 语音引擎实调
echo "--- 域3 语音引擎 ---"
H=$(curl -s -m 8 http://127.0.0.1:8787/health)
echo "$H" | grep -q '"ok":true' && echo "$H" | grep -q 'whisper.cpp' && echo "$H" | grep -q 'piper'
report "voice health 全本地引擎" $?
python3 - <<'PY' >/tmp/smoke-asr.txt 2>&1
import json, base64, urllib.request
wav = base64.b64encode(open('/mnt/mac/zh-user-utterance.wav','rb').read()).decode()
r = urllib.request.urlopen(urllib.request.Request('http://127.0.0.1:8787/asr', data=json.dumps({'audio':wav,'format':'wav','language':'zh'}).encode(), headers={'content-type':'application/json'}), timeout=30)
d = json.loads(r.read())
print('ASR_TEXT:', d.get('text'))
r2 = urllib.request.urlopen(urllib.request.Request('http://127.0.0.1:8787/tts', data=json.dumps({'text':'冒烟'}).encode(), headers={'content-type':'application/json'}), timeout=30)
d2 = json.loads(r2.read())
print('TTS_BYTES:', len(base64.b64decode(d2.get('audio',''))))
PY
grep -q 'ASR_TEXT: .\+' /tmp/smoke-asr.txt && grep -q 'TTS_BYTES: [1-9]' /tmp/smoke-asr.txt
report "ASR 转写 + TTS 合成实调" $? "$(tail -1 /tmp/smoke-asr.txt)"

# 域4 实时链路
echo "--- 域4 实时链路 ---"
sh /mnt/mac/live-e2e-test.sh > /tmp/smoke-live.log 2>&1
grep -q 'E2E_LIVE_PASS' /tmp/smoke-live.log; report "live 链路 E2E_LIVE_PASS" $? "$(tail -1 /tmp/smoke-live.log)"

# 域5 对话与审批
echo "--- 域5 对话 ---"
cd $CORE
A=$(timeout 60 node apps/daemon/dist/cli.js ask '用四个字回答：天空是什么颜色' 2>&1 | tail -1)
echo "$A" | grep -qE '蓝'; report "answer 直答（蓝色）" $? "$A"
B=$(timeout 60 node apps/daemon/dist/cli.js ask '我的项目代号是什么' 2>&1 | tail -1)
echo "$B" | grep -q '夜莺'; report "记忆跨会话召回（夜莺）" $? "$B"
T=$(timeout 90 node apps/daemon/dist/cli.js ask "帮我删除 ~/.cache/smoke-del-$$ 目录" 2>&1)
echo "$T" | grep -q '等待你确认'; report "高危任务审批门" $?
TID=$(node apps/daemon/dist/cli.js tasks | grep 'WAITING_APPROVAL' | head -1 | awk '{print $2}')
[ -n "$TID" ]; report "任务状态机 WAITING_APPROVAL" $? "$TID"
AU=$(node apps/daemon/dist/cli.js audit 2 | head -1)
echo "$AU" | grep -q 'task_execute'; report "审计落库" $?


echo "======== PART1 结果：PASS=$PASS FAIL=$FAIL ========
