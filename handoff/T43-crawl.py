"""T43：细线「爬行」的量化（配合 handoff/T08-flicker.mjs 的连拍帧，调试 24 只画道路）。
用法：python T43-crawl.py 目录 x0 y0 w h
线在屏幕上匀速滑动时，抗锯齿做对了，每个像素的亮度随时间是平滑变化的（线性插值：二阶差分≈0）；
盒式足迹下细线是「像素中心进了 F/2 就满亮、出去就全暗」，亮度一跳一跳，二阶差分很大——这就是台阶沿线爬。
输出：亮像素（时间均值 > 12）上 |I(t+1) − 2I(t) + I(t−1)| 的均值 ÷ 亮度均值（越小越稳），以及一阶差分的同样比值做参考。
T08-flicker.py 的块能量 CV 量的是「总能量是否守恒」，量不出台阶（台阶移动时块能量也守恒），所以另写这一个。
"""
import glob
import sys

import numpy as np
from PIL import Image

d, x0, y0, w, h = sys.argv[1], *map(int, sys.argv[2:6])
fr = np.stack([np.asarray(Image.open(f).convert("RGB"), dtype=np.float64)[y0:y0 + h, x0:x0 + w] for f in sorted(glob.glob(d + "/f*.png"))])
lum = fr @ np.array([0.2126, 0.7152, 0.0722])
m = lum.mean(axis=0)
bright = m > 12
d2 = np.abs(lum[2:] - 2 * lum[1:-1] + lum[:-2]).mean(axis=0)
d1 = np.abs(np.diff(lum, axis=0)).mean(axis=0)
print(f"{d}: 亮像素 {bright.sum()}，二阶差分/亮度 {d2[bright].sum() / m[bright].sum():.4f}，一阶差分/亮度 {d1[bright].sum() / m[bright].sum():.4f}")
