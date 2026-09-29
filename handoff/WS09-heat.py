"""live 帧的闪烁热图：python ws09-heat.py 帧文件.u8 宽 高 输出.png（u8 按 帧×高×宽 灰度或 RGBA 自动判断）"""
import sys
import numpy as np
from PIL import Image

f, w, h, out = sys.argv[1], int(sys.argv[2]), int(sys.argv[3]), sys.argv[4]
a = np.fromfile(f, dtype=np.uint8)
for ch in (1, 3, 4):
    if a.size % (w * h * ch) == 0 and a.size // (w * h * ch) in range(200, 300):
        break
n = a.size // (w * h * ch)
a = a.reshape(n, h, w, ch).astype(np.float32)
y = a[..., 0] if ch == 1 else (0.2126 * a[..., 0] + 0.7152 * a[..., 1] + 0.0722 * a[..., 2])
d2 = np.abs(y[2:] - 2 * y[1:-1] + y[:-2])
frac = (d2 > 16).mean(axis=0)
print("帧", n, "通道", ch, "闪烁像素", int((frac > 0.05).sum()))
ys, xs = np.nonzero(frac > 0.05)
if len(ys):
    print("行范围", ys.min(), ys.max(), "列范围", xs.min(), xs.max())
    hist = np.bincount(ys // 20)
    print("按 20 行分组：", {int(i * 20): int(c) for i, c in enumerate(hist) if c})
img = np.clip(frac * 255 * 4, 0, 255).astype(np.uint8)
base = np.clip(y.mean(axis=0), 0, 255).astype(np.uint8)
Image.fromarray(np.concatenate([base, img], axis=1)).save(out)
