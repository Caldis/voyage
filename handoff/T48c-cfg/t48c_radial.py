# 灯周围按扇区的径向亮度剖面：python t48brev-radial.py <目录> <场景> <cx,cy> <角度起,止(度，y 向下为正)> <变体,...>
import sys, os
import numpy as np
from PIL import Image
sys.stdout.reconfigure(encoding="utf-8")
d, s, c, ang, vs = sys.argv[1:6]
cx, cy = map(float, c.split(","))
a0, a1 = map(float, ang.split(","))
W = np.array([0.2126, 0.7152, 0.0722])
rows = []
for v in vs.split(","):
    L = np.asarray(Image.open(os.path.join(d, f"{s}.{v}.png")).convert("RGB"), float) @ W
    yy, xx = np.mgrid[0:L.shape[0], 0:L.shape[1]]
    r = np.hypot(xx - cx, yy - cy); th = np.degrees(np.arctan2(yy - cy, xx - cx)) % 360
    sec = (th >= a0) & (th <= a1)
    prof = []
    for r0 in [0, 3, 6, 10, 15, 20, 30, 40, 55, 70, 90, 120, 160]:
        m = sec & (r >= r0) & (r < r0 + max(3, r0 * 0.25))
        prof.append(L[m].mean() if m.any() else np.nan)
    rows.append((v, prof))
print("半径:", [0, 3, 6, 10, 15, 20, 30, 40, 55, 70, 90, 120, 160])
for v, p in rows:
    print(f"{v:8s}", " ".join(f"{x:6.1f}" for x in p))
