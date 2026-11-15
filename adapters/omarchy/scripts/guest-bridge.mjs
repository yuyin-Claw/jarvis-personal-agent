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
    // 空闲自愈：bridge 停止后 /cmd、/req 都返回空 → 20 分钟无工作自动退出，
    // 避免历次注入在 guest 桌面遗留常驻终端窗口（曾堆到 110 个）
    "IDLE=0",
    "while :; do",
    `  c=$(curl -s --max-time 8 ${base}/cmd)`,
    '  if [ -n "$c" ]; then',
    "    IDLE=0",
    '    cmd=$(printf %s "$c" | base64 -d 2>/dev/null)',
    '    [ -n "$cmd" ] || { sleep 1; continue; }',
    '    out=$(sh -c "$cmd" 2>&1; printf "\\n__JARVIS_RC__%s" "$?")',
    `    curl -s --max-time 8 -X POST --data-binary "$out" ${base}/out >/dev/null`,
    "  fi",
    // hostfwd 在部分 QEMU 构建上不生效时，用反向 HTTP 代理把请求送进 guest
    `  p=$(curl -s --max-time 8 ${base}/req)`,
    '  if [ -n "$p" ]; then',
    "    IDLE=0",
    '    sh -c "$p" >/dev/null 2>&1',
    "  fi",
    '  if [ -z "$c" ] && [ -z "$p" ]; then',
    "    IDLE=$((IDLE+1))",
    '    [ "$IDLE" -ge 1200 ] && { echo "[bridge] idle timeout, exit"; exit 0; }',
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
  let seq = 0;
  /** 命令 id → 回调；结果按 id 精确匹配，杜绝轮询双通道的响应错配 */
  const waiters = new Map();
  /** 旧格式（无 id）命令队列：迁移期喂给驻留的旧协议代理 */
  const legacyQueue = [];
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
      // 旧格式迁移命令优先（供磁盘持久化的旧协议代理执行）
      if (legacyQueue.length) {
        res.writeHead(200, { "content-type": "text/plain" });
        res.end(legacyQueue.shift());
        return;
      }
      const next = queue.shift();
      res.writeHead(200, { "content-type": "text/plain" });
      res.end(next
        ? Buffer.from(`${Buffer.from(next.id).toString("base64")}\n${Buffer.from(next.cmd).toString("base64")}`).toString("base64")
        : "");
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
        if (process.env.JARVIS_BRIDGE_DEBUG) console.log("[bridge][out-body]", JSON.stringify(body.slice(0, 200)));
        // 协议：首行 = agent 回传的 id（对已部署 agent 是双重 base64；
        // 新 agent 是单层 base64 明文）。两种都试解，匹配到 waiter 即成功。
        const nl = body.indexOf("\n");
        if (nl < 0) return;
        let id = "";
        const firstLine = body.slice(0, nl).trim();
        if (!firstLine) return;
        const candidates = [];
        try { candidates.push(Buffer.from(firstLine, "base64").toString("utf8")); } catch { /* 忽略 */ }
        try { candidates.push(Buffer.from(Buffer.from(firstLine, "base64").toString("utf8"), "base64").toString("utf8")); } catch { /* 忽略 */ }
        candidates.push(firstLine);
        for (const c of candidates) { if (waiters.has(c)) { id = c; break; } }
        if (!id) return; // 无匹配 waiter：丢弃（诊断事件另走 debug 日志）
        const rest = body.slice(nl + 1);
        const m = rest.match(/\n__JARVIS_RC__(-?\d+)\s*$/);
        const out = m ? rest.slice(0, m.index) : rest;
        const rc = m ? Number(m[1]) : -1;
        const w = waiters.get(id);
        if (w) { waiters.delete(id); w({ out, rc }); }
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
  const fixedPort = Number(process.env.JARVIS_BRIDGE_PORT ?? 0);
