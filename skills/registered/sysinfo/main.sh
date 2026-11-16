#!/bin/sh
# sysinfo Skill（参照实现）：stdin JSON {section} → stdout JSON
# 契约：零写操作、零网络、只读 /proc 与 df —— 零权限即可运行
input=$(cat)
section=$(printf %s "$input" | sed -n 's/.*"section"[": ]*"\([a-z]*\)".*/\1/p')
[ -n "$section" ] || section=all

uptime=$(uptime -p 2>/dev/null | sed 's/^up //')
mem_avail=$(awk '/MemAvailable/ {printf "%d", $2/1024}' /proc/meminfo 2>/dev/null)
disk_free=$(df -BG / 2>/dev/null | awk 'NR==2 {gsub("G","",$4); print $4}')
load1=$(cut -d' ' -f1 /proc/loadavg 2>/dev/null)

case "$section" in
  uptime) printf '{"ok": true, "uptime": "%s"}\n' "$uptime" ;;
  mem)    printf '{"ok": true, "memAvailableMB": %s}\n' "${mem_avail:-0}" ;;
  disk)   printf '{"ok": true, "diskFreeGB": %s}\n' "${disk_free:-0}" ;;
  load)   printf '{"ok": true, "load1": %s}\n' "${load1:-0}" ;;
  *)      printf '{"ok": true, "uptime": "%s", "memAvailableMB": %s, "diskFreeGB": %s, "load1": %s}\n' "$uptime" "${mem_avail:-0}" "${disk_free:-0}" "${load1:-0}" ;;
esac
