import { ENDPOINTS } from "./types.js";
import type {
  AdapterId,
  AdapterStatus,
  CapabilityState,
  EndpointId,
  PlatformAdapter,
} from "./types.js";

const VALID: readonly CapabilityState[] = ["ready", "unavailable", "unsupported", "degraded"];

function status(id: AdapterId, endpoint: EndpointId, detail: string): AdapterStatus {
  return { id, endpoint, state: "unsupported", detail };
}

/** 能力缺失时的安全基线：全部明确报 unsupported，绝不静默假装成功 */
export function createNullPlatform(id: AdapterId): PlatformAdapter {
  const noop = async () => {};
  return {
    id,
    avatarHost: {
      id,
      start: noop,
      setState: noop,
      capture: async () => false,
      stop: noop,
      probe: async () => status(id, "avatarHost", "null adapter"),
    },
    speechOutput: {
      id,
      speak: async () => "unsupported",
      interrupt: () => {},
      speaking: false,
      probe: async () => status(id, "speechOutput", "null adapter"),
    },
    speechInput: {
      id,
      start: noop,
      stop: noop,
      onEvent: () => () => {},
      probe: async () => status(id, "speechInput", "null adapter"),
    },
    foreground: {
      id,
      current: async () => null,
      probe: async () => status(id, "foreground", "null adapter"),
    },
    notification: {
      id,
      send: async () => false,
      probe: async () => status(id, "notification", "null adapter"),
    },
    probe: async () => ENDPOINTS.map((e) => status(id, e, "null adapter")),
  };
}

/** 供各平台实现复用的契约检查：结构完整 + 状态合法 + 端点归属正确 */
export function verifyContractShape(adapter: PlatformAdapter, statuses: AdapterStatus[]): string[] {
  const errors: string[] = [];
  if (adapter.id !== "macos" && adapter.id !== "omarchy") errors.push(`非法 id: ${adapter.id}`);
  if (statuses.length !== ENDPOINTS.length) {
    errors.push(`端点数量 ${statuses.length}，应为 ${ENDPOINTS.length}`);
  }
  for (const endpoint of ENDPOINTS) {
    const hit = statuses.filter((s) => s.endpoint === endpoint);
    if (hit.length !== 1) errors.push(`端点 ${endpoint} 出现 ${hit.length} 次`);
  }
  for (const s of statuses) {
    if (s.id !== adapter.id) errors.push(`${s.endpoint} 的 id 不一致：${s.id}`);
    if (!VALID.includes(s.state)) errors.push(`${s.endpoint} 状态非法：${s.state}`);
    if (!ENDPOINTS.includes(s.endpoint)) errors.push(`未知端点：${s.endpoint}`);
  }
  for (const [name, impl] of [
    ["avatarHost", adapter.avatarHost],
    ["speechOutput", adapter.speechOutput],
    ["speechInput", adapter.speechInput],
    ["foreground", adapter.foreground],
    ["notification", adapter.notification],
  ] as const) {
    if (!impl) errors.push(`缺少端点实例：${name}`);
    else if (impl.id !== adapter.id) errors.push(`${name} 实例 id 不一致：${impl.id}`);
  }
  return errors;
}
