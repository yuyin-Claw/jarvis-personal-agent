import { describe, expect, it, vi } from "vitest";
import { verifyContractShape } from "@jarvis/platform";
import { GdbusCaptureAuthorization, HyprlandIpc } from "./native.js";
import { OmarchyPlatformAdapter } from "./omarchy-adapter.js";
import type { OmarchyProc } from "./omarchy-adapter.js";

function fakeProc() {
  const cbs: Record<string, Array<(v?: unknown) => void>> = {};
  const p: OmarchyProc & { dataCbs: Array<(c: string) => void>; killed: boolean } = {
    killed: false,
    dataCbs: [],
    stdout: { on: (_e, cb) => { p.dataCbs.push(cb); return p; } },
    on: (e, cb) => { (cbs[e] ??= []).push(cb); return p; },
    kill: () => { p.killed = true; cbs.close?.forEach((f) => f()); return true; },
  };
  return p;
}

function opts(overrides: Record<string, unknown> = {}) {
  return {
    platform: "linux" as NodeJS.Platform,
    env: { XDG_RUNTIME_DIR: "/run/user/1000", HYPRLAND_INSTANCE_SIGNATURE: "test-sig" },
    exists: () => false,
    hasCommand: async () => false,
    hasAudio: () => false,
    exec: async () => ({ stdout: "", stderr: "" }),
    authorization: { authorize: async () => ({ ok: false, detail: "denied" }) },
    ipc: { socketPath: () => "/run/user/1000/hypr/test-sig/.socket.sock", activeWindow: async () => null },
    ...overrides,
  };
}

describe("OmarchyPlatformAdapter 契约", () => {
  it("五端点齐全、状态结构合法、id 一致", async () => {
    const p = new OmarchyPlatformAdapter(opts());
    const statuses = await p.probe();
    expect(verifyContractShape(p, statuses)).toEqual([]);
    expect(statuses).toHaveLength(5);
  });

  it("非 Linux 上全部明确 unsupported", async () => {
    const p = new OmarchyPlatformAdapter(opts({ platform: "darwin" }));
    const s = await p.probe();
    expect(s.every((x) => x.state === "unsupported")).toBe(true);
    expect(await p.speechOutput.speak("hi")).toBe("unsupported");
    expect(await p.notification.send({ text: "hi" })).toBe(false);
    await expect(p.avatarHost.start()).rejects.toThrow(/Linux/);
  });

  it("依赖缺失时返回 unavailable，不假装可用", async () => {
    const s = await new OmarchyPlatformAdapter(opts()).probe();
    expect(s.find((x) => x.endpoint === "speechOutput")?.state).toBe("unavailable");
    expect(s.find((x) => x.endpoint === "notification")?.state).toBe("unavailable");
    expect(s.find((x) => x.endpoint === "speechInput")?.state).toBe("unavailable");
  });
});

describe("架构红线：麦克风采集必须先授权", () => {
  it("Portal 授权失败 → 绝不启动 pw-record，且发出 error", async () => {
    const spawnImpl = vi.fn(() => fakeProc());
    const p = new OmarchyPlatformAdapter(opts({
      spawnImpl,
      authorization: { authorize: async () => ({ ok: false, detail: "Portal 拒绝" }) },
      hasCommand: async () => true,
    }));
    const events: string[] = [];
    p.speechInput.onEvent((e) => events.push(e.type));
    await p.speechInput.start();
    expect(spawnImpl).not.toHaveBeenCalled();
    expect(events).toEqual(["error"]);
  });

  it("授权成功 + 依赖齐全 → 启动采集并上报 ready/status", async () => {
    const proc = fakeProc();
    const spawnImpl = vi.fn(() => proc);
    const authorize = vi.fn(async () => ({ ok: true, detail: "granted" }));
    const p = new OmarchyPlatformAdapter(opts({ spawnImpl, authorization: { authorize }, hasCommand: async () => true }));
    const events: string[] = [];
    p.speechInput.onEvent((e) => events.push(e.type));
    await p.speechInput.start();
    expect(authorize).toHaveBeenCalledWith("microphone");
    expect(spawnImpl).toHaveBeenCalledWith("pw-record", expect.any(Array));
    expect(events).toContain("ready");
    expect(events).toContain("status");
    await p.speechInput.stop();
    expect(proc.killed).toBe(true);
  });

  it("GdbusCaptureAuthorization 麦克风路径检查 Portal 存活", async () => {
    const exec = vi.fn(async () => ({ stdout: "('ok',)", stderr: "" }));
    const auth = new GdbusCaptureAuthorization(exec);
    const r = await auth.authorize("microphone");
    expect(r.ok).toBe(true);
    expect(exec).toHaveBeenCalledWith("gdbus", expect.arrayContaining(["org.freedesktop.portal.Settings.ReadAll"]));
  });
});

