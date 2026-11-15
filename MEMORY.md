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
| 9 | **实施基准确立（用户裁决 2026-11-15）**：0.1-0.3 已落地，保留现项目边界与技术决策不再扩大范围；可靠闭环（任务→理解→执行→验证→汇报）优先于一切扩展；Harness Factory/数字人/动态 UI 挂起不阻塞闭环 | 2026-11-15 |
| 10 | **平台端点收归 Platform Adapter（ADR-007，用户裁决 2026-11-15）**：保留 ADR-001 独立仓库；补 `adapters/platform` 接口 + `adapters/macos` + `adapters/omarchy`；Core 只依赖接口，macOS 为开发验证台、Omarchy 为首个系统宿主 | 2026-11-15 |
| 11 | **语音能力服务化（ADR-009，用户裁决 2026-11-15）**：TTS/ASR 以独立 HTTP 服务架设在 Omarchy 上（契约 v1：/health /contract /asr /tts）；Core 经 `JARVIS_VOICE_URL` 调用 | 2026-11-15 |
| 12 | **语音服务零 macOS 依赖红线（用户裁决 2026-11-15）**：语音服务是架设在 Omarchy 系统里面的组成部分，不是独立项目，不得依赖任何 macOS 内容——MacBackend 已删除（createBackend 拒绝 macos、auto 恒为 omarchy）；测试音频用仓库 fixtures；守卫测试固化该红线 | 2026-11-15 |
| 13 | **JARVIS 系统栈开机自启动（ADR-010，用户裁决 2026-11-15）**：用户所说「唯一操作入口」含义即开机自启——系统启动数字人就在；JARVIS 栈（jarvis-voice + jarvis-avatar）在 Omarchy 上 systemd --user 开机自启为一个整体（「仅经数字人交互、不设 GUI」的引申表述已更正） | 2026-11-15 |

## 实施进度（2026-11-15 基准）

- **0.1 对话闭环 ✅**：LLM Gateway / Memory / Conversation+人格 / Task Manager / Orchestrator / Coding Harness / PermissionBroker；三场景真实 GLM E2E 全过（含文件落盘回读验证）
- **0.2 持续运行 ✅**：ContinuousRuntime / ProactiveEngine（去重冷却+每日限额+静默时段）/ 停滞检测 / daemon 常驻（崩溃恢复+双通知通道）
- **0.3 Ambient ✅**：context-engine（activities 时间线+脱敏红线）+ macOS 前台感知（Swift NSWorkspace 零权限方案）+ audit_logs 独立表 + CLI audit/notify/status
- 全仓 110/110 测试、CI 绿；GLM key 在 jevis/.env（gitignore 保护）
- **挂起项**：0.4 Harness Factory、数字人、动态 UI（按基准不启动）
- **允许的收尾方向**：context-engine.currentContext() 接 Orchestrator（感知→决策闭环）、macOS 原生通知、稳定性打磨

## 六阶段路线（备忘录既定，顺序不可倒置）

1. JARVIS Core（对话+记忆+调度）→ 2. Harness Runtime（国内模型 Coding Harness 为主）→ 3. Continuous Runtime（后台+主动沟通）→ 4. Context Awareness（Ambient 感知）→ 5. Harness Factory（自我扩展）→ 6. 数字人+动态 UI

JARVIS 0.1 验收三场景：①委派任务自动调度 Harness 完成并汇报 ②关闭对话窗口仍持续跟进并主动联系 ③记住历史项目决策不重复交代背景。

## 环境事实

- Try Omarchy v1.2.0 已装于 /Applications，VM 已首次启动（2026-11-14）；**VM 内 Omarchy = 4.0.0.r7848.g723072a（edge 滚动版，非 4.5.0）**，版本看 `~/Library/Application Support/Try Omarchy/VM/v1/shell/guest-status.json`
- **汉化盘点结论（2026-11-14，已实测验证）**：上游 zh-CN 翻译 100% 覆盖（menu 437/shell 555/cli 434/keybindings 193 + 51 篇手册），由 Muse 机器人 CI 自动同步；VM 内已切换中文成功（菜单 Setup→Language→简体中文）——**fork 全量汉化计划已取消**，后续仅按需回馈上游
- GitHub：账号 yuyin-Claw 已 gh 登录；clone/下载加速走 gh-proxy.com
- 用户模型服务：智谱 GLM Coding Plan（glm-5.3-flash，OpenAI 兼容端点，文本/流式/视觉实测全通）；DeepSeek 待实测
- git 全局配置：yuyin / mbollemitraka30@outlook.com

## 待验证风险

- DeepSeek 端点工具调用（function calling）行为——未实测（非阻塞，GLM 已稳定）
- XDG ScreenCast Portal 会话恢复与锁屏策略（备忘录 §16 未决项）

## 0.2 基准变更（用户裁决 2026-11-15 凌晨）

