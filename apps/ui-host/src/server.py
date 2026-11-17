#!/usr/bin/env python3
"""JARVIS Dynamic UI Host（FR-12）——按需生成交互界面。

架构：
    Orchestrator → UI Host（HTTP API）→ HTML 渲染 → webkit2gtk 窗口弹出
    用户操作 → UI Host 回传结果 → Orchestrator 继续执行

API：
    POST /ui/render      生成界面（type + data + title + actions）
    GET  /ui/windows     已保存窗口列表
    POST /ui/reopen/<id> 按持久化元数据重开窗口
    GET  /ui/result/<id> 查询用户操作结果
    POST /ui/close/<id>  关闭窗口
    GET  /health         健康检查

窗口管理：
    - 每个界面分配 windowId（UUID）
    - webkit2gtk 窗口在 guest 内弹出（浮动/置顶）
    - 用户操作通过 HTTP 回传到 UI Host
"""
import json
import os
import sys
import time
import uuid
import subprocess
from pathlib import Path
from http.server import HTTPServer, BaseHTTPRequestHandler
from urllib.parse import urlparse

from settings import load_settings, update_preferences
from agent_control import change_wake_word, control_agents, service_status

HOME = Path.home()
JARVIS_ROOT = HOME / ".local/share/jarvis"
SETTINGS_FILE = JARVIS_ROOT / "settings.json"

# 窗口注册表：windowId → {type, title, data, actions, result, createdAt}
WINDOWS_FILE = JARVIS_ROOT / "ui-windows" / "windows.json"


def load_windows() -> dict:
    """服务重启后恢复窗口元数据；损坏文件保留备份，不静默吞掉。"""
    if not WINDOWS_FILE.exists():
        return {}
    try:
        data = json.loads(WINDOWS_FILE.read_text(encoding="utf-8"))
        return data if isinstance(data, dict) else {}
    except Exception as e:
        backup = WINDOWS_FILE.with_name(f"windows.corrupt-{int(time.time())}.json")
        WINDOWS_FILE.replace(backup)
        print(f"[ui-host] 窗口注册表损坏，已备份到 {backup}: {e}", file=sys.stderr)
        return {}


def save_windows():
    """原子落盘，避免服务被杀时留下半个 JSON。"""
    WINDOWS_FILE.parent.mkdir(parents=True, exist_ok=True)
    tmp = WINDOWS_FILE.with_suffix(".json.tmp")
    tmp.write_text(json.dumps(WINDOWS, ensure_ascii=False, indent=2), encoding="utf-8")
    tmp.replace(WINDOWS_FILE)


WINDOWS = load_windows()


