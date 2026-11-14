# Changelog

本项目的显著变更记录在此。格式参照 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/)，
版本号遵循 [SemVer](https://semver.org/lang/zh-CN/)。

## [0.1.0] - 2026-11-15

首个可用版本：统一人格对话、长期记忆、任务调度、Coding Harness、权限审计、
持续运行与环境感知。范围基准：可靠闭环优先，0.4+ 扩展能力挂起。

### 新增

**JARVIS Core（0.1）**
- `@jarvis/llm-gateway`：OpenAI 兼容多 provider 统一网关——流式/超时分类/五级错误
  分类/调用日志/健康检查；`rawChat` 暴露 tool_calls 原始协议（GLM 实测修复 role 字段）
- `@jarvis/memory`：SQLite 记忆引擎——写入管道（隐私过滤→重要性评估→去重→入库）、
  CJK 词法检索（字+2-gram）、对话存储、epoch 迁移框架、audit_logs（0.3 并入）
- `@jarvis/task-manager`：八态任务状态机（转换表驱动 8×8 全边测试）、依赖、
  崩溃恢复（RUNNING→BLOCKED）、全生命周期事件审计
- `@jarvis/orchestrator`：中央决策——LLM 结构化意图判定（answer/ask/create_task/
  continue_task 四分支）、有限工作流（无模型循环工具调用）、解析容错、
  对话记忆提取（本地规则）、环境上下文注入（0.3）
- `apps/daemon`：CLI 对话入口（jarvis / ask / --continue / tasks / run / audit /
  notify / status）+ JARVIS 人格（理性冷静专业私人管家）

**Harness Runtime（0.1-0.2）**
- `@jarvis/harness-runtime`：HarnessAdapter 统一接口 + CodingHarness
  （LLM 工具调用循环：read/write/list/run_command，maxSteps 防失控）
- 沙箱：路径越界拦截（workDir 硬边界）、命令白名单、危险模式黑名单
  （rm -rf/sudo/git push/管道 shell/命令替换注入）
- PermissionBroker：read/write/system/legal 四级裁决 + 目标提级规则
  （.ssh/.gnupg/凭证文件/.env/.pem/系统目录/支付/提权）+ 全请求审计

**Continuous Runtime（0.2）**
- `@jarvis/runtime`：ContinuousRuntime（定时调度/事件流/优雅停止）、
  ProactiveEngine（去重冷却 1h/每日限额/静默时段 23-7）、停滞检测（24h 阈值）
- `daemon.ts` 常驻进程：崩溃恢复、停滞检查、通知三通道（stdout/文件/macOS 原生）
- MacNotifyChannel：osascript 原生通知（high 带声音；AppleScript 注入防护）

**Context Awareness（0.3）**
- `@jarvis/context-engine`：activities 时间线（采集→脱敏→折叠去重→入库）、
  时段聚合、当前上下文快照；脱敏红线（隐身/密码管理器/银行/私聊标题整条拒收）
- macOS 前台感知：Swift NSWorkspace 主方案（零 TCC 权限）+ AppleScript 降级
- 感知→决策接线：环境快照进 Orchestrator 意图判定

### 验收
- 0.1 三场景真实 GLM E2E：问答 / 任务全链路（文件落盘回读）/ 跨会话记忆召回
- 实战演练 4/4：实用脚本（自测过）/ 多步文件整理（路径自修复）/ 高危任务双重拦截 /
  跨进程记忆+环境综合决策
- daemon LaunchAgent+保活双方案；117 测试全绿；CI 绿

### 已知限制
- DeepSeek 端点未实测（无 key；GLM 单供应商已稳定）
- 追问式任务（requiresApproval）执行需 CLI `run` 命令，无对话内确认流
- 记忆提取为规则式（提取模式有限），LLM 提取器留待后续版本
