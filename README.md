# JARVIS Personal Agent

系统级个人智能体：统一人格 · 长期记忆 · 环境感知 · Harness 调度 · 自我扩展。
运行于 Omarchy / Arch Linux / Hyprland 之上，但核心不与任何桌面环境耦合。

**One Persona, One Conversation, Multiple Execution Engines.**

用户只面对一个 Agent（一个人格、一个对话入口）；底层由中央 Orchestrator 调度多个执行引擎（Harness）完成任务，模型层以国内模型为主（GLM / DeepSeek 等），可插拔、反锁定。

## 当前状态

**Pre-alpha（2026-11）**：需求与架构文档定稿 v0.1，工程骨架搭建中。

- JARVIS 0.1 范围：统一人格对话、LLM Gateway、SQLite 记忆、Task Manager、首个 Coding Harness（国内模型驱动）、后台任务、权限与审计
- 完整路线：Core → Harness Runtime → Continuous Runtime → Context Awareness（Ambient）→ Harness Factory → 数字人与动态 UI

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
