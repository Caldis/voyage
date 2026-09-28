# T48c-live.mjs 的分析（口径同审查 t48crev-livean.py）：python t48c_livean.py <目录>
import sys, os, glob
import numpy as np
from PIL import Image
sys.stdout.reconfigure(encoding="utf-8")
D = sys.argv[1]
W = np.array([0.2126, 0.7152, 0.0722])
for p in sorted(glob.glob(os.path.join(D, "*.hold.png"))):
    b = p[: -len(".hold.png")]
    A = np.asarray(Image.open(p).convert("RGB"), float)
    B = np.asarray(Image.open(b + ".conv.png").convert("RGB"), float)
    d = (A - B) @ W
    c = d[900:1100, 450:950]
    print(f"{os.path.basename(b)}: 整窗 A−B 最大 {d.max():.1f} 最小 {d.min():.1f} >2 {int((d > 2).sum())} >8 {int((d > 8).sum())} >16 {int((d > 16).sum())}；城区裁剪 均值 {c.mean():.2f} p99 {np.percentile(c, 99):.1f} 最大 {c.max():.1f}")
    if os.path.exists(b + ".conv2.png"):
        C = np.asarray(Image.open(b + ".conv2.png").convert("RGB"), float)
        n = (C - B) @ W
        print(f"    噪声底 conv2 − conv：最大 |差| {np.abs(n).max():.1f} >8 {int((np.abs(n) > 8).sum())}")
    Image.fromarray((128 + d * 8).clip(0, 255).astype(np.uint8)).save(b + ".diff-x8.png")