class UIHostHandler(BaseHTTPRequestHandler):
    def log_message(self, fmt, *args):
        # 静默日志（不输出到 stderr）
        pass

    def _json(self, code: int, data: dict):
        body = json.dumps(data, ensure_ascii=False).encode("utf-8")
        self.send_response(code)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Access-Control-Allow-Headers", "Content-Type")
        self.send_header("Access-Control-Allow-Methods", "GET, POST, OPTIONS")
        self.end_headers()
        self.wfile.write(body)

    def _read_body(self) -> dict:
        length = int(self.headers.get("Content-Length", 0))
        if length == 0:
            return {}
        return json.loads(self.rfile.read(length).decode("utf-8"))

    def do_OPTIONS(self):
        self._json(204, {})

    def do_GET(self):
        parsed = urlparse(self.path)
        path = parsed.path

        if path == "/health":
            self._json(200, {"ok": True, "service": "jarvis-ui-host", "windows": len(WINDOWS)})
            return

        if path == "/api/status":
            self._json(200, {
                "ok": True,
                "settings": load_settings(),
                "services": service_status(),
            })
            return

        if path == "/ui/windows":
            items = [{
                "windowId": window_id,
                "type": w.get("type"),
                "title": w.get("title"),
                "result": w.get("result"),
                "createdAt": w.get("createdAt"),
                "reopenedAt": w.get("reopenedAt"),
            } for window_id, w in WINDOWS.items()]
            self._json(200, {"ok": True, "windows": items})
            return

        if path.startswith("/ui/result/"):
            window_id = path.split("/")[-1]
            w = WINDOWS.get(window_id)
            if not w:
                self._json(404, {"ok": False, "error": f"窗口不存在：{window_id}"})
                return
            self._json(200, {"ok": True, "windowId": window_id, "result": w.get("result")})
            return

        self._json(404, {"ok": False, "error": f"未知端点：GET {path}"})

    def do_POST(self):
        parsed = urlparse(self.path)
        path = parsed.path

        if path == "/api/agent":
            try:
                body = self._read_body()
                result = control_agents(str(body.get("action", "")))
                self._json(200 if result["ok"] else 500, result)
            except Exception as e:
                self._json(400, {"ok": False, "error": str(e)})
            return

        if path == "/api/wake-word":
            try:
                body = self._read_body()
                result = change_wake_word(str(body.get("wakeWord", "")))
                self._json(200, result)
            except ValueError as e:
                self._json(400, {"ok": False, "error": str(e)})
            except Exception as e:
                self._json(500, {"ok": False, "error": str(e)})
            return

        if path == "/api/preferences":
            try:
                body = self._read_body()
                settings = update_preferences(body)
                self._json(200, {"ok": True, "settings": settings})
            except Exception as e:
                self._json(400, {"ok": False, "error": str(e)})
            return

        if path == "/ui/render":
            self._handle_render()
            return

        if path.startswith("/ui/reopen/"):
            self._handle_reopen(path.split("/")[-1])
            return

        if path.startswith("/ui/close/"):
            window_id = path.split("/")[-1]
            self._handle_close(window_id)
            return

        if path.startswith("/ui/action/"):
            window_id = path.split("/")[-1]
            self._handle_action(window_id)
            return

        self._json(404, {"ok": False, "error": f"未知端点：POST {path}"})

    def _spawn_window(self, html_path: Path):
        proc = subprocess.Popen(
            ["python3", str(JARVIS_ROOT / "ui-host" / "src" / "window.py"), str(html_path)],
            stdout=subprocess.DEVNULL,
            stderr=subprocess.PIPE,
        )
        def log_stderr():
            for line in proc.stderr:
                print(f"[window.py] {line.decode().strip()}", file=sys.stderr, flush=True)
        import threading
        threading.Thread(target=log_stderr, daemon=True).start()

    def _handle_render(self):
        """生成界面并弹出窗口"""
        try:
            body = self._read_body()
        except Exception as e:
            self._json(400, {"ok": False, "error": f"请求体解析失败：{e}"})
            return

        ui_type = body.get("type", "custom")
        title = body.get("title", "JARVIS")
        data = body.get("data", {})
        actions = body.get("actions", [{"id": "ok", "label": "确定"}])

        window_id = str(uuid.uuid4())[:8]
        WINDOWS[window_id] = {
            "type": ui_type,
            "title": title,
            "data": data,
            "actions": actions,
            "result": None,
            "createdAt": int(time.time() * 1000),
        }

        # 渲染 HTML
        html = render_html(ui_type, title, data, actions, window_id)

        # 写入临时文件
        html_path = JARVIS_ROOT / "ui-windows" / f"{window_id}.html"
        html_path.parent.mkdir(parents=True, exist_ok=True)
        html_path.write_text(html, encoding="utf-8")

        # 弹出窗口（webkit2gtk）
        try:
            self._spawn_window(html_path)
            save_windows()
        except Exception as e:
            self._json(500, {"ok": False, "error": f"窗口弹出失败：{e}"})
            return

        self._json(200, {"ok": True, "windowId": window_id, "htmlPath": str(html_path)})

    def _handle_reopen(self, window_id: str):
        """按持久化元数据重新生成并打开窗口；历史 result 保留。"""
        w = WINDOWS.get(window_id)
        if not w:
            self._json(404, {"ok": False, "error": f"窗口不存在：{window_id}"})
            return
        html_path = JARVIS_ROOT / "ui-windows" / f"{window_id}.html"
        html = render_html(w["type"], w["title"], w.get("data", {}), w.get("actions", []), window_id)
        try:
            html_path.parent.mkdir(parents=True, exist_ok=True)
            html_path.write_text(html, encoding="utf-8")
            self._spawn_window(html_path)
            w["reopenedAt"] = int(time.time() * 1000)
            w["reopenCount"] = int(w.get("reopenCount", 0)) + 1
            save_windows()
            self._json(200, {"ok": True, "windowId": window_id, "htmlPath": str(html_path), "result": w.get("result")})
        except Exception as e:
            self._json(500, {"ok": False, "error": f"窗口重开失败：{e}"})

    def _handle_close(self, window_id: str):
        """关闭窗口"""
        w = WINDOWS.get(window_id)
        if not w:
            self._json(404, {"ok": False, "error": f"窗口不存在：{window_id}"})
            return
        w["result"] = {"action": "close", "at": int(time.time() * 1000)}
        save_windows()
        self._json(200, {"ok": True, "windowId": window_id})

    def _handle_action(self, window_id: str):
        """用户操作回传"""
        w = WINDOWS.get(window_id)
        if not w:
            self._json(404, {"ok": False, "error": f"窗口不存在：{window_id}"})
            return
        try:
            body = self._read_body()
        except Exception as e:
            self._json(400, {"ok": False, "error": f"请求体解析失败：{e}"})
            return
        w["result"] = {"action": body.get("action"), "data": body.get("data"), "at": int(time.time() * 1000)}
        save_windows()
        self._json(200, {"ok": True, "windowId": window_id})


