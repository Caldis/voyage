"""C12b：对 C12b-ab.mjs 的输出算指标。
静止（static）：HDR relStd / relLow16 / 空间噪声 spatRms（单帧 − 64 帧平均，÷ 均值）来自 summary.json；
              显示裁剪截图（16 张实时单帧）算归一相邻差、FFT 对角高频、斜纹指数（口径同 C12-metrics.py）。
运动（motion / turn / exit）：每个检查点拿变体的 HDR 亮度 V 与真值 T（同姿态、静止等权平均）比：
  err   = rms(V − T) / mean(T)（总误差：噪声 + 模糊 + 拖影）
  σx/σy = 拟合 V ≈ G(σx, σy) ⊗ T 的等效高斯模糊（像素；噪声与 T 无关，只抬高残差不偏移最优 σ）
  resid = 拟合后的残差 rms / mean(T)（≈ 噪声）
  edge  = 云边带（T 的梯度前 10%）上，3×3 盒滤波后梯度能量 V / T（1 = 同样锐，< 1 变糊）
用法：python C12b-metrics.py <目录> [基准变体=master]
"""
import json, math, os, re, sys
import numpy as np
from PIL import Image
sys.stdout.reconfigure(encoding="utf-8")
root = sys.argv[1]
basev = sys.argv[2] if len(sys.argv) > 2 else "master"
S = json.load(open(os.path.join(root, "summary.json"), encoding="utf-8"))
rows = S["rows"]


