/**
 * 具身运行时 Composition Root（0.2-④⑤）
 *
 * 唯一把「Core 决策 / 数字人状态机 / 语音 / 平台宿主」拼起来的地方：
 *   AvatarStateEngine ──onAesthetic──> PlatformAdapter.avatarHost（唯一渲染发布通道）
 *   EmbodiedConversation ──speaker──> VoiceIO ──> PlatformAdapter.speechOutput
 *   ContinuousRuntime 通知 ──> ProactiveVoiceChannel ──announce──> VoiceIO
 *   TaskManager 状态 diff ──> TaskEventWatcher ──> AvatarStateEngine
 *
 * Core 侧（packages/*）不 import 任何平台实现；此处只依赖 @jarvis/platform 契约。
 */
import { AvatarStateEngine, TaskEventWatcher } from "@jarvis/avatar";
import type { AestheticState } from "@jarvis/avatar";
import { EmbodiedConversation, ProactiveVoiceChannel } from "@jarvis/embodied";
import type { EmbodiedPhase, EmbodiedSpeaker, ReplyGenerator } from "@jarvis/embodied";
import type { PlatformAdapter } from "@jarvis/platform";
import type { TaskStatus } from "@jarvis/task-manager";
import { VoiceIO } from "@jarvis/voice";
import type { SpeechSynthesizer } from "@jarvis/voice";

export interface EmbodiedRuntimeOptions {
  platform: PlatformAdapter;
  /** Core 决策入口（CLI 注入 Orchestrator，验收脚本注入确定性 fake） */
  reply: ReplyGenerator;
  /** 提供后监听任务状态 diff，自动表现 working/responding */
  tasks?: { list(): Array<{ id: string; status: TaskStatus }> };
  /** 只写 AIFF 不发声（自动验收） */
  speechOutputFile?: string;
  /** 关闭宿主窗口（无 GUI 环境）；默认启用 */
  avatar?: boolean;
  /** 关闭语音（含主动开口）；默认启用 */
  voice?: boolean;
  /** 播放期间强度包络（默认跟随 voice；自动截图验收需关闭，避免状态文件被覆盖） */
  envelope?: boolean;
  /** 每阶段回调（验收截图 / 可观测性） */
  onPhase?: (phase: EmbodiedPhase, aesthetic: AestheticState) => void | Promise<void>;
}

export interface EmbodiedRuntime {
  readonly engine: AvatarStateEngine;
  readonly conversation: EmbodiedConversation;
  readonly voice: VoiceIO;
  readonly proactive: ProactiveVoiceChannel;
  /** 全程表现层快照（验收/审计） */
  readonly states: AestheticState[];
  start(): Promise<void>;
  stop(): Promise<void>;
  capture(path: string): Promise<boolean>;
}

export function createEmbodiedRuntime(opts: EmbodiedRuntimeOptions): EmbodiedRuntime {
  const platform = opts.platform;
  const avatarEnabled = opts.avatar !== false;
  const voiceEnabled = opts.voice !== false;
  const engine = new AvatarStateEngine();
  const states: AestheticState[] = [];

  engine.onAesthetic((a) => {
    states.push({ ...a });
    if (!avatarEnabled) return;
    void platform.avatarHost
      .setState({ state: a.state, intensity: a.intensity, caption: a.caption })
      .catch(() => undefined);
  });

  // 平台 TTS 适配 → VoiceIO 需要的 SpeechSynthesizer 契约
  const tts: SpeechSynthesizer = {
    speak: (text) =>
      platform.speechOutput.speak(text, opts.speechOutputFile ? { outputFile: opts.speechOutputFile } : {}),
    interrupt: () => platform.speechOutput.interrupt(),
    get speaking() {
      return platform.speechOutput.speaking;
    },
  };
  const voice = new VoiceIO(tts, engine, { envelope: opts.envelope ?? voiceEnabled });

  const speaker: EmbodiedSpeaker = voiceEnabled
    ? {
        speak: (text) => voice.speak(text),
        interrupt: () => voice.interrupt(),
        get speaking() {
          return tts.speaking;
        },
        emitsStateEvents: true, // VoiceIO 自行派 tts_* / user_interrupt
      }
    : {
        // 静音模式：不发声，也不自派 tts_end（由对话编排补齐，状态弧仍完整）
        speak: async () => undefined,
        interrupt: () => undefined,
        speaking: false,
        emitsStateEvents: false,
      };

  const conversation = new EmbodiedConversation({
    sink: engine,
    reply: opts.reply,
    speaker,
    onPhase: opts.onPhase,
  });

  const proactive = new ProactiveVoiceChannel({
    engine,
    announcer: voice,
    enabled: voiceEnabled,
  });

  const watcher = opts.tasks ? new TaskEventWatcher(opts.tasks, engine) : undefined;
  let started = false;

  return {
    engine,
    conversation,
    voice,
    proactive,
    states,
    async start() {
      if (started) return;
      if (avatarEnabled) await platform.avatarHost.start();
      watcher?.start();
      started = true;
    },
    async stop() {
      watcher?.stop();
      voice.dispose();
      proactive.dispose();
      if (started && avatarEnabled) await platform.avatarHost.stop();
      started = false;
    },
    capture: (path) => platform.avatarHost.capture(path),
  };
}
