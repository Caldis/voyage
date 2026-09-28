"""W-STAIR：放大对照 + 指标。
用法：python W-STAIR-view.py <输出.png> <x,y,w,h|full> <放大倍数> <拉伸:0/1> <图1> [<图2> ...]
每张图裁剪后（按所有图共同的 1%–99% 分位做对比度拉伸），最近邻放大，横排拼接；
同时打印每张图裁剪区的指标：
  adj   相邻像素 luma 绝对差均值（横 + 纵）
  hf2   2 px 周期能量：luma 减去 3×3 盒滤波后的残差绝对值均值（点阵 / 棋盘纹 / 阶梯的锯齿都落在这里）
  stair 边缘阶梯度：在梯度强（|∇L|>阈值）的像素上，梯度方向角相邻像素的跳变均值（度）；直边越平滑越小
"""
import sys

import numpy as np
from PIL import Image

sys.stdout.reconfigure(encoding="utf-8")
out, crop, zoom, stretch = sys.argv[1], sys.argv[2], int(sys.argv[3]), sys.argv[4] == "1"
files = sys.argv[5:]
imgs = []
for f in files:
    a = np.asarray(Image.open(f).convert("RGB")).astype(np.float64)
    if crop != "full":
        x, y, w, h = map(int, crop.split(","))
        a = a[y:y + h, x:x + w]
    imgs.append(a)


def L(a):
    return a @ np.array([0.2126, 0.7152, 0.0722])


def metrics(a):
    l = L(a)
    adj = (np.abs(np.diff(l, axis=1)).mean() + np.abs(np.diff(l, axis=0)).mean()) / 2
    p = np.pad(l, 1, mode="edge")
    box = sum(p[dy:dy + l.shape[0], dx:dx + l.shape[1]] for dy in range(3) for dx in range(3)) / 9
    hf = np.abs(l - box)[1:-1, 1:-1].mean()
    gx = np.zeros_like(l); gy = np.zeros_like(l)
    gx[:, 1:-1] = (l[:, 2:] - l[:, :-2]) / 2
    gy[1:-1, :] = (l[2:, :] - l[:-2, :]) / 2
    g = np.hypot(gx, gy)
    ang = np.arctan2(gy, gx)
    th = max(3.0, np.percentile(g, 95))
    m = g > th
    jumps = []
    for dy, dx in ((0, 1), (1, 0)):
        a1 = ang[:l.shape[0] - dy, :l.shape[1] - dx]
        a2 = ang[dy:, dx:]
        mm = m[:l.shape[0] - dy, :l.shape[1] - dx] & m[dy:, dx:]
        d = np.abs(np.angle(np.exp(1j * (a1 - a2))))[mm]
        jumps.append(d)
    j = np.concatenate(jumps)
    stair = np.degrees(j.mean()) if j.size else 0.0
    return adj, hf, stair


for f, a in zip(files, imgs):
    adj, hf, st = metrics(a)
    print(f"{f}: adj {adj:.3f}  hf2 {hf:.3f}  stair {st:.2f}°")

if stretch:
    allv = np.concatenate([i.reshape(-1) for i in imgs])
    lo, hi = np.percentile(allv, 1), np.percentile(allv, 99)
    imgs = [np.clip((i - lo) / max(hi - lo, 1) * 255, 0, 255) for i in imgs]
tiles = []
for a in imgs:
    im = Image.fromarray(a.astype(np.uint8))
    tiles.append(np.asarray(im.resize((im.width * zoom, im.height * zoom), Image.NEAREST)))
    tiles.append(np.full((tiles[-1].shape[0], 6, 3), 255, np.uint8))
Image.fromarray(np.concatenate(tiles[:-1], 1)).save(out)
