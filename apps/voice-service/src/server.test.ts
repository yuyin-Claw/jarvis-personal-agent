import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { spawn, type ChildProcess } from "node:child_process";
import { fileURLToPath } from "node:url";

const serverPath = fileURLToPath(new URL("./server.mjs", import.meta.url));
let proc: ChildProcess;
let base = "";

async function post(route: string, body: unknown) {
  return fetch(`${base}/${route}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

beforeAll(async () => {
  proc = spawn(process.execPath, [serverPath, "--backend", "fake", "--port", "0"], {
    stdio: ["ignore", "pipe", "pipe"],
  });
  let out = "";
  proc.stdout?.on("data", (c) => { out += String(c); });
  await new Promise<void>((resolve, reject) => {
    const timer = setInterval(() => {
      if (out.includes("listening")) { clearInterval(timer); resolve(); }
    }, 30);
    setTimeout(() => { clearInterval(timer); reject(new Error(`服务未启动：${out}`)); }, 10_000);
  });
  const info = JSON.parse(out.trim().split("\n")[0]);
  base = info.url;
});

afterAll(async () => {
  proc?.kill("SIGTERM");
});

describe("语音服务契约 v1", () => {
  it("health 如实报告后端与契约版本", async () => {
    const r = await fetch(`${base}/health`);
    const j = await r.json();
    expect(r.status).toBe(200);
    expect(j.contract).toBe("1.0");
    expect(j.ok).toBe(true);
    expect(j.ready).toBe(true);
    expect(j.asr.engine).toBe("fake");
    expect(j.tts.engine).toBe("fake");
  });

  it("contract 声明端点与限制", async () => {
    const j = await (await fetch(`${base}/contract`)).json();
    expect(j.version).toBe("1.0");
    expect(j.endpoints).toEqual(["health", "contract", "asr", "tts"]);
    expect(j.limits.maxTextChars).toBeGreaterThan(0);
  });

  it("asr 接受 base64 音频并返回文本", async () => {
    const wav = Buffer.alloc(44 + 1600);
    wav.write("RIFF", 0);
    const r = await post("asr", { audio: wav.toString("base64"), format: "wav", language: "zh" });
    const j = await r.json();
    expect(r.status).toBe(200);
    expect(j.ok).toBe(true);
    expect(j.text.length).toBeGreaterThan(0);
    expect(j.engine).toBe("fake");
  });

  it("tts 返回可播放的 WAV 音频", async () => {
    const r = await post("tts", { text: "你好，JARVIS", rate: 180 });
    const j = await r.json();
    expect(r.status).toBe(200);
    const wav = Buffer.from(j.audio, "base64");
    expect(wav.toString("ascii", 0, 4)).toBe("RIFF");
    expect(wav.toString("ascii", 8, 12)).toBe("WAVE");
    expect(wav.length).toBeGreaterThan(1000);
    expect(j.format).toBe("wav");
  });

  it("缺 audio / 空 text 返回结构化错误，不崩溃", async () => {
    const a = await post("asr", { format: "wav" });
    expect(a.status).toBe(500);
    expect((await a.json()).ok).toBe(false);
    const t = await post("tts", { text: "   " });
    expect(t.status).toBe(500);
    expect((await t.json()).ok).toBe(false);
  });

  it("未知端点返回 404", async () => {
    expect((await fetch(`${base}/nope`)).status).toBe(404);
  });

  it("服务进程全程存活（错误请求后仍可用）", async () => {
    expect((await fetch(`${base}/health`)).status).toBe(200);
  });
});