def render_html(ui_type: str, title: str, data: dict, actions: list, window_id: str) -> str:
    """渲染 HTML 界面（零依赖字符串模板）"""
    # 根据类型渲染不同内容
    if ui_type == "settings":
        content = render_settings(data)
    elif ui_type == "task_list":
        content = render_task_list(data)
    elif ui_type == "confirm":
        content = render_confirm(data)
    elif ui_type == "progress":
        content = render_progress(data)
    else:
        content = f"<pre>{json.dumps(data, ensure_ascii=False, indent=2)}</pre>"

    # 操作按钮
    buttons = ""
    for a in actions:
        buttons += f'<button class="btn" onclick="sendAction(\'{a["id"]}\')">{a["label"]}</button>'

    return f"""<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<title>{title}</title>
<style>
* {{ margin: 0; padding: 0; box-sizing: border-box; }}
body {{
  font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', 'PingFang SC', 'Microsoft YaHei', sans-serif;
  background: #1a1a2e; color: #eee; padding: 24px;
  min-height: 100vh;
}}
.container {{ max-width: 480px; margin: 0 auto; }}
h1 {{ font-size: 20px; margin-bottom: 20px; color: #7b9cff; }}
.card {{ background: #16213e; border-radius: 12px; padding: 20px; margin-bottom: 16px; }}
.row {{ display: flex; justify-content: space-between; align-items: center; padding: 10px 0; border-bottom: 1px solid #2a3a5e; }}
.row:last-child {{ border-bottom: none; }}
.label {{ color: #aaa; }}
.value {{ color: #eee; font-weight: 500; }}
.status-on {{ color: #4ade80; }}
.status-off {{ color: #f87171; }}
.btn {{
  background: #7b9cff; color: #fff; border: none; border-radius: 8px;
  padding: 10px 20px; font-size: 14px; cursor: pointer; margin-right: 8px;
}}
.btn:hover {{ background: #6a8ae8; }}
.btn-danger {{ background: #f87171; }}
.btn-danger:hover {{ background: #e85d5d; }}
.input {{
  background: #0f1420; border: 1px solid #2a3a5e; border-radius: 8px;
  padding: 10px 14px; color: #eee; font-size: 14px; width: 100%;
}}
.actions {{ margin-top: 20px; text-align: right; }}
.btn-secondary {{ background: #334155; }}
.btn-secondary:hover {{ background: #475569; }}
.btn:disabled {{ opacity: 0.45; cursor: wait; }}
.message {{ min-height: 22px; margin: 12px 0; font-size: 13px; color: #7b9cff; }}
.message.error {{ color: #f87171; }}
.hint {{ color: #888; font-size: 12px; margin-top: 8px; line-height: 1.5; }}
.toggle {{ width: 20px; height: 20px; accent-color: #7b9cff; }}
code {{ color: #a5b4fc; word-break: break-all; }}
</style>
</head>
<body>
<div class="container">
  <h1>{title}</h1>
  {content}
  <div class="actions">{buttons}</div>
</div>
<script>
function sendAction(actionId, data = null) {{
  fetch('http://127.0.0.1:8788/ui/action/{window_id}', {{
    method: 'POST',
    headers: {{'Content-Type': 'application/json'}},
    body: JSON.stringify({{action: actionId, data: data}})
  }}).then(r => r.json()).then(() => {{
    window.close();
  }});
}}
</script>
</body>
</html>"""


