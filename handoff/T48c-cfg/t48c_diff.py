# 差异图：python t48c_diff.py <目录> <场景> <A> <B> [x,y,w,h 放大区域] [倍数]
#  输出 <场景>.diff-<A>-<B>.png：左 A、中 B、右 |A−B|×8（红 = A 更亮，蓝 = B 更亮）；给了区域就只取该区域并放大
import sys, os
import numpy as np
from PIL import Image
sys.stdout.reconfigure(encoding="utf-8")
d, s, a, b = sys.argv[1:5]
A = np.asarray(Image.open(os.path.join(d, f"{s}.{a}.png")).convert("RGB"), float)
B = np.asarray(Image.open(os.path.join(d, f"{s}.{b}.png")).convert("RGB"), float)
W = np.array([0.2126, 0.7152, 0.0722])
if len(sys.argv) > 5:
    x, y, w, h = map(int, sys.argv[5].split(","))
    A = A[y:y + h, x:x + w]; B = B[y:y + h, x:x + w]
k = int(sys.argv[6]) if len(sys.argv) > 6 else 1
dl = (A @ W) - (B @ W)
D = np.zeros_like(A)
D[..., 0] = np.clip(dl * 8, 0, 255)
D[..., 2] = np.clip(-dl * 8, 0, 255)
D[..., 1] = np.clip(np.abs(dl) * 2, 0, 255) * 0
img = np.concatenate([A, B, D], axis=1).astype(np.uint8)
im = Image.fromarray(img)
if k > 1: im = im.resize((im.width * k, im.height * k), Image.NEAREST)
ys, xs = np.nonzero(np.abs(dl) > 8)
print(f"|ΔL|>8: {len(ys)} 像素" + (f"，范围 x {xs.min()}–{xs.max()} y {ys.min()}–{ys.max()}，A−B 均值 {dl[np.abs(dl) > 8].mean():.1f}" if len(ys) else ""))
im.save(os.path.join(d, f"{s}.diff-{a}-{b}.png"))
