"""T41：星点闪烁统计。输入同一场景连拍的若干帧（T41-shots.mjs --frames N --dx ...），
在第一帧窗内天空区域找局部亮点，逐帧在附近 ±R 像素里跟踪，统计每颗星「总能量」（7×7 窗内线性亮度减背景）
和「峰值」在各帧间的相对起伏（max/min）。能量守恒的点扩散应让总能量基本不变，峰值起伏有限。
用法：python T41-flicker.py <帧1.png> <帧2.png> ... [--box x0,y0,x1,y1]
"""
import sys

import numpy as np
from PIL import Image

args = [a for a in sys.argv[1:] if not a.startswith("--box")]
box = (420, 60, 1180, 520)
for a in sys.argv[1:]:
    if a.startswith("--box="):
        box = tuple(int(v) for v in a[6:].split(","))


def lin(path):
    im = np.asarray(Image.open(path).convert("RGB")).astype(np.float64) / 255.0
    im = np.where(im <= 0.04045, im / 12.92, ((im + 0.055) / 1.055) ** 2.4)
    return im @ np.array([0.2126, 0.7152, 0.0722])


frames = [lin(p) for p in args]
x0, y0, x1, y1 = box
f0 = frames[0]
# 局部极大：比 5×5 邻域都亮，且比周围中位数亮出一截
cands = []
for y in range(y0 + 4, y1 - 4):
    for x in range(x0 + 4, x1 - 4):
        v = f0[y, x]
        win = f0[y - 2 : y + 3, x - 2 : x + 3]
        if v < win.max():
            continue
        bg = np.median(f0[y - 6 : y + 7, x - 6 : x + 7])
        if v - bg > 0.01:
            cands.append((v - bg, x, y))
cands.sort(reverse=True)
cands = cands[:40]
R = 12
rows = []
for amp, x, y in cands:
    es, ps = [], []
    px, py = x, y
    ok = True
    for f in frames:
        sub = f[py - R : py + R + 1, px - R : px + R + 1]
        iy, ix = np.unravel_index(np.argmax(sub), sub.shape)
        py, px = py - R + iy, px - R + ix
        win = f[py - 3 : py + 4, px - 3 : px + 4]
        ring = np.concatenate([f[py - 6, px - 6 : px + 7], f[py + 6, px - 6 : px + 7], f[py - 6 : py + 7, px - 6], f[py - 6 : py + 7, px + 6]])
        bg = np.median(ring)
        e = (win - bg).clip(0).sum()
        p = win.max() - bg
        if p <= 0:
            ok = False
            break
        es.append(e)
        ps.append(p)
    if ok:
        rows.append((amp, x, y, max(es) / min(es), max(ps) / min(ps), f0[y, x] >= 0.99))
print(f"{len(rows)} 颗星，{len(frames)} 帧")
print("  x    y    峰值   能量起伏  峰值起伏  饱和")
for amp, x, y, er, pr, sat in rows:
    print(f"{x:4d} {y:4d}  {amp:.3f}   {er:.2f}      {pr:.2f}     {'是' if sat else ''}")
er = np.array([r[3] for r in rows if not r[5]])
pr = np.array([r[4] for r in rows if not r[5]])
if len(er):
    print(f"未饱和的星：能量起伏中位数 {np.median(er):.2f}（最大 {er.max():.2f}），峰值起伏中位数 {np.median(pr):.2f}（最大 {pr.max():.2f}）")
