"""WS07 巨柱群「一排柱的大气透视逐根变蓝」（research/WONDER_SCALE.md §4 WS07 验收：最远 / 最近对比度比 ≤ 0.5）。
同机位「开 / 关奇观」两张图（shots --pair 的 <场景>.a.png / .b.png）：在地平线上方若干行上找出每一根柱的横向片段，
每段算「柱与天空的平均亮度差 ÷ 天空亮度」（对比度）和平均蓝色占比；按片段宽度排（越宽越近），报最宽 / 最窄的对比度之比。
用法：python handoff/WS07-depth.py <a.png> <b.png> <地平线行号> [行偏移=60,120] [阈值=4]
"""
import sys
from PIL import Image

sys.stdout.reconfigure(encoding="utf-8")
a = Image.open(sys.argv[1]).convert("RGB")
b = Image.open(sys.argv[2]).convert("RGB")
hz = int(sys.argv[3])
offs = [int(x) for x in (sys.argv[4] if len(sys.argv) > 4 else "60,120").split(",")]
thr = float(sys.argv[5]) if len(sys.argv) > 5 else 4.0
pa, pb = a.load(), b.load()


def lum(p):
    return 0.2126 * p[0] + 0.7152 * p[1] + 0.0722 * p[2]


for off in offs:
    y = hz - off
    segs, cur = [], None
    for x in range(390, 1211):
        on = abs(lum(pa[x, y]) - lum(pb[x, y])) > thr
        if on and cur is None:
            cur = [x, x]
        elif on:
            cur[1] = x
        elif cur is not None:
            segs.append(cur)
            cur = None
    if cur:
        segs.append(cur)
    rows = []
    for x0, x1 in segs:
        w = x1 - x0 + 1
        if w < 4:
            continue
        # 片段内部（去掉两端各 1 像素的抗锯齿边）
        xs = range(x0 + 1, x1) if w > 3 else range(x0, x1 + 1)
        c = sum(abs(lum(pa[x, y]) - lum(pb[x, y])) / max(lum(pb[x, y]), 1) for x in xs) / len(xs)
        blue = sum(pa[x, y][2] / max(sum(pa[x, y]), 1) for x in xs) / len(xs)
        rows.append((w, x0, c, blue))
    rows.sort(reverse=True)
    print(f"地平线上方 {off} px（行 {y}）：{len(rows)} 段")
    for w, x0, c, blue in rows:
        print(f"  宽 {w:4d} px  x={x0:4d}  对比 {c:.3f}  蓝占比 {blue:.3f}")
    if len(rows) >= 2:
        print(f"  最窄（最远）÷ 最宽（最近）对比度 = {rows[-1][2] / max(rows[0][2], 1e-6):.2f}")
