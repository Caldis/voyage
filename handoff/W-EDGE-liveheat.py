"""W-EDGE：ab live 录下的逐帧亮度（live_<变体>_<w>x<h>.u8）→ 每像素「时间二阶差 > 阈值」的帧占比热图，变体并排。
python W-EDGE-liveheat.py <ab 输出目录/job> <w> <h> <变体,...> <输出.png> [阈值 8] [y0 y1 只看这几行]"""
import sys

import numpy as np
from PIL import Image

jd, w, h, vs, out = sys.argv[1], int(sys.argv[2]), int(sys.argv[3]), sys.argv[4].split(","), sys.argv[5]
thr = float(sys.argv[6]) if len(sys.argv) > 6 else 8.0
tiles = []
for v in vs:
    a = np.fromfile(f"{jd}/live_{v}_{w}x{h}.u8", np.uint8)
    n = a.size // (w * h * 4)   # RGBA
    F = a[: n * w * h * 4].reshape(n, h, w, 4)[..., :3].astype(np.float32) @ np.array([0.2126, 0.7152, 0.0722], np.float32)
    d2 = np.abs(F[1:-1] - 0.5 * (F[:-2] + F[2:]))
    frac = (d2 > thr).mean(0)
    base = F[n // 2] / 255.0
    rgb = np.stack([base * 0.5 + frac * 4, base * 0.5, base * 0.5 + frac * 4], -1)
    tiles.append(np.clip(rgb, 0, 1))
    print(v, "闪烁像素（>5%）", int((frac > 0.05).sum()), "均值", float(frac.mean()))
im = np.concatenate([np.pad(t, ((0, 0), (0, 4), (0, 0)), constant_values=1) for t in tiles], 1)
Image.fromarray((im * 255).astype(np.uint8)).resize((im.shape[1] * 2, im.shape[0] * 2), Image.NEAREST).save(out)
