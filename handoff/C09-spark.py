"""C09：实时单帧里的亮点（萤火虫）与对角高频。用法：python handoff/C09-spark.py x,y,w,h a.png b.png ...
亮点：显示亮度比 5×5 邻域中位数高 > 12/255 的孤立像素（邻域里只有它亮）所占比例（‰）；对角高频与 C03-hf.py 同口径。
"""
import sys
import numpy as np
from PIL import Image

sys.stdout.reconfigure(encoding="utf-8")
x, y, w, h = [int(v) for v in sys.argv[1].split(",")]
for f in sys.argv[2:]:
    L = np.asarray(Image.open(f).convert("RGB").crop((x, y, x + w, y + h))).astype(np.float64) @ [0.2126, 0.7152, 0.0722]
    st = np.stack([np.roll(np.roll(L, i, 0), j, 1) for i in range(-2, 3) for j in range(-2, 3)], 0)
    med = np.median(st, 0)
    spike = (L - med > 12)[2:-2, 2:-2]
    F = np.abs(np.fft.fftshift(np.fft.fft2(L - L.mean()))) ** 2
    cy, cx = h // 2, w // 2
    yy, xx = np.mgrid[0:h, 0:w]
    fy, fx = (yy - cy) / h, (xx - cx) / w
    r = np.hypot(fx, fy)
    diagb = F[(np.abs(fx) > 0.2) & (np.abs(fy) > 0.2)].sum() / F[r > 0.02].sum()
    print(f"{f}: 亮点 {spike.mean() * 1000:.3f}‰  对角高频 {diagb:.4f}")
