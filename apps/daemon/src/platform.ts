/**
 * Composition Root（ADR-007）：唯一决定「用哪套平台实现」的地方。
 *
 * Core / CLI 只拿 @jarvis/platform 的接口；平台实现按需动态加载，
 * 避免 macOS 原生依赖被静态带进 Omarchy 运行时。
 */
import { detectPlatformId, registerPlatform, resolvePlatform } from "@jarvis/platform";
import type { AdapterId, PlatformAdapter } from "@jarvis/platform";

export async function initPlatform(id: AdapterId = detectPlatformId()): Promise<PlatformAdapter> {
  if (id === "macos") {
    const { MacPlatformAdapter } = await import("@jarvis/adapter-macos");
    registerPlatform("macos", () => new MacPlatformAdapter());
  } else {
    const { OmarchyPlatformAdapter } = await import("@jarvis/adapter-omarchy");
    registerPlatform("omarchy", () => new OmarchyPlatformAdapter());
  }
  return resolvePlatform(id);
}
