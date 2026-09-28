"""wedge3：live 录像某区域的闪烁热图（放大）+ 中间帧，变体并排。
python heatzoom.py <job 目录> <w> <h> <变体,...> <x,y,w,h> <倍数> <输出.png> [阈值]"""
import sys

import numpy as np
from PIL import Image

sys.stdout.reconfigure(encoding="utf-8")
jd, w, h, vs = sys.argv[1], int(sys.argv[2]), int(sys.argv[3]), sys.argv[4].split(",")
x, y, cw, ch = [int(v) for v in sys.argv[5].split(",")]
s = int(sys.argv[6])
out = sys.argv[7]
thr = float(sys.argv[8]) if len(sys.argv) > 8 else 8.0
rows = []
for v in vs:
    a = np.memmap(f"{jd}/live_{v}_{w}x{h}.u8", np.uint8, "r")
    n = a.size // (w * h * 4)
    A = a[: n * w * h * 4].reshape(n, h, w, 4)
    # 审查返工：这里不需要再翻转。ab-live.mjs 的 recordLive 存盘前已经把 GL 的下到上翻成了自上而下，
    # 这里再翻一次会把热图上下颠倒——旧版复现命令里的区域框错了（框到右上方小翼旁的云），就是这个坑（见 W-EDGE-review.md §1）
    F = A[:, y:y + ch, x:x + cw, :3].astype(np.float32) @ np.array([0.2126, 0.7152, 0.0722], np.float32)
    d2 = np.abs(F[1:-1] - 0.5 * (F[:-2] + F[2:]))
    import json as _j, os as _o
    fl = f"{jd}/live_{v}_flags.json"
    if _o.path.exists(fl) and "uStrobe" in _j.load(open(fl)):
        sb = np.array(_j.load(open(fl))["uStrobe"][:n]) >= 0.5
        ok = ~(sb[:-2] | sb[1:-1] | sb[2:])
        d2 = d2[ok]
    frac = (d2 > thr).mean(0)
    mid = A[n // 2, y:y + ch, x:x + cw, :3].astype(np.float32) / 255.0
    heat = np.stack([np.clip(frac * 5, 0, 1)] * 3, -1) * np.array([1.0, 0.2, 1.0])
    heat = np.clip(mid * 0.35 + heat, 0, 1)
    print(v, "闪烁像素（>5%）", int((frac > 0.05).sum()), "超阈值总和", float(frac.sum()))
    rows.append(np.concatenate([mid, np.ones((ch, 2, 3)), heat], 1))
im = np.concatenate([np.pad(r, ((0, 2), (0, 0), (0, 0)), constant_values=1) for r in rows], 0)
Image.fromarray((im * 255).astype(np.uint8)).resize((im.shape[1] * s, im.shape[0] * s), Image.NEAREST).save(out)
