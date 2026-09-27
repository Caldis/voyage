"""T36：把舷窗里的天空裁出来，做 1:1 与对比度拉伸对照拼图，并统计「色带」指标。

用法：python handoff/T36-stretch.py <目录> <前缀1> [<前缀2> ...]  → <目录>/stretch-<前缀们>.png
拉伸：每张图按窗内 1% / 99% 分位数线性拉到 0–255，再额外 ×gain（默认 4，突出暗部台阶）。
色带指标：沿竖直方向对窗中间一列带做二阶差分，|Δ²| > 阈值的「台阶」比例（平滑渐变接近 0）。
"""
import sys
from pathlib import Path

import numpy as np
from PIL import Image, ImageDraw

X0, X1, Y0, Y1 = 470, 1130, 90, 560  # 窗内天空区域（1600×1200 截图，左右座通用）


def load(p):
    return np.asarray(Image.open(p).convert("RGB")).astype(np.float32)


def stretch(a, gain=1.0):
    lo, hi = np.percentile(a, 1), np.percentile(a, 99)
    b = (a - lo) / max(hi - lo, 1e-3) * 255 * gain
    return np.clip(b, 0, 255).astype(np.uint8)


def steps_metric(a):
    """亮度沿 y 的一阶差分里，出现「平台 + 跳变」的程度：跳变像素占比（|Δ| ≥ 2 且上下邻差分都 < 1）"""
    L = a.mean(axis=2)
    d = np.diff(L, axis=0)
    jump = (np.abs(d[1:-1]) >= 1.5) & (np.abs(d[:-2]) < 0.75) & (np.abs(d[2:]) < 0.75)
    return float(jump.mean() * 100)


def main():
    d = Path(sys.argv[1])
    prefixes = sys.argv[2:]
    files = []
    for pre in prefixes:
        files += sorted(d.glob(f"{pre}-sun*.png"))
    tiles = []
    for f in files:
        a = load(f)[Y0:Y1, X0:X1]
        m = steps_metric(a)
        print(f"{f.name}: 台阶像素 {m:.3f}%  亮度均值 {a.mean():.1f}")
        row = np.concatenate([a.astype(np.uint8), stretch(a), stretch(a, 3.0)], axis=1)
        im = Image.fromarray(row)
        ImageDraw.Draw(im).text((6, 6), f"{f.stem}  steps={m:.3f}%", fill=(255, 255, 0))
        tiles.append(np.asarray(im))
    out = d / f"stretch-{'_'.join(prefixes)}.png"
    Image.fromarray(np.concatenate(tiles, axis=0)).save(out)
    print(out)


main()
