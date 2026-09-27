"""T36：回归场景改前（?lut16）/ 改后逐像素差异。用法：python handoff/T36-diff.py <目录> 场景1 [场景2 ...]
输出平均差（/255）、差 > 8 的像素占比，并拼一张「改前 | 改后 | 差 ×8」的对照图。"""
import sys
from pathlib import Path

import numpy as np
from PIL import Image

d = Path(sys.argv[1])
rows = []
for name in sys.argv[2:]:
    a = np.asarray(Image.open(d / f"reg16-{name}.png").convert("RGB")).astype(np.int16)
    b = np.asarray(Image.open(d / f"reg32-{name}.png").convert("RGB")).astype(np.int16)
    diff = np.abs(a - b)
    print(f"{name}: 平均差 {diff.mean():.2f}/255，差 > 8 的像素 {(diff.max(axis=2) > 8).mean() * 100:.2f}%")
    small = lambda x: np.asarray(Image.fromarray(np.clip(x, 0, 255).astype(np.uint8)).resize((533, 400)))
    rows.append(np.concatenate([small(a), small(b), small(diff * 8)], axis=1))
Image.fromarray(np.concatenate(rows, axis=0)).save(d / "reg-diff.png")
print(d / "reg-diff.png")
