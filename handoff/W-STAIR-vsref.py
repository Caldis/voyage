"""W-STAIR：各变体与参考（给足步数的 full-nostarve）逐像素比，参考图当「真值」。
只看机翼附近：参考与 old 不同、或任一变体与参考不同的像素，按显示值（0–255）统计平均绝对差 / >8 的像素数。
用法：python W-STAIR-vsref.py <A/B 输出目录> <参考变体> <job1,job2,...> <变体1,变体2,...>
"""
import sys

import numpy as np
from PIL import Image

sys.stdout.reconfigure(encoding="utf-8")
root, ref, jobs, vs = sys.argv[1], sys.argv[2], sys.argv[3].split(","), sys.argv[4].split(",")
for j in jobs:
    R = np.asarray(Image.open(f"{root}/{j}/{ref}/full.png").convert("RGB")).astype(np.float64)
    ims = {v: np.asarray(Image.open(f"{root}/{j}/{v}/full.png").convert("RGB")).astype(np.float64) for v in vs}
    mask = np.zeros(R.shape[:2], bool)
    for a in ims.values():
        mask |= np.abs(a - R).max(2) > 0
    n = int(mask.sum())
    out = []
    for v, a in ims.items():
        d = np.abs(a - R).max(2)[mask]
        out.append(f"{v}: 差和 {d.sum():.0f}, >8 {int((d > 8).sum())}")
    print(f"{j}（{n} 像素有差）  " + " | ".join(out))
