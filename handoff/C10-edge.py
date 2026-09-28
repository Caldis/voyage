"""C10：云边宽度与表皮剖面（读 C10-ab.mjs 的 .bin / .diag.bin）。

边宽口径（写死，前后一致）：云缓冲 16 帧平均的不透明度 α = 1 − T（生产的时间累积之后），
在 0.4 ≤ α ≤ 0.6 且 |∇α| > 0.02 的像素上，沿梯度方向（Sobel）双线性取 ±16 px 的剖面，
往外找最近的 α ≤ 0.1、往里找最近的 α ≥ 0.9，二者距离 = 该点的 10%→90% 边宽（px）。两头都找到的才算「完整边」。
输出：完整边的中位数 / p25 / p75、完整边占候选的比例、α 均值（云量有没有变）、云芯（α ≥ 0.97）HDR 亮度 c = Y/α 的 (p90 − p10) / 均值。
用法：python C10-edge.py <目录> <job> 变体1 变体2 ...   （diag 变体名自动读 .diag.bin）
"""
import json, os, sys
import numpy as np
sys.stdout.reconfigure(encoding="utf-8")

root, job = sys.argv[1], sys.argv[2]
vns = sys.argv[3:]


def load(vn, diag=False):
    dims = json.load(open(os.path.join(root, job, vn + ".dims.json")))
    a = np.fromfile(os.path.join(root, job, vn + (".diag.bin" if diag else ".bin")), dtype=np.float32)
    return a.reshape(dims["H"], dims["W"], dims["ch"])[::-1]


def bil(img, x, y):
    h, w = img.shape
    x = np.clip(x, 0, w - 1.001); y = np.clip(y, 0, h - 1.001)
    x0 = np.floor(x).astype(int); y0 = np.floor(y).astype(int)
    fx = x - x0; fy = y - y0
    return (img[y0, x0] * (1 - fx) * (1 - fy) + img[y0, x0 + 1] * fx * (1 - fy)
            + img[y0 + 1, x0] * (1 - fx) * fy + img[y0 + 1, x0 + 1] * fx * fy)


def edges(a):
    gx = np.zeros_like(a); gy = np.zeros_like(a)
    gx[1:-1, 1:-1] = (a[1:-1, 2:] - a[1:-1, :-2]) * 2 + (a[:-2, 2:] - a[:-2, :-2]) + (a[2:, 2:] - a[2:, :-2])
    gy[1:-1, 1:-1] = (a[2:, 1:-1] - a[:-2, 1:-1]) * 2 + (a[2:, :-2] - a[:-2, :-2]) + (a[2:, 2:] - a[:-2, 2:])
    g = np.hypot(gx, gy) / 8
    ys, xs = np.nonzero((a >= 0.4) & (a <= 0.6) & (g > 0.02))
    if len(xs) > 20000:
        sel = np.random.default_rng(1).choice(len(xs), 20000, replace=False)
        ys, xs = ys[sel], xs[sel]
    nx = gx[ys, xs] / (g[ys, xs] * 8); ny = gy[ys, xs] / (g[ys, xs] * 8)
    s = np.arange(-16, 16.01, 0.25)
    P = bil(a, xs[:, None] + s[None, :] * nx[:, None], ys[:, None] + s[None, :] * ny[:, None])
    c = len(s) // 2
    ws = []
    for p in P:
        lo = np.nonzero(p[:c] <= 0.1)[0]
        hi = np.nonzero(p[c:] >= 0.9)[0]
        if len(lo) and len(hi):
            ws.append(s[c + hi[0]] - s[lo[-1]])
    return np.array(ws), len(xs)


rows = []
for vn in vns:
    if vn.startswith("diag"):
        d = load(vn, True)
        m = d[..., 3] < 0
        if not m.any():
            print(f"{vn:10s} 没有 40 km 内的云"); continue
        r, g, b, sm = d[..., 0][m], d[..., 1][m], d[..., 2][m], -d[..., 3][m] - 1
        ok1 = r < 998
        ok3 = g < 998
        q = lambda x: "/".join(f"{v:.0f}" for v in np.percentile(x, [25, 50, 75])) if len(x) else "-"
        print(f"{vn:10s} 像素 {m.sum():7d}  视线 od→1 深度 m（p25/中/p75）{q(r[ok1])}（800 m 内达不到 {100 * (1 - ok1.mean()):.0f}%）"
              f"  od→3 {q(g[ok3])}（达不到 {100 * (1 - ok3.mean()):.0f}%）  100 m 处 σ /km {q(b)}  σmax {q(sm)}")
        continue
    x = load(vn)
    a, Y = x[..., 0], x[..., 1]
    ws, ncand = edges(a)
    core = a >= 0.97
    c = Y[core] / a[core]
    con = (np.percentile(c, 90) - np.percentile(c, 10)) / c.mean() if core.sum() > 100 else float("nan")
    print(f"{vn:10s} 边宽 10→90% 中位 {np.median(ws) if len(ws) else float('nan'):5.2f} px（p25 {np.percentile(ws, 25) if len(ws) else 0:4.2f} p75 {np.percentile(ws, 75) if len(ws) else 0:4.2f}）"
          f" 完整边 {len(ws):6d}/{ncand:6d}  α均值 {a.mean():.4f}  云芯占比 {core.mean():.4f}  云芯对比 {con:.3f}  云芯 c 均值 {c.mean() if core.sum() else 0:.2f}")
