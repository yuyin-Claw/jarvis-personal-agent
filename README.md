# JARVIS Personal Agent

系统级个人智能体：统一人格 · 长期记忆 · 环境感知 · Harness 调度 · 自我扩展。
运行于 Omarchy / Arch Linux / Hyprland 之上，但核心不与任何桌面环境耦合。

**One Persona, One Conversation, Multiple Execution Engines.**

用户只面对一个 Agent（一个人格、一个对话入口）；底层由中央 Orchestrator 调度多个执行引擎（Harness）完成任务，模型层以国内模型为主（GLM / DeepSeek 等），可插拔、反锁定。

## 当前状态

**JARVIS 0.1 功能集齐（2026-11-15）**：82 测试全绿，CI 绿。

已落地（`packages/` + `apps/daemon`）：

| 模块 | 能力 |
|---|---|
| llm-gateway | GLM/DeepSeek 等 OpenAI 兼容端点直连（流式/超时/错误分类/调用日志），多 provider 路由 |
| memory | SQLite 记忆引擎：隐私过滤→重要性→去重→入库；CJK 词法检索；对话存储 |
| task-manager | 八态任务状态机、依赖、崩溃恢复（RUNNING→BLOCKED）、全事件审计 |
| orchestrator | LLM 意图判定四分支（回答/追问/建任务/续任务），有限工作流无失控循环 |
| harness-runtime | Coding Harness（LLM 工具循环 + 沙箱：路径越界拦截/命令白名单/危险模式黑名单）+ PermissionBroker（read/write/system/legal 四级裁决 + 审计） |
| apps/daemon | CLI 全链路：`jarvis`（交互）/ `ask`（单问）/ `--continue`（续会话）/ `tasks`（任务列表） |

使用：设置 `JARVIS_LLM_API_KEY`（或 `jevis/.env`）→ `pnpm daemon`。

- 待办：真实 GLM 端点端到端验收（0.1 三场景）、DeepSeek 端点实测、`jarvis run <id>` 确认执行命令
- 后续版本：0.2 持续运行（systemd/主动通知）→ 0.3 Ambient 感知 → 0.4 自我扩展（见 PRD §8）

## 文档

| 文档 | 内容 |
|---|---|
| [docs/PRD.md](docs/PRD.md) | 产品需求文档 v0.1 |
| [docs/SYSTEM-ARCHITECTURE.md](docs/SYSTEM-ARCHITECTURE.md) | 系统架构 v0.1 |
| [docs/decisions.md](docs/decisions.md) | 架构决策记录（ADR） |
| [docs/PLAN-jevis-0.1.md](docs/PLAN-jevis-0.1.md) | 0.1 实施计划 |
| [AGENTS.md](AGENTS.md) | 人机协作契约（贡献前必读） |

## 核心设计原则

1. **人格统一**——Harness 永远是执行环境，不成为用户的交互入口
2. **对话优先**——不设固定 Dashboard，界面按需生成
3. **持续存在**——后台常驻，主动沟通而有分寸
4. **权限即设计**——感知权限与执行权限分离，新能力默认零权限
5. **平台独立**——Omarchy 是首个宿主，不是架构边界

## 相关产品线

- **Omarchy 中文汉化 fork**：独立仓库（规划中），与本仓库不耦合
- 手机版 agent-native OS（DouxianNG）：独立项目

## License

MIT
