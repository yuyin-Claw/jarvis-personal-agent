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
