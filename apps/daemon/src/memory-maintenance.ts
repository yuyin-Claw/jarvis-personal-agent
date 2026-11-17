import { MemoryDistiller, WikiCompiler, type MemorySummarizer, type WikiSynthesizer } from "@jarvis/memory";
import type { SqliteMemoryEngine } from "@jarvis/memory";

export interface MemoryMaintenanceOptions {
  engine: SqliteMemoryEngine;
  rootDir: string;
  summarize: MemorySummarizer;
  synthesize?: WikiSynthesizer;
  /** 每轮最多处理有新消息的会话数（默认 3） */
  maxConversations?: number;
  /** 单会话失败退避基数/上限 */
  baseBackoffMs?: number;
  maxBackoffMs?: number;
  now?: () => number;
}

export interface MemoryMaintenanceReport {
  skipped: boolean;
  scanned: number;
  records: number;
  wikiCompiled: boolean;
  overviewMode?: string;
  errors: string[];
}

/** 后台自动记忆维护：增量蒸馏 → dirty 时统一 Wiki 编译；失败可重试、不阻塞主对话。 */
export class MemoryMaintenance {
  private readonly distiller: MemoryDistiller;
  private readonly wiki: WikiCompiler;
  private readonly failures = new Map<string, { count: number; nextAt: number }>();
  private running = false;
  private readonly idleWaiters: Array<() => void> = [];
  private wikiDirty = true; // 启动首轮强制重建，覆盖上次异常退出窗口。

  constructor(private readonly opts: MemoryMaintenanceOptions) {
    this.distiller = new MemoryDistiller(opts.engine, opts.summarize);
    this.wiki = new WikiCompiler(opts.engine);
  }

  /** 优雅退出时等待当前轮次；调用方可与超时 Promise.race。 */
  waitForIdle(): Promise<void> {
    if (!this.running) return Promise.resolve();
    return new Promise((resolve) => this.idleWaiters.push(resolve));
  }

  async runOnce(): Promise<MemoryMaintenanceReport> {
    if (this.running) return { skipped: true, scanned: 0, records: 0, wikiCompiled: false, errors: [] };
    this.running = true;
    const report: MemoryMaintenanceReport = { skipped: false, scanned: 0, records: 0, wikiCompiled: false, errors: [] };
    const now = this.opts.now ?? Date.now;
    const maxConversations = this.opts.maxConversations ?? 3;
    const baseBackoff = this.opts.baseBackoffMs ?? 60_000;
    const maxBackoff = this.opts.maxBackoffMs ?? 3_600_000;

    try {
      for (const conversation of this.opts.engine.listConversations()) {
        if (report.scanned >= maxConversations) break;
        if (conversation.title.startsWith("__")) continue;
        const failure = this.failures.get(conversation.id);
        if (failure && now() < failure.nextAt) continue;

        const messages = this.opts.engine.listMessages(conversation.id);
        const lastId = messages.at(-1)?.id;
        if (!lastId || this.opts.engine.getDistilledMessageId(conversation.id) === lastId) continue;

        report.scanned++;
        try {
          const result = await this.distiller.distillConversation(conversation.id);
          this.failures.delete(conversation.id);
          report.records += result.records.length;
          if (result.records.length > 0) this.wikiDirty = true;
        } catch (e) {
          const count = (failure?.count ?? 0) + 1;
          const backoff = Math.min(maxBackoff, baseBackoff * 2 ** (count - 1));
          this.failures.set(conversation.id, { count, nextAt: now() + backoff });
          report.errors.push(`${conversation.id}: ${(e as Error).message}（${Math.round(backoff / 1000)}s 后重试）`);
        }
      }

      if (this.wikiDirty) {
        try {
          const result = await this.wiki.compile({ rootDir: this.opts.rootDir, synthesize: this.opts.synthesize });
          this.wikiDirty = false;
          report.wikiCompiled = true;
          report.overviewMode = result.overviewMode;
        } catch (e) {
          // dirty 保持 true；下轮即使无新对话也会继续重试 Wiki。
          report.errors.push(`wiki: ${(e as Error).message}`);
        }
      }
      return report;
    } finally {
      this.running = false;
      for (const resolve of this.idleWaiters.splice(0)) resolve();
    }
  }
}
