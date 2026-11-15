# PLAN 0.4 — Harness Factory（能力闭环 MVP）

> 依据：ADR-011（2026-11-15 用户裁决）。ADR 只增不删；本文是实施细化，可修订。

## 目标

让 JARVIS 从「能力固定」变为「能力可生长」：用户提出能力缺口 → JARVIS 自己
开发、测试、注册该能力 → 下次对话直接可用 → 可禁用回滚。全程零自动授权。

## 现有基础（复用，不重写）

| 已有 | 在 0.4 中的角色 |
|---|---|
| `CodingHarness`（LLM 工具循环） | Factory 的代码生成引擎 |
| `PermissionBroker`（四级裁决） | 沙箱执行与安全审查 |
| TaskManager 状态机 | Factory 作业本身也是任务（可审计可恢复） |
| Orchestrator 意图判定 | 缺口探测入口 |
| audit_logs | 每次 Factory 运行的审计 |

## 实施步骤（Vertical Slice）

### Step 4.1 Capability Registry + Skill 目录约定
- 新包 `packages/capability-registry`：
  - SQLite 迁移：`capabilities` 表（id/name/version/status/enabled/entry/permissions[]/created）
  - `SkillRunner`：按 skill.json 清单在沙箱内执行子进程（stdin JSON → stdout JSON）
- 目录约定：`~/.local/share/jarvis/skills/<name>/`（skill.json + src/ + tests/ + README）
- 手写首个 Skill 作参照：`sysinfo`（读系统信息，只读、零权限）

### Step 4.2 Capability Gap 探测
- Orchestrator：意图判定增加 `capability_gap` 分支——当任务需要明确工具而
  Registry 无匹配时，产出结构化缺口（description / acceptanceCriteria）
- CLI：`jarvis capabilities`（列表/详情/禁用）

### Step 4.3 HarnessFactory（核心闭环）
- `packages/harness-factory`：流水线
  `gap → design（LLM 产 skill.json + 契约测试）→ develop（调度 CodingHarness
  写实现）→ sandbox test（跑契约测试）→ security review（PermissionBroker
  静态审查：路径边界/危险命令/权限声明）→ register（写 Registry，零权限）`
- 任何一步失败：产出诊断报告入任务记录，不注册

### Step 4.4 权限申请单（红线实现）
- 新能力需要权限（读写边界外/网络/系统）→ Factory 生成申请单（permission
  request：能力/理由/风险/范围）→ 用户对话内批准 → 才写入 permissions[]
- Factory 代码路径上不存在「自动授予」分支（测试断言固化）

### Step 4.5 端到端验收（ADR-011 五条标准）
- 真实对话触发缺口 → 生成 → 测试 → 注册 → 调度 → 禁用回落，全程审计
- guest 内重复验收（Omarchy 上 Factory 同样工作）

## 边界（0.4 不做）

MCP Server 生成、多语言 Skill、版本自动升级、能力市场、UI 管理界面。

## 风险

- 生成代码质量 → 契约测试先行 + 沙箱隔离 + 拒绝注册未过测能力
- LLM 幻觉能力声明 → Registry 健康检查（调用 smoke test）标记 degraded
- 权限膨胀 → 申请单唯一授权路径 + audit 全记录
