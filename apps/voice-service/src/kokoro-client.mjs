import { spawn } from "node:child_process";
import fs from "node:fs";

/** Kokoro 常驻 Python worker 客户端：单进程、请求排队、失败可重建。 */
export class KokoroClient {
  constructor(scriptPath, opts = {}) {
    this.scriptPath = scriptPath;
    this.opts = opts;
    this.proc = null;
    this.seq = 0;
    this.pending = new Map();
    this.buffer = "";
  }

  ensureProcess() {
    if (this.proc) return;
    this.proc = spawn("python3", [this.scriptPath], {
      env: { ...process.env, ...this.opts.env },
      stdio: ["pipe", "pipe", "pipe"],
    });
    this.proc.stdout.on("data", (chunk) => {
      this.buffer += chunk.toString();
      const lines = this.buffer.split("\n");
      this.buffer = lines.pop() ?? "";
      for (const line of lines) {
        if (!line.trim()) continue;
        try {
          const msg = JSON.parse(line);
          const pending = this.pending.get(msg.id);
          if (!pending) continue;
          this.pending.delete(msg.id);
          clearTimeout(pending.timer);
          if (msg.ok && msg.audio) pending.resolve({
            audio: Buffer.from(msg.audio, "base64"), format: msg.format ?? "wav",
            sampleRate: msg.sampleRate ?? 24000, engine: "kokoro",
            voice: msg.voice, latencyMs: msg.latencyMs,
          });
          else pending.reject(new Error(msg.error ?? "Kokoro 合成失败"));
        } catch { /* 非 JSON 日志行忽略 */ }
      }
    });
    this.proc.stderr.on("data", (chunk) => {
      if (process.env.JARVIS_TTS_DEBUG) console.error("[kokoro]", String(chunk).trim());
    });
    this.proc.on("exit", () => {
      this.proc = null;
      for (const pending of this.pending.values()) {
        clearTimeout(pending.timer);
        pending.reject(new Error("Kokoro worker 退出"));
      }
      this.pending.clear();
    });
  }

  async synthesize(text, opts = {}) {
    this.ensureProcess();
    const id = ++this.seq;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error("Kokoro 合成超时"));
      }, opts.timeoutMs ?? 60_000);
      this.pending.set(id, { resolve, reject, timer });
      this.proc.stdin.write(JSON.stringify({
        id, text, voice: opts.voice ?? "zf_xiaoxiao", speed: opts.speed ?? 1.0,
      }) + "\n");
    });
  }

  dispose() {
    if (!this.proc) return;
    this.proc.kill("SIGTERM");
    this.proc = null;
  }
}

export function kokoroModelReady(modelDir) {
  const model = fs.existsSync(`${modelDir}/model.onnx`) || fs.existsSync(`${modelDir}/model.int8.onnx`);
  return model
    && fs.existsSync(`${modelDir}/voices.bin`)
    && fs.existsSync(`${modelDir}/tokens.txt`)
    && fs.existsSync(`${modelDir}/espeak-ng-data`)
    && fs.existsSync(`${modelDir}/lexicon-us-en.txt`)
    && fs.existsSync(`${modelDir}/lexicon-zh.txt`);
}
