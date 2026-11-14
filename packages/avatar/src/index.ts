export { AvatarStateEngine, BASELINE } from "./state-engine.js";
export type {
  AestheticState,
  AvatarState,
  AvatarStateEngineOptions,
  CoreEvent,
  StateTransition,
} from "./state-engine.js";
export { TaskEventWatcher, conversationEvents, taskEventFor } from "./event-bridge.js";
export { AvatarRenderTransport } from "./render-transport.js";
export type { RenderAck, RenderPayload, RenderTransportOptions } from "./render-transport.js";
