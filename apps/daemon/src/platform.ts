/**
 * Composition Root（ADR-007）：唯一决定「用哪套平台实现」的地方。
 *
 * Core / CLI 只拿 @jarvis/platform 的接口；平台实现按需动态加载，
 * 避免 macOS 原生依赖被静态带进 Omarchy 运行时。
 */
import { detectPlatformId, registerPlatform, resolvePlatform } from "@jarvis/platform";
import type { AdapterId, PlatformAdapter } from "@jarvis/platform";
import { withVoiceService } from "./voice-service.js";

export async function initPlatform(id: AdapterId = detectPlatformId()): Promise<PlatformAdapter> {
  if (id === "macos") {
    const { MacPlatformAdapter } = await import("@jarvis/adapter-macos");
    registerPlatform("macos", () => new MacPlatformAdapter());
  } else {
    const { OmarchyPlatformAdapter } = await import("@jarvis/adapter-omarchy");
    registerPlatform("omarchy", () => new OmarchyPlatformAdapter());
  }
  const platform = await resolvePlatform(id);
  // ADR-009：语音能力服务化。设置 JARVIS_VOICE_URL 即把两个语音端点切到
  // 独立语音服务进程（可运行在 Omarchy guest 内），其余平台端点不变。
  const voiceUrl = process.env.JARVIS_VOICE_URL;
  return voiceUrl ? withVoiceService(platform, { url: voiceUrl }) : platform;
}
