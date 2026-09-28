"""WS05 建木的尺度指标（research/WONDER_SCALE.md §1.1）：同机位「开 / 关奇观」两张图（shots --pair 拍的 <场景>.a.png / .b.png）相减得掩码。
  M1 = 掩码最高点在地平线上方多少度（22.5 px/°）；掩码碰到窗的上沿（y < 40）就报「出画」
  M2 = 掩码面积 ÷ 舷窗面积（约 97 万像素）
  M6 = 大气分层：上段（地平线上方 200–320 px，树干中上段 / 树冠下）与下段（地平线上方 10–60 px，树脚）各自
       「奇观与天空的平均亮度差 ÷ 天空亮度」的比值（上段 ÷ 下段）
  另报：各行掩码宽度的最大值（地平线附近 = 板根 + 脚的宽度）、树干在地平线上方 150 px 处的宽度
用法：python handoff/WS05-metrics.py <a.png> <b.png> <地平线行号> [阈值=4]
地平线行号：默认头位（head [0, 0.02, -0.3]）约 556；仰看头位（[0, −0.12, −0.3]）按截图另量。
"""
import sys
from PIL import Image
sys.stdout.reconfigure(encoding="utf-8")

a = Image.open(sys.argv[1]).convert("RGB")
b = Image.open(sys.argv[2]).convert("RGB")
hz = int(sys.argv[3])
thr = float(sys.argv[4]) if len(sys.argv) > 4 else 4.0
pa, pb = a.load(), b.load()


def lum(p):
    return 0.2126 * p[0] + 0.7152 * p[1] + 0.0722 * p[2]


X0, X1 = 390, 1210
rows = {}
area = 0
for y in range(0, 1140):
    xs = [x for x in range(X0, X1) if abs(lum(pa[x, y]) - lum(pb[x, y])) > thr]
    if xs:
        rows[y] = xs
        area += len(xs)
top = min((y for y, xs in rows.items() if len(xs) >= 3), default=None)
print("掩码 %d 像素（%.2f%% 窗面积 97 万）" % (area, 100.0 * area / 970000))
if top is not None:
    out = "，碰到窗上沿 → 出画" if top < 40 else ""
    print("M1 最高点行 %d → 地平线上方 %.1f°（%d px）%s" % (top, (hz - top) / 22.5, hz - top, out))


def band_contrast(y0, y1):
    num = 0.0
    n = 0
    for y in range(y0, y1):
        for x in rows.get(y, []):
            la, lb = lum(pa[x, y]), lum(pb[x, y])
            num += abs(la - lb) / max(lb, 1.0)
            n += 1
    return (num / n if n else 0.0), n


cu, nu = band_contrast(hz - 320, hz - 200)
cl, nl = band_contrast(hz - 60, hz - 10)
if nu and nl:
    print("M6 上段对比 %.3f（%d px）÷ 下段对比 %.3f（%d px）= %.2f" % (cu, nu, cl, nl, cu / max(cl, 1e-6)))
wmax = max(((max(xs) - min(xs) + 1, y) for y, xs in rows.items() if hz - 80 < y < hz + 20), default=(0, 0))
print("地平线附近最宽的一行：%d px（行 %d）" % wmax)
yt = hz - 150
if yt in rows:
    xs = rows[yt]
    # 只算离中位数最近的连续一段（树干）
    xs.sort()
    mid = xs[len(xs) // 2]
    seg = [x for x in xs if abs(x - mid) < 60]
    print("地平线上方 150 px 处的掩码宽度：%d px" % (max(seg) - min(seg) + 1))
