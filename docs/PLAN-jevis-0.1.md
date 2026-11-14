# JARVIS 0.1 实施计划（Phase 1 → Phase 2）

> 依据 docs/PRD.md 与 docs/SYSTEM-ARCHITECTURE.md。Vertical Slice 方法：先跑通骨架链路。

## 总路线（备忘录既定）

```
Phase 1 Core → Phase 2 Harness → Phase 3 Continuous → Phase 4 Context → Phase 5 Factory → Phase 6 Avatar
   \__________ 0.1 范围 __________/
```

JARVIS 0.1 = Phase 1 + Phase 2：统一人格、文字对话、LLM Gateway、SQLite Memory、Task Manager、Codex/Claude Code Adapter、后台任务、基础主动通知、权限与审计。

## Phase 1：Central Core（JARVIS 0.1 前半）

### Step 1.0 仓库骨架（半天）
- [ ] pnpm workspace 初始化：apps/（daemon、desktop）、packages/（core、llm-gateway、memory、task-manager、orchestrator）、adapters/、docs/、tests/
- [ ] TypeScript 严格模式、vitest、eslint、CI（GitHub Actions：lint+test）
- [ ] 目录对齐 SYSTEM-ARCHITECTURE.md §12（首期只建 0.1 用到的包，其余占位 README）

### Step 1.1 LLM Gateway（1 天）
- [ ] LLMProvider 接口（generate 流式 / getModels / healthCheck）
- [ ] OpenAI 兼容 provider——直接接 GLM Coding Plan 端点（已验证可用：open.bigmodel.cn/api/coding/paas/v4 + glm-5.3-flash）
- [ ] 模型调用日志与成本统计、超时与故障处理
- 验收：命令行发起对话，流式返回，日志入库

### Step 1.2 Memory Engine（1-2 天）
- [ ] SQLite 初始化 + 迁移框架（epoch 时间戳命名，幂等）
- [ ] 首批表：conversations、messages、memories、memory_links、decisions
- [ ] 记忆写入管道：候选 → 隐私检查 → 重要性评估 → 去重 → 入库
- [ ] 词法检索（PRD FR-04：第一版不做向量库）
- 验收：跨会话记忆召回（对话 A 说的事实，对话 B 能引用）

### Step 1.3 Conversation Gateway + 人格（1 天）
- [ ] ConversationGateway 接口（receive / streamResponse / interrupt）
- [ ] JARVIS 人格 Prompt（理性/冷静/专业私人管家，PRD FR-01 人格要求）
- [ ] CLI 对话入口（0.1 的"对话窗口"就是终端，desktop 壳 Phase 6 再做）
- 验收：CLI 连续对话，带历史记忆上下文

### Step 1.4 Task Manager（1-2 天）
- [ ] AgentTask 结构 + 状态机（CREATED→PLANNED→RUNNING→COMPLETED/FAILED/CANCELLED…）
- [ ] SQLite 持久化；任务与 Harness 进程状态分离（架构 §3.6）
- [ ] 恢复/取消/重试/依赖
- 验收：重启进程后任务状态恢复

## Phase 2：Harness Runtime（JARVIS 0.1 后半）

### Step 2.0 前置验证：国内模型接入（半天）
- [x] GLM Coding Plan 端点已验证可用（手机底座系统项目实测：open.bigmodel.cn/api/coding/paas/v4 + glm-5.3-flash，文本/流式/视觉全通）
- [ ] DeepSeek 端点连通性与工具调用（function calling）实测
- [ ] 确认 Coding Harness 执行链：LLM Gateway → 工具调用循环 → 受限工具集（文件/命令）——首版自研轻量实现，底层模型可换
- 说明（ADR-004，2026-11-14 用户裁决）：以国内模型为主（GLM/DeepSeek 等）；Codex/Claude Code Adapter 为可选扩展，非 0.1 阻塞项

### Step 2.1 HarnessAdapter 接口 + Runtime（1-2 天）
- [ ] HarnessAdapter 接口（getCapabilities/healthCheck/execute/getStatus/streamEvents/cancel）
- [ ] 子进程管理：工作目录分配、环境变量、超时、日志收集、产物管理

### Step 2.2 首个 Adapter 落地（2 天）
- [ ] GLM Coding Adapter：自研轻量 Coding Harness（LLM 工具调用循环 + 沙箱化文件/命令工具），底层 GLM/DeepSeek 可换
- [ ] HarnessRouter：按能力声明路由任务
- 验收（0.1 核心场景）：「帮我开发一个 MCP Server」→ JARVIS 选 Harness → 后台执行 → 进度监控 → 失败重试 → 汇报

### Step 2.3 权限与审计（1 天）
- [ ] PermissionBroker 最小实现：Shell/文件读写/网络按 risk 分级，高危需用户确认
- [ ] audit_logs 表全链路记录
- 验收：未授权操作系统操作被拒绝并留痕

## 0.1 收尾验收（对齐 PRD §8）

- [ ] 场景①：对话委派任务 → 自动调度 Harness → 完成汇报
- [ ] 场景②：关闭对话窗口（CLI 退出）→ 后台继续 → 主动通知
- [ ] 场景③：历史项目决策跨会话记忆，无需重复背景
- [ ] 架构验收清单（SYSTEM-ARCHITECTURE.md §15）逐项打勾

## 风险与对策

| 风险 | 对策 |
|---|---|
| 国内模型工具调用质量参差（GLM vs DeepSeek function calling 行为差异） | Gateway 层做 provider 适配矩阵测试；任务复杂度低时用 flash 档，高时切旗舰档 |
| macOS 与 Linux 行为差异（子进程/路径） | 核心逻辑抽象层不碰平台 API；集成测试在 VM 跑 |
| 主动通知在 macOS 开发期不可完整验证 | 0.1 通知先用终端 bell + 文件，systemd/通知集成归 Phase 3 在 VM 验证 |
| 备忘录接口伪代码与实际 TS 类型有出入 | 以接口签名为准，参数细节实现时微调并回填架构文档 |