- **数字人提前为核心**（原 0.4+ 挂起项解冻）：数字人=JARVIS 与用户交流的主体，非装饰
- 新里程碑 **JARVIS 0.2 = Embodied Conversational Agent**（原 0.2/0.3 已并入 v0.1.0，版本号无冲突）
- 视觉方向（用户选定）：**B 全息 AI 助手**——粒子/光效/HUD，抽象表现替代拟真唇形；未来可切 VRM 3D
- 架构铁律：Avatar = 实时表现层（AvatarStateEngine + CoreEventBridge），经事件桥与 Core 解耦，渲染技术可替换 Core 零改动
- 六状态：idle/listening/thinking/speaking/working/responding，与 Core 事件绑定（用户说话→listening；LLM→thinking；Harness→working；TTS→speaking；完成→responding；打断→立即切 listening）
- 五步：①状态引擎+事件桥 ②全息渲染 ③语音双向（TTS/输入/打断） ④对话连接 ⑤主动交流
- **2026-11-15 收尾**：五步全部完成并发布 `v0.2.0`；ADR-007 补平台适配层
  （Core → Platform Adapter → macos/omarchy），ADR-008 固化具身对话与主动交流的事件归属；
  自动验收以生产 composition root 驱动真实窗口 + 像素断言为准，禁止手工 setState 冒充对话

## 2026-11-15 实测回归（用户裁决：全部通过验收再继续）

- 全量 build / lint / 226 测试绿；0.1/0.3/CLI 回归 21/21（真实 GLM、真实落盘、跨进程记忆、
  权限拦截、platform 五端点、talk 闭环、WAITING_APPROVAL 门禁、BLOCKED 恢复执行）
- 持续运行验收 11/11；macOS 六状态渲染 / TTS / 具身对话验收全过
- 修复真实缺陷：whisper 输出文件名（converted.txt）、CLI run 状态守卫、
  Omarchy 适配器缺默认 spawn/socketWrite、Portal gdbus 参数、宿主全屏/不透明验收模式
- **Omarchy guest 全链路实测通过**：生产适配器六状态上屏 + 像素断言
  （verify-omarchy-avatar-host.mjs）；语音服务 superwhisper ASR + espeak-ng TTS +
  真实 GLM 闭环 + 打断语义（verify-omarchy-voice.mjs）
- **guest 能力实测**：GTK 4.24.1 / webkit2gtk-4.1 2.54.2 / Portal D-Bus 存活 /
  Hyprland 0.57.2 / PipeWire / grim——此前 WEBKIT=none / PORTAL=none 是探针假阴性
- ADR-009 语音服务化 + 零 macOS 依赖红线落盘（见决策表 #11 #12）

## 语音服务基准（用户裁决 2026-11-15 午后，同日更正）

- **语音服务是架设在 Omarchy 系统里面的组成部分**，从属于 JARVIS-on-Omarchy
  整体，**不是独立拆分项目**（「独立项目化」表述是记录错误，已全仓更正）
- **零 macOS 依赖红线**：该服务只活在 Omarchy 系统内，macOS 上不存在其运行
  形态——MacBackend 已删除；`createBackend("macos")` 抛错；auto 恒为 omarchy
- 守卫测试（backends.test.ts）固化：源码无 macOS 专有引用 + 拒绝 macos 后端
- 测试音频 = 仓库 fixtures（apps/voice-service/fixtures/zh-*.wav，真实人声 16k WAV）
- 打断语义断言已移植进 verify-omarchy-voice.mjs 5c 节（guest 实测通过）
- 复验：全量 build/lint/226 测试绿；core 21/21、runtime 11/11、
  render/embodied/tts、guest avatar、guest voice（含打断）全部 PASS

## Core 进驻 Omarchy + 语音引擎本地化（2026-11-15 下午，用户选定方向 1+2）

- JARVIS 全栈三 unit 在 Omarchy guest 内 systemd 常驻并开机自启：
  jarvis-voice（语音服务）+ jarvis-avatar（数字人窗口）+ jarvis-core（Core daemon）
- 部署链：deploy-core.mjs（宿主 pnpm build → tar 经 9p → guest 本地磁盘
  npm install（better-sqlite3 12.11.1 aarch64 现场编译）+ @jarvis/* symlink）
- 关键坑：npm 不认 pnpm workspace:*（tsconfig extends 失效 → CJS 输出）；
  better-sqlite3 11.x 不兼容 node 26（升级 12.11.1）；9p 上 symlink 异常
  （部署到本地磁盘）；guest 代理长命令转义损耗（复杂逻辑落 sh 文件执行）
- 语音引擎完全本地化：ASR = whisper.cpp（guest 内源码编译 whisper-cli +
  ggml-base 147MB，643ms/次）；TTS = piper aarch64 + zh_CN-huayan-medium
  神经音色（211ms/次）；piper -f 是输出参数，文本必须走 stdin（已修
  backends.mjs 并固化）
- 全栈验收 6/6：三 unit active、引擎全本地、fixture ASR、guest 内真实
  GLM 对话、Core 驱动数字人窗口、piper 合成落盘
- GLM key 经 9p jarvis-core.env 注入 guest（JARVIS_ENV_FILE）
