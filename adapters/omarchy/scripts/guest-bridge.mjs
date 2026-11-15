#!/usr/bin/env node
/**
 * Try Omarchy guest 执行桥（ADR-007 guest 实测通道）
 *
 * 背景：QEMU 无 guest-exec / qemu-ga，sshd 在本次启动未启用，9p 共享目录
 * 只传文件不执行命令。但 QMP 的 input-send-event 可向 virtio-keyboard 注入
 * 按键，且 SLIRP 下 guest 能访问宿主网关 10.0.2.2。
 *
 * 原理：
 *   1. 宿主起一个临时 HTTP 服务（命令队列 + 结果回收）
 *   2. QMP 注入一次 `curl -s 10.0.2.2:PORT/b|sh` 到 guest 终端
 *   3. /b 返回轮询脚本：guest 每秒取 /cmd（base64）→ sh -c → POST /out
 *   4. 之后宿主可在 guest 内执行任意命令并拿到 stdout / exit code
 *
 * 用法：
 *   node guest-bridge.mjs exec "uname -a"
 *   node guest-bridge.mjs probe            # 环境依赖探测
 *   作为库：import { createGuestBridge } from "./guest-bridge.mjs"
 *
 * 安全：只注入一次短命令；不改 VM 磁盘、不重启 VM、不需要用户手动操作。
 */
import http from "node:http";
import net from "node:net";
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

const GATEWAY_IP = process.env.JARVIS_GUEST_GATEWAY ?? "10.0.2.2";

function findQmp() {
  const explicit = process.env.JARVIS_QMP_SOCKET;
  if (explicit && fs.existsSync(explicit)) return explicit;
  for (const d of fs.readdirSync("/tmp")) {
    if (!d.startsWith("omarchy-qemu-gpu.")) continue;
    const p = path.join("/tmp", d, "qmp.sock");
    if (fs.existsSync(p)) return p;
  }
  throw new Error("未找到运行中的 Try Omarchy QMP socket");
}

/** 极简 QMP 客户端（自增 id，跳过异步事件） */
class Qmp {
  constructor(socketPath) {
    this.sock = net.createConnection(socketPath);
    this.buf = "";
    this.pending = new Map();
    this.seq = 0;
    this.sock.setEncoding("utf8");
    this.sock.on("data", (chunk) => {
      this.buf += chunk;
      let i;
      while ((i = this.buf.indexOf("\n")) >= 0) {
        const line = this.buf.slice(0, i);
        this.buf = this.buf.slice(i + 1);
        if (!line.trim()) continue;
        let msg;
        try { msg = JSON.parse(line); } catch { continue; }
        if (msg.id !== undefined && this.pending.has(msg.id)) {
          const { resolve } = this.pending.get(msg.id);
          this.pending.delete(msg.id);
          resolve(msg);
        }
      }
    });
  }
  async ready() {
    await new Promise((resolve, reject) => {
      this.sock.once("connect", resolve);
      this.sock.once("error", reject);
    });
    await this.call("qmp_capabilities");
  }
  call(execute, args) {
    const id = ++this.seq;
    const payload = { execute, id };
    if (args) payload.arguments = args;
    return new Promise((resolve) => {
      this.pending.set(id, { resolve });
      this.sock.write(JSON.stringify(payload) + "\n");
    });
  }
  close() { this.sock.end(); }
}

const SHIFT = {
  "|": "backslash", ":": "semicolon", "_": "minus", "?": "slash",
  "!": "1", '"': "apostrophe", "+": "equal", "&": "7", "*": "8",
  "(": "9", ")": "0", "$": "4", "%": "5", "^": "6", "#": "3",
  "@": "2", "~": "grave_accent",
};
const PLAIN = {
  "-": "minus", "/": "slash", ".": "dot", " ": "spc", "=": "equal",
  ",": "comma", "'": "apostrophe", ";": "semicolon", "\\": "backslash",
  "`": "grave_accent", "[": "bracket_left", "]": "bracket_right",
};
const key = (qcode, down = true) => ({
  type: "key", data: { down, key: { type: "qcode", data: qcode } },
});
function textEvents(text) {
  const ev = [];
  for (const ch of text) {
    if (SHIFT[ch]) {
      ev.push(key("shift", true), key(SHIFT[ch], true), key(SHIFT[ch], false), key("shift", false));
    } else if (/[A-Z]/.test(ch)) {
      ev.push(key("shift", true), key(ch.toLowerCase(), true), key(ch.toLowerCase(), false), key("shift", false));
    } else {
      ev.push(key(PLAIN[ch] ?? ch, true), key(PLAIN[ch] ?? ch, false));
    }
  }
  return ev;
}
function comboEvents(...keys) {
  return [...keys.map((k) => key(k, true)), ...keys.slice().reverse().map((k) => key(k, false))];
}

