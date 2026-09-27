"""W-STAIR：机翼 pass 的迭代计数（W-STAIR-jobs-iter.json 输出的 hdrWing：R = 这个像素 sdWing 调用次数，G = 着色次数）。
GPU 计时在多代理并行时噪声 ±10–30%，迭代数是确定的：总迭代（平均开销）、按 8×4 块取最大值再求和（近似 warp 的耗时，
一个 warp 要等最慢的像素）、着色次数。用法：python W-STAIR-iter.py <job 目录> <变体 ...>
"""
import sys

import numpy as np

sys.stdout.reconfigure(encoding="utf-8")
root = sys.argv[1]
base = None
for v in sys.argv[2:]:
    a = np.fromfile(f"{root}/{v}/hdrWing_1600x1200.f32", dtype=np.float32).reshape(1200, 1600, 4)
    it = np.round(a[..., 0] / 0.85)   # 机翼 pass 里乘了窗板透射率
    sh = np.round(a[..., 1] / 0.85)
    H, W = it.shape
    warp = it[: H // 4 * 4, : W // 8 * 8].reshape(H // 4, 4, W // 8, 8).max(axis=(1, 3))
    r = dict(total=float(it.sum()), warpMax=float(warp.sum()) * 32, shade=float(sh.sum()), maxPx=float(it.max()))
    if base is None:
        base = r
    print(v, "  ".join(f"{k} {r[k]:.4g} ({r[k] / base[k] - 1:+.2%})" if base[k] else f"{k} {r[k]:.4g}" for k in r))
