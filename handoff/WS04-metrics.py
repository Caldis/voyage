"""WS04 尺度指标（research/WONDER_SCALE.md §1.1）：同机位「开 / 关奇观表面」两张图（shots --pair 拍的 <场景>.a.png / .b.png）
相减得城的掩码（只算表面：岩座、台地、树冠、粗根；瀑布 / 云涡是介质，不算）。
  M1 = 掩码最高点在地平线上方多少度（1600×1200 默认视场 22.5 px/°）；
  M2 = 掩码面积 ÷ 舷窗面积（约 97 万像素）；另报掩码的宽、高（像素）；
  M6 = 大气分层：掩码最上面 20% 行（冠顶）与最下面 20% 行（岩座 / 根）各自和背后天空（b 图同一像素）的对比度
       |L − L_bg| / L_bg 的中位数之比（上段 ÷ 下段，≥ 2 为达标）。
用法：python apps/voyage/handoff/WS04-metrics.py <a.png> <b.png> <地平线行号> [阈值=6]
"""
import sys
from PIL import Image

sys.stdout.reconfigure(encoding="utf-8")
a = Image.open(sys.argv[1]).convert("RGB")
b = Image.open(sys.argv[2]).convert("RGB")
hz = float(sys.argv[3])
thr = float(sys.argv[4]) if len(sys.argv) > 4 else 6.0
pa, pb = a.load(), b.load()


def lum(p):
    return 0.2126 * p[0] + 0.7152 * p[1] + 0.0722 * p[2]


rows = {}
cols = set()
pix = []
for y in range(20, 1140):
    n = 0
    for x in range(390, 1210):
        la, lb = lum(pa[x, y]), lum(pb[x, y])
        if abs(la - lb) > thr:
            n += 1
            cols.add(x)
            pix.append((y, la, lb))
    if n:
        rows[y] = n
area = sum(rows.values())
ys = [y for y, n in rows.items() if n >= 3]
print("掩码像素 %d（%.2f%% 窗面积 97 万）" % (area, 100.0 * area / 970000))
if ys:
    top, bottom = min(ys), max(ys)
    print("最高点行 %d → 地平线上方 %.2f°（%.0f px）；竖向跨度 %d px = 窗高 %.0f%%；宽 %d px" % (
        top, (hz - top) / 22.5, hz - top, bottom - top, 100.0 * (bottom - top) / 1150, max(cols) - min(cols)))
    span = bottom - top
    def contrast(lo, hi):
        v = sorted(abs(la - lb) / max(lb, 1.0) for (y, la, lb) in pix if lo <= y <= hi)
        return v[len(v) // 2] if v else float("nan")
    cu = contrast(top, top + 0.2 * span)
    cl = contrast(bottom - 0.2 * span, bottom)
    print("M6 对比度：上段 %.3f，下段 %.3f，上 ÷ 下 = %.2f" % (cu, cl, cu / max(cl, 1e-6)))
