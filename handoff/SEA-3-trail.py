"""SEA-3 尾迹验收：old / new 各自对「同代码关掉尾迹」的亮度差（尾迹像素 = 与对应无尾迹图差 > 2）
用法：python SEA-3-trail.py <accept-trail 输出目录>
"""
import sys
from pathlib import Path

import numpy as np
from PIL import Image

sys.stdout.reconfigure(encoding="utf-8")
W = np.array([0.2126, 0.7152, 0.0722])


def L(p):
    return np.asarray(Image.open(p).convert("RGB"), float) @ W


for d in sorted(p for p in Path(sys.argv[1]).iterdir() if p.is_dir()):
    o, n, bn, bo = (L(d / f"{k}.png") for k in ("old", "new", "noTraffic", "oldNoTraffic"))
    m = (np.abs(o - bo) > 2) | (np.abs(n - bn) > 2)
    rest = ~((np.abs(o - bo) > 0) | (np.abs(n - bn) > 0))
    print(f"{d.name}: 尾迹像素 {int(m.sum())}  old − 背景 {(o - bo)[m].mean():+.2f}  new − 背景 {(n - bn)[m].mean():+.2f}"
          f"  | 尾迹外 new 对无尾迹 new 的最大差 {np.abs(n - bn)[rest].max() if rest.any() else 0:.0f}")
