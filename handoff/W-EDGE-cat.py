"""W-EDGE 调试：按 covDbg（wingTrace 探测段走了哪条分支）分类统计边缘带里的像素数与对参考图的差和。
python W-EDGE-cat.py <ab 输出目录/job> [变体=new]"""
import base64
import json
import sys

import numpy as np
from PIL import Image

sys.stdout.reconfigure(encoding="utf-8")
jd = sys.argv[1]
v = sys.argv[2] if len(sys.argv) > 2 else "new"
d = json.load(open(jd + "/dump.json", encoding="utf-8"))["jsOut"]
w, h = d["w"], d["h"]
dec = lambda k: np.frombuffer(base64.b64decode(d[k]), np.uint8).reshape(h, w)[::-1].astype(np.float64) / 255.0
mixed = dec("mixed") > 0.5
P = np.pad(mixed, 1)
E = np.zeros_like(mixed)
for dy in (-1, 0, 1):
    for dx in (-1, 0, 1):
        E |= P[1 + dy:1 + dy + h, 1 + dx:1 + dx + w]
cat = np.round(dec("covDbg") * 10).astype(int)
cn, cr = dec("covNew"), dec("covRef")
A = np.asarray(Image.open(f"{jd}/{v}.png").convert("RGB")).astype(np.float64)
R = np.asarray(Image.open(f"{jd}/ref.png").convert("RGB")).astype(np.float64)
D = np.abs(A - R).max(2)
names = {0: "未探测", 1: "深处满覆盖", 2: "走远放弃", 3: "折角", 4: "探测满覆盖", 5: "背后有机翼", 6: "解析", 7: "延续步数用完"}
for c in range(8):
    m = E & (cat == c)
    if m.sum():
        print(f"{names[c]:>8}: {int(m.sum()):6d} 像素  差和 {D[m].sum():8.0f}  覆盖率误差均值 {np.abs(cn - cr)[m].mean():.3f} 有符号 {(cn - cr)[m].mean():+.3f} 参考覆盖率均值 {cr[m].mean():.2f}")
