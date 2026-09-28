"""SEA-3 验收指标：对 accept 组 ab 输出的每个 job 目录算
- 非相关像素（new 与 maskG、maskT 都逐位相同的像素）上 old vs new 的差：应为 0
- 噪声底：old vs old#2、new vs new#2
- 暗墙：x=1000 列上地平线附近最大的相邻行亮度跳变（硬边）
- 横纹：cruise-ground 裁剪区的逐行残差 RMS 与自相关周期（同 SEA-3-stripes.py）
- 尾迹：maskT 标出的尾迹像素上，old / new 对 noTraffic 近似背景（尾迹像素上下 6 行的均值）的亮度差
用法：python SEA-3-accept.py <accept 输出目录>
"""
import sys
from pathlib import Path

import numpy as np
from PIL import Image

sys.stdout.reconfigure(encoding="utf-8")
W = np.array([0.2126, 0.7152, 0.0722])


def load(p):
    return np.asarray(Image.open(p).convert("RGB"), dtype=np.int32)


def find(d, name, r):
    for cand in ([f"{name}_r{r}.png"] if r > 1 else [f"{name}.png"]):
        if (d / cand).exists():
            return d / cand
    hits = sorted(d.glob(f"{name}*.png"))
    hits = [h for h in hits if not h.stem.startswith(name + "_") and "zoom" not in h.stem]
    return hits[min(r - 1, len(hits) - 1)] if hits else None


def stripes(lum):
    K = 31
    rows = lum.mean(axis=1)
    pad = np.pad(rows, K // 2, mode="edge")
    res = rows - np.convolve(pad, np.ones(K) / K, mode="valid")
    r = res[K:-K] - res[K:-K].mean()
    rms = float(np.sqrt(np.mean(r**2)))
    ac = np.correlate(r, r, mode="full")[len(r) - 1 :]
    ac = ac / max(ac[0], 1e-9)
    per = None
    for i in range(3, min(80, len(ac) - 1)):
        if ac[i] > ac[i - 1] and ac[i] >= ac[i + 1] and ac[i] > 0.1:
            per = (i, round(float(ac[i]), 2))
            break
    return rms, per


root = Path(sys.argv[1])
for d in sorted(p for p in root.iterdir() if p.is_dir()):
    files = sorted(x.name for x in d.glob("*.png"))
    o1, n1 = find(d, "old", 1), find(d, "new", 1)
    o2, n2 = find(d, "old", 2), find(d, "new", 2)
    mg, mt = find(d, "maskG", 1), find(d, "maskT", 1)
    if not (o1 and n1 and mg and mt):
        print(d.name, "缺图", files[:8])
        continue
    O, N, MG, MT = load(o1), load(n1), load(mg), load(mt)
    unrel = np.all(N == MG, axis=2) & np.all(N == MT, axis=2)
    dd = np.abs(O - N).max(axis=2)
    print(f"== {d.name}")
    print(f"  非相关像素 {int(unrel.sum())}：old/new 差 >0 的 {int((dd[unrel] > 0).sum())} 个，最大 {int(dd[unrel].max()) if unrel.any() else 0}")
    for a, b, lab in ((o1, o2, "old"), (n1, n2, "new")):
        if a and b and a != b:
            x = np.abs(load(a) - load(b))
            print(f"  噪声底 {lab}: mean {x.mean():.3f} max {int(x.max())}")
    lo, ln = O @ W, N @ W
    if "hnd-low-day" in d.name or "sea-mod-low" in d.name:
        x0 = 1000
        for lab, L in (("old", lo), ("new", ln)):
            col = L[380:700, x0 - 3 : x0 + 4].mean(axis=1)
            j = np.abs(np.diff(col))
            k = int(j.argmax())
            print(f"  {lab} x={x0} 列 y380–700 最大相邻行跳变 {j.max():.1f}（y={380 + k}）")
    if "cruise-ground" in d.name:
        for lab, L in (("old", lo), ("new", ln)):
            rms, per = stripes(L[60:320, 700:1250])
            print(f"  {lab} 横纹：行残差 RMS {rms:.3f}  周期 {per}")
    if "@" in d.name:
        m = np.any(MT != N, axis=2)
        if m.any():
            ys, xs = np.nonzero(m)
            # 背景：同列上下 8 行外的像素（不在尾迹里）
            bg_o, bg_n, vo, vn = [], [], [], []
            for y, x in zip(ys, xs):
                for yy in (y - 8, y + 8):
                    if 0 <= yy < m.shape[0] and not m[yy, x]:
                        vo.append(lo[y, x]); bg_o.append(lo[yy, x]); vn.append(ln[y, x]); bg_n.append(ln[yy, x])
                        break
            print(f"  尾迹像素 {int(m.sum())}：old − 背景 {np.mean(vo) - np.mean(bg_o):+.2f}，new − 背景 {np.mean(vn) - np.mean(bg_n):+.2f}")
