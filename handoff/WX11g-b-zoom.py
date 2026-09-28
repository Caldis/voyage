# WX11g-b：把若干变体的同一裁剪区放大拼在一起看（最近邻放大，不插值）。
# 用法：python apps/voyage/handoff/WX11g-b-zoom.py <job 目录> x,y,w,h 倍数 输出.png 变体1 变体2 ...
import os
import sys

from PIL import Image, ImageDraw

d, box, k, out = sys.argv[1], [int(v) for v in sys.argv[2].split(",")], int(sys.argv[3]), sys.argv[4]
names = sys.argv[5:]
x, y, w, h = box
tiles = []
for n in names:
    im = Image.open(os.path.join(d, n + ".png")).convert("RGB").crop((x, y, x + w, y + h)).resize((w * k, h * k), Image.NEAREST)
    ImageDraw.Draw(im).text((4, 4), n, fill=(255, 255, 0))
    tiles.append(im)
W = sum(t.width for t in tiles) + 4 * (len(tiles) - 1)
canvas = Image.new("RGB", (W, h * k), (0, 0, 0))
cx = 0
for t in tiles:
    canvas.paste(t, (cx, 0))
    cx += t.width + 4
canvas.save(out)
print(out)
