# JARVIS Personal Agent

系统级个人智能体：统一人格 · 长期记忆 · 环境感知 · Harness 调度 · 自我扩展。
运行于 Omarchy / Arch Linux / Hyprland 之上，但核心不与 Omarchy 耦合。

**核心理念**：One Persona, One Conversation, Multiple Execution Engines.

## 文档导航

| 文档 | 内容 |
|---|---|
| docs/PRD.md | 产品需求文档 v0.1（从备忘录提取） |
| docs/SYSTEM-ARCHITECTURE.md | 系统架构 v0.1（从备忘录提取） |
| docs/decisions.md | 架构决策记录 ADR |
| docs/PLAN-jevis-0.1.md | JARVIS 0.1 实施计划（Phase 1+2） |
| docs/PLAN-hanjian-omarchy.md | 汉化 Omarchy 计划（独立产品线） |
| docs/source/ | 原始备忘录存档《Omarchy改造目标》 |
| AGENTS.md | 人机协作契约（改代码前必读） |
| MEMORY.md | 项目长期记忆 |

## 当前状态（2026-11-14）

- 项目初始化完成，尚未开始编码
- 下一步：按 PLAN-jevis-0.1.md Step 1.0 建仓库骨架；Step 2.0 验证 Harness 接入
- 汉化线：先完成 Try Omarchy VM 启动与中文覆盖度盘点（PLAN 第 0/1 步）

## 与其他项目的关系

- **手机底座系统（DouxianNG）**：姊妹产品线（Android agent-native OS），共享"agent 一等公民"理念与部分经验（ADR 方法、Omarchy 研究成果），仓库与架构完全独立
- **Omarchy 汉化 fork**：独立产品线，仓库待建（见 PLAN-hanjian-omarchy.md）
