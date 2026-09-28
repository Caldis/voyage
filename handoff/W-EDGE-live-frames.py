"""wedge3：live 录像连续几帧的放大并排（跳过频闪帧），看到底是什么在闪。
python frames.py <job 目录> <w> <h> <变体,...> <x,y,w,h（翻转后）> <起始帧> <帧数> <倍数> <输出.png>"""
import json
import os
import sys

import numpy as np
from PIL import Image

jd, w, h, vs = sys.argv[1], int(sys.argv[2]), int(sys.argv[3]), sys.argv[4].split(",")
x, y, cw, ch = [int(v) for v in sys.argv[5].split(",")]
f0, nf, s, out = int(sys.argv[6]), int(sys.argv[7]), int(sys.argv[8]), sys.argv[9]
rows = []
for v in vs:
    a = np.memmap(f"{jd}/live_{v}_{w}x{h}.u8", np.uint8, "r")
    n = a.size // (w * h * 4)
    A = a[: n * w * h * 4].reshape(n, h, w, 4)[:, ::-1]
    fl = f"{jd}/live_{v}_flags.json"
    st = np.array(json.load(open(fl))["uStrobe"][:n]) >= 0.5 if os.path.exists(fl) and "uStrobe" in json.load(open(fl)) else np.zeros(n, bool)
    idx = [i for i in range(f0, n) if not st[i]][:nf]
    tiles = [A[i, y:y + ch, x:x + cw, :3] for i in idx]
    rows.append(np.concatenate([np.pad(t, ((0, 0), (0, 1), (0, 0)), constant_values=255) for t in tiles], 1))
im = np.concatenate([np.pad(r, ((0, 1), (0, 0), (0, 0)), constant_values=255) for r in rows], 0)
Image.fromarray(im).resize((im.shape[1] * s, im.shape[0] * s), Image.NEAREST).save(out)
