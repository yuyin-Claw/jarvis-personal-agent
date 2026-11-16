#!/bin/sh
# JARVIS guest 永久方案部署脚本（2026-11-16）
#
# 解决 VM 重启后 jarvis unit 依赖 9p 导致启动失败的问题。
#
# 根因：
# - jarvis-voice / jarvis-avatar 的 WorkingDirectory 指向 9p 路径（~/Omarchy/...）
# - VM 重启后 9p 没自动挂载 → 工作目录不存在 → unit 启动失败
#
# 永久方案：
# 1. 配 /etc/fstab 自动挂载 9p
# 2. 把 jarvis 代码复制到 guest 本地磁盘（~/.local/share/jarvis/）
# 3. 改 jarvis unit 的 WorkingDirectory/ExecStart/Environment 指向本地路径
# 4. 配 sudo 免密（bridge-agent 可自主操作 guest）
#
# 用法：在 guest 内执行（需要 sudo 密码一次）
#   sh setup-guest-permanent.sh

set -e

echo "=== JARVIS guest 永久方案部署 ==="
echo

# ---- 1. 配 sudo 免密（bridge-agent 可自主操作）----
echo "=== 1. 配 sudo 免密 ==="
echo 'yuyin ALL=(ALL) NOPASSWD: /bin/mount, /bin/umount, /usr/bin/modprobe, /usr/bin/systemctl, /usr/bin/journalctl, /usr/bin/tee, /usr/bin/cp, /bin/sh, /usr/bin/sh, /usr/bin/mkdir, /usr/bin/ln' | sudo tee /etc/sudoers.d/yuyin-jarvis
sudo chmod 440 /etc/sudoers.d/yuyin-jarvis
echo "✓ sudo 免密已配（mount/umount/modprobe/systemctl/journalctl/tee/cp/sh/mkdir/ln）"
echo

# ---- 2. 挂载 9p（立即）----
echo "=== 2. 挂载 9p ==="
sudo modprobe 9p
sudo modprobe 9pnet_virtio
sudo mount -t 9p -o trans=virtio,version=9p2000.L mac /mnt/mac || echo "（已挂载或挂载失败，继续）"
echo "✓ 9p 已挂载到 /mnt/mac"
echo

# ---- 3. 配 fstab 自动挂载 ----
echo "=== 3. 配 fstab 自动挂载 ==="
if ! grep -q "^mac /mnt/mac" /etc/fstab; then
  echo "mac /mnt/mac 9p trans=virtio,version=9p2000.L,_netdev,nofail 0 0" | sudo tee -a /etc/fstab
  echo "✓ fstab 已追加"
else
  echo "✓ fstab 已配置"
fi
echo

# ---- 4. 创建符号链接 ----
echo "=== 4. 创建 ~/Omarchy 符号链接 ==="
ln -sfn /mnt/mac ~/Omarchy
echo "✓ ~/Omarchy -> /mnt/mac"
echo

# ---- 5. 复制 jarvis 代码到本地磁盘 ----
echo "=== 5. 复制 jarvis 代码到本地磁盘 ==="
mkdir -p ~/.local/share/jarvis
cp -r /mnt/mac/jarvis-voice-service ~/.local/share/jarvis/
cp /mnt/mac/jarvis-avatar-host.py ~/.local/share/jarvis/
cp /mnt/mac/avatar.html ~/.local/share/jarvis/
cp /mnt/mac/jarvis-core.env ~/.local/share/jarvis/ 2>/dev/null || touch ~/.local/share/jarvis/jarvis-core.env
echo "✓ jarvis-voice-service / jarvis-avatar-host.py / avatar.html / jarvis-core.env 已复制"
echo

# ---- 6. 改 jarvis unit 指向本地路径 ----
echo "=== 6. 改 jarvis unit 指向本地路径 ==="

# jarvis-voice
if [ -f ~/.config/systemd/user/jarvis-voice.service ]; then
  cp ~/.config/systemd/user/jarvis-voice.service ~/.config/systemd/user/jarvis-voice.service.bak
  sed -i "s|WorkingDirectory=%h/Omarchy/jarvis-voice-service|WorkingDirectory=%h/.local/share/jarvis/jarvis-voice-service|" ~/.config/systemd/user/jarvis-voice.service
  echo "✓ jarvis-voice WorkingDirectory → 本地"
fi

# jarvis-avatar
if [ -f ~/.config/systemd/user/jarvis-avatar.service ]; then
  cp ~/.config/systemd/user/jarvis-avatar.service ~/.config/systemd/user/jarvis-avatar.service.bak
  sed -i "s|%h/Omarchy/jarvis-avatar-host.py|%h/.local/share/jarvis/jarvis-avatar-host.py|" ~/.config/systemd/user/jarvis-avatar.service
  sed -i "s|--html %h/Omarchy/avatar.html|--html %h/.local/share/jarvis/avatar.html|" ~/.config/systemd/user/jarvis-avatar.service
  echo "✓ jarvis-avatar ExecStart + --html → 本地"
fi

# jarvis-core
if [ -f ~/.config/systemd/user/jarvis-core.service ]; then
  cp ~/.config/systemd/user/jarvis-core.service ~/.config/systemd/user/jarvis-core.service.bak
  sed -i "s|Environment=JARVIS_ENV_FILE=/mnt/mac/jarvis-core.env|Environment=JARVIS_ENV_FILE=%h/.local/share/jarvis/jarvis-core.env|" ~/.config/systemd/user/jarvis-core.service
  echo "✓ jarvis-core JARVIS_ENV_FILE → 本地"
fi

echo

# ---- 7. 重启所有 jarvis unit ----
echo "=== 7. 重启所有 jarvis unit ==="
systemctl --user daemon-reload
systemctl --user restart jarvis-voice jarvis-avatar jarvis-core
sleep 3
systemctl --user is-active jarvis-voice jarvis-avatar jarvis-core
echo

# ---- 8. 验证 ----
echo "=== 8. 验证 ==="
echo "jarvis-voice 健康："
curl -s http://localhost:8787/health | head -c 200
echo
echo
echo "=== 部署完成 ==="
echo "下次 VM 重启后："
echo "- 9p 会自动挂载（fstab）"
echo "- 即使 9p 没挂载，jarvis unit 也能起来（代码在本地磁盘）"
