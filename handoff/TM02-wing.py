# TM02：机翼区域相对参考变体的逐像素差（wave7 第 1 条「机翼迷彩斑」验收）
#   差 = (|ΔR| + |ΔG| + |ΔB|) / 3（compare.mjs --diff 同口径）；报均值、最大、> 1 / > 3 级的像素比例
# 用法：python TM02-wing.py <根目录> <场景> <参考> <变体,...> x,y,w,h
import sys, os
import numpy as np
from PIL import Image
sys.stdout.reconfigure(encoding="utf-8")
root, sc, ref, names, box = sys.argv[1], sys.argv[2], sys.argv[3], sys.argv[4].split(","), sys.argv[5]
x, y, w, h = (int(v) for v in box.split(","))
load = lambda n: np.asarray(Image.open(os.path.join(root, sc, n + ".png")).convert("RGB"), float)[y:y + h, x:x + w]
R = load(ref)
print(f"## {sc} 机翼区 {box}（参考 {ref}）")
print("| 变体 | 平均差 | 最大差 | > 1 级 | > 3 级 |")
print("| --- | ---: | ---: | ---: | ---: |")
for n in names:
    d = np.abs(load(n) - R).sum(axis=2) / 3
    print(f"| {n} | {d.mean():.3f} | {d.max():.1f} | {(d > 1).mean() * 100:.2f}% | {(d > 3).mean() * 100:.2f}% |")
