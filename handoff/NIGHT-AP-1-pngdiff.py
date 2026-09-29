"""屏幕截图两两比较：python pngdiff.py <目录> a,b ...（窗区裁剪 x 480–1200, y 360–840 另报）"""
import sys
import numpy as np
from PIL import Image

sys.stdout.reconfigure(encoding="utf-8")
d = sys.argv[1]
L = lambda n: np.asarray(Image.open(f"{d}/{n}.png").convert("RGB")).astype(np.int32)
for pair in sys.argv[2:]:
    x, y = pair.split(",")
    a, b = L(x), L(y)
    dd = np.abs(a - b).max(axis=2)
    w = (slice(360, 840), slice(480, 1200))
    print(f"{x} vs {y}: 整图最大 {dd.max()} 平均 {dd.mean():.3f} >1 级 {(dd > 1).sum()} >3 级 {(dd > 3).sum()}；窗区均值差 {(a[w].mean(axis=(0,1)) - b[w].mean(axis=(0,1))).round(3).tolist()}")
