#!/usr/bin/env python3
"""0.2-② 全息渲染像素断言：核对六状态真实上屏（不依赖视觉模型读图）。

输入 verify-render.mjs 产出的 shots 目录：
  - report.json：Node 侧状态送达与渲染帧证据
  - <state>.png：宿主截取的自身窗口画面
断言：
  1. 每个状态画面有足量发光像素（渲染器确实在画）
  2. 高亮像素主色符合 PALETTE（橙/绿/紫等状态色真的出现）
  3. 相邻状态画面存在帧差（动画在推进，不是静态图）
"""
import json
import os
import sys
import warnings
from PIL import Image, ImageChops

warnings.filterwarnings("ignore", category=DeprecationWarning)

STATES = ["idle", "listening", "thinking", "speaking", "working", "responding"]
# 各状态高亮像素的通道关系（对应 avatar.html 的 PALETTE）
RULES = {
    "idle":       lambda r, g, b: b > r + 8,
    "listening":  lambda r, g, b: g > b > r and (g - b) < 90,
    "thinking":   lambda r, g, b: b > r > g and (r - g) > 6,
    "speaking":   lambda r, g, b: b >= g > r,
    "working":    lambda r, g, b: r > g > b and (r - b) > 30,
    "responding": lambda r, g, b: g > b > r and (g - b) > 20,
}
DESC = {
    "idle": "蓝色主导 B>R",
    "listening": "青绿 G>B>R 且接近",
    "thinking": "紫色 B>R>G",
    "speaking": "冰蓝 B>=G>R",
    "working": "橙色 R>G>B 且 R-B 显著",
    "responding": "亮绿 G>B>R 且 G-B 显著",
}


def highlight_stats(path):
    im = Image.open(path).convert("RGBA")
    w, h = im.size
    im = im.resize((max(1, w // 2), max(1, h // 2)))
    lit = [p for p in im.getdata() if p[3] > 20 and max(p[:3]) > 55]
    if not lit:
        return 0, (0, 0, 0), im
    lit.sort(key=lambda p: sum(p[:3]), reverse=True)
    top = lit[: max(1, len(lit) // 4)]
    avg = tuple(round(sum(p[i] for p in top) / len(top), 1) for i in range(3))
    return len(lit), avg, im


def main(shots):
    report_path = os.path.join(shots, "report.json")
    if not os.path.exists(report_path):
        print("FAIL: 缺少 report.json")
        return 1
    report = json.load(open(report_path, encoding="utf-8"))
    if not all(x.get("rendererOk") and x.get("capture") and x.get("renderedState") == x.get("state") for x in report):
        print("FAIL: report.json 中状态送达证据不全")
        return 1

    failures = []
    images = {}
    print(f"{'state':<12} {'size':<12} {'lit':<8} {'avg RGB':<22} rule")
    for s in STATES:
        path = os.path.join(shots, f"{s}.png")
        if not os.path.exists(path):
            failures.append(f"{s}: 缺截图")
            continue
        lit, (r, g, b), im = highlight_stats(path)
        images[s] = im.convert("RGB")
        size = f"{im.width*2}x{im.height*2}"
        ok = lit >= 150 and RULES[s](r, g, b)
        print(f"{s:<12} {size:<12} {lit:<8} ({r:5.1f},{g:5.1f},{b:5.1f})   "
              f"{'PASS' if ok else 'FAIL'}  {DESC[s]}")
        if lit < 150:
            failures.append(f"{s}: 发光像素仅 {lit}（<150），画面疑似未渲染")
        elif not RULES[s](r, g, b):
            failures.append(f"{s}: 主色 ({r},{g},{b}) 不符合 {DESC[s]}")

    print("\n帧差（相邻状态画面，动画应在推进）")
    for a, b in zip(STATES, STATES[1:]):
        if a not in images or b not in images:
            continue
        ia, ib = images[a], images[b]
        if ia.size != ib.size:
            failures.append(f"{a}->{b}: 尺寸不一致 {ia.size} vs {ib.size}")
            continue
        d = ImageChops.difference(ia, ib).convert("L")
        vals = list(d.getdata())
        changed = sum(1 for v in vals if v > 12) / len(vals) * 100
        print(f"  {a:<11} -> {b:<11} changed={changed:5.2f}%")
        if changed < 0.3:
            failures.append(f"{a}->{b}: 帧差仅 {changed:.2f}%，疑似静态画面")

    if failures:
        print("\nFAIL:")
        for f in failures:
            print("  -", f)
        return 1
    print("\nPASS: 六状态全部真实上屏，配色与动画均符合预期")
    return 0


if __name__ == "__main__":
    if len(sys.argv) != 2:
        print("usage: assert-render.py <shots-dir>")
        sys.exit(2)
    sys.exit(main(sys.argv[1]))
