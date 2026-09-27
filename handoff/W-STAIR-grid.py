"""W-STAIR：多个 job 的 old / new 放大对照拼图 + 指标（同页 A/B 的 full.png）。
用法：python W-STAIR-grid.py <A/B 输出目录> <输出.png> <x,y,w,h> <放大> <job1,job2,...> [变体列表，默认 old,new]
每行一个 job，依次是各变体的裁剪（最近邻放大），最后一列是 |new − old| × 8。打印每个裁剪的 adj / hf2（见 W-STAIR-view.py）。
"""
import sys

import numpy as np
from PIL import Image

sys.stdout.reconfigure(encoding="utf-8")
root, out, crop, zoom, jobs = sys.argv[1], sys.argv[2], sys.argv[3], int(sys.argv[4]), sys.argv[5].split(",")
vs = sys.argv[6].split(",") if len(sys.argv) > 6 else ["old", "new"]
x, y, w, h = map(int, crop.split(","))


def L(a):
    return a @ np.array([0.2126, 0.7152, 0.0722])


def met(a):
    l = L(a)
    adj = (np.abs(np.diff(l, axis=1)).mean() + np.abs(np.diff(l, axis=0)).mean()) / 2
    p = np.pad(l, 1, mode="edge")
    box = sum(p[dy:dy + l.shape[0], dx:dx + l.shape[1]] for dy in range(3) for dx in range(3)) / 9
    return adj, np.abs(l - box)[1:-1, 1:-1].mean()


rows = []
agg = {v: [] for v in vs}
for j in jobs:
    ims = [np.asarray(Image.open(f"{root}/{j}/{v}/full.png").convert("RGB")).astype(np.float64)[y:y + h, x:x + w] for v in vs]
    line = []
    for v, a in zip(vs, ims):
        adj, hf = met(a)
        agg[v].append((adj, hf))
        line.append(f"{v} adj {adj:.3f} hf2 {hf:.3f}")
    print(j, " | ".join(line))
    d = np.clip(np.abs(ims[-1] - ims[0]).max(2, keepdims=True).repeat(3, 2) * 8, 0, 255)
    tiles = [np.asarray(Image.fromarray(t.astype(np.uint8)).resize((w * zoom, h * zoom), Image.NEAREST)) for t in ims + [d]]
    sep = np.full((h * zoom, 4, 3), 255, np.uint8)
    r = []
    for t in tiles:
        r += [t, sep]
    rows.append(np.concatenate(r[:-1], 1))
    rows.append(np.full((4, rows[-1].shape[1], 3), 255, np.uint8))
Image.fromarray(np.concatenate(rows[:-1], 0)).save(out)
for v in vs:
    a = np.array(agg[v])
    print(f"{v}: 几何均值 adj {np.exp(np.log(a[:, 0]).mean()):.3f} hf2 {np.exp(np.log(a[:, 1]).mean()):.3f}；最差 adj {a[:, 0].max():.3f} hf2 {a[:, 1].max():.3f}")
