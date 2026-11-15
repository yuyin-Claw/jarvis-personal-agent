# Changelog

本项目的显著变更记录在此。格式参照 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/)，
版本号遵循 [SemVer](https://semver.org/lang/zh-CN/)。

## [0.2.0] - 2026-11-15 — Embodied Conversational Agent

### 新增（0.2-① 状态引擎）
- `@jarvis/avatar`：AvatarStateEngine 六状态机（idle/listening/thinking/speaking/
  working/responding）+ 转换表 + responding 自动回落；AestheticState 与渲染技术解耦
- CoreEventBridge：任务状态 diff 与对话轮生命周期 → CoreEvent；13 单测

### 新增（0.2-② 全息渲染）
- `apps/avatar/avatar.html`：Canvas 粒子全息球，六状态独立波形/配色/HUD，
  暴露 `window.jarvis` / `window.setAvatarState`
- `apps/avatar/avatar-host.swift`：macOS 透明置顶 NSWindow + WKWebView 宿主，
  状态文件（seq 递增）控制通道 + ack 回写 + 自身窗口截图
- `AvatarRenderTransport`：Core → 表现层单向通道（原子写、seq 断点续传、
  引擎绑定、ack / 截图等待）
- 自动验收 `apps/avatar/scripts/verify-render.sh`：六状态驱动 → 宿主窗口截图 →
  像素断言（发光量、状态主色、相邻帧差），不依赖人工看图

### 新增（0.2-③ 语音双向）
- `@jarvis/voice`：
  - `MacSayTTS`——macOS `say` 输出（参数数组防注入、控制字符清洗、
    `-o` 静默合成用于验收、SIGTERM 打断并返回 interrupted）
  - `VoiceIO`——TTS 生命周期 ↔ AvatarStateEngine 事件闭环；强度包络驱动
    全息球波动；打断时只派 `user_interrupt`、绝不派 `tts_end`（防错误回 idle）
  - `SpeechInput`——消费 SFSpeechRecognizer JSONL，partial 首段自动打断 TTS，
    final 结束聆听；权限探测未就绪时自动降级文本输入、不弹系统授权窗
- `packages/voice/native/speech-input.swift`：中文实时识别助手（zh-CN），
  `--status-only` 可在零权限下探测授权状态

### 新增（平台适配层，ADR-007）
- `adapters/platform`：五个平台端点契约（AvatarHost / SpeechOutput / SpeechInput /
  ForegroundSource / Notification）+ 注册表 + 能力探测 + Null 降级基线，零平台依赖
- `adapters/macos`：收编原有 WKWebView 宿主 / `say` / SFSpeechRecognizer /
  NSWorkspace / osascript 五端点
- `adapters/omarchy`：GTK4+WebKitGTK 透明窗口（复用同一份 `avatar.html`）、
  Hyprland IPC 前台感知、XDG Portal 授权 + PipeWire 采集、espeak-ng、notify-send；
  麦克风采集必须先取得授权会话，失败即拒绝启动（架构红线）
- `apps/daemon` composition root：按环境动态注入实现，CLI 新增 `jarvis platform`
  探测命令；Core 不再直接 import 平台实现
- 自包含 guest 验证包 `~/Omarchy/jarvis-omarchy-probe/`（9p 共享目录）

### 新增（0.2-④⑤ 对话连接 + 主动交流）
- `@jarvis/embodied`（平台无关编排层）：
  - `EmbodiedConversation`——把一轮输入编成完整表现弧
    `idle → listening → thinking → [working → responding] → speaking → idle`；
    流式增量驱动强度波动、任务分支接 Harness 事件、打断立即停 TTS 且不播报旧结果、
    `onPhase` 异步暂停点供自动验收在每个状态截图（业务代码零改动）
  - `ProactiveVoiceChannel`——主动通知 → 数字人开口；只在 idle 播报，忙时排队
    （high 插队 / 队列上限 / TTL 过期不补播 / 公告串行防重入），关闭语音时降级不丢消息
- `AvatarStateEngine` 补 `llm_error`（任意状态回 idle，防卡在 thinking）与
  任意状态 `user_interrupt → listening` 转换
- `apps/daemon/src/embodied.ts`：具身运行时 composition root，唯一发布通道为
  `PlatformAdapter.avatarHost`；TaskEventWatcher 把任务状态 diff 映射到 working/responding
- CLI 新增 `jarvis talk`（流式对话 + 数字人 + 语音，支持无窗口/静音/静默合成）；
  `jarvis-daemon` 接入主动开口、空闲 30 分钟问候、平台感知与平台通知通道
- 自动验收 `packages/embodied/scripts/verify-embodied.sh`：生产 composition root +
  确定性 fake reply + 真实窗口截图 + 静默 `say` 合成，覆盖回答/任务/打断/故障/
  主动交流/排队补播，并用像素断言核对六状态真实上屏

### 修复
- 首版宿主把 JSON 文本直接插入 `JSON.parse()` 且 FIFO 读端一次性关闭，
  导致状态指令全部被吞；改为 base64 注入 + 状态文件轮询
- 具身运行时 `voice=false` 时仍会调用 TTS；改为静音 speaker 由编排层补齐 `tts_end`，
  状态弧仍完整回落 idle

### 验收
- **210/210 测试通过**（新增 embodied 17 项、composition root 5 项、状态机异常路径 2 项）
- 六状态端到端渲染验收通过（帧 106→394，橙/绿/紫主色实测上屏）
- 0.2-④⑤ 具身对话端到端验收通过：六状态由**对话链路**驱动上屏（帧 88→452），
  配色/帧差全部 PASS，打断不播报旧结果、故障回落 idle、主动开口与排队补播正确，
  `say` 静默合成 43KB AIFF；`jarvis talk` 真实 GLM 单轮问答通过
- `packages/voice/scripts/verify-tts.sh`：`say` 真实合成 AIFF（39KB，不发声）、
  状态轨迹 listening>thinking>speaking>idle、tts 事件齐备、识别权限探测通过
- `node apps/daemon/dist/cli.js platform` 实测：macOS 四端点 ready、
  语音识别 unavailable（notDetermined → 自动降级文本输入）
- Try Omarchy VM 通道现状：QMP 无 guest-exec / 无 qemu-ga，`hostfwd_add` 后
  guest sshd 未响应，9p 共享目录无执行通道 → guest 内实测待打通，未假装通过

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
