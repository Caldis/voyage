"""WS02 尺度指标（research/WONDER_SCALE.md §1.1 的 M1 / M2）：用「开 / 关表面」同机位两张图（tmp/ws02-mask.sh 或
shots --pair 拍的 <场景>.a.png / .b.png）相减得塔的掩码。
  M1 = 掩码最高点在地平线上方多少度（默认视场 1600×1200 下 22.5 px/°）；
  M2 = 掩码面积 ÷ 舷窗面积（约 97 万像素）；另报最高结构的像素高度占窗高（约 1150 px）的比例（WS02 验收：尖塔高 ≥ 窗高 15%）。
用法：python handoff/WS02-metrics.py <a.png> <b.png> <地平线行号> [阈值=6]
地平线行号：同一头位下的黄昏截图里地平线那一道亮线的行（冷启动默认头位约 587，见 handoff/WS02.md）。
"""
import sys
from PIL import Image
sys.stdout.reconfigure(encoding="utf-8")

a = Image.open(sys.argv[1]).convert("RGB")
b = Image.open(sys.argv[2]).convert("RGB")
hz = float(sys.argv[3])
thr = float(sys.argv[4]) if len(sys.argv) > 4 else 6.0
W, H = a.size
pa, pb = a.load(), b.load()
def lum(p):
    return 0.2126 * p[0] + 0.7152 * p[1] + 0.0722 * p[2]
rows = {}
area = 0
# 只看舷窗内的大致范围（1600×1200 默认头位：x 390–1210，y 20–1140）
for y in range(20, 1140):
    n = 0
    for x in range(390, 1210):
        if abs(lum(pa[x, y]) - lum(pb[x, y])) > thr:
            n += 1
    if n:
        rows[y] = n
        area += n
top = min((y for y, n in rows.items() if n >= 3), default=None)
bottom = max((y for y, n in rows.items() if n >= 3), default=None)
print("掩码像素 %d（%.2f%% 窗面积 97 万）" % (area, 100.0 * area / 970000))
if top is not None:
    print("最高点行 %d → 地平线上方 %.2f°（%.0f px）；掩码竖向跨度 %d px = 窗高 %.0f%%" % (top, (hz - top) / 22.5, hz - top, bottom - top, 100.0 * (bottom - top) / 1150))
