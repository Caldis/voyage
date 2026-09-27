"""C11：对 C11-ab.mjs 的输出算显示端指标（改自 C09 审查的 tmp/c09rev_metrics.py）。
每个 job / 变体 16 张实时单帧裁剪：相邻像素差 adj、对角高频 diag（FFT，同 C03-hf.py）、亮点 ‰、显示 relStd（逐像素 16 帧时间 std / 均值）；
单帧指标取 16 帧均值。另比 det.png（全冻结整屏）跨变体的最大差 / 平均差（0–255）。最后给 ic_ 姿态的几何均值 / 最差比。
用法：python C11_metrics.py <ab 输出目录> [新变体名=new] [旧变体名=old] [噪声底变体名=new2]
"""
import json
import math
import os
import sys

import numpy as np
from PIL import Image

sys.stdout.reconfigure(encoding="utf-8")
root = sys.argv[1]
NEW = sys.argv[2] if len(sys.argv) > 2 else "new"
OLD = sys.argv[3] if len(sys.argv) > 3 else "old"
N2 = sys.argv[4] if len(sys.argv) > 4 else "new2"
summ = json.load(open(os.path.join(root, "summary.json"), encoding="utf-8"))
W = np.array([0.2126, 0.7152, 0.0722])


def frame_metrics(L):
    h, w = L.shape
    st = np.stack([np.roll(np.roll(L, i, 0), j, 1) for i in range(-2, 3) for j in range(-2, 3)], 0)
    med = np.median(st, 0)
    spike = (L - med > 12)[2:-2, 2:-2].mean() * 1000
    F = np.abs(np.fft.fftshift(np.fft.fft2(L - L.mean()))) ** 2
    yy, xx = np.mgrid[0:h, 0:w]
    fy, fx = (yy - h // 2) / h, (xx - w // 2) / w
    r = np.hypot(fx, fy)
    diag = F[(np.abs(fx) > 0.2) & (np.abs(fy) > 0.2)].sum() / F[r > 0.02].sum()
    adj = (np.abs(np.diff(L, axis=1)).mean() + np.abs(np.diff(L, axis=0)).mean()) / 2
    return spike, diag, adj


def load(p):
    return np.asarray(Image.open(p).convert("RGB")).astype(np.float64)


rows = {}
for row in summ:
    job = row["job"]
    rows[job] = {}
    vns = list(row["variants"].keys())
    for vn in vns:
        d = os.path.join(root, job, vn)
        fs = sorted(f for f in os.listdir(d) if f.startswith("f") and f.endswith(".png"))
        Ls = [load(os.path.join(d, f)) @ W for f in fs]
        ms = np.array([frame_metrics(L) for L in Ls])
        S = np.stack(Ls, 0)
        m = S.mean(0)
        ok = m > 5
        rel = (S.std(0)[ok] / m[ok]).mean() if ok.any() else float("nan")
        hdr = row["variants"][vn]
        rows[job][vn] = dict(spark=ms[:, 0].mean(), diag=ms[:, 1].mean(), adj=ms[:, 2].mean(), dRel=rel, mean=m.mean(),
                             relStd=hdr["relStd"] or float("nan"), relLow16=hdr["relLow16"] or float("nan"), hdr=hdr["meanHdr"] or float("nan"), imm=hdr["imm"], fp=hdr.get("fp", ""))
    print(f"== {job}")
    for vn in vns:
        r = rows[job][vn]
        print(f"  {vn:5s} imm {r['imm']:.3f} HDR relStd {r['relStd']:.4f} relLow16 {r['relLow16']:.4f} 均值 {r['hdr']:.3f} | 显示 均值 {r['mean']:.1f} "
              f"relStd {r['dRel']:.4f} 亮点 {r['spark']:.3f}‰ 对角高频 {r['diag']:.4f} adj {r['adj']:.3f}   [{r['fp']}]")
    # det.png 跨变体（整屏，全冻结）
    dets = {vn: load(os.path.join(root, job, vn, "det.png")) for vn in vns}
    parts = []
    for i in range(len(vns)):
        for k in range(i + 1, len(vns)):
            d = np.abs(dets[vns[i]] - dets[vns[k]])
            parts.append(f"{vns[i]}-{vns[k]} 最大 {d.max():.0f} 平均 {d.mean():.4f} 非零 {(d.max(2) > 0).mean() * 100:.2f}%")
    print("  det.png 整屏差：" + "；".join(parts))
    bd = row.get("bufDiff", {})
    print("  云缓冲差：" + "；".join(f"{k} 最大 {v['max']} 平均 {v['mean']}" for k, v in bd.items()))

keys = ["relStd", "relLow16", "dRel", "spark", "diag", "adj", "hdr"]
print(f"\n== 比值 {NEW} / {OLD}（括号：噪声底 {N2} / {NEW}）")
for job, r in rows.items():
    if OLD not in r or NEW not in r:
        continue
    parts = []
    for k in keys:
        o, n = r[OLD][k], r[NEW][k]
        n2 = r[N2][k] if N2 in r else float("nan")
        parts.append(f"{k} {n / o if o else float('nan'):.3f}({n2 / n if n else float('nan'):.3f})")
    print(f"  {job:16s} " + "  ".join(parts))
ic = [j for j in rows if j.startswith("ic_") and OLD in rows[j]]
if ic:
    print(f"\n== in-cloud {len(ic)} 姿态：{NEW} / {OLD} 几何均值（最差 = 最大比）")
    for k in keys:
        rs = [rows[j][NEW][k] / rows[j][OLD][k] for j in ic if rows[j][OLD][k] > 0]
        if not rs:
            continue
        g = math.exp(sum(math.log(x) for x in rs) / len(rs))
        print(f"  {k:8s} 几何均值 ×{g:.3f}  最差 ×{max(rs):.3f}  最好 ×{min(rs):.3f}")
    print(f"\n== in-cloud 绝对值几何均值（{OLD} → {NEW}）")
    for k in ["adj", "diag", "relStd", "relLow16", "dRel", "spark"]:
        def gm(vn):
            xs = [rows[j][vn][k] for j in ic if rows[j][vn][k] > 0]
            return math.exp(sum(math.log(x) for x in xs) / len(xs)) if xs else float("nan")
        mx_o = max(rows[j][OLD][k] for j in ic)
        mx_n = max(rows[j][NEW][k] for j in ic)
        print(f"  {k:8s} {gm(OLD):.4f} → {gm(NEW):.4f}   最差姿态 {mx_o:.4f} → {mx_n:.4f}")
