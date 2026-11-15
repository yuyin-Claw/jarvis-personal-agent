# AGENTS.md — JARVIS Personal Agent 工程协作契约

本文件是人类与 AI 协作者（Codex / Claude Code / WorkBuddy 等）的共同规范。修改代码前先读本文件。

## 产品定位

**JARVIS Personal Agent**（用户口语亦称 JevIs）：运行于 Omarchy/Arch Linux 之上的系统级个人智能体。
核心原则：One Persona, One Conversation, Multiple Execution Engines。
正式文档：`docs/PRD.md`（需求）、`docs/SYSTEM-ARCHITECTURE.md`（架构）。备忘录原始存档：`docs/source/`。

## 决策登记

- 所有架构决策登记在 `docs/decisions.md`（ADR 只增不删）
- 两份正式文档（PRD/架构）的修订需先在 decisions.md 立项记录
- 命名统一：对外产品名 JARVIS Personal Agent；仓库内标识符用 jarvis（小写）；JevIs 为用户口语别名，不出现在代码标识符中

## Git 提交授权

- 未经用户明确授权，不得自行创建 Git commit；修改代码、完成任务或通过验证均不代表获准提交
- 提交授权仅适用于用户明确指定的任务和改动范围

## 开发方法（来自备忘录，强制）

1. **Vertical Slice**：每个迭代交付一条从用户输入到最终结果的完整链路，禁止按纯模块方式推进
2. **依赖顺序不可倒置**：Core + Harness + Task Manager 骨架先行；Continuous Runtime 先于 Ambient 感知；Harness Factory 最后实现
3. **模拟事件测试**：Ambient/主动行为的测试不得依赖真人操作电脑，必须使用模拟 Context Event 回放
4. **每功能三测试**：单元 + 集成 + 权限测试（安全相关功能必须含红队场景）

## 架构红线（摘自 docs/SYSTEM-ARCHITECTURE.md §17，改动需先立 ADR）

- Harness 不得直接获得全局屏幕/麦克风/文件流；JARVIS 只传最小化 Context Package
- 感知权限与执行权限分离；新能力默认零权限，权限授予必经 Permission Broker
- Context Collector 不得直接向 LLM 发送原始数据
- 屏幕/麦克风采集必须走 XDG Portal/PipeWire 授权会话，禁止隐蔽采集
- 事件驱动，禁止无休止模型轮询
- JARVIS Core 不得依赖 Omarchy 私有脚本（Platform Adapter 隔离）
- 平台端点（窗口宿主/语音输出/语音输入/前台感知/通知）必须经 `@jarvis/platform`
  接口由 composition root 注入；Core 不得直接 import `adapters/macos` 或
  `adapters/omarchy`（ADR-007）
- **`apps/voice-service` 零 macOS 依赖**（ADR-009，用户裁决 2026-11-15）：
  该服务未来独立拆分为单独项目，不得引入任何 macOS 专有工具、框架或
  按平台的分支；测试音频一律用仓库内置 fixtures，不得调用宿主专有合成工具
- 私密区域（密码管理器/银行/锁屏）默认禁止感知，不确定时停止采集

## 工程规范

- 语言：TypeScript / Node LTS；类型严格模式；pnpm workspace 单仓
- 每次提交前测试必绿；禁止删测试让构建通过
- SQLite 单库（`~/.local/share/jarvis/database/`），schema 变更走迁移脚本（epoch 时间戳命名，幂等）
- 凭证不写入代码或普通配置文件，使用系统 Secret Service
- 配置位于 `~/.config/jarvis/`（config.toml / permissions.toml / models.toml）

## 平台备注（开发环境）

- JARVIS Core 平台无关部分在 macOS 直接开发测试
- Omarchy 特有部分（Hyprland IPC / XDG Portal / PipeWire）在 Try Omarchy 虚拟机（已装 v1.2.0）内验证
- 汉化 Omarchy 是独立产品线（fork 维护中文版），与 JARVIS 仓库分离，不得耦合
