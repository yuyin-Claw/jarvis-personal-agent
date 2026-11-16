#!/bin/sh
# smoke：skill.json 的 smoke 契约可执行且输出匹配
cd "$(dirname "$0")/.." || exit 1
out=$(printf '%s' '{"args":{}}' | ./main.sh)
echo "$out" | grep -q '"ok": true' || { echo "FAIL: $out"; exit 1; }
echo "$out" | grep -q '"implemented": false' || { echo "FAIL: implemented 应为 false（骨架）"; exit 1; }
echo PASS
