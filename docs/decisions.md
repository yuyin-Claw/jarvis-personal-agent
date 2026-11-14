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
