"""C09：银边剖面。读 C09-rim.mjs --bin 写出的云缓冲（<变体>.bin，W×H×RGBA float32，行自下而上）与 ang.bin（每像素离太阳的角度），
按「离云边往里多少像素」分带，看云自身亮度 c = Y(L)/α 从边到芯怎么衰减；同一分带再在显示截图（<变体>.png）上量一遍。
用法：python handoff/C09-prof.py <场景目录> 变体1 变体2 ... [--zone 15]
输出（每个变体一行）：
  HDR  edge：α 0.2–0.7 的边像素的 c 均值；d1–4 / d4–12 / d12–32 / d32–64 / d64+：α ≥ 0.9 的芯像素按离边距离（像素，1° ≈ 22 px）分带的 c 均值
       rim = edge / 全部芯（α ≥ 0.97），sharp = edge / d12–32（边比「往里 0.5–1.5°」亮多少：越大越像一条细亮边，越小越像一团光晕）
  显示  同样的分带在截图亮度（0–255）上的均值
只统计离太阳 ≤ zone 度的像素。
"""
import sys
import os
import numpy as np
from PIL import Image

sys.stdout.reconfigure(encoding="utf-8")
args = [a for a in sys.argv[1:] if not a.startswith("--")]
zone = 15.0
if "--zone" in sys.argv:
    zone = float(sys.argv[sys.argv.index("--zone") + 1])
d = args[0]
ang = np.fromfile(os.path.join(d, "ang.bin"), dtype=np.float32)


def erode_dist(mask, maxd=64):
    """mask 内每个像素到 mask 外的 4 邻域距离（像素，截断到 maxd）"""
    dist = np.zeros(mask.shape, np.int32)
    cur = mask.copy()
    for k in range(maxd):
        dist[cur] += 1
        n = cur.copy()
        n[1:, :] &= cur[:-1, :]
        n[:-1, :] &= cur[1:, :]
        n[:, 1:] &= cur[:, :-1]
        n[:, :-1] &= cur[:, 1:]
        cur = n
        if not cur.any():
            break
    return dist


BANDS = [(1, 4), (4, 12), (12, 32), (32, 64), (64, 10**9)]
for vn in args[1:]:
    buf = np.fromfile(os.path.join(d, vn + ".bin"), dtype=np.float32).reshape(-1, 4)
    n = buf.shape[0]
    H = 1200 if n == 1600 * 1200 else int(round((n / (4 / 3)) ** 0.5))
    W = n // H
    a = (1 - buf[:, 3]).reshape(H, W)
    Y = (buf[:, :3] @ np.array([0.2126, 0.7152, 0.0722], np.float32)).reshape(H, W)
    A = ang.reshape(H, W)
    c = np.where(a > 1e-3, Y / np.maximum(a, 1e-3), 0)
    z = A <= zone
    dist = erode_dist(a >= 0.9)
    edge = z & (a >= 0.2) & (a <= 0.7)
    core = z & (a >= 0.97)
    # 显示截图（行自上而下），缩放到云缓冲尺寸
    png = os.path.join(d, vn + ".png")
    disp = None
    if os.path.exists(png):
        im = Image.open(png).convert("RGB")
        if im.size != (W, H):
            im = im.resize((W, H))
        disp = (np.asarray(im).astype(np.float64) @ [0.2126, 0.7152, 0.0722])[::-1]

    def row(img):
        e = img[edge].mean() if edge.any() else float("nan")
        bands = [img[z & (dist >= lo) & (dist < hi)].mean() if (z & (dist >= lo) & (dist < hi)).any() else float("nan") for lo, hi in BANDS]
        return e, bands, img[core].mean()

    def texture(img):
        # 亮边一带（边 + 离边 32 px 以内的芯）的纹理：减 5×5 均值后的标准差 ÷ 均值（静态细节 + 单帧噪声都算在内）
        k = sum(np.roll(np.roll(img, i, 0), j, 1) for i in range(-2, 3) for j in range(-2, 3)) / 25
        m = z & (((a >= 0.2) & (a < 0.9)) | ((dist >= 1) & (dist < 32)))
        return (img - k)[m].std() / max(img[m].mean(), 1e-9)

    e, b, k = row(c)
    print(f"{vn:>10} HDR  edge {e:8.2f} | " + " ".join(f"{x:8.2f}" for x in b) + f" | rim {e / k:5.2f} sharp {e / b[2]:5.2f} tex {texture(c):.4f}  (边 {edge.sum()} px)")
    if disp is not None:
        e, b, k = row(disp)
        print(f"{'':>10} 显示 edge {e:8.1f} | " + " ".join(f"{x:8.1f}" for x in b) + f" | rim {e / k:5.2f} sharp {e / b[2]:5.2f} tex {texture(disp):.4f}")
print(f"{'':>10}      分带：边 | d1–4 d4–12 d12–32 d32–64 d64+（像素，α ≥ 0.9 的芯按离边距离）；只算离太阳 ≤ {zone}°")
