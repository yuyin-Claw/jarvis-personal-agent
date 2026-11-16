#!/bin/sh
# 部署 JARVIS bridge 持久代理 v3（注册令牌制 + flock 单实例）
# 一次性执行：sh /mnt/mac/deploy-bridge-agent.sh
set -e
mkdir -p /home/yuyin/.local/share/jarvis /home/yuyin/.config/systemd/user

# 清旧代理（无 token 的 curl 残留与旧 agent）
pkill -f 'curl.*10.0.2.2' 2>/dev/null || true
systemctl --user stop jarvis-bridge-agent 2>/dev/null || true

cp /mnt/mac/jarvis-bridge-agent.sh /home/yuyin/.local/share/jarvis/bridge-agent.sh
cp /mnt/mac/proxy-request.mjs /home/yuyin/.local/share/jarvis/proxy-request.mjs
chmod +x /home/yuyin/.local/share/jarvis/bridge-agent.sh /home/yuyin/.local/share/jarvis/proxy-request.mjs

cat > /home/yuyin/.config/systemd/user/jarvis-bridge-agent.service <<'UNIT'
[Unit]
Description=JARVIS guest bridge agent（注册令牌制 + flock 单实例）
After=default.target
StartLimitBurst=0

[Service]
Type=simple
ExecStart=/bin/sh /home/yuyin/.local/share/jarvis/bridge-agent.sh
Restart=always
RestartSec=2

[Install]
WantedBy=default.target
UNIT

systemctl --user daemon-reload
systemctl --user enable --now jarvis-bridge-agent
sleep 1
systemctl --user is-active jarvis-bridge-agent
echo "DEPLOYED_V3_TOKEN"
