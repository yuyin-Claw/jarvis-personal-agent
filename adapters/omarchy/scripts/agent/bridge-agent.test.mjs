import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const AGENT = path.join(HERE, "bridge-agent.sh");
const PROXY = path.join(HERE, "..", "proxy-request.mjs");

function listen(server) {
  return new Promise((resolve) => server.listen(0, "127.0.0.1", () => resolve(server.address().port)));
}

function close(server) {
  return new Promise((resolve) => server.close(resolve));
}

function readBody(req) {
  return new Promise((resolve) => {
    const chunks = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
  });
}

test("agent 在 /cmd 为空时仍处理 /req，并回传 invoke_ui 响应", { timeout: 10_000 }, async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "jarvis-agent-test-"));
  const fakeBin = path.join(tmp, "bin");
  fs.mkdirSync(fakeBin);
  // macOS 无 flock；测试只验证轮询/代理协议，用 no-op 替代单实例锁。
  const flock = path.join(fakeBin, "flock");
  fs.writeFileSync(flock, "#!/bin/sh\nexit 0\n");
  fs.chmodSync(flock, 0o755);

  let targetPayload = "";
  const target = http.createServer(async (req, res) => {
    if (req.url === "/ui/render" && req.method === "POST") {
      targetPayload = await readBody(req);
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ ok: true, windowId: "test-window" }));
      return;
    }
    res.writeHead(404); res.end();
  });
  const targetPort = await listen(target);

  const token = "abcd1234";
  let proxyDispatched = false;
  let requestBodyRead = false;
  let resolveResult;
  let rejectResult;
  const result = new Promise((resolve, reject) => { resolveResult = resolve; rejectResult = reject; });
  const resultTimer = setTimeout(() => rejectResult(new Error("等待 /res 超时")), 6_000);

  const bridge = http.createServer(async (req, res) => {
    const url = new URL(req.url, "http://x");
    if (url.pathname === "/register") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ ok: true, token, proto: 4 }));
      return;
    }
    if (url.pathname === "/cmd") {
      assert.equal(url.searchParams.get("token"), token);
      res.writeHead(204); res.end();
      return;
    }
    if (url.pathname === "/req") {
      assert.equal(url.searchParams.get("token"), token);
      res.writeHead(200, { "content-type": "text/plain" });
      if (!proxyDispatched) {
        proxyDispatched = true;
        const base = `http://127.0.0.1:${bridge.address().port}`;
        res.end(`node ${PROXY} ${base} 42 POST '/ui/render' http://127.0.0.1:${targetPort} ${token}`);
      } else {
        res.end("");
      }
      return;
    }
    if (url.pathname === "/body/42") {
      assert.equal(url.searchParams.get("token"), token);
      requestBodyRead = true;
      res.writeHead(200); res.end('{"type":"settings","title":"测试"}');
      return;
    }
    if (url.pathname === "/res/42" && req.method === "POST") {
      assert.equal(url.searchParams.get("token"), token);
      const raw = await readBody(req);
      res.writeHead(200); res.end("ok");
      resolveResult(JSON.parse(raw));
      return;
    }
    res.writeHead(404); res.end();
  });
  const bridgePort = await listen(bridge);

  const child = spawn("sh", [AGENT], {
    env: {
      ...process.env,
      PATH: `${fakeBin}:${process.env.PATH}`,
      JARVIS_BRIDGE_HOST: "127.0.0.1",
      JARVIS_BRIDGE_PORT: String(bridgePort),
      JARVIS_BRIDGE_AGENT_LOCK: path.join(tmp, "agent.lock"),
      JARVIS_BRIDGE_AGENT_LOG: path.join(tmp, "agent.log"),
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let stderr = "";
  child.stderr.on("data", (c) => { stderr += c; });

  try {
    const response = await result;
    assert.equal(response.status, 200, stderr);
    assert.deepEqual(JSON.parse(response.body), { ok: true, windowId: "test-window" });
    assert.equal(proxyDispatched, true);
    assert.equal(requestBodyRead, true);
    assert.equal(JSON.parse(targetPayload).type, "settings");
  } finally {
    clearTimeout(resultTimer);
    child.kill("SIGTERM");
    await Promise.all([close(bridge), close(target)]);
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});
