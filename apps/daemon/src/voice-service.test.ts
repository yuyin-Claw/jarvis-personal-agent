import { describe, expect, it, vi } from "vitest";
import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { PlatformAdapter } from "@jarvis/platform";
import {
  VoiceServiceSpeechInput, VoiceServiceSpeechOutput, withVoiceService,
} from "./voice-service.js";

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

function fakeFetch(handlers: Record<string, (body: Record<string, unknown>, init?: RequestInit) => unknown>) {
  return vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
    const route = String(url).split("/").pop() ?? "";
    const body = init?.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : {};
    const h = handlers[route];
    if (!h) return jsonResponse({ ok: false, error: "not found" }, 404);
    return jsonResponse(h(body, init));
  }) as unknown as typeof fetch;
}

function stubPlatform(): PlatformAdapter {
  return {
    id: "macos",
    probe: async () => [{ id: "macos", endpoint: "avatarHost", state: "ready" }],
  } as unknown as PlatformAdapter;
}

describe("语音服务端点（ADR-009）", () => {
  it("withVoiceService 只替换两个语音端点，其余平台端点不变", async () => {
    const base = stubPlatform();
    const p = withVoiceService(base, {
      url: "http://127.0.0.1:9999/",
      fetchImpl: fakeFetch({ health: () => ({ ok: true, contract: "1.0", platform: "macos",
        asr: { engine: "whisper", ready: true }, tts: { engine: "say", ready: true }, upstream: null, ready: true }) }),
    });
    expect(p.id).toBe("macos");
    expect(p.avatarHost).toBe(base.avatarHost);
    expect(p.speechOutput).toBeInstanceOf(VoiceServiceSpeechOutput);
    expect(p.speechInput).toBeInstanceOf(VoiceServiceSpeechInput);
    const statuses = await p.probe();
    expect(statuses.find((s) => s.endpoint === "avatarHost")?.state).toBe("ready");
    expect(statuses.find((s) => s.endpoint === "speechOutput")?.state).toBe("ready");
    expect(statuses.find((s) => s.endpoint === "speechInput")?.detail).toContain("whisper");
  });

  it("speak 把服务返回的音频静默写入 outputFile", async () => {
    const dir = mkdtempSync(join(tmpdir(), "jarvis-vs-test-"));
    const file = join(dir, "reply.aiff");
    const audio = Buffer.from("AIFF-TEST-AUDIO");
    const out = new VoiceServiceSpeechOutput("macos", {
      url: "http://x", fetchImpl: fakeFetch({
        tts: () => ({ ok: true, audio: audio.toString("base64"), format: "aiff", sampleRate: 22050 }),
      }),
    });
    expect(await out.speak("你好", { outputFile: file })).toBe("completed");
    expect(existsSync(file)).toBe(true);
    expect(readFileSync(file).toString()).toBe(audio.toString());
    expect(out.speaking).toBe(false);
  });

  it("服务不可用时 probe=unavailable、speak=error，不抛异常", async () => {
    const out = new VoiceServiceSpeechOutput("macos", {
      url: "http://x",
      fetchImpl: (async () => { throw new Error("ECONNREFUSED"); }) as unknown as typeof fetch,
    });
    expect((await out.probe()).state).toBe("unavailable");
    expect(await out.speak("你好", { outputFile: join(tmpdir(), "no.aiff") })).toBe("error");
  });

  it("submitAudio 走真实 ASR 响应并派发 partial → final", async () => {
    const input = new VoiceServiceSpeechInput("macos", {
      url: "http://x", fetchImpl: fakeFetch({
        asr: (body) => ({ ok: true, text: body.audio ? "请介绍一下你自己" : "", engine: "openai-whisper", model: "base" }),
      }),
    });
    const events: string[] = [];
    input.onEvent((e) => events.push(`${e.type}:${e.text ?? ""}`));
    const text = await input.submitAudio(Buffer.alloc(1024), "aiff", "zh");
    expect(text).toBe("请介绍一下你自己");
    expect(events).toEqual(["partial:请介绍一下你自己", "final:请介绍一下你自己"]);
  });

  it("合成阶段即可被打断（用户开口取消未完成的 TTS 请求）", async () => {
    let signal: AbortSignal | undefined;
    let resolveFetch: ((r: Response) => void) | undefined;
    const pending = new Promise<Response>((r) => { resolveFetch = r; });
    const fetchImpl = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      signal = init?.signal ?? undefined;
      return pending;
    }) as unknown as typeof fetch;
    const out = new VoiceServiceSpeechOutput("macos", { url: "http://x", fetchImpl });
    const p = out.speak("很长的一段回复", { outputFile: join(tmpdir(), "unused.aiff") });
    expect(out.speaking).toBe(true);
    out.interrupt();
    expect(signal?.aborted).toBe(true);
    resolveFetch?.(jsonResponse({ ok: true, audio: "AAAA", format: "aiff" }));
    expect(await p).toBe("interrupted");
    expect(out.speaking).toBe(false);
  });
});
