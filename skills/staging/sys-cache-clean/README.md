# sys-cache-clean

- 需求：每日定时自动清理系统缓存（临时文件/浏览器缓存/包管理器缓存），含定时调度
- 形态：skill
- 状态：**Factory 骨架（未审批）**

## 实现步骤
1. 审阅 PERMISSION_REQUEST.md（权限申请单）
2. `jarvis factory approve sys-cache-clean` 批准并注册
3. 替换 main.sh 为真实实现（保持 stdin JSON → stdout JSON 契约）
4. 更新 skill.json 的 description/smoke.expect.implemented=true
5. `jarvis capabilities health sys-cache-clean` 验证 healthy
