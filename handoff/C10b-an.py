"""C10b：按距离分带的云边宽度（口径同 handoff/C10-edge.py）、对细步真值 ref 的 α 分档比值 / 亮度误差、裁剪区 HDR relStd。
距离来自 dist 变体（输出 L = depth·α，所以 Y/α = 深度 km）。
用法：python c10b-an.py <目录> <ref 变体> 变体1,变体2,...  [场景过滤,逗号]
"""
import json, os, sys
import numpy as np
sys.stdout.reconfigure(encoding="utf-8")
root, REFV = sys.argv[1], sys.argv[2]
vns = sys.argv[3].split(",")
only = sys.argv[4].split(",") if len(sys.argv) > 4 else None
BANDS = [(0, 10), (10, 20), (20, 40), (40, 80), (80, 1e9)]
ABINS = [(0.01, 0.1), (0.1, 0.3), (0.3, 0.6), (0.6, 0.9)]


def load(job, vn):
    p = os.path.join(root, job, vn + ".bin")
    if not os.path.exists(p):
        return None
    dims = json.load(open(os.path.join(root, job, vn + ".dims.json")))
    return np.fromfile(p, dtype=np.float32).reshape(dims["H"], dims["W"], dims["ch"])[::-1]


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
    if len(xs) > 30000:
        sel = np.random.default_rng(1).choice(len(xs), 30000, replace=False)
        ys, xs = ys[sel], xs[sel]
    nx = gx[ys, xs] / (g[ys, xs] * 8); ny = gy[ys, xs] / (g[ys, xs] * 8)
    s = np.arange(-16, 16.01, 0.25)
    P = bil(a, xs[:, None] + s[None, :] * nx[:, None], ys[:, None] + s[None, :] * ny[:, None])
    c = len(s) // 2
    W = np.full(len(xs), np.nan)
    for k, p in enumerate(P):
        lo = np.nonzero(p[:c] <= 0.1)[0]
        hi = np.nonzero(p[c:] >= 0.9)[0]
        if len(lo) and len(hi):
            W[k] = s[c + hi[0]] - s[lo[-1]]
    return ys, xs, W


summ = {r["job"]: r for r in json.load(open(os.path.join(root, "summary.json"), encoding="utf-8"))}
for job in sorted(os.listdir(root)):
    if not os.path.isdir(os.path.join(root, job)) or (only and job not in only):
        continue
    ref = load(job, REFV)
    dist = load(job, "dist")
    if ref is None:
        continue
    D = dist[..., 1] / np.maximum(dist[..., 0], 1e-4) if dist is not None else None
    ar, yr = ref[..., 0], ref[..., 1]
    print(f"==== {job}")
    if D is not None:
        m = (ar > 0.05) & (ar < 0.95)
        print("  边缘像素（真值 α 0.05–0.95）距离 km 分位 p10/25/50/75/90：" + "/".join(f"{v:.0f}" for v in np.percentile(D[m], [10, 25, 50, 75, 90])))
    hdr = "  变体     | 边宽中位 " + " ".join(f"[{lo:.0f}-{hi if hi < 1e8 else 999:.0f}]" for lo, hi in BANDS) + " | α/真值 " + " ".join(f"{lo:.2f}-{hi:.1f}" for lo, hi in ABINS) + " | 云区|Δα| | Y比 | 云区|ΔY|/Y | relStd"
    print(hdr)
    for vn in vns + [REFV]:
        x = load(job, vn)
        if x is None:
            continue
        a, y = x[..., 0], x[..., 1]
        ys, xs, W = edges(a)
        cells = [f"{np.nanmedian(W):5.2f}"]
        for lo, hi in BANDS:
            if D is None:
                break
            sel = (D[ys, xs] >= lo) & (D[ys, xs] < hi) & ~np.isnan(W)
            cells.append(f"{np.median(W[sel]):5.2f}({sel.sum():5d})" if sel.sum() > 30 else "   -        ")
        rb = []
        for lo, hi in ABINS:
            mm = (ar >= lo) & (ar < hi)
            rb.append(f"{a[mm].mean() / max(ar[mm].mean(), 1e-9):.3f}")
        c = (ar > 0.01) | (a > 0.01)
        rs = summ.get(job, {}).get("variants", {}).get(vn, {}).get("relStd", "")
        print(f"  {vn:8s} | " + " ".join(cells) + " | " + " ".join(rb) +
              f" | {np.abs(a - ar)[c].mean():.4f} | {y.sum() / yr.sum():.3f} | {np.abs(y - yr)[c].mean() / yr[c].mean():.3f} | {rs}")
