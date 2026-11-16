#!/usr/bin/env python3
"""Super+J：聚焦已有 JARVIS 设置窗口；不存在则通过 UI Host 新建。"""
import json
import subprocess
import urllib.request

UI_HOST = "http://127.0.0.1:8788"


def main():
    clients = json.loads(subprocess.check_output(["hyprctl", "clients", "-j"], text=True))
    settings = [
        c for c in clients
        if str(c.get("title", "")).startswith("JARVIS") and "设置" in str(c.get("title", ""))
    ]
    if settings:
        subprocess.run(
            ["hyprctl", "dispatch", "focuswindow", f"address:{settings[-1]['address']}"],
            check=False,
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
        )
        return

    payload = json.dumps({
        "type": "settings",
        "title": "JARVIS 设置",
        "data": {},
        "actions": [{"id": "close", "label": "关闭"}],
    }, ensure_ascii=False).encode("utf-8")
    req = urllib.request.Request(
        UI_HOST + "/ui/render",
        data=payload,
        headers={"content-type": "application/json"},
    )
    with urllib.request.urlopen(req, timeout=5) as resp:
        result = json.loads(resp.read().decode("utf-8"))
        if not result.get("ok"):
            raise RuntimeError(result.get("error", "UI Host 创建窗口失败"))


if __name__ == "__main__":
    main()