def fm(L):
    h, w = L.shape
    F = np.abs(np.fft.fftshift(np.fft.fft2(L - L.mean()))) ** 2
    yy, xx = np.mgrid[0:h, 0:w]
    fy, fx = (yy - h // 2) / h, (xx - w // 2) / w
    r = np.hypot(fx, fy)
    diag = F[(np.abs(fx) > 0.2) & (np.abs(fy) > 0.2)].sum() / F[r > 0.02].sum()
    adj = (np.abs(np.diff(L, axis=1)).mean() + np.abs(np.diff(L, axis=0)).mean()) / 2
    k3 = sum(np.roll(np.roll(L, i, 0), j, 1) for i in (-1, 0, 1) for j in (-1, 0, 1)) / 9
    H = (L - k3)[3:-3, 3:-3]
    H = H - H.mean()
    v0 = (H * H).mean()
    acs = [(H * np.roll(np.roll(H, dy, 0), dx, 1))[3:-3, 3:-3].mean() / v0 for dy, dx in [(0, 1), (1, 0), (1, 1), (1, -1), (1, 2), (2, 1), (1, -2), (2, -1), (2, 2), (2, -2)]]
    return diag, adj / max(L.mean(), 1e-6), max(acs)


def gk(s):
    if s < 0.05:
        return np.array([1.0])
    r = int(math.ceil(3 * s)) + 1
    x = np.arange(-r, r + 1)
    k = np.exp(-0.5 * (x / s) ** 2)
    return k / k.sum()


def blur1(A, s, axis):
    k = gk(s)
    if len(k) == 1:
        return A
    r = len(k) // 2
    P = np.pad(A, [(r, r) if a == axis else (0, 0) for a in range(2)], mode="reflect")
    out = np.zeros_like(A)
    for i, kv in enumerate(k):
        sl = [slice(None)] * 2
        sl[axis] = slice(i, i + A.shape[axis])
        out += kv * P[tuple(sl)]
    return out


SIG = np.round(np.arange(0, 3.01, 0.1), 2)


def fit_sigma(V, T):
    m = 4
    Vc = V[m:-m, m:-m]
    Tx = {s: blur1(T, s, 1) for s in SIG}
    best = (1e30, 0, 0)
    # 粗搜 0.2 步长，再在最优附近细搜
    for sx in SIG[::2]:
        for sy in SIG[::2]:
            e = ((blur1(Tx[sx], sy, 0)[m:-m, m:-m] - Vc) ** 2).mean()
            if e < best[0]:
                best = (e, sx, sy)
    _, bx, by = best
    for sx in SIG[(SIG >= bx - 0.2) & (SIG <= bx + 0.2)]:
        for sy in SIG[(SIG >= by - 0.2) & (SIG <= by + 0.2)]:
            e = ((blur1(Tx[sx], sy, 0)[m:-m, m:-m] - Vc) ** 2).mean()
            if e < best[0]:
                best = (e, sx, sy)
    return best


def box3(A):
    return sum(np.roll(np.roll(A, i, 0), j, 1) for i in (-1, 0, 1) for j in (-1, 0, 1)) / 9


def grad2(A):
    gx = np.zeros_like(A); gy = np.zeros_like(A)
    gx[:, 1:-1] = (A[:, 2:] - A[:, :-2]) / 2
    gy[1:-1, :] = (A[2:, :] - A[:-2, :]) / 2
    return gx * gx + gy * gy


def load(p, w, h):
    return np.fromfile(p, dtype=np.float32).reshape(h, w).astype(np.float64)


out = {}
for row in rows:
    job = row["job"]
    out[job] = {}
    for vn, res in row["variants"].items():
        r = {}
        if "static" in res:
            st = res["static"]
            r.update(relStd=st["relStd"], relLow16=st["relLow16"], spatRms=st["spatRms"], hdr=st["meanHdr"])
            d = os.path.join(root, job, "static", vn)
            fs = sorted(f for f in os.listdir(d) if re.fullmatch(r"f\d\d\.png", f))
            if fs:
                Ls = [np.asarray(Image.open(os.path.join(d, f)).convert("RGB")).astype(np.float64) @ [0.2126, 0.7152, 0.0722] for f in fs]
                ms = np.array([fm(L) for L in Ls])
                r.update(diag=ms[:, 0].mean(), nadj=ms[:, 1].mean(), streak=ms[:, 2].mean())
        for mode in ("motion", "turn", "exit"):
            if mode not in res:
                continue
            w, h = res[mode]["w"], res[mode]["h"]
            acc = []
            for k in sorted(res[mode]["meta"], key=int):
                V = load(os.path.join(root, job, mode, vn, f"cp{k}.f32"), w, h)
                T = load(os.path.join(root, job, mode, "_truth", f"cp{k}.f32"), w, h)
                mu = max(T.mean(), 1e-9)
                err = math.sqrt(((V - T) ** 2).mean()) / mu
                e, sx, sy = fit_sigma(V, T)
                gT = grad2(box3(T))
                band = gT > np.percentile(gT, 90)
                edge = grad2(box3(V))[band].mean() / max(gT[band].mean(), 1e-30)
                acc.append((err, sx, sy, math.sqrt(e) / mu, edge))
            a = np.array(acc)
            r[mode] = dict(err=a[:, 0].mean(), errMax=a[:, 0].max(), sx=a[:, 1].mean(), sy=a[:, 2].mean(), resid=a[:, 3].mean(), edge=a[:, 4].mean(), per=acc)
        out[job][vn] = r
    print(f"== {job}（变体 {row['key'] or '默认'}，裁剪 {row['crop']}）")
    for vn, r in out[job].items():
        s = f"  {vn:14s}"
        if "relStd" in r:
            s += f" 静止 relStd {r['relStd']:.4f} low16 {r['relLow16']:.4f} spat {r['spatRms']:.4f} HDR {r['hdr']:.3f}"
        if "diag" in r:
            s += f" | 显示 diag {r['diag']:.4f} nadj {r['nadj']:.4f} 斜纹 {r['streak']:+.3f}"
        for mode in ("motion", "turn", "exit"):
            if mode in r:
                m = r[mode]
                s += f" | {mode} err {m['err']:.4f}(峰 {m['errMax']:.4f}) σ {m['sx']:.2f}/{m['sy']:.2f} resid {m['resid']:.4f} edge {m['edge']:.3f}"
        print(s)

keys = ["relStd", "relLow16", "spatRms", "diag", "nadj", "streak", "hdr"]
mkeys = ["err", "errMax", "resid", "edge"]
vns = [v for v in next(iter(out.values())) if v != basev]
print(f"\n== 各变体 / {basev} 的几何均值（最差 = 最大比）")
for vn in vns:
    parts = []
    for k in keys:
        rs = [out[j][vn][k] / out[j][basev][k] for j in out if vn in out[j] and k in out[j][vn] and out[j][basev].get(k, 0) > 0]
        if rs:
            g = math.exp(sum(math.log(x) for x in rs) / len(rs))
            parts.append(f"{k} ×{g:.3f}(最差×{max(rs):.3f})")
    for mode in ("motion", "turn", "exit"):
        for k in mkeys:
            rs = [out[j][vn][mode][k] / out[j][basev][mode][k] for j in out if vn in out[j] and mode in out[j][vn] and out[j][basev][mode][k] > 0]
            if rs:
                g = math.exp(sum(math.log(x) for x in rs) / len(rs))
                parts.append(f"{mode}.{k} ×{g:.3f}(最差×{max(rs):.3f})")
        sg = [(out[j][vn][mode]["sx"], out[j][vn][mode]["sy"], out[j][basev][mode]["sx"], out[j][basev][mode]["sy"]) for j in out if vn in out[j] and mode in out[j][vn]]
        if sg:
            a = np.array(sg).mean(0)
            parts.append(f"{mode}.σ {a[0]:.2f}/{a[1]:.2f}（基准 {a[2]:.2f}/{a[3]:.2f}）")
    print(f"  {vn:14s} " + "  ".join(parts))
json.dump(out, open(os.path.join(root, "metrics.json"), "w", encoding="utf-8"), ensure_ascii=False, indent=1, default=float)
