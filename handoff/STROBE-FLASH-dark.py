# 冻结截图：频闪钉亮 − 钉灭，找「闪的时候反而变暗」的像素（T48c P2-1 口径 ≤ −4 级），打印数量、位置分布，存一张标注图
# 用法：python handoff/STROBE-FLASH-dark.py <off.png> <on.png> <标注输出.png>
import sys
import numpy as np
from PIL import Image

sys.stdout.reconfigure(encoding="utf-8")
off = np.asarray(Image.open(sys.argv[1]).convert("RGB")).astype(np.float32)
on = np.asarray(Image.open(sys.argv[2]).convert("RGB")).astype(np.float32)
Y = lambda a: a @ np.array([0.2126, 0.7152, 0.0722], np.float32)
d = Y(on) - Y(off)
m = d <= -4
ys, xs = np.nonzero(m)
print(f"变暗 ≤ −4 级像素 {m.sum()}，最暗 {d.min():.1f}；变亮 ≥ 8 级 {(d >= 8).sum()}")
if len(xs):
    print(f"  范围 x {xs.min()}–{xs.max()}，y {ys.min()}–{ys.max()}，重心 ({xs.mean():.0f}, {ys.mean():.0f})")
vis = on.copy()
vis[m] = [255, 0, 255]
Image.fromarray(vis.astype(np.uint8)).save(sys.argv[3])
