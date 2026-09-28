"""W-EDGE：沿轮廓逐行打印（亮度 / 覆盖率），看轮廓像素的颜色和覆盖率各差在哪。
python W-EDGE-rows.py <ab 输出目录/job> <y0> <y1> <x0> <x1> [变体,...]"""
import base64
import json
import sys

import numpy as np
from PIL import Image

sys.stdout.reconfigure(encoding="utf-8")
jd, y0, y1, x0, x1 = sys.argv[1], *map(int, sys.argv[2:6])
vs = sys.argv[6].split(",") if len(sys.argv) > 6 else ["new", "ref"]
d = json.load(open(jd + "/dump.json", encoding="utf-8"))["jsOut"]
w, h = d["w"], d["h"]
dec = lambda k: np.frombuffer(base64.b64decode(d[k]), np.uint8).reshape(h, w)[::-1].astype(np.float64) / 255.0
cov = {k: dec(k) for k in ("covNew", "covRef", "covOld", "covDbg") if k in d}
L = {v: np.asarray(Image.open(f"{jd}/{v}.png").convert("RGB")).astype(np.float64) @ [0.2126, 0.7152, 0.0722] for v in vs}
for y in range(y0, y1):
    print(f"y={y}")
    for v in vs:
        print(f"  {v:>6} L " + " ".join(f"{L[v][y, x]:4.0f}" for x in range(x0, x1)))
    for k in cov:
        print(f"  {k:>6} a " + " ".join(f"{cov[k][y, x]:4.2f}"[1:] if cov[k][y, x] < 1 else " 1.0" for x in range(x0, x1)))
