# decisions.md — JARVIS 架构决策记录（ADR）

> 只增不删。每条决策含场景/决策/理由/代价/状态。

**ADR-001: JARVIS 独立项目，不 fork Omarchy**
- 场景：备忘录明确建议"暂时不要直接开始 Fork Omarchy，先建独立 JARVIS Core 项目"
- 决策：独立仓库开发 JARVIS Core，经 Platform Adapter 对接 Omarchy；不被 Omarchy 升级牵制，可在普通 Linux/macOS 独立测试
- 状态：已接受（2026-11-14）

**ADR-002: TypeScript/Node 实现**
- 场景：备忘录接口示例全部为 TS 伪代码，未定实现语言
- 决策：TypeScript（严格模式）+ Node LTS + pnpm workspace 单仓；沿用备忘录接口签名，降低转录成本
- 理由：Codex/Claude Code 工具链对 TS 生态最友好；瓶颈在 LLM 网络调用而非运行时性能
- 状态：已接受（2026-11-14）

**ADR-003: 汉化 Omarchy 走独立 fork，与 JARVIS 分离**
- 场景：用户选择"Fork 维护中文版"，与备忘录"不被 Omarchy 牵制"原则存在张力
- 决策：汉化 fork 是独立产品线，单独仓库；JARVIS 不依赖汉化 fork 的任何私有改动
- 风险：fork rebase 成本长期化——需建立每周 upstream 差异检查（参照 DouxianNG M0 经验）
- 状态：已接受（2026-11-14）

**ADR-004: Harness 模型策略——国内模型为主（GLM / DeepSeek 等）**
- 场景：备忘录指定 Codex CLI + Claude Code CLI；用户裁决（2026-11-14）：以接入国内模型为主，不绑定海外订阅
- 决策：
  - LLM Gateway 直接实现 OpenAI 兼容 provider：智谱 GLM（已验证端点 open.bigmodel.cn/api/coding/paas/v4 + glm-5.3-flash）、DeepSeek 等国内模型
  - 首个 Coding Harness 的底层执行模型走国内端点；Codex/Claude Code Adapter 保留为可选接入（架构接口不变），非 0.1 阻塞项
  - 模型可换是产品原则（反锁定），Gateway 层不得绑定单一厂商
- 状态：已接受（2026-11-14 用户裁决）

**ADR-006: 汉化 Omarchy——缺口已实测确认，fork 补全中文**
- 场景：用户已在 Try Omarchy VM 完成首次启动，实测中文汉化程度差
- 决策：执行 PLAN-hanjian-omarchy.md 第 1 步盘点（i18n 机制/覆盖面/硬编码规模），随后 fork 补全；此产品线优先级上调（用户已确认痛点真实存在）
- 状态：已接受（2026-11-14）

**ADR-005: 开发环境双轨制**
- 决策：JARVIS Core 平台无关部分（对话/记忆/任务/调度）在 macOS 直接开发；Omarchy 特有部分（Hyprland IPC/XDG Portal/PipeWire）在 Try Omarchy VM 验证
- 理由：核心循环不被 VM 依赖阻塞，加快 Phase 1-3 迭代
- 状态：已接受（2026-11-14）

**ADR-007: 0.2 平台端点统一收归 Platform Adapter（恢复架构 §7.1）**
- 场景：0.2-②③ 为快速完成自动截图/语音验收，数字人窗口直接用了 macOS NSWindow/WKWebView，
  语音直接用了 `say` / SFSpeechRecognizer / AVFoundation；`adapters/` 目录（pnpm-workspace、
  vitest、架构目录树均已预留）实际为空，且未立 ADR。用户 2026-11-15 指出偏离"融入 Omarchy"基准。
- 决策：
  - 恢复三层：**Core → Platform Adapter（`adapters/platform` 纯接口）→ 平台实现
    （`adapters/macos` / `adapters/omarchy`）**；`packages/*` 只依赖接口，不得 import 平台实现。
  - 五个平台端点：`AvatarHost` / `SpeechOutput` / `SpeechInput` / `ForegroundSource` / `Notification`。
    能力缺失时返回 `unsupported` / `unavailable` 并降级，**不静默假装成功**。
  - 维持 ADR-001（独立仓库 + 适配器对接）与 ADR-005（macOS 为开发验证台、Omarchy 为首个系统宿主）；
    不 fork Omarchy、不把代码并入汉化 fork（ADR-003）。
  - 架构 §16 待确认项「数字人采用 Tauri 原生窗口还是独立桌面进程」收敛为**可替换宿主**：
    接口固定，macOS 用 WKWebView 宿主，Omarchy 用 Wayland 层壳/WebKitGTK 宿主共用同一
    `avatar.html` 渲染层；未来切 VRM 3D 只换渲染层，Core 零改动。
  - 麦克风/屏幕采集必须经 XDG Portal / PipeWire 授权会话（AGENTS.md 架构红线），
    Omarchy 适配器不得绕过授权直接抓音频设备。
