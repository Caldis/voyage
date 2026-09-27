"""T08：截图区域的亮度统计（看道路 / 城区是否过曝成平色）。
用法：python T08-stats.py 图.png x0 y0 w h
输出：区域内各亮度分位数，以及 R/G/B 任一通道 ≥ 250 的像素占比（过曝比例）。
"""
import sys
from PIL import Image

p, x0, y0, w, h = sys.argv[1], *map(int, sys.argv[2:6])
im = Image.open(p).convert("RGB").crop((x0, y0, x0 + w, y0 + h))
px = list(im.getdata())
lum = sorted(0.2126 * r + 0.7152 * g + 0.0722 * b for r, g, b in px)
n = len(lum)
q = lambda f: lum[min(n - 1, int(f * n))]
sat = sum(1 for r, g, b in px if max(r, g, b) >= 250) / n
print(f"{p}: p50={q(0.5):.0f} p90={q(0.9):.0f} p98={q(0.98):.0f} p99.8={q(0.998):.0f} 过曝={sat*100:.2f}%")
