"""C10：逆光银边剖面（口径仿 handoff/C09-prof.py，但读 C10-ab.mjs 的 .bin：α、Y 两通道）。
c = Y/α 是云自身亮度；α ≥ 0.9 的芯按「离芯边界多少像素」分带（1–4 / 4–12 / 12–32 / 32–64 / 64+ px），
边 = 0.2 ≤ α ≤ 0.7 的像素；sharp = 边 ÷ 12–32 px 带；只统计裁剪框内（默认 backlit-close 的太阳附近 560,100,560,320）。
用法：python C10-rim.py <目录> <job> 变体... [--crop x,y,w,h]
"""
import json, os, sys
import numpy as np


def edt(m):
    # 近似距离：反复 3×3 腐蚀，第 k 次被腐蚀掉的像素距离 = k（切比雪夫距离，≥ 64 记 1e9）
    d = np.zeros(m.shape, np.float64)
    cur = m.copy()
    for k in range(1, 65):
        e = cur.copy()
        e[1:, :] &= cur[:-1, :]; e[:-1, :] &= cur[1:, :]; e[:, 1:] &= cur[:, :-1]; e[:, :-1] &= cur[:, 1:]
        e[1:, 1:] &= cur[:-1, :-1]; e[:-1, :-1] &= cur[1:, 1:]; e[1:, :-1] &= cur[:-1, 1:]; e[:-1, 1:] &= cur[1:, :-1]
        d[cur & ~e] = k
        cur = e
    d[cur] = 1e9
    return d
sys.stdout.reconfigure(encoding="utf-8")
args = sys.argv[1:]
crop = (560, 100, 560, 320)
if "--crop" in args:
    i = args.index("--crop"); crop = tuple(int(v) for v in args[i + 1].split(",")); del args[i:i + 2]
root, job, vns = args[0], args[1], args[2:]
x, y, w, h = crop
for vn in vns:
    dims = json.load(open(os.path.join(root, job, vn + ".dims.json")))
    d = np.fromfile(os.path.join(root, job, vn + ".bin"), dtype=np.float32).reshape(dims["H"], dims["W"], 2)[::-1]
    a, Y = d[..., 0], d[..., 1]
    core = a >= 0.9
    dist = edt(core)
    c = np.where(a > 0.05, Y / np.maximum(a, 1e-6), 0)
    sl = (slice(y, y + h), slice(x, x + w))
    A, C, Dd = a[sl], c[sl], dist[sl]
    edge = C[(A >= 0.2) & (A <= 0.7)]
    bands = [(1, 4), (4, 12), (12, 32), (32, 64), (64, 1e9)]
    bm = [C[(Dd >= lo) & (Dd < hi)].mean() if ((Dd >= lo) & (Dd < hi)).any() else float("nan") for lo, hi in bands]
    em = edge.mean() if len(edge) else float("nan")
    print(f"{vn:8s} 边 {em:7.2f}  芯分带 " + " / ".join(f"{v:6.2f}" for v in bm) + f"  sharp(边÷12–32) {em / bm[2]:.2f}  边÷芯64+ {em / bm[4]:.2f}")
