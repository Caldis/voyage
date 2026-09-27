# TM01：实时单帧截图（TM01-measure.mjs --live）上的相邻像素差，区分「对比变大」与「噪点 / 棋盘纹变多」
#   adj：luma 的相邻像素差均值（C01-texture.py 同口径）；lf：σ = 3 低通后的相邻像素差（中低频结构）
#   逐点的色调曲线把所有频率按同一个局部增益放大，所以 adj 与 lf 同比变化（hf/lf 比不变）就是「没有新增高频噪点」
# 用法：python TM01-hf.py <根目录> <参考变体> <变体> <场景:x,y,w,h> ...
import sys, os
import numpy as np
from PIL import Image
sys.stdout.reconfigure(encoding="utf-8")

def gauss(img, s):
    r = int(3 * s + 0.5)
    x = np.arange(-r, r + 1)
    k = np.exp(-x * x / (2 * s * s)); k /= k.sum()
    p = np.pad(img, r, mode="reflect")
    t = np.apply_along_axis(lambda m: np.convolve(m, k, "valid"), 0, p)
    return np.apply_along_axis(lambda m: np.convolve(m, k, "valid"), 1, t)

def adj(L):
    return 0.5 * (np.abs(np.diff(L, axis=1)).mean() + np.abs(np.diff(L, axis=0)).mean())

root, ref, var = sys.argv[1:4]
print("| 场景 / 区域 | adj 改前 → 改后 | 低频 lf 改前 → 改后 | adj 倍数 / lf 倍数 | RGB 改前 → 改后 |")
print("| --- | --- | --- | ---: | --- |")
for spec in sys.argv[4:]:
    sc, box = spec.split(":")
    x, y, w, h = (int(v) for v in box.split(","))
    row = []
    for nm in (ref, var):
        a = np.asarray(Image.open(os.path.join(root, sc, nm + ".png")).convert("RGB"), dtype=np.float64)[y:y + h, x:x + w]
        L = a @ np.array([0.2126, 0.7152, 0.0722])
        row.append((adj(L), adj(gauss(L, 3.0)), a.reshape(-1, 3).mean(axis=0)))
    (a0, l0, c0), (a1, l1, c1) = row
    f = lambda c: "/".join(f"{v:.0f}" for v in c)
    print(f"| {sc} {box} | {a0:.2f} → {a1:.2f} | {l0:.3f} → {l1:.3f} | {a1 / a0:.3f} / {l1 / l0:.3f} | {f(c0)} → {f(c1)} |")
