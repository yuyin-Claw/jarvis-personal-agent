import { afterEach, describe, expect, it } from "vitest";
import { clearPlatformRegistry, detectPlatformId } from "@jarvis/platform";
import { initPlatform } from "./platform.js";

afterEach(() => clearPlatformRegistry());

describe("composition root 平台选择", () => {
  it("按 process.platform 推断", () => {
    expect(detectPlatformId({}, "darwin")).toBe("macos");
    expect(detectPlatformId({}, "linux")).toBe("omarchy");
  });

  it("initPlatform(omarchy) 返回五端点齐全的适配器", async () => {
    const p = await initPlatform("omarchy");
    expect(p.id).toBe("omarchy");
    for (const endpoint of [p.avatarHost, p.speechOutput, p.speechInput, p.foreground, p.notification]) {
      expect(endpoint.id).toBe("omarchy");
    }
  });

  it("重复初始化以最后一次注册为准，不串台", async () => {
    const a = await initPlatform("omarchy");
    const b = await initPlatform("omarchy");
    expect(a.id).toBe("omarchy");
    expect(b.id).toBe("omarchy");
  });
});
