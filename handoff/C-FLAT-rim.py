# 银边 / 云芯对比的简化复查（C09-prof 口径去掉「离太阳 zone 度」限制，改为只取窗内最亮的一块区域）：
# python C-FLAT-rim.py <job 目录> 变体1 变体2 ...
# edge = α 0.2–0.7 的边像素 c = Y/α 均值；d12–32 = 离 α ≥ 0.9 边界 12–32 px 的芯像素均值；sharp = edge / d12–32；
# 另报芯（α ≥ 0.97）的 c 的 p90/p10（云芯对比）。区域：云缓冲里 c 的 99 分位点周围 ±R px（逆光时就是太阳附近）
import sys, os, json
import numpy as np

sys.stdout.reconfigure(encoding="utf-8")
d = sys.argv[1]
R = 160


def load(n):
    m = json.load(open(os.path.join(d, f"{n}.cloud.json"), encoding="utf-8"))
    a = np.fromfile(os.path.join(d, f"{n}.cloud.f32"), dtype=np.float32).reshape(m["H"], m["W"], 2)
    return a[..., 0], a[..., 1]


def dist_in(mask, maxd=40):
    dist = np.zeros(mask.shape, np.int32)
    cur = mask.copy()
    for _ in range(maxd):
        dist[cur] += 1
        n = cur.copy()
        n[1:, :] &= cur[:-1, :]
        n[:-1, :] &= cur[1:, :]
        n[:, 1:] &= cur[:, :-1]
        n[:, :-1] &= cur[:, 1:]
        cur = n
    return dist


center = None
for v in sys.argv[2:]:
    A, Y = load(v)
    c = Y / np.maximum(A, 1e-6)
    if center is None:
        cc = np.where(A > 0.2, c, 0)
        thr = np.percentile(cc[A > 0.2], 99)
        ys, xs = np.nonzero(cc >= thr)
        center = (int(np.median(ys)), int(np.median(xs)))
    y0, x0 = center
    win = np.zeros(A.shape, bool)
    win[max(0, y0 - R):y0 + R, max(0, x0 - R):x0 + R] = True
    edge = win & (A >= 0.2) & (A <= 0.7)
    core = A >= 0.9
    dd = dist_in(core)
    band = win & core & (dd >= 12) & (dd <= 32)
    c97 = c[win & (A >= 0.97)]
    print(f"{v}: edge {c[edge].mean():.3g}  d12–32 {c[band].mean():.3g}  sharp {c[edge].mean() / c[band].mean():.2f}  芯 p90/p10 {np.percentile(c97, 90) / np.percentile(c97, 10):.2f}（中心 {center}，边 {int(edge.sum())} px）")
