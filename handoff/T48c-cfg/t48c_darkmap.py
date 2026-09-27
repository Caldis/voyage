# 「亮了反而变暗」的像素标红叠在 B 上：python t48c_darkmap.py <A.png> <B.png> <输出.png> [x,y,w,h] [倍数]
import sys
import numpy as np
from PIL import Image
sys.stdout.reconfigure(encoding="utf-8")
W = np.array([0.2126, 0.7152, 0.0722])
A = np.asarray(Image.open(sys.argv[1]).convert("RGB"), float)
B = np.asarray(Image.open(sys.argv[2]).convert("RGB"), float)
d = (A - B) @ W
o = A.copy()
m = d < -2
o[m] = [255, 0, 0]
if len(sys.argv) > 4:
    x, y, w, h = map(int, sys.argv[4].split(",")); o = o[y:y + h, x:x + w]
im = Image.fromarray(o.astype(np.uint8))
k = int(sys.argv[5]) if len(sys.argv) > 5 else 1
if k > 1: im = im.resize((im.width * k, im.height * k), Image.NEAREST)
im.save(sys.argv[3])
