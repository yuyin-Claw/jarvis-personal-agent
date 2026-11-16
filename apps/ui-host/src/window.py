#!/usr/bin/env python3
"""JARVIS UI Host 窗口弹出（webkit2gtk）。

用法：
    python3 window.py <html-file>

在 guest 内弹出浮动窗口（webkit2gtk），加载指定 HTML 文件。
窗口规则（浮动/置顶/右下角）由 Hyprland 的 jarvis.lua 定义。
"""
import sys
from pathlib import Path

import gi
gi.require_version("Gtk", "3.0")
gi.require_version("WebKit2", "4.1")  # guest 内装的是 webkit2gtk-4.1
from gi.repository import Gtk, WebKit2


def main():
    if len(sys.argv) < 2:
        print("用法：window.py <html-file>", file=sys.stderr)
        sys.exit(1)

    html_path = Path(sys.argv[1])
    if not html_path.exists():
        print(f"HTML 文件不存在：{html_path}", file=sys.stderr)
        sys.exit(1)

    # 创建窗口
    window = Gtk.Window(title="JARVIS")
    window.set_default_size(480, 640)
    window.set_keep_above(True)  # 置顶
    window.set_decorated(True)

    # webkit2gtk 加载 HTML
    webview = WebKit2.WebView()
    webview.load_uri(html_path.as_uri())
    window.add(webview)

    window.connect("destroy", Gtk.main_quit)
    window.show_all()
    Gtk.main()


if __name__ == "__main__":
    main()
