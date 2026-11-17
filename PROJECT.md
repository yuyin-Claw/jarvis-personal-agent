# JARVIS Personal Agent · Omarchy 改造与汉化项目

系统级个人智能体 + 配套 Omarchy 中文体验层。
主仓 `jevis`：统一人格 · 长期记忆 · 环境感知 · Harness 调度 · 自我扩展。
宿主 Omarchy / Arch Linux / Hyprland，核心与桌面实现零耦合。

**核心理念**：One Persona, One Conversation, Multiple Execution Engines.

---

## 一、项目双产品线

| 产品线 | 仓库 | 状态 |
|---|---|---|
| **JARVIS Personal Agent**（主线） | 本仓 `jevis` | 0.4 能力闭环打通，28 commit 待推送 |
| **Omarchy 汉化** | 不建独立 fork（见 ADR-003 / ADR-006） | 已盘点完成：上游 zh-CN 100% 覆盖，转向「配置 + 补缺 + 反馈上游」路线 |

姊妹产品线：手机底座系统 DouxianNG（`/Users/yuyin/WorkBuddy/手机底座系统/`，独立仓库）。

---

## 二、当前真实状态（2026-11-17）

### 代码状态

- **当前发布**：v0.6.0（本地长期记忆 + Wiki + 自动记忆维护）
- **仓库**：main 与 origin/main 同步；CHANGELOG 已更新至 v0.6.0
- **测试**：322 单测 + typecheck 全绿；bridge / Python / Omarchy 生产冒烟通过

### 已交付能力（按阶段）

| 阶段 | 内容 | 状态 |
|---|---|---|
| **0.1 底座** | Core / LLM Gateway / Memory / Task Manager / Orchestrator / Harness / PermissionBroker / Runtime | ✅ |
| **0.2 具身与生产化** | Avatar / VoiceIO / TTS / Talk / systemd 常驻 / 平台适配 / Omarchy 自治 | ✅ |
| **0.3 实时语音** | SenseVoice / Silero VAD / KWS 唤醒词 / PipeWire / 打断语义 | ✅ |
| **0.4 Harness Factory** | gap → 骨架 → 多轮 develop/repair → 安全审查 → 沙箱 → 审批注册 → 对话直调 | ✅ |
| **0.5 设置与 Dynamic UI** | UI Host / invoke_ui / 设置中心 / 自定义唤醒词 / Agent 启停 / Super+J | ✅ |
| **0.6 长期记忆** | 本地 Qwen3 向量与蒸馏 / 增量水位线 / Wiki 编译层 / 自动记忆维护 / 失败退避 | ✅ |

### 后续工程债（不阻塞当前版本）

- **P1**：真人麦克风最终实测、Wiki Lint（冲突/过期/失效来源）、Dynamic UI 结果持久化与重开
- **P2**：Ambient 文件/屏幕/浏览器感知、长期目标跟进、主聊天备用模型与成本统计持久化
- **长期**：MCP Factory、能力版本自动升级、更多模态；多设备分布式与复杂 3D 仍属非目标

---

## 三、架构骨架

```
┌─────────────────────────────────────────────────────────────┐
│  用户 ⇄ 数字人（avatar）⇄ 具身编排 embodied ⇄ ConversationGateway │
└──────────────────────────┬──────────────────────────────────┘
                           │
              ┌────────────┴─────────────┐
              │  Central Orchestrator    │  六分支决策：
              │  （六分支意图）            │  answer / ask / create_task /
              └────────────┬─────────────┘  continue_task / capability_gap /
                           │                invoke_capability
        ┌──────────────────┼──────────────────────┐
        │                  │                      │
   ┌────▼─────┐     ┌──────▼───────┐     ┌────────▼─────────┐
   │ Harness  │     │  Capability  │     │  Proactive /     │
   │ Runtime  │     │  Registry    │     │  Runtime         │
   │ + 沙箱   │     │  + Factory   │     │  + 调度器         │
   └──────────┘     └──────────────┘     └──────────────────┘
        │                  │                      │
   ┌────▼──────────────────▼──────────────────────▼─────┐
   │  llm-gateway（GLM 主 / DeepSeek 备）· memory        │
   │  task-manager · audit_logs · PermissionBroker      │
   └─────────────────────────────────────────────────────┘
                           │
              ┌────────────┴─────────────┐
              │  @jarvis/platform 五端点  │  ADR-007
              │  窗口/语音输出/语音输入/   │
              │  前台感知/通知            │
              └────────────┬─────────────┘
                           │
        ┌──────────────────┼──────────────────┐
   ┌────▼─────┐       ┌────▼──────┐     ┌─────▼──────┐
   │ adapters │       │ adapters/ │     │ apps/      │
   │ /macos   │       │ omarchy   │     │ voice-svc  │
   │ (开发台) │       │ (生产宿主) │     │ avatar     │
   └──────────┘       └───────────┘     │ daemon     │
                                         └────────────┘
```

