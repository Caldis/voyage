# C10c：dev-browser ab（cloudDump）的输出——按距离分带看各变体对真值（ref）的 Y、α 比值与逐像素误差；显示层看截图近处区域的 8 bit 亮度
# 用法：python c10c-an2.py <ab 输出目录> <job,...> <变体,...>   （目录里需要 ref / dist 两个 builtin 变体）
import sys, json, os
import numpy as np
from PIL import Image
sys.stdout.reconfigure(encoding="utf-8")

def load(d, job, vn):
    m = json.load(open(os.path.join(d, job, vn + ".cloud.json")))
    return np.fromfile(os.path.join(d, job, vn + ".cloud.f32"), dtype=np.float32).reshape(m["H"], m["W"], 2)[::-1]

def luma8(path):
    a = np.asarray(Image.open(path).convert("RGB")).astype(np.float64)
    return 0.2126 * a[..., 0] + 0.7152 * a[..., 1] + 0.0722 * a[..., 2]

root, jobs, vns = sys.argv[1], sys.argv[2].split(","), sys.argv[3].split(",")
EDGES = [0, 20, 40, 60, 90, 130, 400]
res = {}
for job in jobs:
    V = {v: load(root, job, v) for v in vns + ["ref", "dist"] if os.path.exists(os.path.join(root, job, v + ".cloud.f32"))}
    ad = V["dist"]
    km = ad[..., 1] / np.maximum(ad[..., 0], 1e-4)
    cloud = V["ref"][..., 0] > 0.05
    print(f"== {job}   （每格：Y/真值 · 逐像素 |ΔY|/Y 真值）")
    print("  变体     " + "".join(f"{a:>4d}–{b:<4d}km      " for a, b in zip(EDGES[:-1], EDGES[1:])) + " 0–60 α/真值  0–60 合计误差")
    near = cloud & (km < 60)
    for v in vns:
        if v not in V: continue
        cells = []
        for a, b in zip(EDGES[:-1], EDGES[1:]):
            s = cloud & (km >= a) & (km < b)
            if s.sum() < 200: cells.append("      —          "); continue
            yr = V["ref"][..., 1][s]; yv = V[v][..., 1][s]
            cells.append(f"{yv.sum() / yr.sum():.3f} · {np.abs(yv - yr).sum() / yr.sum():.3f}   ")
        aa = V[v][..., 0][near].sum() / max(V["ref"][..., 0][near].sum(), 1e-6)
        yr = V["ref"][..., 1][near]; yv = V[v][..., 1][near]
        e = np.abs(yv - yr).sum() / yr.sum()
        res[(job, v)] = e
        print(f"  {v:8s} " + "".join(cells) + f"  {aa:.3f}      {e:.4f}")
    rows = []
    for v in vns + ["ref"]:
        f = os.path.join(root, job, v + ".png")
        if not os.path.exists(f): continue
        L = luma8(f)
        H, W = L.shape
        rows.append((v, L.mean(), L[int(H * 0.667):int(H * 0.917), :].mean() if H > 900 else float("nan")))
    rr = {v: (c, f) for v, c, f in rows}
    if "ref" in rr:
        print("  显示 8 bit：变体  截图均值（对真值）  下部 2/3–11/12（对真值）")
        for v, c, f in rows:
            print(f"    {v:8s} {c:7.2f} ({c - rr['ref'][0]:+6.2f})   {f:7.2f} ({f - rr['ref'][1]:+6.2f})")
