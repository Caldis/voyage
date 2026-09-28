"""SEA-3：横纹强度——裁剪区逐行平均亮度，去掉 31 行滑动平均（大尺度渐变）后的残差 RMS，
另报残差的主周期（自相关第一个峰，行）。只看横向（与地平线平行）的条纹：逐行平均把横向起伏平均掉了，
剩下的就是「一整行一起亮 / 暗」的成分。

用法：python SEA-3-stripes.py x,y,w,h 图1.png [图2.png ...]
"""
import sys

import numpy as np
from PIL import Image

sys.stdout.reconfigure(encoding="utf-8")
x, y, w, h = [int(v) for v in sys.argv[1].split(",")]
K = 31
for p in sys.argv[2:]:
    a = np.asarray(Image.open(p).convert("RGB"), dtype=np.float64)[y : y + h, x : x + w]
    lum = a @ np.array([0.2126, 0.7152, 0.0722])
    rows = lum.mean(axis=1)
    pad = np.pad(rows, K // 2, mode="edge")
    smooth = np.convolve(pad, np.ones(K) / K, mode="valid")
    res = rows - smooth
    rms = float(np.sqrt(np.mean(res[K:-K] ** 2)))
    r = res[K:-K] - res[K:-K].mean()
    ac = np.correlate(r, r, mode="full")[len(r) - 1 :]
    ac = ac / max(ac[0], 1e-9)
    per = None
    for i in range(3, min(80, len(ac) - 1)):
        if ac[i] > ac[i - 1] and ac[i] >= ac[i + 1] and ac[i] > 0.1:
            per = (i, round(float(ac[i]), 2))
            break
    # 列方向做同样的事当对照（竖纹 / 各向同性噪声的量级）
    cols = lum.mean(axis=0)
    padc = np.pad(cols, K // 2, mode="edge")
    resc = cols - np.convolve(padc, np.ones(K) / K, mode="valid")
    rmsc = float(np.sqrt(np.mean(resc[K:-K] ** 2)))
    print(f"{p}: 行残差 RMS {rms:.3f}  列残差 RMS {rmsc:.3f}  比 {rms / max(rmsc, 1e-6):.2f}  主周期(行, 自相关) {per}  均亮 {lum.mean():.1f}")
