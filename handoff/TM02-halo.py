# TM02 局部色调映射的光晕指标（halo）：
#   逐点的色调曲线（TM01 的全局曲线）改变的量只取决于像素自己的颜色；局部色调映射多出来的那部分取决于邻域，
#   光晕就是「离云边多远」这件事对改变量的系统性影响。所以：
#   D = 变体显示 luma − 参考变体显示 luma；在离云边 ≥ 25 px 的云内部，按参考 luma（每 1 级一格）取 D 的中位数，得到「像逐点曲线那样」的改变量 f(L)；
#   残差 R = D − f(L_ref)。逐点曲线 R 的均值在各距离上都 ≈ 0；局部色调映射的光晕表现为云边附近 R 的均值偏离内部。
#   按离云边的距离分格（云内：不透明度 > 0.5 一侧，报 R 的均值；云外：< 0.05 一侧，门控为 0，直接报 D 的均值，应为 0），显示级（0–255）。
#   光晕幅度 = 各近边格 |R 均值 − 内部格 R 均值| 的最大值；光晕宽度 = 该差 > 0.5 级的最远格的外沿（px），没有就是 0。
#   只统计窗内（<场景>/mask.png，曝光合成的 uDebugMask 截图，白 = 窗外）腐蚀 4 px，避开窗框。
# 用法：python TM02-halo.py <根目录> <参考变体> <变体,...> <场景,...>
import sys, os
import numpy as np
from PIL import Image
sys.stdout.reconfigure(encoding="utf-8")
X, Y, W, H = 420, 120, 760, 1000
W709 = np.array([0.2126, 0.7152, 0.0722])
BINS = [(1, 2), (3, 4), (5, 8), (9, 16), (17, 24)]
INNER = 25

def lum(p):
    return (np.asarray(Image.open(p).convert("RGB"), float) @ W709)[Y:Y + H, X:X + W]

def erode(m, n):
    m = m.copy()
    for _ in range(n):
        p = np.pad(m, 1, mode="edge")
        m = p[1:-1, 1:-1] & p[:-2, 1:-1] & p[2:, 1:-1] & p[1:-1, :-2] & p[1:-1, 2:]
    return m

def dist_in(m, cap=INNER):
    """m 内每个像素到 m 外的距离（4 邻域逐层腐蚀，≥ cap 的记 cap）"""
    d = np.zeros(m.shape, int)
    cur = m.copy()
    for i in range(1, cap + 1):
        d[cur] = i
        p = np.pad(cur, 1, mode="edge")
        cur = p[1:-1, 1:-1] & p[:-2, 1:-1] & p[2:, 1:-1] & p[1:-1, :-2] & p[1:-1, 2:]
        if not cur.any():
            break
    d[cur] = cap
    return d

root, ref, names, scenes = sys.argv[1], sys.argv[2], sys.argv[3].split(","), sys.argv[4].split(",")
for s in scenes:
    d = os.path.join(root, s)
    R0 = lum(os.path.join(d, ref + ".png"))
    O = (1.0 - np.fromfile(os.path.join(d, ref + ".bin"), dtype=np.float32).reshape(1200, 1600, 4)[::-1][:, :, 3])[Y:Y + H, X:X + W]
    mp = os.path.join(d, "mask.png")
    win = erode(lum(mp) > 250, 4) if os.path.exists(mp) else np.ones_like(R0, bool)
    din = dist_in(O > 0.5)
    dout = dist_in(O < 0.05)
    inner = win & (din >= INNER)
    print(f"\n## {s}（窗内云内部像素 {inner.sum()}，参考 {ref}）")
    hdr = " | ".join(f"云内 {a}–{b}" for a, b in BINS) + " | 云内 ≥25 | " + " | ".join(f"云外 {a}–{b}" for a, b in BINS[:3])
    print(f"| 变体 | {hdr} | 光晕幅度 / 宽度 px | D 均值（云） |")
    print("|---|" + "---:|" * (len(BINS) + 4) + "---|---:|")
    for nm in names:
        F = lum(os.path.join(d, nm + ".png"))
        D = F - R0
        keys = np.clip(np.round(R0).astype(int), 0, 255)
        f = np.zeros(256)
        cnt = np.bincount(keys[inner], minlength=256)
        for k in np.nonzero(cnt >= 20)[0]:
            f[k] = np.median(D[inner & (keys == k)])
        have = cnt >= 20
        if have.any():  # 没数据的亮度格按最近的有数据格插值
            idx = np.nonzero(have)[0]
            f = np.interp(np.arange(256), idx, f[idx])
        Rr = D - f[keys]
        base = Rr[inner].mean() if inner.any() else 0.0
        cells, amp, width = [], 0.0, 0
        for a, b in BINS:
            m = win & (din >= a) & (din <= b)
            v = Rr[m].mean() if m.sum() > 200 else float("nan")
            cells.append(v)
            if not np.isnan(v):
                amp = max(amp, abs(v - base))
                if abs(v - base) > 0.5:
                    width = max(width, b)
        out = []
        for a, b in BINS[:3]:
            m = win & (dout >= a) & (dout <= b)
            out.append(D[m].mean() if m.sum() > 200 else float("nan"))  # 云外（天空）不吃增益，直接报 D（应为 0）
        cl = win & (O > 0.5)
        print(f"| {nm} | " + " | ".join(f"{v:+.2f}" for v in cells) + f" | {base:+.2f} | " + " | ".join(f"{v:+.2f}" for v in out)
              + f" | {amp:.2f} / {width} | {D[cl].mean():+.2f} |")
