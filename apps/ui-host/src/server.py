#!/usr/bin/env python3
"""JARVIS Dynamic UI Host（FR-12）——按需生成交互界面。

架构：
    Orchestrator → UI Host（HTTP API）→ HTML 渲染 → webkit2gtk 窗口弹出
    用户操作 → UI Host 回传结果 → Orchestrator 继续执行

API：
    POST /ui/render      生成界面（type + data + title + actions）
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

HOME = Path.home()
JARVIS_ROOT = HOME / ".local/share/jarvis"
SETTINGS_FILE = JARVIS_ROOT / "settings.json"

# 窗口注册表：windowId → {type, title, data, actions, result, createdAt}
WINDOWS = {}


class UIHostHandler(BaseHTTPRequestHandler):
    def log_message(self, fmt, *args):
        # 静默日志（不输出到 stderr）
        pass

    def _json(self, code: int, data: dict):
        body = json.dumps(data, ensure_ascii=False).encode("utf-8")
        self.send_response(code)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def _read_body(self) -> dict:
        length = int(self.headers.get("Content-Length", 0))
        if length == 0:
            return {}
        return json.loads(self.rfile.read(length).decode("utf-8"))

    def do_GET(self):
        parsed = urlparse(self.path)
        path = parsed.path

        if path == "/health":
            self._json(200, {"ok": True, "service": "jarvis-ui-host", "windows": len(WINDOWS)})
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

        if path == "/ui/render":
            self._handle_render()
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
            proc = subprocess.Popen(
                ["python3", str(JARVIS_ROOT / "ui-host" / "src" / "window.py"), str(html_path)],
                stdout=subprocess.DEVNULL,
                stderr=subprocess.PIPE,
            )
            # 捕获 stderr 到日志
            def log_stderr():
                for line in proc.stderr:
                    print(f"[window.py] {line.decode().strip()}", file=sys.stderr, flush=True)
            import threading
            threading.Thread(target=log_stderr, daemon=True).start()
        except Exception as e:
            self._json(500, {"ok": False, "error": f"窗口弹出失败：{e}"})
            return

        self._json(200, {"ok": True, "windowId": window_id, "htmlPath": str(html_path)})

    def _handle_close(self, window_id: str):
        """关闭窗口"""
        w = WINDOWS.get(window_id)
        if not w:
            self._json(404, {"ok": False, "error": f"窗口不存在：{window_id}"})
            return
        w["result"] = {"action": "close", "at": int(time.time() * 1000)}
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
  fetch('/ui/action/{window_id}', {{
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
    """设置窗口"""
    agent_status = data.get("agentStatus", {})
    wake_word = data.get("wakeWord", "你好贾维斯")
    voice_enabled = data.get("voiceEnabled", True)
    notify_enabled = data.get("notifyEnabled", True)

    def status_badge(active: bool) -> str:
        return '<span class="status-on">● 运行中</span>' if active else '<span class="status-off">● 已停止</span>'

    rows = ""
    for name, active in agent_status.items():
        rows += f'<div class="row"><span class="label">{name}</span><span class="value">{status_badge(active)}</span></div>'

    return f"""
<div class="card">
  <h3>Agent 状态</h3>
  {rows}
</div>
<div class="card">
  <h3>唤醒词</h3>
  <input class="input" id="wakeWord" value="{wake_word}" placeholder="输入唤醒词">
</div>
<div class="card">
  <h3>语音反馈</h3>
  <div class="row"><span class="label">启用</span><span class="value">{'开启' if voice_enabled else '关闭'}</span></div>
</div>
<div class="card">
  <h3>主动通知</h3>
  <div class="row"><span class="label">启用</span><span class="value">{'开启' if notify_enabled else '关闭'}</span></div>
</div>
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
