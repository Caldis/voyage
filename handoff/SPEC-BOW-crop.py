"""裁剪 + 放大 + 可选对比增强：python bow-crop.py in.png out.png x y w h [scale=2] [contrast=1]"""
import sys
import numpy as np
from PIL import Image

im = Image.open(sys.argv[1]).convert("RGB")
x, y, w, h = map(int, sys.argv[3:7])
sc = float(sys.argv[7]) if len(sys.argv) > 7 else 2
ct = float(sys.argv[8]) if len(sys.argv) > 8 else 1
c = im.crop((x, y, x + w, y + h))
if ct != 1:
    a = np.asarray(c).astype(np.float64)
    m = a.mean((0, 1), keepdims=True)
    a = np.clip(m + (a - m) * ct, 0, 255).astype(np.uint8)
    c = Image.fromarray(a)
c = c.resize((int(w * sc), int(h * sc)), Image.LANCZOS)
c.save(sys.argv[2])
