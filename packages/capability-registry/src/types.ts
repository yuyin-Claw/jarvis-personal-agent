/** 能力注册表类型定义（ADR-011） */

export type CapabilityKind = "skill" | "harness" | "mcp" | "tool" | "workflow";

/** 权限声明/授予项（skill.json 与 capabilities.db 共用此结构） */
export interface Permission {
  /** 能力类别：network / fs_read / fs_write / exec / delete / ... */
  capability: string;
  /** 资源标识：wttr.in:80 / ~/.cache / etc */
  resource: string;
  /** 操作模式：connect / read / write / delete / ... */
  mode: string;
}

/** capabilities 表行（permissions 为 JSON 数组字符串，读取时 hydrate） */
export interface CapabilityRecord {
  name: string;
  version: string;
  kind: CapabilityKind;
  /** 相对 skillsRoot 的目录名或入口标识 */
  entry: string;
  description: string;
  enabled: 0 | 1;
  permissions: Permission[];
  created_at: string;
  health: "healthy" | "degraded" | "unknown";
}

export interface RegisterInput {
  name: string;
  version: string;
  kind: CapabilityKind;
  entry: string;
  description?: string;
  /** 红线：注册入口忽略此字段（权限只能经用户批准的申请单授予） */
  permissions?: Permission[];
}

/** skill.json 清单 */
export interface SkillManifest {
  name: string;
  version: string;
  description?: string;
  /** 执行入口：命令 + 固定参数；输入经 stdin JSON，输出 stdout JSON */
  entry: { command: string; args?: string[] };
  /** 输入输出 JSON Schema（Factory 生成测试契约用；Runner 不强制校验） */
  input?: Record<string, unknown>;
  output?: Record<string, unknown>;
  /** 健康检查 smoke：固定输入 + 期望输出键值 */
  smoke?: { input: unknown; expect?: Record<string, unknown> };
  /** 声明的权限需求（仅文档作用；实际授予走申请单） */
  permissions?: Permission[];
}