def render_settings(data: dict) -> str:
    """设置窗口（真实 API：状态、启停、唤醒词、语音/通知开关）"""
    return """
<div class="card">
  <div class="row"><h3>Agent 状态</h3><button class="btn btn-secondary setting-control" onclick="refreshStatus()">刷新</button></div>
  <div class="row"><span class="label">jarvis-core</span><span class="value" id="state-core">读取中…</span></div>
  <div class="row"><span class="label">jarvis-voice</span><span class="value" id="state-voice">读取中…</span></div>
  <div class="row"><span class="label">jarvis-avatar</span><span class="value" id="state-avatar">读取中…</span></div>
  <div class="hint">UI Host 与 bridge-agent 保持运行，因此 Agent 停用后仍可从这里重新激活。</div>
  <div class="hint">基础设施：<span id="state-infra">读取中…</span></div>
  <div class="actions" style="text-align:left">
    <button class="btn setting-control" onclick="agentAction('start')">激活 Agent</button>
    <button class="btn btn-secondary setting-control" onclick="agentAction('restart')">重启</button>
    <button class="btn btn-danger setting-control" onclick="agentAction('stop')">停用</button>
  </div>
</div>
<div class="card">
  <h3>唤醒词</h3>
  <div class="row"><input class="input setting-control" id="wakeWord" maxlength="8" placeholder="2-8 个汉字"></div>
  <div class="actions" style="text-align:left"><button class="btn setting-control" onclick="saveWakeWord()">保存并生效</button></div>
  <div class="hint">仅修改当前自定义唤醒词；旧词会失效。保存时自动校验模型并热重启语音服务，失败自动回滚。</div>
  <div class="hint">音素：<code id="kwsTokens">尚未修改</code></div>
</div>
<div class="card">
  <h3>偏好</h3>
  <div class="row"><span class="label">语音反馈（TTS）</span><input class="toggle setting-control" id="voiceEnabled" type="checkbox" onchange="savePreferences()"></div>
  <div class="row"><span class="label">主动通知</span><input class="toggle setting-control" id="notifyEnabled" type="checkbox" onchange="savePreferences()"></div>
</div>
<div class="message" id="message"></div>
<script>
const API = 'http://127.0.0.1:8788';
let busy = false;

async function api(path, options = {}) {
  const response = await fetch(API + path, {
    ...options,
    headers: {'Content-Type': 'application/json', ...(options.headers || {})},
  });
  const body = await response.json();
  if (!response.ok || body.ok === false) throw new Error(body.error || `HTTP ${response.status}`);
  return body;
}

function showMessage(text, isError = false) {
  const el = document.getElementById('message');
  el.textContent = text;
  el.className = 'message' + (isError ? ' error' : '');
}

function setBusy(value) {
  busy = value;
  document.querySelectorAll('.setting-control').forEach(el => { el.disabled = value; });
}

function badge(active) {
  return active ? '<span class="status-on">● 运行中</span>' : '<span class="status-off">● 已停止</span>';
}

async function refreshStatus() {
  if (busy) return;
  try {
    const j = await api('/api/status');
    for (const [id, name] of [['state-core', 'jarvis-core'], ['state-voice', 'jarvis-voice'], ['state-avatar', 'jarvis-avatar']]) {
      document.getElementById(id).innerHTML = badge(j.services[name].active);
    }
    document.getElementById('state-infra').textContent =
      `bridge ${j.services['jarvis-bridge-agent'].state} · UI Host ${j.services['jarvis-ui-host'].state}`;
    const wake = document.getElementById('wakeWord');
    if (document.activeElement !== wake) wake.value = j.settings.wakeWord;
    document.getElementById('voiceEnabled').checked = j.settings.voiceEnabled;
    document.getElementById('notifyEnabled').checked = j.settings.notifyEnabled;
  } catch (e) {
    showMessage(`状态读取失败：${e.message}`, true);
  }
}

async function runAction(fn) {
  if (busy) return;
  setBusy(true);
  try { await fn(); }
  catch (e) { showMessage(e.message, true); }
  finally { setBusy(false); await refreshStatus(); }
}

async function agentAction(action) {
  if (action === 'stop' && !confirm('确定停用 core、voice 和 avatar 吗？设置窗口会保持可用。')) return;
  await runAction(async () => {
    await api('/api/agent', {method: 'POST', body: JSON.stringify({action})});
    showMessage(action === 'stop' ? 'Agent 已停用' : 'Agent 已恢复运行');
  });
}

async function saveWakeWord() {
  const wakeWord = document.getElementById('wakeWord').value.trim();
  await runAction(async () => {
    showMessage('正在校验模型并重启语音服务…');
    const j = await api('/api/wake-word', {method: 'POST', body: JSON.stringify({wakeWord})});
    document.getElementById('kwsTokens').textContent = j.tokens;
    showMessage(j.voiceRestarted ? '唤醒词已保存并生效' : '唤醒词已保存，语音启动后生效');
  });
}

async function savePreferences() {
  const voiceEnabled = document.getElementById('voiceEnabled').checked;
  const notifyEnabled = document.getElementById('notifyEnabled').checked;
  await runAction(async () => {
    await api('/api/preferences', {method: 'POST', body: JSON.stringify({voiceEnabled, notifyEnabled})});
    showMessage('偏好已保存');
  });
}

refreshStatus();
</script>
"""


