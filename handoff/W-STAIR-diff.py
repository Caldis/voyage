"""W-STAIR：同页 A/B 截图的差异定位。
用法：python W-STAIR-diff.py <job 目录> <a> <b> <输出.png> [放大区 x,y,w,h ...]
打印 |a−b| 的像素数 / 最大 / 前 10 个差异块（32×32）的位置；输出 a | b | |a−b|×8 的拼图（给了放大区就裁剪放大 4 倍，否则整图缩小一半）。
"""
import sys

import numpy as np
from PIL import Image

sys.stdout.reconfigure(encoding="utf-8")
d, a, b, out = sys.argv[1:5]
crops = sys.argv[5:]
A = np.asarray(Image.open(f"{d}/{a}/full.png").convert("RGB")).astype(np.float64)
B = np.asarray(Image.open(f"{d}/{b}/full.png").convert("RGB")).astype(np.float64)
D = np.abs(A - B).max(2)
print(f"差异像素 {int((D > 0).sum())}，>8 的 {int((D > 8).sum())}，最大 {D.max():.0f}，平均 {D.mean():.4f}")
H, W = D.shape
blocks = []
for y in range(0, H, 32):
    for x in range(0, W, 32):
        s = D[y:y + 32, x:x + 32]
        if s.max() > 0:
            blocks.append((s.sum(), x, y, s.max()))
blocks.sort(reverse=True)
for s, x, y, m in blocks[:10]:
    print(f"  块 ({x},{y}) 差和 {s:.0f} 最大 {m:.0f}")
rows = []
if crops:
    for c in crops:
        x, y, w, h = map(int, c.split(","))
        tiles = [A[y:y + h, x:x + w], B[y:y + h, x:x + w], np.clip(D[y:y + h, x:x + w, None].repeat(3, 2) * 8, 0, 255)]
        tiles = [np.asarray(Image.fromarray(t.astype(np.uint8)).resize((w * 4, h * 4), Image.NEAREST)) for t in tiles]
        rows.append(np.concatenate(tiles, 1))
    img = np.concatenate(rows, 0) if len({r.shape[1] for r in rows}) == 1 else rows[0]
else:
    tiles = [A, B, np.clip(D[..., None].repeat(3, 2) * 8, 0, 255)]
    img = np.concatenate([np.asarray(Image.fromarray(t.astype(np.uint8)).resize((W // 2, H // 2), Image.BILINEAR)) for t in tiles], 1)
Image.fromarray(img).save(out)
