"""T08：连拍帧的闪烁统计（配合 T08-flicker.mjs）。
用法：python T08-flicker.py 目录 x0 y0 w h [块边长=48]
把区域切成块，对每块求各帧的亮度总和，输出块能量变异系数（std / mean）的中位数与 90 / 98 分位；
只统计平均亮度够亮的块（排除全黑的块把中位数拉低）。
另输出「逐像素时间抖动」：每个像素相邻帧差的绝对值均值 / 该像素均值，取亮像素的中位数（线在滑动时这个值本来就不为 0，只做前后对比用）。
"""
import sys, glob
import numpy as np
from PIL import Image

d, x0, y0, w, h = sys.argv[1], *map(int, sys.argv[2:6])
B = int(sys.argv[6]) if len(sys.argv) > 6 else 48
files = sorted(glob.glob(d + "/f*.png"))
fr = np.stack([np.asarray(Image.open(f).convert("RGB"), dtype=np.float64)[y0:y0 + h, x0:x0 + w] for f in files])
lum = fr[..., 0] * 0.2126 + fr[..., 1] * 0.7152 + fr[..., 2] * 0.0722  # 显示值，不是线性亮度；只做相对比较
T, H, W = lum.shape
cvs = []
for by in range(0, H - B + 1, B):
    for bx in range(0, W - B + 1, B):
        s = lum[:, by:by + B, bx:bx + B].sum(axis=(1, 2))
        if s.mean() / (B * B) < 3:
            continue
        cvs.append(s.std() / s.mean())
cvs = np.array(cvs)
m = lum.mean(axis=0)
jit = np.abs(np.diff(lum, axis=0)).mean(axis=0)
bright = m > 20
pj = np.median(jit[bright] / m[bright]) if bright.any() else float("nan")
print(f"{d}: 帧 {T}，块 {len(cvs)}，块能量 CV 中位 {np.median(cvs):.4f} / p90 {np.percentile(cvs, 90):.4f} / p98 {np.percentile(cvs, 98):.4f}；亮像素逐帧抖动中位 {pj:.3f}")