**monorepo 布局**（pnpm workspace）：

```
jevis/
├── apps/
│   ├── daemon/           CLI + 常驻 daemon
│   ├── avatar/           数字人宿主（macOS swift / Omarchy GTK4）
│   └── voice-service/    语音子系统（Omarchy 内，零 macOS 依赖）
├── packages/
│   ├── llm-gateway/      OpenAI 兼容多 provider + rawChat 工具协议
│   ├── memory/           记忆管道（隐私过滤→重要性→去重）+ CJK 检索
│   ├── task-manager/     八态状态机 + 崩溃恢复 + 事件审计
│   ├── orchestrator/     六分支意图 + 对话记忆提取 + 环境上下文
│   ├── harness-runtime/  Coding Harness + PermissionBroker 四级裁决
│   ├── runtime/          持续运行：调度 / 通知裁决 / 停滞检测
│   ├── context-engine/   activities 时间线（脱敏）+ 上下文快照
│   ├── embodied/         具身编排（表现弧 + 主动开口）
│   ├── avatar/           AvatarStateEngine + RenderTransport
│   ├── capability-registry/  能力注册表 + Skill 契约（0.4）
│   └── tsconfig/         共享 TS 配置
├── adapters/
│   ├── macos/            macOS 适配器（开发验证台）
│   └── omarchy/          Omarchy 适配器（生产宿主）
│       └── scripts/      deploy-core / verify-* / guest-bridge
└── scripts/smoke/        十域 25 项冒烟（part1 / part2 / PipeWire 配置）
```

---

## 四、架构决策摘要（ADR）

| ADR | 决策 |
|---|---|
| 001 | JARVIS 独立项目，不 fork Omarchy |
| 002 | TypeScript / Node LTS / pnpm workspace |
| 003 | 汉化走独立 fork（已修正——见 ADR-006） |
| 004 | Harness 模型策略：国内模型为主（GLM / DeepSeek），反锁定 |
| 005 | 开发双轨：macOS 验证台 + Try Omarchy VM 实测 |
| 006 | 汉化盘点后修正：上游 zh-CN 100% 覆盖，**无需 fork**，转向配置 + 补缺 + 反馈上游 |
| 007 | 0.2 平台五端点收归 `@jarvis/platform`，Core 不得直接 import 适配器 |
| 008 | 0.2 具身编排事件归属：embodied 包平台无关 |
| 009 | 语音服务化：零 macOS 依赖红线（用户裁决 2026-11-15） |
| 010 | JARVIS 系统栈开机自启动（数字人随系统启动即就位） |
| 011 | 0.4 Harness Factory：能力闭环而非工具闭环 |
| 012 | 实时麦克风语音链路（live listening） |

完整决策记录：`docs/decisions.md`（只增不删）。

---

## 五、文档地图

| 文档 | 内容 |
|---|---|
| `docs/PRD.md` | 产品需求文档 v0.1 |
| `docs/SYSTEM-ARCHITECTURE.md` | 系统架构 v0.1（含红线 §17） |
| `docs/decisions.md` | ADR 001–012 |
| `docs/PLAN-jevis-0.1.md` | 0.1 实施计划（Phase 1+2） |
| `docs/PLAN-jevis-0.4.md` | 0.4 Harness Factory 计划 |
| `docs/PLAN-hanjian-omarchy.md` | 汉化盘点结论与路线修正 |
| `docs/source/` | 原始备忘录存档《Omarchy 改造目标》 |
| `AGENTS.md` | **人机协作契约**（改代码前必读） |
| `MEMORY.md` | 项目长期记忆（架构、用户裁决、坑位基线） |
| `CHANGELOG.md` | 版本变更（停在 0.2.1，待补 0.3.0） |
| `README.md` | 仓库入口（快速开始 / 命令 / 部署） |

外部经验库（Obsidian）：
`/Users/yuyin/docs/knowledge/知识库/09.经验沉淀/JARVIS开发记录库/`
（踩坑总览 + QEMU/通道 + 音频链路 + systemd + 构建 + 方法论 6 大主题）

---

## 六、核心设计原则（红线）

