/**
 * Context Engine（PRD FR-11 Ambient 感知 / 架构 §3.9）
 *
 * 用户活动（正在用什么应用/什么文件/什么窗口）进入 Timeline，
 * 规则提取（无 LLM）产生 Context；推断必须有据且可追溯。
 * 红线：感知不落原始敏感内容；来源标记清楚；用户可清空。
 */

/** 单条活动事件 */
export interface ActivityEvent {
  /** 来源标识：macos-foreground / hyprland-window / file-watch … */
  source: string;
  /** 事件类型 */
  kind: "app_focus" | "window_title" | "file_touch" | "idle" | "custom";
  /** 应用名/标识 */
  app: string;
  /** 摘要（已脱敏的窗口标题/文件名） */
  detail?: string;
  at: string;
}

/** 感知源接口（Awareness Source，架构 §3.9） */
export interface AwarenessSource {
  readonly id: string;
  /** 采集一次当前活动（无副作用；失败返回空） */
  sample(): Promise<ActivityEvent | null>;
}

/** 时间段聚合后的活动概要 */
export interface ActivitySummary {
  app: string;
  /** 该时段内出现次数（折叠后） */
  hits: number;
  /** 首末出现时间 */
  firstAt: string;
  lastAt: string;
  /** 折叠的窗口标题样本（最多 3 条） */
  details: string[];
}

/** 隐私脱敏器：窗口标题/文件名里的敏感内容置空 */
export interface DetailSanitizer {
  sanitize(detail: string): string | null; // null = 整条拒收
}

/** 默认脱敏规则（浏览器无痕/密码管理器/银行/私聊关键词 → 拒收 detail） */
export class DefaultDetailSanitizer implements DetailSanitizer {
  private readonly rejectPatterns = [
    /隐身|incognito|private/i,
    /密码|password|1password|bitwarden|keepass/i,
    /银行|bank|支付|alipay|wechat.?pay/i,
    /微信|wechat|telegram|whatsapp|signal|消息/i,
  ];

  sanitize(detail: string): string | null {
    for (const p of this.rejectPatterns) {
      if (p.test(detail)) return null;
    }
    // 邮箱/长数字脱敏
    return detail
      .replace(/[\w.+-]+@[\w-]+\.[\w.]+/g, "[邮箱]")
      .replace(/\b\d{9,}\b/g, "[数字]")
      .slice(0, 120);
  }
}

/** Context Engine：采集 → 脱敏 → 去重折叠 → 入库（activities 表） */
import type Database from "better-sqlite3";

export interface ContextEngineOptions {
  /** 复用 memory 的库连接（activities 与 memories 同库不同表） */
  db: Database.Database;
  sanitizer?: DetailSanitizer;
  /** 连续同 app 事件折叠窗口（默认 5 分钟内不重复记录） */
  foldWindowMs?: number;
}

export class ContextEngine {
  private readonly db: Database.Database;
  private readonly sanitizer: DetailSanitizer;
  private readonly foldWindowMs: number;

  constructor(opts: ContextEngineOptions) {
    this.db = opts.db;
    this.sanitizer = opts.sanitizer ?? new DefaultDetailSanitizer();
    this.foldWindowMs = opts.foldWindowMs ?? 5 * 60_000;
  }

  migrate(): void {
    this.db.exec(`CREATE TABLE IF NOT EXISTS activities (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      source TEXT NOT NULL,
      kind TEXT NOT NULL,
      app TEXT NOT NULL,
      detail TEXT,
      at TEXT NOT NULL
    )`);
    this.db.exec("CREATE INDEX IF NOT EXISTS idx_activities_at ON activities(at)");
    this.db.exec("CREATE INDEX IF NOT EXISTS idx_activities_app ON activities(app, at)");
  }

  /** 采集一个事件：脱敏 → 折叠去重 → 入库 */
  record(event: ActivityEvent): boolean {
    const detail = event.detail ? this.sanitizer.sanitize(event.detail) : undefined;
    const at = new Date(event.at);

    // 折叠：同 source+app+kind 在窗口内已有记录则跳过
    const last = this.db
      .prepare(
        "SELECT at, detail FROM activities WHERE source = ? AND app = ? AND kind = ? ORDER BY id DESC LIMIT 1",
      )
      .get(event.source, event.app, event.kind) as { at: string; detail: string | null } | undefined;
    if (last) {
      const lastAt = new Date(last.at).getTime();
      const sameDetail = (last.detail ?? undefined) === detail;
      if (at.getTime() - lastAt < this.foldWindowMs && sameDetail) {
        return false; // 折叠掉
      }
    }

    this.db
      .prepare("INSERT INTO activities (source, kind, app, detail, at) VALUES (?,?,?,?,?)")
      .run(event.source, event.kind, event.app, detail ?? null, event.at);
    return true;
  }

  /** 从感知源采集一次 */
  async sampleFrom(source: AwarenessSource): Promise<boolean> {
    const ev = await source.sample().catch(() => null);
    if (!ev) return false;
    return this.record(ev);
  }

  /** 时间段活动概要（按 app 聚合） */
  summarize(fromIso: string, toIso: string): ActivitySummary[] {
    const rows = this.db
      .prepare("SELECT * FROM activities WHERE at >= ? AND at <= ? ORDER BY at")
      .all(fromIso, toIso) as Array<{ app: string; detail: string | null; at: string }>;
    const byApp = new Map<string, ActivitySummary>();
    for (const r of rows) {
      let s = byApp.get(r.app);
      if (!s) {
        s = { app: r.app, hits: 0, firstAt: r.at, lastAt: r.at, details: [] };
        byApp.set(r.app, s);
      }
      s.hits++;
      s.lastAt = r.at;
      if (r.detail && !s.details.includes(r.detail) && s.details.length < 3) {
        s.details.push(r.detail);
      }
    }
    return [...byApp.values()].sort((a, b) => b.hits - a.hits);
  }

  /** 当前上下文快照（供 Orchestrator 注入）：最近 N 分钟高频 app */
  currentContext(minutes = 30): ActivitySummary[] {
    const from = new Date(Date.now() - minutes * 60_000).toISOString();
    return this.summarize(from, new Date().toISOString()).slice(0, 5);
  }

  /** 用户清空（红线：用户可删） */
  purge(): number {
    const res = this.db.prepare("DELETE FROM activities").run();
    return res.changes;
  }

  count(): number {
    return (this.db.prepare("SELECT COUNT(*) c FROM activities").get() as { c: number }).c;
  }
}
