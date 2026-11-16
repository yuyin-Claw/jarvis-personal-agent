# weather-briefing

- 需求：每日定时获取并播报天气（定时任务调度 + 天气数据查询）
- 形态：skill
- 状态：**Factory 骨架（未审批）**

## 实现步骤
1. 审阅 PERMISSION_REQUEST.md（权限申请单）
2. `jarvis factory approve weather-briefing` 批准并注册
3. 替换 main.sh 为真实实现（保持 stdin JSON → stdout JSON 契约）
4. 更新 skill.json 的 description/smoke.expect.implemented=true
5. `jarvis capabilities health weather-briefing` 验证 healthy
