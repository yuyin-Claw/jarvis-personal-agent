# JARVIS Personal Agent

系统级个人智能体：统一人格 · 长期记忆 · 环境感知 · Harness 调度 · 自我扩展。
运行于 Omarchy / Arch Linux / Hyprland 之上，但核心不与任何桌面环境耦合。

**One Persona, One Conversation, Multiple Execution Engines.**

用户只面对一个 Agent（一个人格、一个对话入口）；底层由中央 Orchestrator 调度多个执行引擎（Harness）完成任务，模型层以国内模型为主（GLM / DeepSeek 等），可插拔、反锁定。

## 当前状态

**v0.1.0（2026-11-15）**：117 测试全绿，CI 绿；真实 GLM E2E 三场景 + 实战演练 4/4 通过。

| 模块 | 能力 |
|---|---|
| llm-gateway | OpenAI 兼容多 provider 直连（流式/超时/错误分类/调用日志）+ rawChat 工具协议 |
| memory | 记忆管道（隐私过滤→重要性→去重）、CJK 检索、对话存储、audit_logs |
| task-manager | 八态状态机、依赖、崩溃恢复、事件审计 |
| orchestrator | 意图判定四分支、对话记忆提取、环境上下文注入 |
| harness-runtime | Coding Harness（工具循环+沙箱）+ PermissionBroker（四级裁决+审计） |
| runtime | 持续运行：定时调度、主动通知裁决（冷却/限额/静默时段）、停滞检测、macOS 原生通知 |
| context-engine | activities 时间线（脱敏红线）、macOS 前台感知（零权限）、上下文快照 |
| apps/daemon | CLI + 常驻 daemon |

## 快速开始

```bash
# 1. 配置（key 只走环境变量/.env，不入库）
cat > .env << 'EOF'
JARVIS_LLM_API_KEY=<你的 GLM key>
EOF

# 2. 构建
pnpm install && pnpm run typecheck

# 3. 对话（单问 / 交互 / 续会话）
node apps/daemon/dist/cli.js ask "帮我写一个词频统计脚本"
node apps/daemon/dist/cli.js            # 交互模式
node apps/daemon/dist/cli.js --continue # 续最近会话

# 4. 管理命令
node apps/daemon/dist/cli.js tasks   # 任务列表
node apps/daemon/dist/cli.js run <id> # 放行待确认任务
node apps/daemon/dist/cli.js audit   # 审计记录
node apps/daemon/dist/cli.js notify  # 通知历史
node apps/daemon/dist/cli.js status  # 全局概览

# 5. 常驻 daemon（停滞检查/活动采样/通知）
node apps/daemon/dist/daemon.js --check-interval 120
```

**环境变量**：`JARVIS_LLM_API_KEY`（必填）、`JARVIS_LLM_MODEL`（默认 glm-5.3-flash）、
`JARVIS_LLM_BASE_URL`、`JARVIS_DB_PATH`（默认 `~/.local/share/jarvis/database/jarvis.db`）、
`JARVIS_WORK_DIR`（Harness 工作边界，默认 `~/jarvis-workspace`）、`JARVIS_ENV_FILE`。

**常驻化**：macOS 见 `~/Library/LaunchAgents/com.jarvis.daemon.plist`（本机 launchctl 受
管控时用 `~/.local/share/jarvis/bin/jarvis-daemon.sh` 保活脚本）；Linux 用 systemd --user。

**安全设计**：Harness 只能操作 `JARVIS_WORK_DIR` 内文件；命令白名单 + 危险模式黑名单；
高危任务（删除/支付/凭证/提权）自动停确认门等 `run` 放行；全部操作落 audit_logs；
感知数据经脱敏（敏感标题拒收）入库，可随时清空。

## 文档

| 文档 | 内容 |
|---|---|
| [docs/PRD.md](docs/PRD.md) | 产品需求文档 v0.1 |
| [docs/SYSTEM-ARCHITECTURE.md](docs/SYSTEM-ARCHITECTURE.md) | 系统架构 v0.1 |
| [docs/decisions.md](docs/decisions.md) | 架构决策记录（ADR） |
| [docs/PLAN-jevis-0.1.md](docs/PLAN-jevis-0.1.md) | 0.1 实施计划 |
| [AGENTS.md](AGENTS.md) | 人机协作契约（贡献前必读） |

## 0.2 数字人（进行中）

JARVIS 0.2 的数字人是存在主体，不是装饰：表现层经事件桥与 Core 解耦，
只消费 `AestheticState`。当前已完成状态引擎与全息渲染（B 全息 AI 助手方向）。

```sh
# 编译并运行透明置顶窗口（macOS）
cd apps/avatar
swiftc -O -framework Cocoa -framework WebKit avatar-host.swift -o jarvis-avatar
./jarvis-avatar "$PWD/avatar.html"

# 驱动状态（另开终端；seq 必须递增）
echo '{"seq":1,"state":"speaking","intensity":0.85,"amplitude":0.7,"caption":"你好"}' \
  > ~/.local/share/jarvis/avatar.state.json

# 端到端自动验收：六状态驱动 → 窗口截图 → 像素断言
apps/avatar/scripts/verify-render.sh
```

Node 侧推荐用 `AvatarRenderTransport`（`packages/avatar`）发布状态或直接
`bind(engine)` 订阅状态引擎，无需手写 seq。

语音链路（0.2-③）：

```sh
packages/voice/scripts/verify-tts.sh   # say 只写 AIFF 文件，不发声
```

`MacSayTTS` 负责输出，`VoiceIO` 把 TTS 生命周期接到状态引擎，
`SpeechInput` 消费 macOS 语音识别的 JSONL；用户开口的首段识别结果会立即
打断 TTS。语音识别授权未就绪时自动降级到文本输入，不弹系统窗、不阻塞主流程。

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
