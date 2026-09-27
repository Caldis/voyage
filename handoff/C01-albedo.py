# 有效反照率 R = π L / E（逐像素，L、E 都不带空气透视）：refE 输出的是 E/π（水平面照度），各变体 / refE 即 R
import sys
import numpy as np
sys.stdout.reconfigure(encoding="utf-8")
d = sys.argv[1]
def load(n):
    return np.fromfile(f"{d}/{n}.bin", dtype=np.float32).reshape(1200, 1600, 4)
ref = load("refE")
op = 1 - ref[..., 3]
m = op > 0.97
wY = np.array([0.2126, 0.7152, 0.0722], dtype=np.float32)
ry = (ref[..., :3] @ wY)[m]
for n in sys.argv[2:]:
    a = load(n)
    y = (a[..., :3] @ wY)[m]
    R = y / np.maximum(ry, 1e-9)
    print(n, "R p10 %.2f p50 %.2f p90 %.2f p99 %.2f" % tuple(np.percentile(R, [10, 50, 90, 99])), " E/π p50 %.1f" % np.median(ry))
