# T32：连拍帧之间的细尺度变化（看时间稳定性）。用法：python T32-flicker.py <目录> <视角名>...
# 对 <视角>-burst0..3.png 的相邻两帧，取云区域，各自去掉 > 3 px 的成分后相减，报差值的标准差（色阶）。
# 飞机在动，大尺度的平移会被去掉；剩下的主要是逐像素的闪烁 / 噪点
import os
import sys
import numpy as np
from PIL import Image

BOX = {"sc-far": (0.3, 0.55, 0.95, 0.95), "cu-top": (0.25, 0.1, 0.8, 0.6)}


def blur(x, r):
    k = 2 * r + 1
    for axis in (0, 1):
        c = np.cumsum(np.pad(x, [(r + 1, r) if i == axis else (0, 0) for i in range(2)], mode="edge"), axis=axis)
        x = (np.take(c, range(k, c.shape[axis]), axis=axis) - np.take(c, range(0, c.shape[axis] - k), axis=axis)) / k
    return x


d = sys.argv[1]
for v in sys.argv[2:]:
    fr = []
    for k in range(4):
        im = Image.open(os.path.join(d, f"{v}-burst{k}.png")).convert("L")
        w, h = im.size
        b = BOX[v]
        a = np.asarray(im.crop((int(b[0] * w), int(b[1] * h), int(b[2] * w), int(b[3] * h))), dtype=np.float64)
        fr.append(a - blur(a, 3))
    diffs = [np.std(fr[k + 1] - fr[k]) for k in range(3)]
    print(f"{d.split('/')[-1]:14s} {v:8s} 相邻帧细尺度差 std = " + " ".join("%.2f" % x for x in diffs))
