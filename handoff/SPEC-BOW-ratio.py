"""on / off 两张截图的亮度比，放大对比后存成图（1 = 灰 128，±gain 映射到 0 / 255）。用法：python bow-ratio.py on.png off.png out.png [gain=0.2]"""
import sys
import numpy as np
from PIL import Image

a = np.asarray(Image.open(sys.argv[1]).convert("RGB")).astype(np.float64)
b = np.asarray(Image.open(sys.argv[2]).convert("RGB")).astype(np.float64)
gain = float(sys.argv[4]) if len(sys.argv) > 4 else 0.2
r = (a.mean(2) + 1) / (b.mean(2) + 1)
img = np.clip(128 + (r - 1) / gain * 127, 0, 255).astype(np.uint8)
Image.fromarray(img).save(sys.argv[3])
print("比值 p1/p50/p99:", np.percentile(r, [1, 50, 99]).round(3))
