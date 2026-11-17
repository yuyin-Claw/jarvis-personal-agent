import type { SpeechInputEvent } from "@jarvis/platform";
import type { VoiceServiceSpeechInput } from "./voice-service.js";
import type { EmbodiedRuntime } from "./embodied.js";

/** 实时语音编排：partial 立即打断，final 进入完整 Orchestrator/Embodied 回复链。 */
export class LiveConversation {
  private detach?: () => void;
  private processing = false;

  constructor(
    private readonly input: Pick<VoiceServiceSpeechInput, "onEvent" | "startLive" | "stopLive">,
    private readonly runtime: EmbodiedRuntime,
    private readonly opts: { onInterrupt?: () => void } = {},
  ) {}

  async start(target?: string): Promise<void> {
    this.detach = this.input.onEvent((event) => this.onEvent(event));
    await this.runtime.start();
    await this.input.startLive(target);
  }

  private onEvent(event: SpeechInputEvent): void {
    if (event.type === "session_end") {
      this.opts.onInterrupt?.();
      const text = event.text?.trim() || "有事请随时叫我";
      void this.runtime.voice.speak(text).catch((e) => console.error(`〔退出唤醒提示失败〕${(e as Error).message}`));
      return;
    }
    if (event.type === "partial") {
      this.opts.onInterrupt?.();
      // 空文本也代表用户已开口：必须先打断，不能等 ASR 首字。
      if (this.runtime.voice.tts.speaking) this.runtime.voice.interrupt();
      else this.runtime.voice.startListening();
      return;
    }
    if (event.type !== "final" || this.processing) return;
    const text = event.text?.trim();
    if (!text) {
      this.runtime.voice.endListening("");
      return;
    }
    this.processing = true;
    void (async () => {
      try {
        this.runtime.voice.endListening(text);
        const result = await this.runtime.conversation.submit(text);
        if (!result.ok) console.error(`〔语音轮次失败〕${result.error ?? result.state}`);
      } catch (e) {
        console.error(`〔语音轮次异常〕${(e as Error).message}`);
      } finally {
        this.processing = false;
      }
    })();
  }

  async stop(): Promise<void> {
    this.opts.onInterrupt?.();
    this.detach?.();
    this.detach = undefined;
    await this.input.stopLive();
    await this.runtime.stop();
  }
}
