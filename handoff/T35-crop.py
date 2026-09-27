"""T35：截图局部放大 / 并排对照。
用法：python handoff/T35-crop.py <输出.png> <x> <y> <w> <h> <缩放> <图1> [<图2> ...]
每张图裁同一个区域、按最近邻放大，横向拼在一起（上方标文件名）。
"""
import sys
from PIL import Image, ImageDraw

out, x, y, w, h, s = sys.argv[1], *map(int, sys.argv[2:6]), float(sys.argv[6])
imgs = sys.argv[7:]
tiles = []
for p in imgs:
    im = Image.open(p).convert("RGB").crop((x, y, x + w, y + h))
    im = im.resize((int(w * s), int(h * s)), Image.NEAREST)
    d = ImageDraw.Draw(im)
    d.rectangle((0, 0, 8 * len(p.split("/")[-2] + p.split("/")[-1]) + 6, 14), fill=(0, 0, 0))
    d.text((3, 1), p.split("/")[-2] + "/" + p.split("/")[-1], fill=(255, 255, 0))
    tiles.append(im)
W = sum(t.width for t in tiles) + 4 * (len(tiles) - 1)
H = max(t.height for t in tiles)
canvas = Image.new("RGB", (W, H), (0, 0, 0))
cx = 0
for t in tiles:
    canvas.paste(t, (cx, 0))
    cx += t.width + 4
canvas.save(out)
print(out, canvas.size)
