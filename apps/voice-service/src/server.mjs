#!/usr/bin/env node
/**
 * JARVIS 语音服务进程（契约 v1）
 *
 * 启动：
 *   node server.mjs --backend omarchy --port 8787
 *   node server.mjs --backend upstream --port 8787 --upstream http://10.0.2.2:8787
 *   node server.mjs --backend fake    --port 0       # 契约测试
 *
 * 环境变量：JARVIS_VOICE_BACKEND / JARVIS_VOICE_PORT / JARVIS_VOICE_HOST /
 *          JARVIS_VOICE_UPSTREAM / JARVIS_ASR_MODEL / JARVIS_TTS_VOICE
 *
 * 零外部依赖：整个 apps/voice-service 目录可直接复制到 Omarchy guest 运行。
 * ADR-009 红线：本服务架设在 Omarchy 系统内，零 macOS 依赖。
 */
import http from "node:http";
import { CONTRACT_VERSION, ENDPOINTS, MAX_AUDIO_BYTES, MAX_TEXT_CHARS, envelope, sanitizeText } from "./contract.mjs";
import { createBackend } from "./backends.mjs";

function arg(name) {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && i + 1 < process.argv.length ? process.argv[i + 1] : undefined;
}

const backend = createBackend(arg("backend") ?? process.env.JARVIS_VOICE_BACKEND ?? "auto", {
  ...process.env,
  ...(arg("upstream") ? { JARVIS_VOICE_UPSTREAM: arg("upstream") } : {}),
});
const port = Number(arg("port") ?? process.env.JARVIS_VOICE_PORT ?? 8787);
const host = arg("host") ?? process.env.JARVIS_VOICE_HOST ?? "0.0.0.0";

function json(res, status, body) {
  const data = JSON.stringify(body);
  res.writeHead(status, { "content-type": "application/json; charset=utf-8", "content-length": Buffer.byteLength(data) });
  res.end(data);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on("data", (c) => {
      size += c.length;
      if (size > MAX_AUDIO_BYTES * 1.5) {
        reject(new Error("请求体超限"));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on("end", () => {
      try { resolve(JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}")); }
      catch { reject(new Error("请求体不是合法 JSON")); }
    });
    req.on("error", reject);
  });
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url ?? "/", "http://localhost");
  const route = url.pathname.replace(/^\//, "");
  const started = Date.now();

  if (route === "health" && req.method === "GET") {
    const d = backend.describe();
    json(res, 200, envelope(true, {
      platform: d.platform, asr: d.asr, tts: d.tts,
      upstream: d.upstream ?? null,
      ready: !!d.asr.ready && !!d.tts.ready,
      pid: process.pid,
    }));
    return;
  }
  if (route === "contract" && req.method === "GET") {
    json(res, 200, envelope(true, { version: CONTRACT_VERSION, endpoints: ENDPOINTS,
      limits: { maxAudioBytes: MAX_AUDIO_BYTES, maxTextChars: MAX_TEXT_CHARS } }));
    return;
  }
  if (req.method !== "POST" || (route !== "asr" && route !== "tts")) {
    json(res, 404, envelope(false, { error: `未知端点：${req.method} /${route}` }));
    return;
  }

  let body;
  try { body = await readBody(req); }
  catch (e) { json(res, 400, envelope(false, { error: e.message })); return; }

  try {
    if (route === "asr") {
      const audio = Buffer.from(String(body.audio ?? ""), "base64");
      if (!audio.length) throw new Error("缺 audio（base64）");
      if (audio.length > MAX_AUDIO_BYTES) throw new Error("音频超过上限");
      const r = await backend.transcribe(audio, String(body.format ?? "wav"), String(body.language ?? "zh"));
      json(res, 200, envelope(true, { ...r, requestMs: Date.now() - started }));
      return;
    }
    const text = sanitizeText(body.text);
    if (!text) throw new Error("缺 text 或文本为空");
    const r = await backend.synthesize(text, { voice: body.voice, rate: body.rate });
    json(res, 200, envelope(true, {
      audio: Buffer.from(r.audio).toString("base64"),
      format: r.format, sampleRate: r.sampleRate,
      engine: r.engine, latencyMs: r.latencyMs, requestMs: Date.now() - started,
    }));
  } catch (e) {
    json(res, 500, envelope(false, { error: e.message, endpoint: route, requestMs: Date.now() - started }));
  }
});

server.listen(port, host, () => {
  const actual = server.address().port;
  console.log(JSON.stringify({
    type: "listening", contract: CONTRACT_VERSION,
    url: `http://127.0.0.1:${actual}`, host, port: actual,
    backend: backend.describe(),
  }));
});

process.on("SIGTERM", () => server.close(() => process.exit(0)));
process.on("SIGINT", () => server.close(() => process.exit(0)));
