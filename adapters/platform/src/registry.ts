import type {
  AdapterId,
  AdapterStatus,
  PlatformAdapter,
} from "./types.js";

export type PlatformFactory = () => PlatformAdapter | Promise<PlatformAdapter>;

const registry = new Map<AdapterId, PlatformFactory>();

/** composition root 调用；同 id 重复注册以最后一次为准 */
export function registerPlatform(id: AdapterId, factory: PlatformFactory): void {
  registry.set(id, factory);
}

export function clearPlatformRegistry(): void {
  registry.clear();
}

/** 显式 JARVIS_PLATFORM 优先，否则按 process.platform 推断 */
export function detectPlatformId(
  env: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
): AdapterId {
  const forced = env.JARVIS_PLATFORM;
  if (forced === "macos" || forced === "omarchy") return forced;
  return platform === "darwin" ? "macos" : "omarchy";
}

/** 未注册时明确报错，不静默回退到另一个平台（避免把 macOS 实现跑在 Omarchy 上） */
export async function resolvePlatform(id: AdapterId = detectPlatformId()): Promise<PlatformAdapter> {
  const factory = registry.get(id);
  if (!factory) {
    throw new Error(
      `platform adapter '${id}' is not registered; call registerPlatform() in the composition root`,
    );
  }
  const adapter = await factory();
  if (adapter.id !== id) {
    throw new Error(`platform adapter id mismatch: requested ${id}, got ${adapter.id}`);
  }
  return adapter;
}

/** 汇总五个端点状态，单个端点探测失败也降级为 unavailable 而不让整体崩 */
export async function probePlatform(adapter: PlatformAdapter): Promise<AdapterStatus[]> {
  const pairs = [
    ["avatarHost", adapter.avatarHost],
    ["speechOutput", adapter.speechOutput],
    ["speechInput", adapter.speechInput],
    ["foreground", adapter.foreground],
    ["notification", adapter.notification],
  ] as const;
  const out: AdapterStatus[] = [];
  for (const [endpoint, impl] of pairs) {
    try {
      out.push(await impl.probe());
    } catch (e) {
      out.push({ id: adapter.id, endpoint, state: "unavailable", detail: String(e) });
    }
  }
  return out;
}
