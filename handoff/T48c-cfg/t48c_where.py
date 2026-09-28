# 差异像素在哪：python t48c_where.py <A.png> <B.png> [阈值]
import sys
import numpy as np
from PIL import Image
sys.stdout.reconfigure(encoding="utf-8")
W = np.array([0.2126, 0.7152, 0.0722])
A = np.asarray(Image.open(sys.argv[1]).convert("RGB"), float) @ W
B = np.asarray(Image.open(sys.argv[2]).convert("RGB"), float) @ W
t = float(sys.argv[3]) if len(sys.argv) > 3 else 8
d = A - B
for name, m in (("A 更亮", d > t), ("B 更亮", d < -t)):
    ys, xs = np.nonzero(m)
    if len(ys):
        print(f"{name}: {len(ys)} 像素，x {xs.min()}–{xs.max()} y {ys.min()}–{ys.max()}，中位点 ({int(np.median(xs))},{int(np.median(ys))})")
    else:
        print(f"{name}: 0")
