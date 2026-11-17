import fs from "node:fs";
import path from "node:path";
import type { ActivityEvent, AwarenessSource } from "./context-engine.js";

export interface FileWatchOptions {
  /** 显式授权的工作区；绝不默认扫描 Desktop/Documents/Home 根目录 */
  rootDir: string;
  maxFiles?: number;
  maxDepth?: number;
  now?: () => Date;
}

type FileState = { mtimeMs: number; size: number };

/** 只比较路径/mtime/size，不读取文件内容；首轮仅建基线，避免历史文件全部变成新事件。 */
export class FileWatchSource implements AwarenessSource {
  readonly id: string;
  private readonly rootDir: string;
  private readonly maxFiles: number;
  private readonly maxDepth: number;
  private readonly now: () => Date;
  private initialized = false;
  private snapshot = new Map<string, FileState>();
  private queue: ActivityEvent[] = [];

  constructor(opts: FileWatchOptions) {
    this.rootDir = path.resolve(opts.rootDir);
    this.id = `file-watch:${this.rootDir}`;
    this.maxFiles = opts.maxFiles ?? 2_000;
    this.maxDepth = opts.maxDepth ?? 4;
    this.now = opts.now ?? (() => new Date());
  }

  private scanFiles(): Map<string, FileState> {
    const files = new Map<string, FileState>();
    if (!fs.existsSync(this.rootDir)) return files;
    const visit = (dir: string, depth: number) => {
      if (depth > this.maxDepth || files.size >= this.maxFiles) return;
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        if (files.size >= this.maxFiles) break;
        if (entry.name.startsWith(".") || entry.name === "node_modules") continue;
        if (entry.isSymbolicLink()) continue;
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) visit(full, depth + 1);
        else if (entry.isFile()) {
          const stat = fs.statSync(full);
          files.set(path.relative(this.rootDir, full), { mtimeMs: stat.mtimeMs, size: stat.size });
        }
      }
    };
    visit(this.rootDir, 0);
    return files;
  }

  async sample(): Promise<ActivityEvent | null> {
    const current = this.scanFiles();
    if (!this.initialized) {
      this.snapshot = current;
      this.initialized = true;
      return null;
    }
    const at = this.now().toISOString();
    const events: ActivityEvent[] = [];
    for (const [relative, state] of current) {
      const before = this.snapshot.get(relative);
      if (!before || before.mtimeMs !== state.mtimeMs || before.size !== state.size) {
        events.push({ source: this.id, kind: "file_touch", app: "workspace", detail: relative, at });
      }
    }
    for (const relative of this.snapshot.keys()) {
      if (!current.has(relative)) events.push({ source: this.id, kind: "file_touch", app: "workspace", detail: `deleted:${relative}`, at });
    }
    this.snapshot = current;
    this.queue.push(...events.slice(0, 100));
    return this.queue.shift() ?? null;
  }
}
