"""T48：量截图区域的平均颜色、luma、HSV 饱和度、R/B 比，以及「橙 / 白」像素占比。
用法：python handoff/T48-chroma.py x,y,w,h 图1.png [图2.png ...]
只统计 luma > 40 的像素（灯 / 雾本身，不含黑底）。
"""
import sys
from PIL import Image


def stats(path, box):
    x, y, w, h = box
    im = Image.open(path).convert("RGB").crop((x, y, x + w, y + h))
    n = 0
    sr = sg = sb = ss = 0.0
    orange = white = 0
    for r, g, b in im.getdata():
        luma = 0.2126 * r + 0.7152 * g + 0.0722 * b
        if luma <= 40:
            continue
        n += 1
        sr += r
        sg += g
        sb += b
        mx, mn = max(r, g, b), min(r, g, b)
        sat = (mx - mn) / mx if mx else 0.0
        ss += sat
        if sat > 0.35 and r >= g >= b:
            orange += 1
        elif sat < 0.15:
            white += 1
    if n == 0:
        return f"{path}: 没有 luma > 40 的像素"
    mr, mg, mb = sr / n, sg / n, sb / n
    return (f"{path}: n={n} 平均 RGB=({mr:.0f},{mg:.0f},{mb:.0f}) luma={0.2126*mr+0.7152*mg+0.0722*mb:.1f} "
            f"平均饱和度={ss/n:.3f} R/B={mr/max(mb,1):.2f} 橙(sat>0.35)={orange/n:.1%} 白(sat<0.15)={white/n:.1%}")


box = tuple(int(v) for v in sys.argv[1].split(","))
for p in sys.argv[2:]:
    print(stats(p, box))
