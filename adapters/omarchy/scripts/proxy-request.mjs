#!/usr/bin/env node
/**
 * guest 侧反向 HTTP 代理（由 guest-bridge.mjs 的 /req 下发命令调用）
 *
 * hostfwd 在部分 QEMU 构建上规则存在却不转发，因此改由 guest 主动拉取请求：
 *   /body/<id> 取请求体 → fetch guest 内服务 → /res/<id> 回传响应
 * 宿主侧因此仍能用同一份 HTTP 契约调用 guest 内服务。
 *
 * 参数：<bridge-base> <job-id> <method> <path> <target-base> [agent-token]
 */
const [base, id, method, reqPath, target, token = ""] = process.argv.slice(2);
const timeoutMs = Number(process.env.JARVIS_PROXY_FETCH_TIMEOUT_MS ?? 5_000);
const auth = token ? `?token=${encodeURIComponent(token)}` : "";

async function reply(status, body) {
  await fetch(`${base}/res/${id}${auth}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ status, body }),
    signal: AbortSignal.timeout(timeoutMs),
  });
}

try {
  let body;
  if (method !== "GET" && method !== "HEAD") {
    const r = await fetch(`${base}/body/${id}${auth}`, {
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!r.ok) throw new Error(`读取代理请求体失败：HTTP ${r.status}`);
    const text = await r.text();
    if (text) body = text;
  }
  const r = await fetch(`${target}${reqPath}`, {
    method,
    headers: body !== undefined ? { "content-type": "application/json" } : {},
    body,
    signal: AbortSignal.timeout(timeoutMs),
  });
  await reply(r.status, await r.text());
} catch (e) {
  await reply(502, JSON.stringify({ ok: false, error: String(e) })).catch(() => undefined);
}
