"""W-EDGE：覆盖率对照图。python W-EDGE-covviz.py <ab 输出目录/job> <covOld|covNew|...> <x,y,w,h> <倍数> <输出.png>
输出三联：左 = 该变体覆盖率，中 = 参考覆盖率，右 = 差（红 = 比参考多，绿 = 比参考少，×4）"""
import base64
import json
import sys

import numpy as np
from PIL import Image

jd, key, crop, s, out = sys.argv[1], sys.argv[2], [int(x) for x in sys.argv[3].split(",")], int(sys.argv[4]), sys.argv[5]
d = json.load(open(jd + "/dump.json", encoding="utf-8"))["jsOut"]
w, h = d["w"], d["h"]
dec = lambda k: np.frombuffer(base64.b64decode(d[k]), np.uint8).reshape(h, w)[::-1].astype(np.float64) / 255.0
A, R = dec(key), dec("covRef")
x, y, cw, ch = crop
A, R = A[y:y + ch, x:x + cw], R[y:y + ch, x:x + cw]
D = A - R
rgb = np.zeros((ch, cw, 3))
rgb[..., 0] = np.clip(D * 4, 0, 1)
rgb[..., 1] = np.clip(-D * 4, 0, 1)
tiles = [np.repeat(A[..., None], 3, 2), np.repeat(R[..., None], 3, 2), rgb]
im = np.concatenate([np.pad(t, ((0, 0), (0, 3), (0, 0)), constant_values=1) for t in tiles], 1)
Image.fromarray((im * 255).astype(np.uint8)).resize((im.shape[1] * s, im.shape[0] * s), Image.NEAREST).save(out)