- 理由：0.2 的逻辑层（状态引擎、事件桥、RenderTransport、VoiceIO）本就平台无关，
  真正绑定的只有 5 个端点；抽接口成本低，可让 0.2-②③ 成果在 Omarchy 上复用而非重写。
- 代价：需维护两套平台实现；Omarchy 侧 Hyprland/Portal/PipeWire 需在 VM 实测
  （当前 Try Omarchy VM 无 guest-exec、sshd 未随运行时 hostfwd 启动，实测通道待打通）。
- 状态：已接受（2026-11-15 用户裁决：补适配层 + Omarchy 实现）

**ADR-008: 0.2-④⑤ 具身对话编排与主动交流的事件归属**
- 场景：0.2-①②③ 各自可跑，但 Core 对话链路（ConversationGateway / Orchestrator）、
  后台主动通知（ContinuousRuntime.ProactiveEngine）与数字人表现层尚未连接。
  状态事件若由多处重复派发，会出现 tts_end 误回 idle、responding 被覆盖等错乱。
- 决策：
  - 新增 `packages/embodied`（平台无关），**唯一持有一轮对话的表现弧编排**：
    `EmbodiedConversation` 派发 user_speech_* / llm_* / harness_* / tts_*；
    `VoiceIO` 保留 TTS 生命周期事件（tts_end / user_interrupt）的归属，
    由 `speaker.emitsStateEvents` 显式声明，禁止隐式双派。
  - 主动通知经 `ProactiveVoiceChannel` 转为数字人开口；`ProactiveEngine` 仍负责
    去重 / 每日限额 / 静默时段，两者职责不重叠。只在 idle 播报，忙时排队
    （high 插队、队列上限、TTL 过期不补播、串行防重入）。
  - 异常路径统一用 `llm_error` 回 idle；任意状态 `user_interrupt → listening`
    （补齐状态机转换表），保证模型故障或用户插话都不会让数字人卡死。
  - 具身 composition root 唯一落在 `apps/daemon/src/embodied.ts`；
    `packages/*` 不得 import 平台实现；状态发布通道只有一个，避免 seq 回退。
  - 自动验收必须以「生产 composition root + 确定性 fake reply + 真实宿主窗口 +
    静默 TTS」为准，禁止用手工 `setState` 逐个驱动状态来冒充对话驱动。
- 理由：把「谁负责状态」收敛到一层，才能让 0.2-②③ 成果被真实对话复用，
  同时让 Omarchy / macOS 两套宿主共用同一套行为契约与验收脚本。
- 代价：状态机新增两类事件，既有单测需补异常路径覆盖（已补 2 项）。
- 状态：已接受（2026-11-15，随 0.2 五步路线收尾，v0.2.0）

**ADR-009: 语音能力服务化——架设在 Omarchy 系统内的语音子系统，零 macOS 依赖**
- 场景：0.2-③ 语音链路最初直接绑 `say` / SFSpeechRecognizer（macOS），跨系统复用受阻。
  用户 2026-11-15 裁决：用 TTS/ASR 模型直接在 Omarchy 系统上架设服务；随后进一步明确
  **语音服务是架设在 Omarchy 系统里面的组成部分，不得依赖任何 macOS 内容**（含开发期
  残留的 MacBackend、`/usr/bin/say` 测试音频生成等）。「未来拆分为独立项目」的
  表述是记录错误，已更正：本服务从属于 JARVIS-on-Omarchy 整体，不是独立项目。
- 决策：
  - 新增 `apps/voice-service`（零外部依赖 Node HTTP 服务，部署在 Omarchy 系统内运行）：
    契约 v1 = `GET /health`、`GET /contract`、`POST /asr {audio: base64, format, language}`、
    `POST /tts {text, voice, rate}`；音频 base64（≤16 MiB）、文本 ≤500 字符、结构化错误、
    health 如实标注本地/上游。
  - **后端只有三种**：`omarchy`（ASR: superwhisper / whisper.cpp / vosk；TTS: espeak-ng / piper）、
    `upstream`（纯转发同契约上游）、`fake`（仅契约测试/CI）。**`macos` 后端已删除**，
    `createBackend("macos")` 直接抛错；`auto` 恒为 `omarchy`，不按 `process.platform` 分支。
  - Core 只经 Platform Adapter 的 `speechOutput` / `speechInput` 端点调用该服务
    （`JARVIS_VOICE_URL` 触发 `withVoiceService` 覆盖），Core 侧零语音引擎绑定。
  - 验收红线：测试音频一律用仓库内置 fixtures（`apps/voice-service/fixtures/*.wav`，
    真实人声 16k WAV），验收流程不得调用任何宿主专有合成工具；守卫测试固化
    「backends.mjs 无 macOS 专有引用」。
- 理由：语音引擎是可替换件；服务化让 Core 与引擎解耦、让 Omarchy 用本地引擎
  实现真实语音闭环。零 macOS 依赖是因为该服务只活在 Omarchy 系统内——
  macOS 上不存在它的运行形态，自然也不该有它的代码路径。