/** bootstrap：guest 侧轮询代理（刻意保持 POSIX sh 兼容） */
function bootstrapScript(base) {
  return [
    "#!/bin/sh",
    "while :; do",
    `  c=$(curl -s --max-time 8 ${base}/cmd)`,
    '  if [ -n "$c" ]; then',
    '    cmd=$(printf %s "$c" | base64 -d 2>/dev/null)',
    '    [ -n "$cmd" ] || { sleep 1; continue; }',
    '    out=$(sh -c "$cmd" 2>&1; printf "\\n__JARVIS_RC__%s" "$?")',
    `    curl -s --max-time 8 -X POST --data-binary "$out" ${base}/out >/dev/null`,
    "  fi",
    // hostfwd 在部分 QEMU 构建上不生效时，用反向 HTTP 代理把请求送进 guest
    `  p=$(curl -s --max-time 8 ${base}/req)`,
    '  if [ -n "$p" ]; then',
    '    sh -c "$p" >/dev/null 2>&1',
    "  fi",
    "  sleep 1",
    "done",
    "",
  ].join("\n");
}

export async function createGuestBridge(opts = {}) {
  const qmpPath = findQmp();
  const queue = [];
  const hits = [];
  let waiter = null;
  const log = opts.quiet ? () => {} : (...a) => console.log(...a);
  // 反向 HTTP 代理：host → (轮询命令) → guest → guest 内服务 → 结果回传
  const proxyJobs = new Map();
  const proxyQueue = [];
  let proxySeq = 0;
  const proxyTarget = opts.proxyTarget ?? "http://127.0.0.1:8787";
  const proxyScript = opts.proxyScript ?? "/home/yuyin/Omarchy/jarvis-voice-service/proxy-request.mjs";

  const server = http.createServer((req, res) => {
    hits.push(`${req.method} ${req.url}`);
    if (req.url === "/b") {
      res.writeHead(200, { "content-type": "text/plain" });
      res.end(bootstrapScript(`http://${GATEWAY_IP}:${port}`));
      return;
    }
    if (req.url === "/cmd") {
      const next = queue.shift();
      res.writeHead(200, { "content-type": "text/plain" });
      res.end(next ? Buffer.from(next.cmd).toString("base64") : "");
      return;
    }
    if (req.url === "/req") {
      const id = proxyQueue.shift();
      const job = id ? proxyJobs.get(id) : undefined;
      res.writeHead(200, { "content-type": "text/plain" });
      res.end(job
        ? `node ${proxyScript} http://${GATEWAY_IP}:${port} ${id} ${job.method} '${job.path}' ${proxyTarget}`
        : "");
      return;
    }
    if (req.url?.startsWith("/body/")) {
      const job = proxyJobs.get(req.url.slice(6));
      res.writeHead(job ? 200 : 404);
      res.end(job ? job.body : "");
      return;
    }
    if (req.url?.startsWith("/res/") && req.method === "POST") {
      let raw = "";
      req.on("data", (c) => { raw += c; });
      req.on("end", () => {
        res.writeHead(200); res.end("ok");
        const job = proxyJobs.get(req.url.slice(5));
        if (!job) return;
        clearTimeout(job.timer);
        proxyJobs.delete(req.url.slice(5));
        try { job.resolve(JSON.parse(raw)); }
        catch { job.resolve({ status: 502, body: JSON.stringify({ ok: false, error: "proxy 结果解析失败" }) }); }
      });
      return;
    }
    if (req.url === "/out" && req.method === "POST") {
      let body = "";
      req.on("data", (c) => { body += c; });
      req.on("end", () => {
        res.writeHead(200); res.end("ok");
        if (waiter) {
          const m = body.match(/\n__JARVIS_RC__(-?\d+)\s*$/);
          const out = m ? body.slice(0, m.index) : body;
          const rc = m ? Number(m[1]) : -1;
          waiter({ out, rc });
          waiter = null;
        }
      });
      return;
    }
    // 其余路径一律透传给 guest 内的 HTTP 服务（同一份语音服务契约）
    const id = String(++proxySeq);
    const chunks = [];
    req.on("data", (c) => { chunks.push(c); });
    req.on("end", () => {
      const timer = setTimeout(() => {
        proxyJobs.delete(id);
        res.writeHead(504, { "content-type": "application/json" });
        res.end(JSON.stringify({ ok: false, error: "guest 代理超时" }));
      }, 90_000);
      const done = new Promise((resolve) => {
        proxyJobs.set(id, { method: req.method, path: req.url, body: Buffer.concat(chunks), resolve, timer });
      });
      proxyQueue.push(id);
      done.then((r) => {
        if (res.writableEnded) return;
        res.writeHead(r.status ?? 502, { "content-type": "application/json; charset=utf-8" });
        res.end(String(r.body ?? ""));
      });
    });
    return;
  });
  await new Promise((resolve) => server.listen(0, "0.0.0.0", resolve));
  const port = server.address().port;
  log(`[bridge] HTTP :${port}  QMP ${qmpPath}`);

  const qmp = new Qmp(qmpPath);
  await qmp.ready();

  // 分批注入按键：QEMU 输入队列一次性塞入过多事件会丢帧
  async function inject(text) {
    const ev = textEvents(text);
    for (let i = 0; i < ev.length; i += 8) {
      const r = await qmp.call("input-send-event", { events: ev.slice(i, i + 8) });
      if (r.error) throw new Error(`按键注入失败：${r.error.desc}`);
      await new Promise((r2) => setTimeout(r2, 35));
    }
  }

  const bootCmd = `curl -s ${GATEWAY_IP}:${port}/b|sh`;
  async function launch() {
    await qmp.call("input-send-event", { events: comboEvents("meta_l", "ret") });
    await new Promise((r) => setTimeout(r, 1800));
    await inject(bootCmd);
    await qmp.call("input-send-event", { events: [key("ret", true), key("ret", false)] });
  }

  // 等待 guest 首次取到 /b 并完成一次探测命令，证明整条链路通
  queue.push({ cmd: "printf bridge-ready" });
  let ready = false;
  for (let attempt = 1; attempt <= 3 && !ready; attempt++) {
    if (attempt > 1) log(`[bridge] 第 ${attempt} 次重试注入`);
    await launch();
    ready = await new Promise((resolve) => {
      const timer = setTimeout(() => { waiter = null; resolve(false); }, 14_000);
      waiter = (r) => { clearTimeout(timer); resolve(r.out.includes("bridge-ready")); };
    });
    if (!ready) log(`[bridge] 诊断 hits=${JSON.stringify(hits.slice(-12))}`);
  }
  if (!ready) {
    qmp.close();
    await new Promise((resolve) => server.close(resolve));
    throw new Error(`guest 代理未启动；请求记录：${JSON.stringify(hits.slice(-20))}`);
  }
  log("[bridge] guest 代理已就绪");

  async function exec(cmd, timeoutMs = 30_000) {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        waiter = null;
        reject(new Error(`guest 命令超时（${timeoutMs}ms）：${cmd.slice(0, 80)}`));
      }, timeoutMs);
      queue.push({ cmd });
      waiter = (r) => { clearTimeout(timer); resolve(r); };
    });
  }

  /** 运行时给 SLIRP 加一条 host→guest 端口转发（无需重启 VM） */
  async function forward(hostPort, guestPort) {
    return qmp.call("human-monitor-command", {
      "command-line": `hostfwd_add tcp:127.0.0.1:${hostPort}-:${guestPort}`,
    });
  }

  async function stop() {
    qmp.close();
    await new Promise((resolve) => server.close(resolve));
  }

  return { exec, stop, forward, port, qmpPath, proxyUrl: `http://127.0.0.1:${port}` };
}

