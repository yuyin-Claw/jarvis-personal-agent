/**
 * 能力注册表（ADR-011 · PLAN-0.4 Step 4.1）
 *
 * CapabilityRegistry：JARVIS 已注册能力的单一事实源（SQLite）。
 * SkillRunner：按 skill.json 清单在沙箱目录内以子进程执行 Skill
 * （stdin JSON → stdout JSON），复用 PermissionBroker 的 workDir 隔离思路。
 *
 * 红线（ADR-011）：注册默认零权限；权限提升只能经用户批准的申请单路径，
 * Registry 本身不提供任何自动授权接口。
 */
import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import Database from "better-sqlite3";
import { ALL_MIGRATIONS } from "./schema.js";
import type { CapabilityRecord, Permission, RegisterInput, SkillManifest } from "./types.js";

export interface RegistryOptions {
  /** SQLite 数据库文件路径（:memory: 供测试） */
  dbPath: string;
  /** Skill 根目录（默认 ~/.local/share/jarvis/skills） */
  skillsRoot?: string;
}

export class CapabilityRegistry {
  private readonly db: Database.Database;
  readonly skillsRoot: string;

  constructor(opts: RegistryOptions) {
    this.db = opts.dbPath === ":memory:"
      ? new Database(":memory:")
      : new Database(opts.dbPath);
    this.skillsRoot = opts.skillsRoot
      ?? path.join(process.env.HOME ?? "/home", ".local/share/jarvis/skills");
    this.db.pragma("journal_mode = WAL");
    this.migrate();
  }

  private migrate(): void {
    this.db.exec(`CREATE TABLE IF NOT EXISTS migrations (
      id INTEGER PRIMARY KEY,
      name TEXT NOT NULL,
      applied_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
    )`);
    const applied = new Set(
      (this.db.prepare("SELECT id FROM migrations").all() as Array<{ id: number }>).map((r) => r.id),
    );
    for (const m of ALL_MIGRATIONS) {
      if (applied.has(m.id)) continue;
      const tx = this.db.transaction(() => {
        m.up(this.db);
        this.db.prepare("INSERT INTO migrations (id, name) VALUES (?, ?)").run(m.id, m.name);
      });
      tx();
    }
  }

  /** 注册能力（默认 disabled=false、permissions=[]）。同名同版本幂等（返回既有记录）。 */
  register(input: RegisterInput): CapabilityRecord {
    const existing = this.db
      .prepare("SELECT * FROM capabilities WHERE name = ? AND version = ?")
      .get(input.name, input.version) as CapabilityRecord | undefined;
    if (existing) return existing;

    // 红线：register 入口强制清零权限——携带 permissions 也被忽略并警告
    if (input.permissions && input.permissions.length > 0) {
      console.warn("[registry] 注册忽略 permissions（权限只能经用户批准的申请单授予）");
    }
    const now = new Date().toISOString();
    this.db.prepare(`INSERT INTO capabilities
      (name, version, kind, entry, description, enabled, permissions, created_at, health)
      VALUES (?, ?, ?, ?, ?, 1, '[]', ?, 'unknown')`)
      .run(input.name, input.version, input.kind, input.entry, input.description ?? "", now);
    // 刚插入的行必然可查回（同事务语义）；防御式处理并发删除的极端情形
    return this.get(input.name, input.version)
      ?? {
        name: input.name, version: input.version, kind: input.kind,
        entry: input.entry, description: input.description ?? "",
        enabled: 1, permissions: [], created_at: now, health: "unknown",
      };
  }

  get(name: string, version: string): CapabilityRecord | undefined {
    const row = this.db
      .prepare("SELECT * FROM capabilities WHERE name = ? AND version = ?")
      .get(name, version) as CapabilityRecord | undefined;
    return row ? this.hydrate(row) : undefined;
  }

  /** 当前可用能力：enabled 且（不指定时）任意 kind */
  list(filter: { enabledOnly?: boolean } = {}): CapabilityRecord[] {
    const rows = (filter.enabledOnly
      ? this.db.prepare("SELECT * FROM capabilities WHERE enabled = 1 ORDER BY name")
      : this.db.prepare("SELECT * FROM capabilities ORDER BY name"))
      .all() as unknown as CapabilityRecord[];
    return rows.map((r) => this.hydrate(r));
  }

  /** 按能力名匹配（任意版本，取最新注册的） */
  findByName(name: string): CapabilityRecord | undefined {
    const row = this.db
      .prepare("SELECT * FROM capabilities WHERE name = ? ORDER BY created_at DESC LIMIT 1")
      .get(name) as CapabilityRecord | undefined;
    return row ? this.hydrate(row) : undefined;
  }

  /** 禁用/启用（回滚 = 禁用，不删文件） */
  setEnabled(name: string, version: string, enabled: boolean): boolean {
    const r = this.db
      .prepare("UPDATE capabilities SET enabled = ? WHERE name = ? AND version = ?")
      .run(enabled ? 1 : 0, name, version);
    return r.changes > 0;
  }

  /** 健康检查：执行 skill 的 smoke 命令（若清单声明），更新 health 字段 */
  async healthCheck(name: string): Promise<"healthy" | "degraded" | "unknown"> {
    const cap = this.findByName(name);
    if (!cap) return "unknown";
    const manifest = this.loadManifest(name);
    if (!manifest?.smoke) {
      this.setHealth(name, "unknown");
      return "unknown";
    }
    try {
      const r = await new SkillRunner(this.skillsRoot).run(name, manifest.smoke.input, { timeoutMs: 15_000 });
      const out = (r.output ?? {}) as Record<string, unknown>;
      const expect = (manifest.smoke.expect ?? {}) as Record<string, unknown>;
      const ok = manifest.smoke.expect
        ? Object.entries(expect).every(([k, v]) => out[k] === v)
        : r.rc === 0;
      this.setHealth(name, ok ? "healthy" : "degraded");
      return ok ? "healthy" : "degraded";
    } catch {
      this.setHealth(name, "degraded");
      return "degraded";
    }
  }