await new Promise((resolve) => server.listen(fixedPort, "0.0.0.0", resolve));
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
    // 先把活动工作区切到 1（avatar 是 pinned 窗口，在哪个工作区都可见；
    // 但注入新开的 foot 终端只会落在活动工作区 1，不再盖住 9 上的画面）
    // hyprctl dispatch 被 Lua 劫持：workspace 1 无参数无逗号，是合法 Lua 调用
    await exec?.("hyprctl dispatch workspace 1 >/dev/null 2>&1", 10_000).catch?.(() => {});
    await qmp.call("input-send-event", { events: comboEvents("meta_l", "ret") });
    await new Promise((r) => setTimeout(r, 1800));
    await inject(bootCmd);
    await qmp.call("input-send-event", { events: [key("ret", true), key("ret", false)] });
  }

  // 等待 guest 首次取到 /b 并完成一次探测命令，证明整条链路通
  const readyId = `ready-${++seq}`;
  queue.push({ id: readyId, cmd: "printf bridge-ready" });
  let ready = false;
  const noInject = !!process.env.JARVIS_BRIDGE_NO_INJECT;
  // 迁移模式：guest 里可能驻留着旧协议代理（拉到新格式 payload 会把两行
  // base64 当命令执行并回传无 id 结果）。先用旧格式下发一条迁移命令：
  // 杀掉所有旧代理 → 立即拉新 /b 起新代理。旧代理回传无 id 结果会被
  // /out 丢弃，迁移命令不需要 ack。
  if (process.env.JARVIS_BRIDGE_MIGRATE) {
    const port2 = port;
    // 不杀旧代理（pkill 的模式会匹配执行者自身，把自己杀了后半段就断）：
    // 旧代理 20 分钟空闲自愈会退出；这里只拉起新协议代理并行共存
    const migrateCmd =
      `nohup curl -s http://${GATEWAY_IP}:${port2}/b | sh > /dev/null 2>&1 < /dev/null & echo MIGRATED`;
    const migratePayload = Buffer.from(migrateCmd).toString("base64");
    // 伪装成宿主：直接在 /cmd 队列前插一条旧格式响应
    legacyQueue.push(migratePayload);
    log("[bridge] 旧格式迁移命令已入队（等待旧代理拉取执行）");
    await new Promise((r) => setTimeout(r, 12_000));
  }
  const waitMode = !!process.env.JARVIS_BRIDGE_WAIT;
  if (waitMode) {
    log("[bridge] WAIT 模式：等待持久代理连入（部署 deploy-bridge-agent.sh 后自动就绪，最长 10 分钟）");
    // 关键时序：先注册 waiter，后入队——agent 每秒拉取，命令入队后秒被
    // 拉走执行，若 waiter 未注册回传会被 /out 丢弃，WAIT 永远等不到
    queue.length = 0; // 丢弃启动早期入队的 ready（其回传已因 waiter 缺失被丢）
    ready = await new Promise((resolve) => {
      const timer = setTimeout(() => { waiters.delete(readyId); resolve(false); }, 600_000);
      waiters.set(readyId, (r) => { clearTimeout(timer); resolve(r.out.includes("bridge-ready")); });
      queue.push({ id: readyId, cmd: "printf bridge-ready" });
    });
  }
  for (let attempt = 1; attempt <= 3 && !ready; attempt++) {
    if (noInject || waitMode) break; // WAIT 模式不注入
    if (attempt > 1) log(`[bridge] 第 ${attempt} 次重试注入`);
    await launch();
    ready = await new Promise((resolve) => {
      const timer = setTimeout(() => { waiters.delete(readyId); resolve(false); }, 14_000);
      waiters.set(readyId, (r) => { clearTimeout(timer); resolve(r.out.includes("bridge-ready")); });
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
    const id = `cmd-${++seq}`;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        waiters.delete(id);
        reject(new Error(`guest 命令超时（${timeoutMs}ms）：${cmd.slice(0, 80)}`));
      }, timeoutMs);
      queue.push({ id, cmd });
      waiters.set(id, (r) => { clearTimeout(timer); resolve(r); });
    });
  }

  // 注意：不要在就绪后清理"轮询代理进程"——pgrep -f 会匹配到轮询 sh 自己
  // 的命令行（curl -s 10.0.2.2:port/b），把代理自杀掉，之后的命令全部超时。
  // 桌面残留终端由空闲自愈（20 分钟）与验收前显式 pkill foot 处理。

  /**
   * 桌面净化：把注入通道遗留的终端全部移到 workspace 9，只留 JARVIS Avatar
   * 在当前工作区。验收截图/像素断言前必须调用（每次注入 bridge 都会新开
   * 一个 foot 终端，直接盖住数字人窗口）。
   */
  async function clearDesktop() {
    const sh = [
      "hyprctl clients -j | python3 -c '",
      "import sys, json, subprocess",
      "for c in json.load(sys.stdin):",
      "  t = str(c.get(\"title\",\"\"))",
      "  if \"JARVIS\" in t: continue",
      "  addr = c.get(\"address\",\"\")",
      "  subprocess.run([\"hyprctl\",\"dispatch\",\"movetoworkspacesilent\",",
      "    \"1,address:\" + addr], capture_output=True)",
      "' >/dev/null 2>&1",
      // 活动工作区切到 2：avatar 是 pinned（跟随所有工作区），foot 已全部
      // 移到 2 之外的工作区集合外——注意 pinned 窗口在哪个工作区都可见，
      // 所以把终端集中到 2、活动区定 2，画面里只剩 avatar
      // （终端移进的是 1；活动区 2 与它们隔离）
      "hyprctl dispatch workspace 2 >/dev/null 2>&1",
      // avatar 提到最前（focus 即 raise）
      "hyprctl dispatch focuswindow 'title:JARVIS Avatar' >/dev/null 2>&1",
      "echo DESKTOP_CLEARED",
    ].join("\n");
    return exec(sh, 30_000);
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

  return { exec, stop, forward, clearDesktop, port, qmpPath, proxyUrl: `http://127.0.0.1:${port}` };
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