/** CLI */
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const mode = process.argv[2] ?? "probe";
  const bridge = await createGuestBridge();
  try {
    if (mode === "exec") {
      const r = await bridge.exec(process.argv.slice(3).join(" "), 60_000);
      process.stdout.write(r.out);
      process.stderr.write(`\n[rc=${r.rc}]\n`);
      process.exitCode = r.rc === 0 ? 0 : 1;
    } else {
      // 逐条短命令：单条命令过长时 curl 回传容易超时
      for (const c of [
        "uname -m; node -v; python3 -V",
        "echo SHARE=$(ls -d ~/Omarchy 2>/dev/null || echo none)",
        "echo HYPR=$HYPRLAND_INSTANCE_SIGNATURE",
        "for c in pw-record pw-play hyprctl grim gdbus espeak-ng whisper-cli piper; do printf '%s=%s ' $c \"$(command -v $c || echo none)\"; done; echo",
        "echo GTK=$(pkg-config --modversion gtk4 2>/dev/null || echo none); echo WEBKIT=$(pkg-config --modversion webkitgtk-6.0 2>/dev/null || echo none)",
      ]) {
        const r = await bridge.exec(c, 30_000);
        process.stdout.write(r.out.trim() + "\n");
      }
    }
  } finally {
    await bridge.stop();
  }
}
