"""live 帧序列（RGBA u8，W×H×帧）的闪烁像素分布：二阶时间差 > thr 的帧占比 > frac 的像素标红，叠在首帧上。
python TW04rev-flickmap.py <u8 文件> W H <输出.png> [y0 y1]"""
import sys
import numpy as np
from PIL import Image

sys.stdout.reconfigure(encoding="utf-8")
path, W, H, out = sys.argv[1], int(sys.argv[2]), int(sys.argv[3]), sys.argv[4]
y0, y1 = (int(sys.argv[5]), int(sys.argv[6])) if len(sys.argv) > 6 else (0, H)
a = np.memmap(path, dtype=np.uint8, mode="r")
n = a.size // (W * H * 4)
a = a.reshape(n, H, W, 4)[:, y0:y1, :, :3].astype(np.float32)
lum = a @ np.array([0.2126, 0.7152, 0.0722], dtype=np.float32)
d2 = np.abs(lum[2:] - 2 * lum[1:-1] + lum[:-2])
frac = (d2 > 16).mean(axis=0)
mask = frac > 0.05
print(f"帧 {n}，闪烁像素 {int(mask.sum())}，最大占比 {frac.max():.3f}")
ys, xs = np.nonzero(mask)
if len(ys):
    print(f"位置 y {ys.min() + y0}–{ys.max() + y0} x {xs.min()}–{xs.max()}")
base = a[0].astype(np.uint8).copy()
base[mask] = [255, 0, 0]
im = Image.fromarray(base)
im = im.resize((im.width * 2, im.height * 2), Image.NEAREST)
im.save(out)