1. **人格统一**——Harness 永远是执行环境，不成为用户交互入口
2. **对话优先**——不设固定 Dashboard，界面按需生成
3. **持续存在**——后台常驻，主动沟通而有分寸（冷却/限额/静默时段）
4. **权限即设计**——感知权限与执行权限分离，新能力默认零权限；高危必审批
5. **平台独立**——Omarchy 是首个宿主，不是架构边界（ADR-007）
6. **零 macOS 依赖**（语音服务）——ADR-009 红线，不得引入 macOS 专有分支
7. **Core 不依赖 Omarchy 私有脚本**——必须经 Platform Adapter 隔离
8. **屏幕/麦克风走 XDG Portal / PipeWire 授权会话**，禁止隐蔽采集
9. **事件驱动**，禁止无休止模型轮询
10. **凭证入库红线**——key 走环境变量 / Secret Service，不入代码或普通配置

---

## 七、工程约定（强制）

- **Vertical Slice**：每个迭代交付一条完整链路，禁止纯模块方式推进
- **依赖顺序**：Core+Harness+Task Manager → Runtime → Ambient → Factory
- **模拟事件测试**：Ambient/主动行为测试必须 mock Context Event 回放，不依赖真人操作
- **每功能三测试**：单元 + 集成 + 权限（安全相关必含红队场景）
- **ADR 先行**：架构改动先在 `docs/decisions.md` 立项
- **Git 提交需用户明确授权**——未经批准不得自行 commit
- **测试必绿才提交**，禁止删测试让构建通过
- **SQLite 迁移**：schema 变更走 epoch 时间戳命名迁移脚本（幂等）
- **配置位置**：`~/.config/jarvis/`（config.toml / permissions.toml / models.toml）
- **数据位置**：`~/.local/share/jarvis/database/jarvis.db`
- **Harness 工作边界**：`JARVIS_WORK_DIR`（默认 `~/jarvis-workspace`），外部操作走审批

---

## 八、里程碑时间线

| 日期 | 里程碑 |
|---|---|
| 2026-11-14 | 项目启动；hello world → 平台适配层；汉化盘点完成（无需 fork） |
| 2026-11-15 上午 | v0.1.0（117 测试）；真实 GLM E2E 三场景 + 实战演练 4/4 |
| 2026-11-15 下午 | 语音服务化（ADR-009）→ 开机自启（ADR-010）→ Core 进驻 Omarchy 三 unit → 语音引擎全本地（whisper.cpp + piper） |
| 2026-11-15 晚 | VM 灾难恢复 → 持久验证通道 → **实时麦克风链路**（ADR-012，E2E_LIVE_PASS）→ 234 测试 |
| 2026-11-16 凌晨 | 0.4 Harness Factory 能力闭环（ADR-011）：gap→骨架→审批→注册→对话直调 |
| 2026-11-16 | 数字人脸 v3.1（粒子拓扑 + 真实振幅口型）；十域 25 项冒烟全绿；通道根治（注册令牌制）；weather-briefing 首个真实能力；invoke_capability 第六分支打通 |
| **进行中** | P0：push 28 commit + 写 v0.3.0 CHANGELOG；P1：weather cron 调度 + 真实人声实测 |

---

## 九、快速入口

```bash
# 构建
pnpm install && pnpm run typecheck

# 对话（CLI 单问 / 交互 / 续会话）
node apps/daemon/dist/cli.js ask "帮我写一个词频统计脚本"
node apps/daemon/dist/cli.js
node apps/daemon/dist/cli.js --continue

# 具身对话（数字人 + 语音 + 流式）
node apps/daemon/dist/cli.js talk "在吗"

# 管理
node apps/daemon/dist/cli.js tasks / run <id> / audit / notify / status

# 能力（0.4 新增）
node apps/daemon/dist/cli.js capabilities list / health / run <name> '<args>'

# 部署到 Omarchy（宿主执行一次）
node adapters/omarchy/scripts/deploy-core.mjs
sh apps/voice-service/deploy/install.sh

# 全面冒烟（guest 内）
sh /mnt/mac/smoke-part1.sh && sh /mnt/mac/smoke-part2.sh
```

环境变量：`JARVIS_LLM_API_KEY`（必填）、`JARVIS_LLM_MODEL`（默认 glm-5.3-flash）、
`JARVIS_LLM_BASE_URL`、`JARVIS_DB_PATH`、`JARVIS_WORK_DIR`、`JARVIS_ENV_FILE`、
`JARVIS_VOICE_URL`、`JARVIS_PLATFORM`（omarchy/macos）。

---

## 十、与其他项目的关系

- **手机底座系统（DouxianNG）**：姊妹产品线，共享「agent 一等公民」理念与 ADR 方法；仓库与架构完全独立（Android 底座 vs Linux 桌面）
- **Omarchy 汉化**：已盘点完成，**不建 fork**；后续以「配置 + 补缺 + 上游 PR」方式回馈
- **Open Doubao Phone / OpenPhone / AOHP 等**：研究参照系，非本项目代码来源

---

## License

MIT
