# WX11g-b：耀斑椒盐点指标（读 ab 的冻结截图）。
# 用法：python apps/voyage/handoff/WX11g-b-metrics.py <ab 输出的 job 目录> [crop x,y,w,h]
# 每个风速档读 old{w}.png / new{w}.png / noglint{w}.png（及 _r2 第二轮），在裁剪区里统计：
#   耀斑区 = old 或 new 与 noglint（耀斑项乘 0）亮度差 > 4 的像素；
#   孤立亮点 = 比 8 邻域最大值还亮 > 24 级的像素（「椒」）；孤立暗点 = 比 8 邻域最小值还暗 > 24 级（「盐」里的黑点）；
#   死白 = 亮度 ≥ 250 的 8 连通块（DEV_SOP 口径），报块数、单像素块数、最大面积；
#   相邻差 = 耀斑区内横纵相邻像素差平均（DEV_SOP 口径：横纵平均）；
#   耀斑区平均亮度（8 位显示值，能量对照）；
#   非耀斑像素（old 与 noglint 逐位相同的像素）上 new 与 old 的差 = 应为 0；
#   噪声底 = 同变体两轮之差。
import glob
import json
import os
import re
import sys

import numpy as np
from PIL import Image

sys.stdout.reconfigure(encoding="utf-8")
d = sys.argv[1]
crop = [int(x) for x in sys.argv[2].split(",")] if len(sys.argv) > 2 else [400, 560, 800, 540]
x0, y0, cw, ch = crop


def load(name):
    p = os.path.join(d, name + ".png")
    if not os.path.exists(p):
        return None
    a = np.asarray(Image.open(p).convert("RGB"), dtype=np.float32)
    return a[y0 : y0 + ch, x0 : x0 + cw]


def lum(a):
    return 0.2126 * a[..., 0] + 0.7152 * a[..., 1] + 0.0722 * a[..., 2]


def neigh_stack(L):
    P = np.pad(L, 1, mode="edge")
    h, w = L.shape
    return np.stack([P[1 + dy : 1 + dy + h, 1 + dx : 1 + dx + w] for dy in (-1, 0, 1) for dx in (-1, 0, 1) if dy or dx])


def components(mask):
    # 8 连通块面积（纯 numpy + 并查集太长，用简单 BFS；死白像素一般不多）
    h, w = mask.shape
    seen = np.zeros_like(mask, dtype=bool)
    sizes = []
    ys, xs = np.nonzero(mask)
    for y, x in zip(ys, xs):
        if seen[y, x]:
            continue
        stack = [(y, x)]
        seen[y, x] = True
        n = 0
        while stack:
            cy, cx = stack.pop()
            n += 1
            for dy in (-1, 0, 1):
                for dx in (-1, 0, 1):
                    ny, nx = cy + dy, cx + dx
                    if 0 <= ny < h and 0 <= nx < w and mask[ny, nx] and not seen[ny, nx]:
                        seen[ny, nx] = True
                        stack.append((ny, nx))
        sizes.append(n)
        if len(sizes) > 200000:
            break
    return sizes


winds = sorted({m.group(1) for f in glob.glob(os.path.join(d, "new*.png")) for m in [re.match(r"new([0-9.]+)\.png$", os.path.basename(f))] if m}, key=float)
rows = []
for w in winds:
    o, n, g = load(f"old{w}"), load(f"new{w}"), load(f"noglint{w}")
    o2, n2 = load(f"old{w}_r2"), load(f"new{w}_r2")
    Lo, Ln, Lg = lum(o), lum(n), lum(g)
    G = (np.abs(Lo - Lg) > 4) | (np.abs(Ln - Lg) > 4)
    res = {"wind": float(w), "glintPx": int(G.sum())}
    for tag, L, A in (("old", Lo, o), ("new", Ln, n)):
        S = neigh_stack(L)
        iso_b = (L - S.max(axis=0) > 24) & G
        iso_d = (S.min(axis=0) - L > 24) & G
        blown = L >= 250
        sz = components(blown)
        ad = (np.abs(np.diff(L, axis=1))[G[:, 1:]].mean() + np.abs(np.diff(L, axis=0))[G[1:, :]].mean()) / 2 if G.sum() > 10 else 0.0
        res[tag] = {
            "isoBright": int(iso_b.sum()),
            "isoDark": int(iso_d.sum()),
            "blownBlobs": len(sz),
            "blown1px": int(sum(1 for s in sz if s == 1)),
            "blownMaxArea": int(max(sz) if sz else 0),
            "blownPx": int(blown.sum()),
            "adjDiffGlint": round(float(ad), 3),
            "meanGlint": round(float(L[G].mean()) if G.sum() else 0.0, 2),
            "meanCrop": round(float(L.mean()), 3),
        }
    same = np.all(o == g, axis=-1)
    dnew = np.any(n != o, axis=-1)
    res["nonGlintChanged"] = int((dnew & same).sum())
    res["nonGlintMaxDiff"] = float(np.abs(n - o)[same].max()) if same.any() else 0.0
    res["noiseOld"] = float(np.abs(o2 - o).max()) if o2 is not None else None
    res["noiseNew"] = float(np.abs(n2 - n).max()) if n2 is not None else None
    rows.append(res)

print(f"{os.path.basename(d)}  crop={crop}")
print("风速 | 耀斑区像素 | 孤立亮点 old→new | 孤立暗点 old→new | 死白块(单像素) old→new | 死白最大面积 | 耀斑区相邻差 old→new | 耀斑区均亮 old→new | 非耀斑像素变化 | 噪声底 old/new")
for r in rows:
    o, n = r["old"], r["new"]
    print(
        f"{r['wind']:>4} | {r['glintPx']:>7} | {o['isoBright']:>6} → {n['isoBright']:<6} | {o['isoDark']:>6} → {n['isoDark']:<6} | "
        f"{o['blownBlobs']}({o['blown1px']}) → {n['blownBlobs']}({n['blown1px']}) | {o['blownMaxArea']} → {n['blownMaxArea']} | "
        f"{o['adjDiffGlint']} → {n['adjDiffGlint']} | {o['meanGlint']} → {n['meanGlint']} | {r['nonGlintChanged']} (max {r['nonGlintMaxDiff']}) | {r['noiseOld']}/{r['noiseNew']}"
    )
json.dump(rows, open(os.path.join(d, "wx11gb-metrics.json"), "w", encoding="utf-8"), ensure_ascii=False, indent=1)
