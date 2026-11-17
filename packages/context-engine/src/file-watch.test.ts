import { afterEach, beforeEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { FileWatchSource } from "./file-watch.js";

let root: string;
beforeEach(() => { root = fs.mkdtempSync(path.join(os.tmpdir(), "jarvis-watch-")); });
afterEach(() => { fs.rmSync(root, { recursive: true, force: true }); });

describe("FileWatchSource", () => {
  it("首轮建基线，之后检测新增/修改/删除且不读内容", async () => {
    const file = path.join(root, "task.md");
    fs.writeFileSync(file, "initial");
    const source = new FileWatchSource({ rootDir: root });
    expect(await source.sample()).toBeNull();

    fs.writeFileSync(file, "changed");
    const created = await source.sample();
    expect(created).toMatchObject({ kind: "file_touch", detail: "task.md" });
    expect(await source.sample()).toBeNull();

    fs.writeFileSync(file, "changed-again");
    expect((await source.sample())?.detail).toBe("task.md");
    fs.unlinkSync(file);
    expect((await source.sample())?.detail).toBe("deleted:task.md");
  });

  it("隐藏目录、node_modules 与符号链接被忽略", async () => {
    fs.mkdirSync(path.join(root, "node_modules"));
    fs.writeFileSync(path.join(root, "node_modules", "ignored.js"), "x");
    fs.writeFileSync(path.join(root, "visible.ts"), "x");
    fs.symlinkSync(path.join(root, "visible.ts"), path.join(root, "link.ts"));
    const source = new FileWatchSource({ rootDir: root });
    await source.sample();
    fs.writeFileSync(path.join(root, "node_modules", "ignored.js"), "y");
    fs.writeFileSync(path.join(root, "visible.ts"), "y");
    expect((await source.sample())?.detail).toBe("visible.ts");
    expect(await source.sample()).toBeNull();
  });
});
