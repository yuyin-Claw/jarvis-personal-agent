# chrome-clean

- 需求：清理浏览器缓存
- 形态：skill
- 状态：**Factory 骨架（未审批）**

## 实现步骤
1. 审阅 PERMISSION_REQUEST.md（权限申请单）
2. `jarvis factory approve chrome-clean` 批准并注册
3. 替换 main.sh 为真实实现（保持 stdin JSON → stdout JSON 契约）
4. 更新 skill.json 的 description/smoke.expect.implemented=true
5. `jarvis capabilities health chrome-clean` 验证 healthy
