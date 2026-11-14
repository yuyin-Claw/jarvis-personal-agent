import { describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { ToolError, assertInside, checkCommand, toolReadFile, toolWriteFile, toolListFiles } from "./tools.js";

function tmpDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "jarvis-tools-"));
}

describe("路径沙箱", () => {
  it("工作目录内路径放行", () => {
    const dir = tmpDir();
    expect(assertInside(dir, "a.txt")).toBe(path.join(dir, "a.txt"));
    expect(assertInside(dir, "./sub/b.txt")).toBe(path.join(dir, "sub", "b.txt"));
    fs.rmSync(dir, { recursive: true });
  });

  it("越界路径被拦截（../ 逃逸 / 绝对路径）", () => {
    const dir = tmpDir();
    expect(() => assertInside(dir, "../escape.txt")).toThrow(ToolError);
    expect(() => assertInside(dir, "/etc/passwd")).toThrow(ToolError);
    expect(() => assertInside(dir, "sub/../../evil")).toThrow(ToolError);
    fs.rmSync(dir, { recursive: true });
  });
});

describe("文件工具", () => {
  it("读写列表闭环", () => {
    const dir = tmpDir();
    const w = toolWriteFile(dir, "src/hello.ts", "console.log('hi')");
    expect(w).toContain("已写入");
    const r = toolReadFile(dir, "src/hello.ts");
    expect(r).toContain("console.log");
    const list = toolListFiles(dir);
    expect(list).toContain("src/");
    fs.rmSync(dir, { recursive: true });
  });

  it("读工作目录外文件被拦截", () => {
    const dir = tmpDir();
    expect(() => toolReadFile(dir, "../../etc/passwd")).toThrow(ToolError);
    fs.rmSync(dir, { recursive: true });
  });
});

describe("命令安全", () => {
  it("白名单命令放行", () => {
    expect(() => checkCommand("node index.js")).not.toThrow();
    expect(() => checkCommand("git status")).not.toThrow();
    expect(() => checkCommand("npm test")).not.toThrow();
  });

  it("非白名单命令拦截", () => {
    expect(() => checkCommand("brew install wget")).toThrow(ToolError);
    expect(() => checkCommand("shutdown -h now")).toThrow(ToolError);
  });

  it("危险模式拦截（白名单内嵌危险也拦）", () => {
    expect(() => checkCommand("git push origin main")).toThrow(ToolError);
    // node -e 脚本内嵌 sudo/rm 模式：保守拦截（宁可误杀）
    expect(() =>
      checkCommand("node -e \"require('child_process').exec('sudo rm -rf /')\""),
    ).toThrow(ToolError);
    expect(() => checkCommand("cat x | sh")).toThrow(ToolError);
    expect(() => checkCommand("echo $(rm -rf /)")).toThrow(ToolError);
    expect(() => checkCommand("echo `id`")).toThrow(ToolError);
    // 正常 node 命令不受影响
    expect(() => checkCommand("node dist/cli.js")).not.toThrow();
  });
});
