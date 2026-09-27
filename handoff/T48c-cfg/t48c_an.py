# T48c 同帧多变体指标：python t48c_an.py <目录> <场景> <变体,...> [裁剪 x,y,w,h] [--ref 变体]
#  每个变体：裁剪内亮度 / 横向相邻差 / RGB / 最大通道 ≥250 的比例、4 邻域连通块（>20 px 的块数、最大块）；
#  与 ref 的逐像素差（最大、平均、>8 的像素数）。
import sys, os
from collections import deque
import numpy as np
from PIL import Image
sys.stdout.reconfigure(encoding="utf-8")
W = np.array([0.2126, 0.7152, 0.0722])
argv = [a for a in sys.argv[1:]]
ref = "master"
if "--ref" in argv:
    i = argv.index("--ref"); ref = argv[i + 1]; del argv[i:i + 2]
d, s, vs = argv[0], argv[1], argv[2].split(",")
crop = tuple(map(int, argv[3].split(","))) if len(argv) > 3 else None

def load(v):
    p = os.path.join(d, f"{s}.{v}.png")
    return np.asarray(Image.open(p).convert("RGB"), float) if os.path.exists(p) else None

def blobs(mask):
    h, w = mask.shape
    seen = np.zeros_like(mask)
    sizes = []
    ys, xs = np.nonzero(mask)
    for y0, x0 in zip(ys, xs):
        if seen[y0, x0]: continue
        q = deque([(y0, x0)]); seen[y0, x0] = True; n = 0
        while q:
            y, x = q.popleft(); n += 1
            for yy, xx in ((y + 1, x), (y - 1, x), (y, x + 1), (y, x - 1)):
                if 0 <= yy < h and 0 <= xx < w and mask[yy, xx] and not seen[yy, xx]:
                    seen[yy, xx] = True; q.append((yy, xx))
        sizes.append(n)
    return sizes

R = load(ref)
for v in vs:
    im = load(v)
    if im is None:
        print(f"{v}: 缺"); continue
    c = im if crop is None else im[crop[1]:crop[1] + crop[3], crop[0]:crop[0] + crop[2]]
    L = c @ W
    adj = np.abs(np.diff(L, axis=1)).mean()
    hot = c.max(2) >= 250
    sz = blobs(hot) if hot.sum() < 200000 else []
    big = [x for x in sz if x > 20]
    line = f"{v:10s} 亮度 {L.mean():6.1f} 相邻差 {adj:5.2f} RGB {'/'.join(f'{x:.0f}' for x in c.reshape(-1, 3).mean(0))} ≥250 {hot.mean()*100:5.2f}% 块 {len(sz)} >20px {len(big)} 最大 {max(sz) if sz else 0}"
    if R is not None and v != ref:
        dd = np.abs(im - R).max(2)
        line += f" | 对 {ref}: 最大 {dd.max():.0f} 平均 {dd.mean():.3f} >8 {(dd > 8).sum()}"
    print(line)
