"""C10：巡航（C10-ab.mjs --motion）检查点对真值的误差与边宽。复用 C10-edge.py 的边宽口径。
原 C10-edge.py 说明：云边宽度与表皮剖面（读 C10-ab.mjs 的 .bin / .diag.bin）。

边宽口径（写死，前后一致）：云缓冲 16 帧平均的不透明度 α = 1 − T（生产的时间累积之后），
在 0.4 ≤ α ≤ 0.6 且 |∇α| > 0.02 的像素上，沿梯度方向（Sobel）双线性取 ±16 px 的剖面，
往外找最近的 α ≤ 0.1、往里找最近的 α ≥ 0.9，二者距离 = 该点的 10%→90% 边宽（px）。两头都找到的才算「完整边」。
输出：完整边的中位数 / p25 / p75、完整边占候选的比例、α 均值（云量有没有变）、云芯（α ≥ 0.97）HDR 亮度 c = Y/α 的 (p90 − p10) / 均值。
用法：python C10-motion.py <目录> 变体1 变体2 ...（所有 job）   （diag 变体名自动读 .diag.bin）
"""
import json, os, sys
import numpy as np
sys.stdout.reconfigure(encoding="utf-8")



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



root = sys.argv[1]
vns = sys.argv[2:]
jobs = sorted(d for d in os.listdir(root) if os.path.isdir(os.path.join(root, d)))
agg = {vn: [] for vn in vns}
for job in jobs:
    print("==", job)
    for vn in vns:
        md = os.path.join(root, job, vn + ".motion")
        if not os.path.isdir(md):
            continue
        dm = json.load(open(os.path.join(md, "dims.json")))
        es, ws_m, ws_t, ae = [], [], [], []
        for k in dm["checks"]:
            m = np.fromfile(os.path.join(md, f"m{k}.bin"), dtype=np.float32).reshape(dm["H"], dm["W"], 2)[::-1]
            t = np.fromfile(os.path.join(md, f"t{k}.bin"), dtype=np.float32).reshape(dm["H"], dm["W"], 2)[::-1]
            ok = t[..., 1] > 0.02
            es.append(np.sqrt(((m[..., 1] - t[..., 1])[ok] ** 2).mean()) / t[..., 1][ok].mean())
            ae.append(np.abs(m[..., 0] - t[..., 0]).mean())
            wm, _ = edges(m[..., 0]); wt, _ = edges(t[..., 0])
            ws_m += list(wm); ws_t += list(wt)
        r = dict(err=np.mean(es), aerr=np.mean(ae), wm=np.median(ws_m) if ws_m else np.nan, wt=np.median(ws_t) if ws_t else np.nan)
        agg[vn].append(r)
        print(f"  {vn:10s} 亮度相对误差 {r['err']:.4f}  α 平均误差 {r['aerr']:.4f}  边宽 巡航 {r['wm']:.2f} / 真值 {r['wt']:.2f} px  检查点 {dm['checks']}")
b = vns[0]
print("== 相对", b, "几何均值")
for vn in vns[1:]:
    for key in ("err", "aerr", "wm", "wt"):
        rs = [x[key] / y[key] for x, y in zip(agg[vn], agg[b]) if y[key] > 0]
        if rs:
            print(f"  {vn:10s} {key} ×{np.exp(np.mean(np.log(rs))):.3f}（最差 ×{max(rs):.3f}）", end="")
    print()
