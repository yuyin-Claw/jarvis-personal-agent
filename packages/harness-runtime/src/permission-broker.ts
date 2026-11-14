/**
 * Permission Broker（PRD FR-10 / 架构 §6.1）
 *
 * 感知权限与执行权限分离；按操作风险分级；审计日志。
 * 0.1 最小实现：本地操作分级裁决 + audit 表。
 */

/** 操作风险级 */
export type RiskLevel = "read" | "write" | "system" | "legal";

/** 请求的操作 */
export interface ActionRequest {
  /** 动作类别 */
  kind:
    | "file_read"
    | "file_write"
    | "shell_exec"
    | "network"
    | "task_create"
    | "task_execute"
    | "harness_run";
  /** 目标描述（路径/命令/URL） */
  target: string;
  /** 发起者：user / agent / harness:<id> */
  actor: string;
}

/** 裁决 */
export interface PermissionDecision {
  allow: boolean;
  risk: RiskLevel;
  /** 需要用户确认（allow=false 且 needApproval=true 时走确认流） */
  needApproval: boolean;
  reason: string;
}

/** 各动作类别的基线风险 */
const KIND_RISK: Record<ActionRequest["kind"], RiskLevel> = {
  file_read: "read",
  file_write: "write",
  shell_exec: "write", // 白名单命令在 harness 层已过滤；此处按目标提级
  network: "write",
  task_create: "read",
  task_execute: "write",
  harness_run: "write",
};

/** 目标特征 → 提级规则（顺序敏感，先匹配先赢） */
const TARGET_ESCALATIONS: Array<{ re: RegExp; risk: RiskLevel; reason: string }> = [
  { re: /(^|\/)\.ssh(\/|$)/i, risk: "system", reason: "SSH 凭证目录" },
  { re: /(^|\/)\.gnupg(\/|$)/i, risk: "system", reason: "GPG 凭证目录" },
  { re: /(^|\/)(password|credential|secret|token)[^/]*$/i, risk: "system", reason: "疑似凭证文件" },
  { re: /\.(env|pem|key)$/i, risk: "system", reason: "敏感扩展名" },
  { re: /^\/(etc|System|Library)\b/, risk: "system", reason: "系统目录" },
  { re: /\b(rm\s+-|mkfs|dd\s+of=)/, risk: "legal", reason: "破坏性命令" },
  { re: /\b(pay|payment|bank|transfer|转账|支付)\b/i, risk: "legal", reason: "支付相关操作" },
  { re: /\b(sudo|chmod\s+777)/, risk: "legal", reason: "提权命令" },
];

export interface AuditEntry {
  timestamp: string;
  actor: string;
  kind: string;
  target: string;
  risk: RiskLevel;
  allowed: boolean;
  reason: string;
}

export interface AuditSink {
  append(entry: AuditEntry): void;
}

export interface PermissionBrokerOptions {
  /** legal 级默认拒绝（0.1：无人值守时一律拒） */
  audit?: AuditSink;
  /** read 级是否免审（默认是） */
  allowReadByDefault?: boolean;
}

export class PermissionBroker {
  private readonly audit?: AuditSink;
  private readonly allowRead: boolean;

  constructor(opts: PermissionBrokerOptions = {}) {
    this.audit = opts.audit;
    this.allowRead = opts.allowReadByDefault ?? true;
  }

  /** 裁决一次动作（全部请求都会产生审计记录） */
  check(action: ActionRequest): PermissionDecision {
    let risk = KIND_RISK[action.kind] ?? "write";
    let reason = `类别基线 ${action.kind}`;

    for (const esc of TARGET_ESCALATIONS) {
      if (esc.re.test(action.target)) {
        risk = escalate(risk, esc.risk);
        reason = esc.reason;
        break;
      }
    }

    let decision: PermissionDecision;
    switch (risk) {
      case "read":
        decision = { allow: this.allowRead, needApproval: false, risk, reason };
        break;
      case "write":
        decision = { allow: true, needApproval: false, risk, reason };
        break;
      case "system":
        decision = { allow: false, needApproval: true, risk, reason };
        break;
      case "legal":
        decision = { allow: false, needApproval: true, risk, reason };
        break;
    }

    this.audit?.append({
      timestamp: new Date().toISOString(),
      actor: action.actor,
      kind: action.kind,
      target: action.target.slice(0, 500),
      risk: decision.risk,
      allowed: decision.allow,
      reason: decision.reason,
    });
    return decision;
  }
}

/** 风险只升不降 */
function escalate(current: RiskLevel, next: RiskLevel): RiskLevel {
  const order: RiskLevel[] = ["read", "write", "system", "legal"];
  return order.indexOf(next) > order.indexOf(current) ? next : current;
}