  private setHealth(name: string, health: string): void {
    this.db.prepare("UPDATE capabilities SET health = ? WHERE name = ?").run(health, name);
  }

  /** 读取 Skill 清单（skillsRoot/<name>/skill.json） */
  loadManifest(name: string): SkillManifest | null {
    const p = path.join(this.skillsRoot, name, "skill.json");
    try {
      return JSON.parse(fs.readFileSync(p, "utf8")) as SkillManifest;
    } catch {
      return null;
    }
  }

  // ---- 权限授予/撤销（PLAN Step 4.4：用户批准的申请单路径，唯一授权入口）----

  /**
   * 授予权限（用户批准的申请单路径）。
   * 红线：必须在 skill.json 的 permissions 数组中已声明（防止越权授予未声明权限）。
   * 幂等：完全相同的 (capability, resource, mode) 已存在则不重复追加。
   */
  grantPermission(name: string, permission: Permission): { ok: boolean; reason?: string } {
    const cap = this.findByName(name);
    if (!cap) return { ok: false, reason: `能力未注册：${name}` };
    const manifest = this.loadManifest(name);
    if (!manifest) return { ok: false, reason: `skill.json 缺失：${name}` };
    const declared = (manifest.permissions ?? []) as Permission[];
    const isDeclared = declared.some(
      (d) => d.capability === permission.capability
        && d.resource === permission.resource
        && d.mode === permission.mode,
    );
    if (!isDeclared) {
      return {
        ok: false,
        reason: `权限未在 skill.json 中声明：${permission.capability}/${permission.resource}/${permission.mode}。`
          + `已声明：${declared.length === 0 ? "（无）" : declared.map((d) => `${d.capability}/${d.resource}/${d.mode}`).join(", ")}`,
      };
    }
    const current = cap.permissions as Permission[];
    const already = current.some(
      (p) => p.capability === permission.capability
        && p.resource === permission.resource
        && p.mode === permission.mode,
    );
    if (already) return { ok: true, reason: "权限已存在（幂等）" };
    const next = [...current, permission];
    this.db.prepare("UPDATE capabilities SET permissions = ? WHERE name = ? AND version = ?")
      .run(JSON.stringify(next), cap.name, cap.version);
    return { ok: true };
  }

  /** 撤销权限（按 capability + resource 精确匹配，mode 任意）。撤销总是允许（不需声明校验）。 */
  revokePermission(name: string, capability: string, resource: string): { ok: boolean; removed: number; reason?: string } {
    const cap = this.findByName(name);
    if (!cap) return { ok: false, removed: 0, reason: `能力未注册：${name}` };
    const current = cap.permissions as Permission[];
    const next = current.filter((p) => !(p.capability === capability && p.resource === resource));
    const removed = current.length - next.length;
    if (removed === 0) return { ok: true, removed: 0, reason: "无匹配权限" };
    this.db.prepare("UPDATE capabilities SET permissions = ? WHERE name = ? AND version = ?")
      .run(JSON.stringify(next), cap.name, cap.version);
    return { ok: true, removed };
  }

  /** 查询能力当前已授予权限（hydrate 后） */
  getPermissions(name: string): Permission[] {
    const cap = this.findByName(name);
    return (cap?.permissions ?? []) as Permission[];
  }

  /** 查询能力在 skill.json 中已声明的权限需求（供 grant 时校验参考） */
  getDeclaredPermissions(name: string): Permission[] {
    const manifest = this.loadManifest(name);
    return (manifest?.permissions ?? []) as Permission[];
  }

  private hydrate(row: CapabilityRecord): CapabilityRecord {
    return { ...row, permissions: JSON.parse(String(row.permissions ?? "[]")) };
  }

  close(): void {
    this.db.close();
  }
}

export interface RunResult {
  rc: number;
  output: unknown;
  stderr: string;
  durationMs: number;
}

/** Skill 执行器：子进程 + stdin JSON → stdout JSON；工作目录限定在 skill 目录内 */
export class SkillRunner {
  constructor(private readonly skillsRoot: string) {}

  async run(name: string, input: unknown, opts: { timeoutMs?: number } = {}): Promise<RunResult> {
    const dir = path.join(this.skillsRoot, name);
    const manifest = (() => {
      try {
        return JSON.parse(fs.readFileSync(path.join(dir, "skill.json"), "utf8")) as SkillManifest;
      } catch {
        throw new Error(`Skill 不存在或清单缺失：${name}`);
      }
    })();
    const started = Date.now();
    return await new Promise<RunResult>((resolve) => {
      // 入参只允许 entry 声明的命令 + 清单固定参数；输入经 stdin（防注入）
      const child = spawn(manifest.entry.command, manifest.entry.args ?? [], {
        cwd: dir,
        stdio: ["pipe", "pipe", "pipe"],
        timeout: opts.timeoutMs ?? 30_000,
      });
      let out = "";
      let err = "";
      child.stdout.on("data", (c) => (out += c));
      child.stderr.on("data", (c) => (err += c));
      child.on("close", (code) => {
        let parsed: unknown = null;
        try { parsed = out.trim() ? JSON.parse(out) : null; } catch { parsed = null; }
        resolve({ rc: code ?? -1, output: parsed, stderr: err, durationMs: Date.now() - started });
      });
      child.stdin?.end(JSON.stringify(input ?? {}));
    });
  }
}