- 代价：macOS 开发机没有本地语音服务实现；macOS 上的语音验收为
  「Core 在开发机 + 语音服务在 Omarchy guest」的跨系统形态（`verify-omarchy-voice.mjs`）。
- 状态：已接受（2026-11-15 用户裁决；同日更正「独立拆分」表述）

**ADR-010: JARVIS 系统栈开机自启动（数字人随系统启动即就位）**
- 场景：生产化部署初期语音服务已 systemd 常驻，但数字人窗口仍靠手动拉起。
  用户 2026-11-15 裁决：「这将是整个系统的唯一操作入口」——用户澄清其含义
  即**开机自启动**：系统启动数字人就在，无需手动启动。此前的「全部交互仅经
  数字人、不设其他 GUI」表述属过度引申，已按用户本意更正。
- 决策：
  - **开机自启**：Omarchy 上 JARVIS 系统栈 = `jarvis-voice.service`
    （systemd --user，default.target）+ `jarvis-avatar.service`
    （systemd --user，graphical-session.target）+ 后续 jarvis daemon。
    开机（图形会话登录）= 数字人就位 = 语音就位，无手动步骤。
  - 部署物统一在 `apps/voice-service/deploy/`（install.sh 幂等安装两个 unit +
    Hyprland Lua 窗口规则）；生产验收以 `verify-omarchy-production.mjs`
    15 断言为准（双 unit enabled/active、kill -9 自愈、浮动窗口六状态像素断言）。
  - jarvis-avatar.service 绑定 graphical-session.target（PartOf）：注销/合成器
    退出时窗口随之停止，重登自动回来；语音服务不受图形会话影响。
- 理由：数字人作为系统的存在主体，「开机即在」是基本产品形态——
  用户开机的第一眼就有 JARVIS，而不是先去找启动器。
- 代价：数字人窗口进程成为常驻组件，其崩溃必须自愈（restart=on-failure 已覆盖）；
  Core daemon 的 Linux 常驻单元尚待部署（下一步）。
- 状态：已接受（2026-11-15 用户裁决；同日按用户澄清更正表述）

**ADR-011: 0.4 Harness Factory——能力闭环而非工具闭环**
- 场景：v0.2.1 后 JARVIS 已在 Omarchy 内自治运行，但能力固定（对话/记忆/任务/
  一个 Coding Harness）。备忘录答案 C 与 PRD FR-11 要求自我扩展：发现能力缺口 →
  设计 → 开发 → 沙箱测试 → 安全审查 → 注册 → 可回滚。
- 决策：
  - **0.4 范围 = 能力闭环 MVP**，不是通用插件系统。交付六件：
    1. `CapabilityRegistry`（能力目录：声明、版本、状态、健康检查）——单一事实源
    2. `CapabilityGap` 探测：Orchestrator 判定「无可用能力」时产出结构化缺口
       （而非泛泛回答），并给出缺口描述与验收标准
    3. `HarnessFactory`：调度现有 CodingHarness 开发新 Skill（Skill = 自包含
       TypeScript/Shell 工具包，接口契约先行：输入输出 schema + 测试样例）
    4. 沙箱测试：新 Skill 只能在隔离 workDir 内跑契约测试（复用 PermissionBroker
       沙箱），测试不过不注册
    5. 安全审查 + 权限红线：新能力默认零权限；**Factory 永不自行授予任何权限**
       （需要新权限 → 生成申请单 → 用户对话内批准，复用 0.1 的审批门）
    6. 注册与回滚：注册即写入 Registry（SQLite 迁移）；禁用/回滚 = 状态位切换，
       不删文件
  - **不做**（留给 0.5+）：MCP Server 生成、多语言 Skill、自动版本升级、
    Capability 市场、非 Coding Harness 类型生成。
  - Skill 形态：目录约定（skill.json 清单 + src/ + tests/ + README），
    执行走子进程（与 Harness 同沙箱模型），首个手写 Skill 作为参照实现。
  - 验收标准（真实闭环，非冒烟）：
    1. 用户对话提出一个 Registry 里没有的能力 → JARVIS 输出缺口分析
    2. Factory 生成 Skill 代码 + 测试 → 沙箱跑测试全绿
    3. 安全审查通过 + 零权限注册 → Orchestrator 下一次可直接调度该能力
    4. 对该 Skill 下禁用指令 → 后续调度立即回落（不重启）
    5. 全程审计落库（每次 Factory 运行都是一条 audit 记录）
- 理由：自我扩展是备忘录三答案中 C 的落地，但真正的价值在「缺口→能力→可用」
  闭环跑通；权限绝不自动授予是不可逾越的红线（备忘录 §428）。
- 代价：Factory 复用 CodingHarness（不自建代码生成栈）；Skill MVP 限
  TypeScript/Shell；能力质量依赖测试契约的严格程度。
- 状态：已接受（2026-11-15 用户裁决方向：发版后启动 0.4）
