"""SEA-3 返工验收：地平线附近逐行亮度剖面。
对每个 job 目录里的各变体：在 x0 列（±3 列平均）找地平线（亮度逐行差最大的位置之一不可靠，改为给定 y 范围内），
报：y 范围内最大相邻行跳变、海面（地平线以下）纯黑像素数（RGB 全 ≤ 1）、地平线下 1 / 5 / 20 行的亮度。
用法：python SEA-3-horizon.py <rework 目录> [x0]
"""
import sys
from pathlib import Path

import numpy as np
from PIL import Image

sys.stdout.reconfigure(encoding="utf-8")
W = np.array([0.2126, 0.7152, 0.0722])
root = Path(sys.argv[1])
x0 = int(sys.argv[2]) if len(sys.argv) > 2 else 800
for d in sorted(p for p in root.iterdir() if p.is_dir()):
    print(f"== {d.name}")
    for name in ("master", "prev8cc", "new"):
        p = d / f"{name}.png"
        if not p.exists():
            continue
        a = np.asarray(Image.open(p).convert("RGB"), dtype=np.float64)
        col = (a[:, x0 - 3 : x0 + 4] @ W).mean(axis=1)
        # 窗内：只看 y 200–1000
        seg = col[200:1000]
        j = np.abs(np.diff(seg))
        k = int(j.argmax())
        black = int(np.all(a[200:1000, 420:1180] <= 1, axis=2).sum())
        print(f"  {name:8s} 最大相邻行跳变 {j.max():5.1f}（y={200 + k}，{seg[k]:.1f}→{seg[k + 1]:.1f}）  纯黑像素 {black}"
              f"  剖面 y{200 + k - 4}..{200 + k + 20}: " + " ".join(f"{v:.0f}" for v in seg[max(k - 4, 0) : k + 21 : 3]))
