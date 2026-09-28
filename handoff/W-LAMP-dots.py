"""W-LAMP：孤立点（虚线 / 点阵）计数。显示亮度（Rec.709 luma）与 3×3 中位数之差超过阈值、且不在 3×3 内与同号离群点相连成线的像素。
用法：python handoff/W-LAMP-dots.py <job 目录> x,y,w,h <变体1,变体2,...> [--thr 10] [--file full.png]
输出每个变体：离群像素数（亮 / 暗）、裁剪区横纵平均相邻差（与 compare.mjs --measure 的 adjacentDiff 同口径）
"""
import sys, os
import numpy as np
from PIL import Image
from numpy.lib.stride_tricks import sliding_window_view
sys.stdout.reconfigure(encoding="utf-8")
job, crop, vs = sys.argv[1], [int(t) for t in sys.argv[2].split(",")], sys.argv[3].split(",")
thr = float(sys.argv[sys.argv.index("--thr") + 1]) if "--thr" in sys.argv else 10.0
fname = sys.argv[sys.argv.index("--file") + 1] if "--file" in sys.argv else "full.png"
x, y, w, h = crop
for v in vs:
    a = np.asarray(Image.open(os.path.join(job, v, fname)).convert("RGB")).astype(np.float64)
    L = a @ np.array([0.2126, 0.7152, 0.0722])
    L = L[y - 1 : y + h + 1, x - 1 : x + w + 1]
    med = np.median(sliding_window_view(L, (3, 3)), axis=(2, 3))
    c = L[1:-1, 1:-1]
    d = c - med
    adj = (np.abs(np.diff(c, axis=1)).mean() + np.abs(np.diff(c, axis=0)).mean()) / 2
    print(v, "bright", int((d > thr).sum()), "dark", int((d < -thr).sum()), "adj %.2f" % adj, "mean %.1f" % c.mean())
