# TM02：一个区域的显示 luma 均值 / p50 / p99 / ≥235 比例 / 相邻像素差（wave7 第 5 条台风卷云盖的口径：区域 420,200,760,250）
# 用法：python TM02-region.py <根目录> <场景> <变体,...> x,y,w,h
import sys, os
import numpy as np
from PIL import Image
sys.stdout.reconfigure(encoding="utf-8")
root, sc, names, box = sys.argv[1], sys.argv[2], sys.argv[3].split(","), sys.argv[4]
x, y, w, h = (int(v) for v in box.split(","))
print(f"## {sc} 区域 {box}")
print("| 变体 | 均值 | p50 | p99 | ≥235 | adj |")
print("| --- | ---: | ---: | ---: | ---: | ---: |")
for n in names:
    L = (np.asarray(Image.open(os.path.join(root, sc, n + ".png")).convert("RGB"), float) @ np.array([0.2126, 0.7152, 0.0722]))[y:y + h, x:x + w]
    adj = 0.5 * (np.abs(np.diff(L, axis=1)).mean() + np.abs(np.diff(L, axis=0)).mean())
    print(f"| {n} | {L.mean():.1f} | {np.percentile(L, 50):.1f} | {np.percentile(L, 99):.1f} | {(L >= 235).mean() * 100:.1f}% | {adj:.2f} |")
