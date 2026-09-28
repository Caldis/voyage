# 频闪钉亮 vs 钉灭：python t48c_strobe.py <目录> <场景> <亮变体>:<灭参考>[:目录2] ...
#  报「亮了反而变暗」的像素（ΔL < −2）数、均值、最小值，以及变亮像素数
import sys, os
import numpy as np
from PIL import Image
sys.stdout.reconfigure(encoding="utf-8")
W = np.array([0.2126, 0.7152, 0.0722])
d, s = sys.argv[1:3]
for pair in sys.argv[3:]:
    parts = pair.split(":")
    a, b = parts[0], parts[1]
    db = parts[2] if len(parts) > 2 else d
    A = np.asarray(Image.open(os.path.join(d, f"{s}.{a}.png")).convert("RGB"), float) @ W
    B = np.asarray(Image.open(os.path.join(db, f"{s}.{b}.png")).convert("RGB"), float) @ W
    D = A - B
    dk = D < -2
    print(f"{a:10s} − {b:10s}: 变暗 {dk.sum():6d} 像素 均值 {D[dk].mean() if dk.any() else 0:6.1f} 最小 {D.min():6.1f}；变亮(>2) {(D > 2).sum():7d}")
