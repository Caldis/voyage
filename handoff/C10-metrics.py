"""C10（复制自 C12-metrics.py，跳过没有截图的 diag 变体）。C12：对 c12-ab.mjs 的输出算显示端指标（口径同 C03-hf.py / c09rev_metrics.py / bis7_hf.py）。
单帧（16 张实时单帧取均值）：相邻像素差 adj、按亮度归一 adj/mean、FFT 对角高频占比 diag（|fx|,|fy|>0.2 ÷ r>0.02）、
各向异性 aniso（r>0.2 的能量按 8 个角度扇区，最大 / 最小 —— 平行斜纹会让某个扇区突出）、亮点 ‰；
显示 dRel（16 帧逐像素时间 std / 均值）；HDR relStd / relLow16（云缓冲 64 帧）。云芯对比 p90−p10（亮度，16 帧平均图）。
用法：python c12_metrics.py <目录> [基准变体=ign]
"""
import json, math, os, sys
import numpy as np
from PIL import Image
sys.stdout.reconfigure(encoding="utf-8")
root = sys.argv[1]
basev = sys.argv[2] if len(sys.argv) > 2 else "ign"
summ = json.load(open(os.path.join(root, "summary.json"), encoding="utf-8"))


def fm(L):
    h, w = L.shape
    st = np.stack([np.roll(np.roll(L, i, 0), j, 1) for i in range(-2, 3) for j in range(-2, 3)], 0)
    med = np.median(st, 0)
    spike = (L - med > 12)[2:-2, 2:-2].mean() * 1000
    F = np.abs(np.fft.fftshift(np.fft.fft2(L - L.mean()))) ** 2
    yy, xx = np.mgrid[0:h, 0:w]
    fy, fx = (yy - h // 2) / h, (xx - w // 2) / w
    r = np.hypot(fx, fy)
    tot = F[r > 0.02].sum()
    diag = F[(np.abs(fx) > 0.2) & (np.abs(fy) > 0.2)].sum() / tot
    ang = np.arctan2(fy, fx) % np.pi
    sec = np.array([F[(r > 0.2) & (ang >= k * np.pi / 8) & (ang < (k + 1) * np.pi / 8)].sum() for k in range(8)])
    aniso = sec.max() / max(sec.min(), 1e-9)
    adj = (np.abs(np.diff(L, axis=1)).mean() + np.abs(np.diff(L, axis=0)).mean()) / 2
    # 斜纹指数：高通残差（L − 3×3 均值）在各方向位移上的自相关，取 8 个位移里的最大值。
    # 平行斜纹沿纹的方向强正相关；各向同性颗粒（白 / 蓝噪声）各方向都 ≤ 0
    k3 = sum(np.roll(np.roll(L, i, 0), j, 1) for i in (-1, 0, 1) for j in (-1, 0, 1)) / 9
    H = (L - k3)[3:-3, 3:-3]
    H = H - H.mean()
    v0 = (H * H).mean()
    acs = []
    for dy, dx in [(0, 1), (1, 0), (1, 1), (1, -1), (1, 2), (2, 1), (1, -2), (2, -1), (2, 2), (2, -2)]:
        acs.append((H * np.roll(np.roll(H, dy, 0), dx, 1))[3:-3, 3:-3].mean() / v0)
    streak = max(acs)
    return spike, diag, adj, adj / max(L.mean(), 1e-6), aniso, streak


rows = {}
for row in summ:
    job = row["job"]
    rows[job] = {}
    for vn, hdr in row["variants"].items():
        d = os.path.join(root, job, vn)
        if vn.startswith("diag") or not os.path.isdir(d) or not any(f.startswith("f") for f in os.listdir(d)):
            continue
        fs = sorted(f for f in os.listdir(d) if f.startswith("f") and f[1:3].isdigit() and f.endswith(".png"))
        Ls = [np.asarray(Image.open(os.path.join(d, f)).convert("RGB")).astype(np.float64) @ [0.2126, 0.7152, 0.0722] for f in fs]
        ms = np.array([fm(L) for L in Ls])
        S = np.stack(Ls, 0)
        m = S.mean(0)
        ok = m > 5
        rel = (S.std(0)[ok] / m[ok]).mean() if ok.any() else float("nan")
        con = np.percentile(m, 90) - np.percentile(m, 10)
        rows[job][vn] = dict(adj=ms[:, 2].mean(), nadj=ms[:, 3].mean(), diag=ms[:, 1].mean(), aniso=ms[:, 4].mean(), streak=ms[:, 5].mean(), spark=ms[:, 0].mean(),
                             dRel=rel, mean=m.mean(), con=con, relStd=hdr["relStd"], relLow16=hdr["relLow16"], hdr=hdr["meanHdr"], err=hdr.get("errors", 0))
    print(f"== {job}（变体 {row['key'] or '默认'}，裁剪 {row['crop']}）")
    for vn, r in rows[job].items():
        print(f"  {vn:8s} 均值 {r['mean']:6.1f} adj {r['adj']:5.2f} adj/mean {r['nadj']:.4f} diag {r['diag']:.4f} aniso {r['aniso']:5.2f} 斜纹 {r['streak']:+.3f} "
              f"亮点 {r['spark']:.2f}‰ 对比p90-10 {r['con']:5.1f} | 显示relStd {r['dRel']:.4f} HDR relStd {r['relStd']:.4f} relLow16 {r['relLow16']:.4f} err {r['err']}")

keys = ["nadj", "adj", "diag", "streak", "dRel", "relStd", "relLow16", "con", "hdr"]
vns = [v for v in next(iter(rows.values())) if v != basev]
print(f"\n== 各变体 / {basev} 的几何均值（最差 = 最大比）")
for vn in vns:
    parts = []
    for k in keys:
        rs = [rows[j][vn][k] / rows[j][basev][k] for j in rows if vn in rows[j] and rows[j][basev][k] > 0]
        if not rs:
            continue
        g = math.exp(sum(math.log(x) for x in rs) / len(rs))
        parts.append(f"{k} ×{g:.3f}(最差×{max(rs):.3f})")
    print(f"  {vn:8s} " + "  ".join(parts))
