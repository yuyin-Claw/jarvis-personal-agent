#!/usr/bin/env python3
"""JARVIS Wayland 透明宿主（Omarchy / Hyprland）。

复用 macOS 版同一份 avatar.html 渲染层，通过 Unix socket 接收状态帧：
  {"type":"frame","state":"speaking","intensity":0.85,"amplitude":0.7,"caption":"..."}
  {"type":"capture","path":"/tmp/shot.png"}   # 由 grim 在 Node 侧完成，这里只 ack

依赖：python3-gobject (GTK4) + WebKitGTK（Omarchy 通常已装）。
GTK/WebKit 版本差异需在 Try Omarchy VM 实测校准；缺依赖时明确退出码 3。
"""
import argparse
import json
import os
import socket
import sys
import threading

try:
    import gi
    gi.require_version("Gtk", "4.0")
    from gi.repository import Gtk, GLib, Gdk
    try:
        gi.require_version("WebKit", "6.0")
        from gi.repository import WebKit
    except (ValueError, ImportError):
        gi.require_version("WebKit2", "4.1")
        from gi.repository import WebKit2 as WebKit
except Exception as exc:  # pragma: no cover - VM 内才会执行
    print(f"JARVIS avatar host dependency missing: {exc}", file=sys.stderr)
    sys.exit(3)

parser = argparse.ArgumentParser()
parser.add_argument("--html", required=True)
parser.add_argument("--socket", required=True)
for key, default in [("--x", 80), ("--y", 80), ("--width", 420), ("--height", 480)]:
    parser.add_argument(key, type=int, default=default)
args = parser.parse_args()

window = Gtk.Window(title="JARVIS Avatar")
window.set_decorated(False)
window.set_default_size(args.width, args.height)
try:
    css = Gtk.CssProvider()
    css.load_from_data(b"window, webview { background: transparent; }")
    Gtk.StyleContext.add_provider_for_display(
        Gdk.Display.get_default(), css, Gtk.STYLE_PROVIDER_PRIORITY_APPLICATION
    )
except Exception:
    pass

web = WebKit.WebView()
try:
    web.set_transparent(True)
except Exception:
    pass
window.set_child(web)
web.load_uri("file://" + os.path.abspath(args.html))


def inject(js):
    """把状态帧送进渲染层；WebKitGTK 4.1/6.0 API 差异在此兜底。"""
    try:
        web.evaluate_javascript(js, -1, None, None, None)
    except TypeError:
        try:
            web.evaluate_javascript(js, -1)
        except Exception as exc:
            print(f"inject failed: {exc}", file=sys.stderr)
    except Exception as exc:
        print(f"inject failed: {exc}", file=sys.stderr)
    return False


def apply_frame(frame):
    state = json.dumps(frame.get("state", "idle"))
    intensity = float(frame.get("intensity", 0.5))
    amplitude = float(frame.get("amplitude", 0.0))
    caption = json.dumps(frame.get("caption", ""), ensure_ascii=False)
    js = (
        "window.jarvis && (window.jarvis.setState(%s,%s,%s),"
        "window.jarvis.setAmplitude(%s))" % (state, intensity, caption, amplitude)
    )
    GLib.idle_add(inject, js)


def serve():
    path = args.socket
    os.makedirs(os.path.dirname(path), exist_ok=True)
    try:
        os.unlink(path)
    except FileNotFoundError:
        pass
    srv = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
    srv.bind(path)
    srv.listen(8)
    print(f"JARVIS avatar host listening on {path}", flush=True)
    while True:
        conn, _ = srv.accept()
        with conn:
            for line in conn.makefile("r", encoding="utf-8"):
                try:
                    frame = json.loads(line)
                except json.JSONDecodeError:
                    continue
                if frame.get("type") == "frame":
                    apply_frame(frame)


threading.Thread(target=serve, daemon=True).start()
window.connect("destroy", lambda *_: sys.exit(0))
window.present()
Gtk.main() if hasattr(Gtk, "main") else GLib.MainLoop().run()
