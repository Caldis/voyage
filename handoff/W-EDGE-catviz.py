"""W-EDGE 调试：在截图上标出覆盖率误差大的像素（按分支）。红 = 比参考少 > 0.25，绿 = 多 > 0.25；只标指定分支。
python W-EDGE-catviz.py <ab 输出目录/job> <分支编号,...> <x,y,w,h> <倍数> <输出.png>"""
import base64
import json
import sys

import numpy as np
from PIL import Image

jd, cats, crop, s, out = sys.argv[1], [int(c) for c in sys.argv[2].split(",")], [int(x) for x in sys.argv[3].split(",")], int(sys.argv[4]), sys.argv[5]
d = json.load(open(jd + "/dump.json", encoding="utf-8"))["jsOut"]
w, h = d["w"], d["h"]
dec = lambda k: np.frombuffer(base64.b64decode(d[k]), np.uint8).reshape(h, w)[::-1].astype(np.float64) / 255.0
cat = np.round(dec("covDbg") * 10).astype(int)
e = dec("covNew") - dec("covRef")
A = np.asarray(Image.open(f"{jd}/new.png").convert("RGB")).astype(np.float64) * 0.6
sel = np.isin(cat, cats)
A[sel & (e < -0.25)] = [255, 0, 0]
A[sel & (e > 0.25)] = [0, 255, 0]
A[sel & (np.abs(e) <= 0.25)] = [255, 255, 0]
x, y, cw, ch = crop
Image.fromarray(A[y:y + ch, x:x + cw].astype(np.uint8)).resize((cw * s, ch * s), Image.NEAREST).save(out)
