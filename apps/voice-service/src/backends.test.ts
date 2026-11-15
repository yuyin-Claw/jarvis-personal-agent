import { afterEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

/**
 * 防回归测试（ADR-009：语音服务零 macOS 依赖）：
 * 1. 源码中不存在 MacBackend / say / darwin 等任何 macOS 专有引用；
 * 2. createBackend 只接受 omarchy / upstream / fake；
 * 3. toWav 转码产物名契约：whisper.cpp 按 converted.wav → converted.txt 消费。
 */
const SRC = path.join(path.dirname(fileURLToPath(import.meta.url)), "backends.mjs");

describe("零 macOS 依赖守卫", () => {
  it("backends.mjs 不含 macOS 专有后端或工具引用", () => {
    const src = fs.readFileSync(SRC, "utf8");
    expect(src).not.toMatch(/\bMacBackend\b/);
    expect(src).not.toMatch(/\bafplay\b/);
    expect(src).not.toMatch(/darwin/i);
    expect(src).not.toMatch(/SFSpeech/i);
    // Apple 专有的语音合成 CLI 不得出现（which 调用 / 绝对路径 / 可执行查找三种形式）
    expect(src).not.toMatch(/which\(["']say["']\)/);
    expect(src).not.toMatch(/\/usr\/bin\/say/);
    expect(src).not.toMatch(/\bsay\s*\(/);
  });

  it("createBackend 拒绝 macos 后端", async () => {
    const mod = (await import("./backends.mjs")) as unknown as {
      createBackend(name: string): { describe(): { platform: string } };
    };
    expect(() => mod.createBackend("macos")).toThrow(/未知语音后端/);
  });

  it("auto 后端恒为 omarchy，与宿主平台无关", async () => {
    const mod = (await import("./backends.mjs")) as unknown as {
      createBackend(name?: string): { describe(): { platform: string } };
    };
    expect(mod.createBackend("auto").describe().platform).toBe("omarchy");
    expect(mod.createBackend().describe().platform).toBe("omarchy");
  });
});

describe("Omarchy 后端 whisper.cpp ASR 输出文件名契约", () => {
  const originalPath = process.env.PATH ?? "";
  let binDir = "";

  function fakeBin(name: string, body: string): void {
    const p = path.join(binDir, name);
    fs.writeFileSync(p, `#!/usr/bin/env node\n${body}\n`, { mode: 0o755 });
  }

  async function importBackend() {
    return (await import("./backends.mjs")) as {
      OmarchyBackend: new (env: NodeJS.ProcessEnv) => {
        transcribe(audio: Buffer, format: string, language: string): Promise<{ text: string }>;
      };
    };
  }

  it("读取 whisper-cli 按 -of 前缀生成的 out.txt", async () => {
    binDir = fs.mkdtempSync(path.join(os.tmpdir(), "jarvis-asr-test-"));
    fakeBin("ffmpeg", "require('fs').writeFileSync(process.argv[process.argv.length - 1], Buffer.from('RIFF'));");
    fakeBin(
      "whisper-cli",
      "const fs=require('fs'),p=require('path');" +
        "const dir=process.argv[process.argv.indexOf('-of')+1];" +
        "const of=p.dirname(process.argv[process.argv.indexOf('-of')+1]);" +
        "const argv=process.argv.slice(2);" +
        "const ofIdx=argv.indexOf('-of');" +
        "const prefix=argv[ofIdx+1];" +
        "fs.writeFileSync(prefix+'.txt','请介绍一下你自己。');",
    );
    process.env.PATH = `${binDir}:${originalPath}`;
    const mod = await importBackend();
    const backend = new mod.OmarchyBackend({
      ...process.env,
      JARVIS_ASR_SUPERWHISPER: "0",
      JARVIS_WHISPER_CPP_MODEL: "/tmp/model.bin",
    });
    const result = await backend.transcribe(Buffer.from("fake-wav"), "wav", "zh");
    expect(result.text).toBe("请介绍一下你自己。");
  });

  afterEach(() => {
    process.env.PATH = originalPath;
    if (binDir) fs.rmSync(binDir, { recursive: true, force: true });
    binDir = "";
  });
});
