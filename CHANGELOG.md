# Changelog

本项目的显著变更记录在此。格式参照 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/)，
版本号遵循 [SemVer](https://semver.org/lang/zh-CN/)。

## [0.4.0] - 2026-11-16 — 能力闭环真正完整 · 权限红线运行时落地 · 高危能力示范

本版把 ADR-011「能力闭环 MVP」从「骨架生成器」推进为「真正完整的能力自生长体系」：

- **Factory develop 落地**：调度 LLM 把骨架改写为真实实现（GLM 实测生成合法 main.sh）
- **PLAN Step 4.3 三步**：security review / sandbox test / approveWithReview——危险命令静态扫描 + 契约测试 + 完整批准流水线
- **权限红线运行时落地**：`registry.run()` 安全入口——未授予权限的能力拒绝执行
- **用户批准入口**：`capabilities grant/revoke/permissions` 子命令（之前只能手工 SQL 落库）
- **首个高危能力示范**：sys-cache-clean 真实实现（dry-run 默认 + confirm 双开关 + 白名单 + 逐项权限）
- **weather cron**：每日 08:00 自动调 weather-briefing 并播报
- **资产风险修复**：guest 真实能力代码备份入库（`skills/`）

### 新增（Factory develop · PLAN Step 4.3）

- `SkillFactory.develop(name, opts)`：调度 LLM 把 staging 骨架 main.sh（implemented=false）改写为真实实现
- `LLMGenerateFn` 依赖注入类型（保持 capability-registry 包与 llm-gateway 解耦）
- 骨架备份 `main.sh.skeleton`（幂等，二次 develop 不覆盖）
- 诊断日志 `DEVELOP_LOG.md`（含 system prompt + user prompt + LLM 原始响应 + 提取代码）
- **红线**：不修改 `PERMISSION_REQUEST.md` / `skill.json.permissions`（申请单只能用户改）
- LLM 声明需要更多权限时不生成代码，返回 `requestedPermissions` 供用户追加
- prompt 含红线约束（权限范围 / 危险命令 / shebang / 契约）+ Promise.race 超时（默认 5 分钟）
- CLI：`jarvis factory develop <name>`（需 LLM key；其他 factory 子命令不需要）

**实测（GLM 真实调用）**：构造 hello-world 骨架 → factory develop → GLM 真实生成 main.sh（含 shebang + 注释 + 排空 stdin + 完全符合契约）→ factory approve 完整流水线 → capabilities run 真实返回 hello world。

### 新增（PLAN Step 4.3 三步：security review / sandbox test / approveWithReview）

- `SkillFactory.securityReview(name)`：同步静态审查
  - entry.command 路径边界（禁止 PATH 逃逸 `..`、绝对路径）
  - 权限声明 resource 合理性（禁止 `*` / `/` 根目录）
  - main.sh 危险命令静态扫描（去注释后匹配）：rm -rf / · dd if= · mkfs · fork 炸弹 · chmod 777 / · curl|sh · wget|sh · 直接写磁盘 /dev/sd* · eval $(...) · nc 监听后门
- `SkillFactory.sandboxTest(name)`：在 stagingRoot 内跑 skill.json 声明的 smoke 契约（不依赖 registry.register，staging 骨架未注册也可测）
- `SkillFactory.approveWithReview(name)`：完整流水线 security → sandbox → register；任一步失败拒绝注册，骨架保留在 staging 供修复
- CLI 改动：`factory approve` 改用 approveWithReview（红线默认开启）；新增 `factory review <name>` / `factory test <name>` 独立调试入口；支持 `JARVIS_STAGING_ROOT` 环境变量

**实测**：危险骨架（curl|sh）→ review 识别 + approve 拒绝 + staging 保留 + 未注册；合法骨架 → review/test/approve 全通过 + 已注册 + staging 清空。

### 新增（权限授予路径 · PLAN Step 4.4）

- `CapabilityRegistry.grantPermission(name, permission)`：红线校验必须已在 skill.json 的 permissions 数组中声明（防越权授予）；幂等去重
- `CapabilityRegistry.revokePermission(name, capability, resource)`：撤销匹配项（capability + resource 精确匹配，mode 任意）
- `CapabilityRegistry.getPermissions / getDeclaredPermissions`：查询权限对照
- **types.ts 修正**：`Permission` 接口 `{capability, resource, mode}` 对象（原 `string[]` 与实际数据不符）
- CLI 三个子命令：
  - `jarvis capabilities grant <name> <cap> <res> <mode>`：授予权限（必须已声明）
  - `jarvis capabilities revoke <name> <cap> <res>`：撤销权限
  - `jarvis capabilities permissions <name>`：权限对照（含未声明已授予的异常检测）

**实测**：register → grant 已声明 ✅ / grant 未声明被拒 ✅ / 重复 grant 幂等 ✅ / revoke ✅ / 权限对照显示 ✅。

### 新增（registry.run 安全入口 · ADR-011 红线运行时落地）

之前 SkillRunner 沙箱只有 cwd 限定，无权限校验。本次加 `CapabilityRegistry.run()` 安全入口：先校验 manifest.permissions 声明 vs capabilities.db 已授予，未全部授予则 throw 拒绝执行（错误信息含缺失权限清单 + grant 命令提示）。

- 零权限能力（manifest.permissions=[]）→ 直接放行
- 声明权限未全部授予 → throw「权限未授予，拒绝执行 <name>：缺失 ...」
- 声明权限全部已授予 → 放行到底层 SkillRunner

**调用方迁移**：
- cli.ts `capabilities run` 子命令 → registry.run
- cli.ts invoke_capability 分发 → capRegistry.run
- daemon.ts weather cron → capRegistry.run

**实测**：未 grant 时 run 被拒（错误信息含缺失权限与命令提示）→ grant 后 run 真实返回上海天气（wttr.in 实时数据）。

### 新增（sys-cache-clean 真实能力 · 首个高危能力示范）

实现 staging 中的 sys-cache-clean 骨架为真实能力（高危删除类，PLAN Step 4.4 逐项权限申请单）。

**main.sh 真实实现**（python3 内嵌，POSIX sh 兼容）：
- 白名单目录：~/.cache / npm / pnpm / macOS Caches / /tmp/jarvis-*
- **默认 dryRun=true**（只扫描报告，不删除）
- **真删双开关**：dryRun=false + confirm=true（高危红线）
- 大小阈值：默认 1MB，小于该值跳过
- 清空而非删除目录：保留目录本身，只清空内容
- 测试重定向：`JARVIS_CACHE_CLEAN_ROOT` env

**权限声明**（10 项按目录拆分）：5 项 fs_read + 5 项 fs_delete，每目录独立 grant/revoke。

**PERMISSION_REQUEST.md** 重写：逐项权限表 + 安全设计说明 + grant/revoke 命令示例。

**实测**：dry-run 扫描出 10.94MB / 141 个文件（未删除）；双开关 confirm=false 拒绝；targets=["cache"] 只删 cache（其他不动）；完整 approve 流水线通过；未授予权限时 registry.run 拒绝执行；逐项 grant 10 项权限后真实删除 8 个 jarvis 遗留目录 ~10MB。

### 新增（weather cron · 每日天气播报）

- daemon.ts 注入 CapabilityRegistry（0.4 能力闭环运行时）
- 注册第 5 个定时任务 weather-briefing：每 5 分钟检查一次，仅在每天 08:00-08:05 窗口内触发；dedupeKey 含日期（weather:YYYY-MM-DD）保证每日一次
- 城市可配：`JARVIS_WEATHER_CITY` 环境变量（默认 Shanghai）
- 仅在能力已注册且 enabled=1 时才调；返回 implemented=true + speech 才 rt.notify 播报；静默失败仅 console.error 不打扰用户
- 启动日志加天气 cron 说明

### 修复（易用性）

- **resource 路径归一化**：shell 把 `~` 展开成绝对路径导致 grant 报「未在 skill.json 中声明」。加 `normalizeResource()` 让 `~` 前缀与绝对路径等价（`~/.cache ≡ /Users/<user>/.cache`），落库统一归一化为 `~` 前缀。网络资源（wttr.in:80）不做路径处理。

### 新增（资产风险修复）

- **guest 真实能力代码备份入库**：之前 Factory 生成的能力代码只存在于 guest `~/.local/share/jarvis/skills/`，VM 重装/损坏即全丢。本版加 `skills/` 目录，把 guest 侧代码完整回传入库：
  - `skills/registered/`：已注册能力（sysinfo / weather-briefing / chrome-clean）
  - `skills/staging/`：待审骨架（sys-cache-clean）
  - `skills/README.md`：目录用途 + 同步协议 + 当前能力状态
- 清理：staging 中冗余的 weather-briefing（已 approve 实现）已删

### 文档

- `MEMORY.md` 补完 2026-11-16 段：0.3 实时语音 / 0.4 能力闭环 / 人脸 v3.1 / 通道根治 / v0.3.0 发版；决策表加 #15（数字人脸 v3.1 + 真实振幅驱动口型）、#16（第六分支 invoke_capability）、#17（注册令牌制通道根治）；待验证风险加「真实麦克风人声实测未做」

### 测试与质量

- **292 单测全绿**（v0.3.0 的 251 + 本轮新增 41）：
  - 8 个 grant/revoke 单测（声明校验 / 幂等 / 撤销 / 未注册异常）
  - 5 个 registry.run 单测（零权限放行 / 未授予拒绝 / 全授予放行 / 部分授予拒绝 / revoke 后再 run 又被拒）
  - 14 个 factory 三步单测（合法通过 / PATH 逃逸 / 绝对路径 / 通配权限 / 危险命令 / 注释不误报 / smoke 期望匹配 / 完整流水线 / 失败骨架保留）
  - 9 个 develop 单测（成功生成 / PERMISSION_REQUEST.md 不改 / skill.json 不改 / needs_more_permissions / LLM 异常 / 无 sh 块 / 缺 shebang / 无骨架 / skeleton 备份幂等）
  - 5 个 normalizeResource 单测（绝对路径匹配 / 幂等 / 绝对路径 revoke / 网络资源不受影响 / 非 home 绝对路径不归一化）
- typecheck 通过

### 当前能力盘点（v0.4.0）

| 能力 | 状态 | 权限 |
|---|---|---|
| sysinfo | ✅ 已实现（参照） | 零 |
| weather-briefing | ✅ 已实现 + 对话直调 + 每日 cron | network（wttr.in:80，可 grant） |
| sys-cache-clean | ✅ 已实现（高危示范） | 10 项按目录拆分，逐项 grant |
| chrome-clean | ⏳ 已注册骨架（implemented=false） | 待定 |

### 剩余工程债

- **真实麦克风人声实测**——live 链路目前仅 fixture 模拟验证
- **chrome-clean 真实实现**——已 approve 注册但骨架未实现
- **中长期**：记忆蒸馏机制；跨域记忆向量检索（当前 LIKE）；DeepSeek 备用模型
- **PLAN Step 4.3 develop 增强**：当前 develop 一次调用 LLM，未来可加「LLM 自主多轮修复」（生成 → 沙箱测试 → 失败诊断 → 重新生成）

## [0.3.0] - 2026-11-16 — 实时语音 · Harness Factory 能力闭环 · 数字人脸 · 通道根治

本版是 JARVIS 从「全栈进驻 Omarchy」走向「具身 + 自我扩展 + 生产可用」的关键跨越：

- **ADR-012 实时麦克风语音链路**：VAD 分段 → 本地 whisper.cpp ASR → 事件流，从「说完再识别」进化为「边说边听」
- **ADR-011 Harness Factory 能力闭环**：capability_gap 探测 → Skill 工厂骨架生成 → 用户审批 → 注册 → **对话直调 invoke_capability**——从「我还不会」到「我学会了并能用」全链路自动化（审批门保留给用户）
- **数字人脸 v3.1**：从全息光球到「由粒子组成的人脸」（蛋形轮廓 + 杏仁眼 + M 唇 + 面部体积点），并由**真实 TTS 振幅驱动口型**——表现层真实反映系统状态，不再播放预制动画
- **验证通道根治**：注册令牌制 + flock 单实例，旧代理（无 token 的 curl 残留）在协议层被永久淘汰
- **首个真实能力 weather-briefing**：wttr.in 只读 + 英中映射，对话直调返回真实天气

### 新增（0.3 实时语音，ADR-012）

- `apps/voice-service` 实时麦克风链路：PipeWire `pw-record` 采集 → VAD 段检测
  （按音频字节数换算时长，避免批量 tick 中 Date.now 几乎不流逝的坑）→ whisper.cpp 本地转写 →
  事件流（speech_start / partial / final / speech_end）
- PipeWire null-sink 持久化：`~/.config/pipewire/pipewire.conf.d/jarvis-mic.conf`，
  VM 重启后自动加载虚拟麦克风，不再每次手动 `pactl load-module`
- 打断语义：speech_start 立即打断 TTS 并回 listening；partial 到达不误派 tts_end；
  说完才进 thinking
- 跨系统验收 `verify-omarchy-live.mjs`：E2E_LIVE_PASS 全链路断言

### 新增（0.4 Harness Factory 能力闭环，ADR-011）

- **Step 4.1 能力注册表** `@jarvis/capability-registry`：Skill 契约（skill.json）+
  CapabilityRegistry（capabilities.db），支持 list / register / health / run
- **Step 4.2 capability_gap 决策分支**：Orchestrator 新增第五种意图——用户诉求超出当前能力时，
  不再只回答「我不会」，而是产出结构化 gap 描述
- **Step 4.3 Skill 工厂**：gap → LLM 生成 Skill 骨架（main.sh + skill.json + smoke 断言）→
  staging 目录待审 → 用户 `capabilities approve <name>` 批准 → 注册入 registry
- **Step 4.4 运行时集成**：daemon 监听 capability_gap 事件 → 自动起工厂 → 审批通知；
  cli `capabilities` 子命令（list/health/run/approve/reject）
- **能力闭环最后一环 invoke_capability**：Orchestrator 新增第六分支——当已注册能力
  能完成用户诉求时直接调用；cli 分发 SkillRunner.run → result.speech 优先输出
- 修复 registry description 陈旧坑：skill.json 更新后必须 SQL 同步 capabilities.db，
  否则 GLM 能力清单读到的还是「待实现骨架」旧描述

### 新增（数字人脸 v2 → v3.1）

- **v2**（318de8e）：粒子拓扑从全息球改为「由光点组成的人脸」——基础轮廓 + 眼 + 唇 + 口型同步
- **v3.1**（d70bef5）：拓扑精细版——蛋形轮廓、杏仁眼（上下眼睑 + 眼神光）、M 形唇峰、
  下颌收拢、面部体积填充点；粒子数 137 → ~320，密度足够才有「脸」的感觉
- **真实 TTS 振幅驱动口型**（eb15af1）：
  - `analyzeAmplitude(wav, sampleRate)`：wav 44 字节头后读 s16le，每 20ms 一帧 RMS 归一化 [0,1]
  - `VoiceServiceSpeechOutput` 新增 `onAmplitude?: (a:number)=>void` 选项
  - speak() 播放段：定时器按帧推包络值；结束推 0（口型闭合）
  - `withVoiceService` 自动接线 onAmplitude → `platform.avatarHost.setState({state:'speaking', amplitude:a})`
- **unit 附着渲染架构修复**：`omarchy-adapter.start()` 检测已有 socket 则复用而非 spawn 竞争；
  `setState` 在 socket 存在时即可写（不再依赖 proc），否则振幅帧会被静默丢弃

### 修复（验证通道根治，提交 2ece595）

- **宿主 server 令牌门** `guest-bridge.mjs`：`/register` 签发 token；
  `/cmd` `/out` 严格校验（未注册或不匹配一律 HTTP 204 空，不出队不消耗命令）
- **agent v3** `jarvis-bridge-agent.sh`：flock 单实例锁 + 启动即注册 + 全程带 token +
  空转 5 次自动重注册（server 重启 ~5 秒自愈，无需人工）
- **部署脚本** `deploy-bridge-agent.sh`：清旧 curl 代理 + unit 更新（StartLimitBurst=0）
- **根治原理**：之前通道反复断裂的根因是旧 curl 代理残留与新 agent 竞争 `/cmd` 队列；
  注册令牌制让无 token 请求永远拿不到命令——协议层结构性消除，不是清理式临时修复
- **实测**：5 连发 gexec 全成功；无 token → 204 空淘汰；合法 token → 200 出队

### 新增（首个真实能力 weather-briefing，提交 056a5a9）

- 实现：wttr.in HTTP 只读（`format=j1` 无需 key）+ 常见天气英中映射（~20 个常见词兜底英文）
- 安全：仅 network 权限申请单（wttr.in:80），无文件写入、无系统调用
- 验证：health healthy；run 北京 7°C、上海 18°C 真实数据
- **完整链路实测**：
  ```
  你：上海今天天气怎么样
  JARVIS：〔我来查询上海今天的实时天气。〕
         上海现在气温18度，霾，体感16度，风速每小时11公里，湿度55%。
  ```
  GLM 判 invoke_capability → SkillRunner 真实执行 → 返回真实天气播报
- ADR-011 能力闭环至此完整：**gap 探测 → 骨架生成 → 用户审批 → 注册 → 对话直调**——
  JARVIS 现在能自己长出能力并用起来

### 测试与质量

- **十域 25 项冒烟断言脚本化**（1d7afd4）：
  - 域 1 systemd 生产常驻（4 断言）
  - 域 2 配置健康（1 断言：hyprctl configerrors 空）
  - 域 3 语音引擎（2 断言：health 全本地 + ASR/TTS 实调）
  - 域 4 实时语音链路（1 断言：E2E_LIVE_PASS）
  - 域 5 对话与审批（5 断言：answer / 记忆跨会话召回 / 高危审批门 / 状态机 / 审计）
  - 域 6 数字人（3 断言：窗口唯一 / 帧驱动 thinking / **真实振幅 speaking 帧**）
  - 域 7 能力闭环（4 断言：sysinfo healthy / run 真实值 / factory staging 待审）
  - 域 8 通知与状态机（2 断言：通知落盘 / 无 RUNNING 悬空）
  - 域 9 数据层（2 断言：核心表齐全 / 记忆零重复）
  - 域 10 管道多轮（1 断言：2 轮回复）
- 固化 `scripts/smoke/`（part1/part2 + PipeWire 配置 + README），可在 guest 内重复执行
- 251 单测全绿；12 项对话深测全过

### 修复（工程债）

- **CLI 管道多轮对话修复**（d84c423）：非 TTY 走逐行读取，不再丢输入
- **Omarchy 窗口规则键名**（a0a771a）：`jarvis.lua` 改用 `no_blur` / `no_initial_focus`
  （原 `noblur` / `noinitialfocus` 是无效键导致顶部报「your config has errors」）
- **daemon 冒烟打磨**（9fa9c40）：孤儿任务恢复 + 工作目录自建 + 执行失败终态保障
- **factory 导入 type-only**（c6aba94）：自引用包路径修正
- **构建产物清理**（ce2cc06）：清理误入 src 的编译产物 + gitignore 防复发
- **bridge 可靠性**（bb6c6d4）：验证通道 + ADR-010 开机自启实弹闭环

### 验收

- 十域 25 项冒烟断言 **25/25 全 PASS**
- 251 单测全绿
- 12 项对话深测全过（含记忆跨会话召回 / 五分支意图 / 高危审批 / 沙箱执行）
- 通道 5 连发 gexec 全成功 + 旧代理淘汰实测通过
- 真实天气对话直调全链路实测成功

### 已知剩余工程债

- weather-briefing 目前只能手动调用，**每日定时调度**（cron 接入 runtime 调度器）未做
- sys-cache-clean 第二个真实能力（高危删除类，需逐项权限申请单）骨架待实现
- chrome-clean 已 approve 注册但未实现
- 真实麦克风人声实测：live 链路目前仅 fixture 模拟验证，真人声音未测
- 记忆蒸馏机制：memories 表已有但蒸馏逻辑未写
- 跨域记忆向量检索：当前是 LIKE 检索，未接向量
- DeepSeek 备用模型：无 key 未接

## [0.2.1] - 2026-11-15 — 语音服务化 · 生产化部署 · 全栈进驻 Omarchy

本版把 JARVIS 从「macOS 上开发的跨系统验证」推进为「Omarchy 内完整自治运行」：

- **ADR-009** 语音能力服务化：架设在 Omarchy 系统内的语音子系统，零 macOS 依赖
- **ADR-010** JARVIS 系统栈开机自启动（语音服务 + 数字人窗口 + Core daemon）
- **Core 进驻 Omarchy**：三 unit systemd 常驻，guest 内真实 GLM 对话闭环
- **语音引擎完全本地化**：whisper.cpp ASR + piper 神经音色 TTS

（用户裁决 2026-11-15：语音服务是 Omarchy 系统的组成部分、零 macOS 依赖；
「唯一操作入口」含义即开机自启动。）

### 变更

### 变更
- 删除 `MacBackend`（whisper-host + say）：`createBackend("macos")` 直接抛错，
  `auto` 恒为 `omarchy`，不再按 `process.platform` 分支；后端只剩
  `omarchy` / `upstream` / `fake` 三种
- 删除 macOS 专用语音对话 E2E（`verify-voice-dialogue.sh/.mjs`）；其独有的
  **打断语义断言**（partial→listening / TTS 中止 / user_interrupt / 不误派
  tts_end / 说完进 thinking）移植进 `verify-omarchy-voice.mjs` 的 5c 节，
  在 Omarchy guest 上实测通过
- 测试音频改为仓库内置 fixtures（`apps/voice-service/fixtures/zh-*.wav`，
  真实人声 16k WAV）：验收流程不再调用 `say` 等任何宿主专有合成工具
- 新增零 macOS 依赖守卫测试：backends.mjs 无 macOS 专有引用、
  createBackend 拒绝 macos、auto 恒为 omarchy、whisper.cpp 输出文件名契约
- `verify-omarchy-voice.mjs` 去除宿主上游降级通道（随 MacBackend 一并移除），
  guest 服务以纯本地引擎运行

### 新增（生产化部署，ADR-010 系统栈开机自启动）
- `apps/voice-service/deploy/`：双 systemd --user unit（jarvis-voice →
  default.target；jarvis-avatar → graphical-session.target，登录即数字人就位、
  崩溃自动重启、注销随停重登自回）、Try Omarchy Lua windowrule（数字人右下角
  420x480 浮动置顶小窗）、一键 install.sh
- `verify-omarchy-production.mjs`：生产形态 15 断言全过——双 unit enabled/active、
  kill -9 后自动拉起、Core 经生产服务 ASR/TTS、浮动窗口六状态区域截图像素断言

### 新增（Core 进驻 Omarchy + 语音引擎本地化）
- `deploy-core.mjs`：宿主编译 dist → guest 本地磁盘安装（~/.../jarvis/core），
  npm 装运行依赖（better-sqlite3 aarch64 现场编译）+ @jarvis/* symlink
- `jarvis-core.service`：Core daemon systemd --user 常驻（Requires jarvis-voice）；
  install.sh 扩为三 unit；guest 内 jarvis talk 真实 GLM 闭环、五端点全 ready
- better-sqlite3 ^11.10.0 → ^12.11.1（node 26 V8 API 兼容）
- 语音引擎完全本地化：ASR whisper.cpp（guest 编译 + ggml-base，643ms 转写，
  优先于 superwhisper 云端）；TTS piper（zh_CN-huayan-medium 神经音色，211ms，
  修复 piper CLI -f 参数误用：文本走 stdin）
- 全栈验收 6/6：三 unit active / 引擎全本地 / fixture 转写 / guest 内 GLM
  对话 / Core 驱动数字人 / piper 合成

### 验收
- guest 内 superwhisper ASR 真实识别 fixture「请介绍一下你自己。」与
  「等一下，我有个问题。」；espeak-ng 真实合成 203KB WAV；
  Core 经 `JARVIS_VOICE_URL` 跨系统调用全绿；打断语义 5 项全 PASS
- 全仓 226/226 测试通过、lint 通过

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
