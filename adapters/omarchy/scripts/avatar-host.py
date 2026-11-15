#!/usr/bin/env python3
"""JARVIS Wayland 透明宿主（Omarchy / Hyprland）。

复用 macOS 版同一份 avatar.html 渲染层，通过 Unix socket 接收状态帧：
  {"type":"frame","state":"speaking","intensity":0.85,"amplitude":0.7,"caption":"..."}

依赖两套之一（必须在导入 Gtk 之前选定，两个 namespace 互斥）：
  - GTK4 + WebKitGTK 6.0（WebKit-6.0.typelib）
  - GTK3 + WebKit2 4.1（Try Omarchy 4.0.0 实际所装：webkit2gtk-4.1）
缺依赖时明确退出码 3；不静默假装窗口可用。
"""
import argparse
import json
import os
import socket
import sys
import threading

try:
    import gi

    try:
        gi.require_version("WebKit", "6.0")
        from gi.repository import WebKit  # noqa: F401  先探测 typelib，避免提前加载 Gtk 3.0
        gi.require_version("Gtk", "4.0")
        from gi.repository import Gtk, GLib, Gdk
        GTK3 = False
        MODE = "gtk4-webkit6.0"
    except Exception:
        gi.require_version("Gtk", "3.0")
        gi.require_version("WebKit2", "4.1")
        from gi.repository import Gtk, GLib, Gdk, WebKit2 as WebKit
        GTK3 = True
        MODE = "gtk3-webkit2-4.1"
except Exception as exc:  # pragma: no cover - VM 内才会执行
    print(f"JARVIS avatar host dependency missing: {exc}", file=sys.stderr)
    sys.exit(3)

# 验收证据：宿主被 spawn 时 stdout 走管道，另写一份文件供跨进程读取
LOG_PATH = os.environ.get("JARVIS_AVATAR_LOG")


def note(msg):
    print(msg, flush=True)
    if LOG_PATH:
        with open(LOG_PATH, "a", encoding="utf-8") as f:
            f.write(msg + "\n")


if LOG_PATH:
    with open(LOG_PATH, "w", encoding="utf-8"):
        pass

parser = argparse.ArgumentParser()
parser.add_argument("--html", required=True)
parser.add_argument("--socket", required=True)
# 自动验收可选：Wayland 合成器的平铺布局可能把透明窗口压成 0 尺寸，
# 全屏模式让截图有确定区域；生产默认仍为普通窗口。
parser.add_argument("--fullscreen", action="store_true",
                    default=bool(os.environ.get("JARVIS_AVATAR_FULLSCREEN")))
# 自动验收可选：不透明深色底，避免透明合成吞掉发光像素（生产仍为透明悬浮窗）
parser.add_argument("--opaque", action="store_true",
                    default=bool(os.environ.get("JARVIS_AVATAR_OPAQUE")))
for key, default in [("--x", 80), ("--y", 80), ("--width", 420), ("--height", 480)]:
    parser.add_argument(key, type=int, default=default)
args = parser.parse_args()

web = WebKit.WebView()
window = Gtk.Window(title="JARVIS Avatar")
window.set_decorated(False)
window.set_default_size(args.width, args.height)

if GTK3:
    # Hyprland 默认平铺普通窗口，会把无尺寸协商的透明 WebView 压成 0 尺寸；
    # DIALOG 类型让合成器默认浮动并尊重显式尺寸请求。
    window.set_type_hint(Gdk.WindowTypeHint.DIALOG)
    window.set_keep_above(True)
    window.set_size_request(args.width, args.height)
    web.set_size_request(args.width, args.height)
    screen = window.get_screen()
    rgba = screen.get_rgba_visual()
    if rgba:
        window.set_visual(rgba)
    window.set_app_paintable(True)
    try:
        css = Gtk.CssProvider()
        css.load_from_data(b"window, webview { background: transparent; }")
        Gtk.StyleContext.add_provider_for_screen(
            screen, css, Gtk.STYLE_PROVIDER_PRIORITY_APPLICATION
        )
    except Exception:
        pass
    try:
        web.set_background_color(
            Gdk.RGBA(0.02, 0.02, 0.05, 1) if args.opaque else Gdk.RGBA(0, 0, 0, 0)
        )
    except Exception:
        pass
    window.add(web)
else:
    try:
        css = Gtk.CssProvider()
        css.load_from_data(b"window, webview { background: transparent; }")
        Gtk.StyleContext.add_provider_for_display(
            Gdk.Display.get_default(), css, Gtk.STYLE_PROVIDER_PRIORITY_APPLICATION
        )
    except Exception:
        pass
    try:
        web.set_transparent(True)
    except Exception:
        pass
    window.set_child(web)

web.load_uri("file://" + os.path.abspath(args.html))


def inject(js):
    """把状态帧送进渲染层；WebKitGTK 6.0 / WebKit2 4.1 API 差异在此兜底。"""
    try:
        web.evaluate_javascript(js, -1, None, None, None)
    except (TypeError, AttributeError):
        try:
            web.run_javascript(js, None, None, None)
        except Exception as exc:
            print(f"inject failed: {exc}", file=sys.stderr, flush=True)
    except Exception as exc:
        print(f"inject failed: {exc}", file=sys.stderr, flush=True)
    return False


def apply_frame(frame):
    state = json.dumps(frame.get("state", "idle"))
    intensity = float(frame.get("intensity", 0.5))
    amplitude = float(frame.get("amplitude", 0.0))
    caption = json.dumps(frame.get("caption", ""), ensure_ascii=False)
    js = (
        "(function(){ if(!window.jarvis) return; window.jarvis.setState(%s,%s,%s);"
        "window.jarvis.setAmplitude(%s);"
        # 带帧号：状态相同时 title 不变会漏 notify 信号（首帧 idle 曾因此丢证据）
        "document.title='jarvis:'+window.jarvis.getState().state+':'+window.jarvis.frame(); })()" %
        (state, intensity, caption, amplitude)
    )
    # 验收证据：宿主确实收到并注入了这一帧
    note(f"[frame] {frame.get('state')} intensity={intensity}")
    GLib.idle_add(inject, js)


def on_title(_web, _param):
    """WebView 真实执行了注入 JS 后回读状态——区分「帧送达」与「渲染层已上屏」"""
    try:
        title = web.get_title() or ""
        if title.startswith("jarvis:"):
            note(f"[rendered] {title.split(':')[1]}")
    except Exception:
        pass


web.connect("notify::title", on_title)


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
    note(f"JARVIS avatar host listening on {path} mode={MODE}")
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


def report_geometry():
    """验收诊断：Wayland 合成器可能把窗口压成 0 尺寸，日志里如实记录分配结果。"""
    try:
        note(
            f"[geometry] win={window.get_size()} "
            f"web={web.get_allocated_width()}x{web.get_allocated_height()} mode={MODE}"
        )
    except Exception as exc:
        note(f"[geometry] unavailable: {exc}")
    return False


GLib.timeout_add_seconds(2, report_geometry)
window.connect("destroy", lambda *_: sys.exit(0))
if GTK3:
    window.show_all()
    window.move(args.x, args.y)
    window.resize(args.width, args.height)
else:
    window.present()
if args.fullscreen:
    window.fullscreen()
Gtk.main() if hasattr(Gtk, "main") else GLib.MainLoop().run()