describe("Hyprland IPC / 通知 / TTS / 宿主", () => {
  it("hyprctl activewindow 解析为 ForegroundContext", async () => {
    const p = new OmarchyPlatformAdapter(opts({
      ipc: { socketPath: () => "/x/.socket.sock", activeWindow: async () => ({ app: "foot", title: "PRD.md" }) },
    }));
    const ctx = await p.foreground.current();
    expect(ctx).toMatchObject({ app: "foot", title: "PRD.md" });
    expect((await p.foreground.probe()).state).toBe("ready");
  });

  it("HyprlandIpc 从环境变量拼 socket 路径", () => {
    expect(new HyprlandIpc(undefined, { XDG_RUNTIME_DIR: "/run/user/1000", HYPRLAND_INSTANCE_SIGNATURE: "abc" }).socketPath())
      .toBe("/run/user/1000/hypr/abc/.socket.sock");
    expect(new HyprlandIpc(undefined, {}).socketPath()).toBeNull();
  });

  it("notify-send 按优先级映射 urgency", async () => {
    const exec = vi.fn(async () => ({ stdout: "", stderr: "" }));
    const p = new OmarchyPlatformAdapter(opts({ exec, hasCommand: async () => true }));
    expect(await p.notification.send({ text: "任务完成", priority: "high" })).toBe(true);
    expect(exec).toHaveBeenCalledWith("notify-send", expect.arrayContaining(["-u", "critical", "任务完成"]));
  });

  it("TTS 打断返回 interrupted 而不是 completed", async () => {
    const proc = fakeProc();
    const spawnImpl = vi.fn(() => proc);
    const p = new OmarchyPlatformAdapter(opts({ spawnImpl, hasCommand: async () => true }));
    const pending = p.speechOutput.speak("你好", { outputFile: "/tmp/a.wav" });
    expect(spawnImpl).toHaveBeenCalledWith("espeak-ng", ["-w", "/tmp/a.wav", "你好"]);
    p.speechOutput.interrupt();
    expect(await pending).toBe("interrupted");
  });

  it("AvatarHost 状态帧写 socket，capture 走 grim 并写 .done", async () => {
    const socketWrite = vi.fn(async () => {});
    const writeDone = vi.fn();
    const exec = vi.fn(async () => ({ stdout: "", stderr: "" }));
    const spawnImpl = vi.fn(() => fakeProc());
    const p = new OmarchyPlatformAdapter(opts({ socketWrite, writeDone, exec, spawnImpl, exists: () => true }));
    await p.avatarHost.start({ x: 10, y: 20, width: 300, height: 400 });
    expect(spawnImpl).toHaveBeenCalledWith("python3", expect.arrayContaining(["--socket", expect.any(String)]));
    await p.avatarHost.setState({ state: "speaking", intensity: 0.8 });
    expect(socketWrite).toHaveBeenCalledWith(expect.any(String), expect.stringContaining('"state":"speaking"'));
    expect(await p.avatarHost.capture("/tmp/shot.png")).toBe(true);
    expect(exec).toHaveBeenCalledWith("grim", ["-g", "10,20 300x400", "/tmp/shot.png"]);
    expect(writeDone).toHaveBeenCalledWith("/tmp/shot.png.done");
  });
});
