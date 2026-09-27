# python t48c_motion.py <目录>/<场景>
#  交替块：各模式裁剪均值（跨轮平均）、tau − inst 的逐轮差；连续段：均值的帧间相对抖动 std、逐帧差分 |Δmean| 的均值、分块 p95
import sys, os, glob
import numpy as np
from PIL import Image
sys.stdout.reconfigure(encoding="utf-8")
W = np.array([0.2126, 0.7152, 0.0722])
d = sys.argv[1]
L = lambda p: np.asarray(Image.open(p).convert("RGB"), float) @ W
modes = sys.argv[2].split(",") if len(sys.argv) > 2 else ["tau", "inst", "noLocal"]
blk = {m: [L(p) for p in sorted(glob.glob(os.path.join(d, f"blk-{m}-*.png")))] for m in modes}
means = {m: np.array([x.mean() for x in blk[m]]) for m in modes}
for m in modes:
    b250 = np.mean([(x >= 250).mean() for x in blk[m]]) * 100
    print(f"块 {m:8s} 均值 {means[m].mean():6.2f}（{len(blk[m])} 轮）≥250(亮度) {b250:.2f}%")
print(f"tau − inst 逐轮：均值 {np.mean(means['tau'] - means['inst']):+.2f}，范围 {np.min(means['tau'] - means['inst']):+.2f} … {np.max(means['tau'] - means['inst']):+.2f}")
def tiles(x):
    h, w = x.shape; return x[: h // 16 * 16, : w // 16 * 16].reshape(h // 16, 16, w // 16, 16).mean((1, 3))
for m in modes:
    files = sorted(glob.glob(os.path.join(d, f"seq-{m}-*.png")))
    segs = sorted({os.path.basename(p).split("-")[2] for p in files})
    dms, rels, rstd, mus = [], [], [], []
    for sg in segs:
        seq = [L(p) for p in files if os.path.basename(p).split("-")[2] == sg]
        mu = np.array([x.mean() for x in seq]); mus.append(mu.mean())
        dms += list(np.abs(np.diff(mu)) / mu.mean())
        rstd.append(mu.std() / mu.mean())
        T = np.array([tiles(x) for x in seq])
        rels.append((np.abs(np.diff(T, axis=0)) / np.maximum(T[:-1], 1)).ravel())
    rel = np.concatenate(rels)
    print(f"连续 {m:8s} {len(segs)} 段 均值 {np.mean(mus):6.2f} 段内相对 std {np.mean(rstd) * 100:.2f}% 帧间 |Δ均值|/均值 {np.mean(dms) * 100:.3f}%（最大 {np.max(dms) * 100:.3f}%） 分块相对变化 p95 {np.percentile(rel, 95) * 100:.2f}%")
