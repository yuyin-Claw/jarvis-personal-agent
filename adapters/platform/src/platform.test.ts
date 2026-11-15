import { afterEach, describe, expect, it } from "vitest";
import {
  clearPlatformRegistry,
  createNullPlatform,
  detectPlatformId,
  ENDPOINTS,
  probePlatform,
  registerPlatform,
  resolvePlatform,
  verifyContractShape,
} from "./index.js";
import type { PlatformAdapter } from "./types.js";

afterEach(() => clearPlatformRegistry());

describe("平台选择与注册表", () => {
  it("按 process.platform 推断；JARVIS_PLATFORM 显式覆盖", () => {
    expect(detectPlatformId({}, "darwin")).toBe("macos");
    expect(detectPlatformId({}, "linux")).toBe("omarchy");
    expect(detectPlatformId({ JARVIS_PLATFORM: "omarchy" }, "darwin")).toBe("omarchy");
    expect(detectPlatformId({ JARVIS_PLATFORM: "bogus" }, "darwin")).toBe("macos");
  });

  it("未注册时明确报错，不静默回退", async () => {
    await expect(resolvePlatform("omarchy")).rejects.toThrow(/not registered/);
  });

  it("注册后返回实例；id 不一致时拒绝", async () => {
    registerPlatform("macos", () => createNullPlatform("macos"));
    expect((await resolvePlatform("macos")).id).toBe("macos");
    registerPlatform("omarchy", () => createNullPlatform("macos"));
    await expect(resolvePlatform("omarchy")).rejects.toThrow(/id mismatch/);
  });
});

describe("平台契约", () => {
  it("Null 平台五端点齐全且全部 unsupported", async () => {
    const p = createNullPlatform("omarchy");
    const statuses = await p.probe();
    expect(verifyContractShape(p, statuses)).toEqual([]);
    expect(statuses.every((s) => s.state === "unsupported")).toBe(true);
    expect(statuses.map((s) => s.endpoint)).toEqual([...ENDPOINTS]);
    expect(await p.speechOutput.speak("hi")).toBe("unsupported");
    expect(await p.avatarHost.capture("/tmp/x.png")).toBe(false);
    expect(await p.foreground.current()).toBeNull();
    expect(await p.notification.send({ text: "hi" })).toBe(false);
  });

  it("probePlatform 在单个端点探测抛错时降级为 unavailable", async () => {
    const p = createNullPlatform("macos");
    p.foreground.probe = async () => { throw new Error("dbus down"); };
    const statuses = await probePlatform(p);
    expect(statuses.find((s) => s.endpoint === "foreground")?.state).toBe("unavailable");
    expect(verifyContractShape(p, statuses)).toEqual([]);
  });

  it("契约检查能抓出端点缺失、状态非法、id 串台", () => {
    const p: PlatformAdapter = createNullPlatform("macos");
    const good = ENDPOINTS.map((endpoint) => ({ id: "macos" as const, endpoint, state: "ready" as const }));
    expect(verifyContractShape(p, good)).toEqual([]);
    expect(verifyContractShape(p, good.slice(1)).length).toBeGreaterThan(0);
    expect(verifyContractShape(p, [{ ...good[0], state: "bogus" as never }, ...good.slice(1)]).length).toBeGreaterThan(0);
    expect(verifyContractShape(p, [{ ...good[0], id: "omarchy" }, ...good.slice(1)]).length).toBeGreaterThan(0);
  });
});
