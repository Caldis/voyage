# C03：水平横纹指标。横纹 = 沿行方向很长、沿列方向很窄的明暗条。
#   streak：先沿行方向做 9 px 盒式平均（抹掉各向同性的纹理，横纹保留），再取竖直方向二阶差分 |I(y+1) − 2I(y) + I(y−1)| 的均值
#   iso：同样的量转 90°（沿列平均 9 px、取水平二阶差分），作为「普通纹理」的参照
#   ratio = streak / iso：各向同性的云约 1，横纹越多越大
#   adj：相邻像素差（与 C01-texture.py 同口径）
# 用法：python C03-streak.py x,y,w,h 图1 [图2 ...]
import sys
import numpy as np
from PIL import Image
sys.stdout.reconfigure(encoding="utf-8")

def box(a, n, axis):
    k = np.ones(n) / n
    return np.apply_along_axis(lambda m: np.convolve(m, k, "valid"), axis, a)

x, y, w, h = (int(v) for v in sys.argv[1].split(","))
for p in sys.argv[2:]:
    a = np.asarray(Image.open(p).convert("RGB"), dtype=np.float64)[y:y + h, x:x + w]
    L = a @ np.array([0.2126, 0.7152, 0.0722])
    bh = box(L, 9, 1)
    streak = np.abs(bh[2:] - 2 * bh[1:-1] + bh[:-2]).mean()
    bv = box(L, 9, 0)
    iso = np.abs(bv[:, 2:] - 2 * bv[:, 1:-1] + bv[:, :-2]).mean()
    adj = 0.5 * (np.abs(np.diff(L, axis=1)).mean() + np.abs(np.diff(L, axis=0)).mean())
    name = "/".join(p.replace("\\", "/").split("/")[-2:])
    print(f"{name}  luma {L.mean():.1f}  adj {adj:.2f}  streak {streak:.3f}  iso {iso:.3f}  ratio {streak / max(iso, 1e-6):.2f}")
