import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { verifyContractShape } from "@jarvis/platform";
import { MacPlatformAdapter } from "./macos-adapter.js";

function adapter(platform: NodeJS.Platform = "linux", extra = {}) {
  return new MacPlatformAdapter({
    baseDir: mkdtempSync(join(tmpdir(), "mac-adapter-")),
    platform,
    exists: () => false,
    ...extra,
  });
}

describe("MacPlatformAdapter 契约", () => {
  it("五端点齐全、状态结构合法、id 一致", async () => {
    const p = adapter("linux");
    const statuses = await p.probe();
    expect(verifyContractShape(p, statuses)).toEqual([]);
    expect(statuses.every((s) => s.state === "unsupported")).toBe(true);
  });

  it("非 macOS 上能力明确降级，不静默假装成功", async () => {
    const p = adapter("linux");
    expect(await p.speechOutput.speak("hi")).toBe("unsupported");
    expect(await p.notification.send({ text: "hi" })).toBe(false);
    expect(await p.foreground.current()).toBeNull();
    const fast = new MacPlatformAdapter({
      baseDir: mkdtempSync(join(tmpdir(), "mac-cap-")),
      platform: "linux",
      exists: () => false,
      captureTimeoutMs: 30,
    });
    expect(await fast.avatarHost.capture("/tmp/none.png")).toBe(false);
    await expect(p.avatarHost.start()).rejects.toThrow(/darwin/);
  });

  it("macOS 上二进制缺失时标记 degraded（start 会现场编译）", async () => {
    const p = adapter("darwin");
    const s = await p.avatarHost.probe();
    expect(s.state).toBe("degraded");
    expect(s.detail).toContain("编译");
  });
});

describe("MacPlatformAdapter 状态通道", () => {
  it("setState 原子写状态文件且 seq 递增", async () => {
    const dir = mkdtempSync(join(tmpdir(), "mac-state-"));
    const p = new MacPlatformAdapter({ baseDir: dir, platform: "linux", exists: () => false });
    await p.avatarHost.setState({ state: "speaking", intensity: 0.8, caption: "你好" });
    await p.avatarHost.setState({ state: "working", intensity: 0.5 });
    const raw = JSON.parse(readFileSync(join(dir, "avatar.state.json"), "utf8"));
    expect(raw).toMatchObject({ seq: 2, state: "working", intensity: 0.5 });
  });

  it("识别事件通过 onEvent 分发，退订后不再收到", async () => {
    const dataCbs: Array<(c: string) => void> = [];
    const fake = {
      stdout: { on: (_e: string, cb: (c: string) => void) => { dataCbs.push(cb); return fake; } },
      on: () => fake,
      kill: () => true,
    };
    const p = new MacPlatformAdapter({
      baseDir: mkdtempSync(join(tmpdir(), "mac-events-")),
      platform: "darwin",
      exists: () => true,
      speechProcess: { spawnImpl: () => fake as never },
    });
    const got: string[] = [];
    const off = p.speechInput.onEvent((e) => got.push(e.type));
    await p.speechInput.start();
    dataCbs.forEach((cb) => cb('{"type":"partial","text":"你好"}\n{"type":"final","text":"你好"}\n'));
    off();
    dataCbs.forEach((cb) => cb('{"type":"partial","text":" again "}\n'));
    expect(got).toEqual(["partial", "final"]);
    await p.speechInput.stop();
  });

  it("通知与前台感知在非 macOS 上零副作用", async () => {
    const exec = vi.fn().mockResolvedValue({ stdout: "", stderr: "" });
    const p = new MacPlatformAdapter({
      baseDir: mkdtempSync(join(tmpdir(), "mac-noop-")),
      platform: "linux",
      exists: () => false,
      notifyExec: exec,
      foregroundExec: exec,
    });
    expect(await p.notification.send({ text: "x" })).toBe(false);
    expect(await p.foreground.current()).toBeNull();
    expect(exec).not.toHaveBeenCalled();
  });
});