def render_task_list(data: dict) -> str:
    """任务列表"""
    tasks = data.get("tasks", [])
    rows = ""
    for t in tasks:
        status_color = {"done": "#4ade80", "running": "#7b9cff", "blocked": "#f87171", "pending": "#aaa"}.get(t.get("status", ""), "#aaa")
        rows += f'<div class="row"><span class="label">{t.get("subject", "")}</span><span class="value" style="color:{status_color}">{t.get("status", "")}</span></div>'
    return f'<div class="card"><h3>任务列表</h3>{rows or "<p>无任务</p>"}</div>'


def render_confirm(data: dict) -> str:
    """确认对话框"""
    message = data.get("message", "确定要执行此操作吗？")
    return f'<div class="card"><p>{message}</p></div>'


def render_progress(data: dict) -> str:
    """进度条"""
    percent = data.get("percent", 0)
    message = data.get("message", "处理中...")
    return f'''
<div class="card">
  <p>{message}</p>
  <div style="background:#0f1420;border-radius:8px;height:24px;margin-top:12px;overflow:hidden">
    <div style="background:#7b9cff;height:100%;width:{percent}%;transition:width 0.3s"></div>
  </div>
  <p style="text-align:right;margin-top:8px;color:#aaa">{percent}%</p>
</div>
'''


def main():
    port = int(os.environ.get("JARVIS_UI_HOST_PORT", "8788"))
    server = HTTPServer(("127.0.0.1", port), UIHostHandler)
    print(f"[ui-host] 监听 127.0.0.1:{port}", flush=True)
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print("\n[ui-host] 退出", flush=True)


if __name__ == "__main__":
    main()
