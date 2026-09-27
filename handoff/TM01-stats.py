# TM01 回归表：每个场景、每个变体
#   窗（420,120,760×1000）/ 舱壁（0,0,300×1200）：luma 均值、相邻像素差 adj（C01-texture.py 同口径）、RGB 均值
#   有云缓冲（.bin）时再按不透明度分：云（> 0.5）与非云（< 0.05：海 / 天空 / 地面）的 RGB 均值与 adj
#   hi250：窗内任一通道 ≥ 250 的像素比例；d8：与参考变体逐像素差 (|ΔR|+|ΔG|+|ΔB|)/3 > 8 的比例（compare.mjs --diff 同口径），dmax 最大差
# 用法：python TM01-stats.py <根目录> <参考变体> <变体,...> [场景,...]
import sys, os
import numpy as np
from PIL import Image
sys.stdout.reconfigure(encoding="utf-8")

WIN = (420, 120, 760, 1000)
WALL = (0, 0, 300, 1200)
W709 = np.array([0.2126, 0.7152, 0.0722])

def load(p):
    return np.asarray(Image.open(p).convert("RGB"), dtype=np.float64)

def crop(a, b):
    x, y, w, h = b
    return a[y:y + h, x:x + w]

def adj_of(L, m=None):
    dx = np.abs(np.diff(L, axis=1)); dy = np.abs(np.diff(L, axis=0))
    if m is None:
        return 0.5 * (dx.mean() + dy.mean())
    mx = m[:, 1:] & m[:, :-1]; my = m[1:, :] & m[:-1, :]
    if mx.sum() < 50:
        return float("nan")
    return 0.5 * (dx[mx].mean() + dy[my].mean())

def fmt_rgb(a):
    m = a.reshape(-1, 3).mean(axis=0)
    return f"{m[0]:.0f}/{m[1]:.0f}/{m[2]:.0f}"

def main():
    root, ref = sys.argv[1], sys.argv[2]
    names = sys.argv[3].split(",")
    scenes = sys.argv[4].split(",") if len(sys.argv) > 4 else sorted(d for d in os.listdir(root) if os.path.isdir(os.path.join(root, d)))
    for sc in scenes:
        d = os.path.join(root, sc)
        if not os.path.exists(os.path.join(d, ref + ".png")):
            continue
        R = load(os.path.join(d, ref + ".png"))
        print(f"\n## {sc}")
        print("| 变体 | 窗 luma / adj / RGB | 舱壁 luma / adj / RGB | 云 RGB / adj | 非云 RGB / adj | hi250 | d8 / dmax |")
        print("| --- | --- | --- | --- | --- | ---: | --- |")
        for nm in names:
            p = os.path.join(d, nm + ".png")
            if not os.path.exists(p):
                continue
            A = load(p)
            w = crop(A, WIN); Lw = w @ W709
            c = crop(A, WALL); Lc = c @ W709
            cloud = non = "—"
            b = os.path.join(d, nm + ".bin")
            if os.path.exists(b):
                O = 1.0 - np.fromfile(b, dtype=np.float32).reshape(1200, 1600, 4)[::-1][:, :, 3]
                O = crop(O, WIN)
                mc, mn = O > 0.5, O < 0.05
                if mc.sum() > 100:
                    cloud = f"{fmt_rgb(w[mc])} / {adj_of(Lw, mc):.2f}"
                if mn.sum() > 100:
                    non = f"{fmt_rgb(w[mn])} / {adj_of(Lw, mn):.2f}"
            hi = (w.max(axis=2) >= 250).mean()
            diff = np.abs(A - R).sum(axis=2) / 3
            print(f"| {nm} | {Lw.mean():.1f} / {adj_of(Lw):.2f} / {fmt_rgb(w)} | {Lc.mean():.1f} / {adj_of(Lc):.2f} / {fmt_rgb(c)} | {cloud} | {non} | {hi * 100:.3f}% | {(diff > 8).mean() * 100:.2f}% / {diff.max():.0f} |")

main()
