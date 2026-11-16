#!/bin/sh
# chrome-clean（Factory 生成骨架）——需求：清理浏览器缓存
# 骨架行为：读 stdin，返回 implemented=false。实现本能力时替换此文件
# 并把 skill.json 的 smoke.expect.implemented 改为 true。
input=$(cat)
printf '{"ok": true, "implemented": false, "result": {"echo": %s}}\n' "$(printf %s "$input" | wc -c | tr -d ' ')"
