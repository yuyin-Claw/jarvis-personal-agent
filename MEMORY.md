# MEMORY.md — JARVIS Personal Agent 项目长期记忆

> 范围：/Users/yuyin/WorkBuddy/jevis 项目。由 AI 协作者维护，蒸馏自每日工作日志（.workbuddy/memory/YYYY-MM-DD.md）。

## 产品定义（2026-11-14 定稿）

- **正式名**：JARVIS Personal Agent（用户口语别名 JevIs；代码标识符统一 jarvis）
- **定义**：运行于 Omarchy/Arch Linux/Hyprland 的系统级个人智能体——统一人格、长期记忆、环境感知、Harness 调度、自我扩展
- **核心理念**：One Persona, One Conversation, Multiple Execution Engines
- **来源**：用户备忘录《Omarchy改造目标》（已提取至 docs/source/，PRD 与架构文档在 docs/）

## 已定关键决策

| # | 决策 | 日期 |
|---|---|---|
| 1 | 项目独立仓库 /Users/yuyin/WorkBuddy/jevis，不与手机底座系统（DouxianNG）合并 | 2026-11-14 |
| 2 | 实现语言 TypeScript/Node（pnpm 单仓）；接口签名沿用备忘录 TS 伪代码 | 2026-11-14 |
| 3 | 不 fork Omarchy 做宿主——JARVIS Core 经 Platform Adapter 隔离；Omarchy 仅为首个运行平台 | 2026-11-14 |
| 4 | 汉化 Omarchy = 独立 fork 维护中文版产品线，与 JARVIS 仓库分离 | 2026-11-14 |
| 5 | **模型策略：国内模型为主（GLM / DeepSeek 等）**（用户裁决）；首个 Coding Harness 自研轻量实现，底层走国内端点；Codex/Claude Code 为可选扩展 | 2026-11-14 |
| 6 | 开发环境：核心模块在 macOS 开发；Omarchy 特有部分在 Try Omarchy 虚拟机验证 | 2026-11-14 |
| 7 | 代码托管 GitHub 新建公开仓库（账号 yuyin-Claw），本地推送 | 2026-11-14 |
| 8 | Try Omarchy VM 已首次启动，实测中文汉化程度差——汉化 fork 优先级上调 | 2026-11-14 |

## 六阶段路线（备忘录既定，顺序不可倒置）

1. JARVIS Core（对话+记忆+调度）→ 2. Harness Runtime（国内模型 Coding Harness 为主）→ 3. Continuous Runtime（后台+主动沟通）→ 4. Context Awareness（Ambient 感知）→ 5. Harness Factory（自我扩展）→ 6. 数字人+动态 UI

JARVIS 0.1 验收三场景：①委派任务自动调度 Harness 完成并汇报 ②关闭对话窗口仍持续跟进并主动联系 ③记住历史项目决策不重复交代背景。

## 环境事实

- Try Omarchy v1.2.0 已装于 /Applications，VM 已首次启动（2026-11-14），实测中文汉化程度差
- GitHub：账号 yuyin-Claw 已 gh 登录；clone/下载加速走 gh-proxy.com
- 用户模型服务：智谱 GLM Coding Plan（glm-5.3-flash，OpenAI 兼容端点，文本/流式/视觉实测全通）；DeepSeek 待实测
- git 全局配置：yuyin / mbollemitraka30@outlook.com

## 待验证风险

- DeepSeek 端点工具调用（function calling）行为——Step 2.0 实测
- Omarchy i18n 机制与硬编码文案规模——汉化 fork 动工前先盘点（VM 内定位英文界面清单）
- XDG ScreenCast Portal 会话恢复与锁屏策略（备忘录 §16 未决项）
