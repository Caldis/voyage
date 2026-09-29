"""把各变体的地平线附近裁剪放大拼成一张对照图（带网格坐标，方便挑 ROI）。
用法：python crop.py <场景目录> x0 y0 x1 y1 scale 变体1 变体2 ..."""
import sys
from PIL import Image, ImageDraw

d = sys.argv[1]
x0, y0, x1, y1, s = map(int, sys.argv[2:7])
names = sys.argv[7:]
tiles = []
for n in names:
    im = Image.open(f"{d}/{n}.png").convert("RGB").crop((x0, y0, x1, y1))
    im = im.resize(((x1 - x0) * s, (y1 - y0) * s), Image.NEAREST)
    dr = ImageDraw.Draw(im)
    dr.text((6, 4), n, fill=(255, 255, 0))
    tiles.append(im)
W = tiles[0].width
H = sum(t.height for t in tiles)
out = Image.new("RGB", (W, H))
y = 0
for t in tiles:
    out.paste(t, (0, y))
    y += t.height
out.save(f"{d}/zoom_{'_'.join(names)}.png")
print(f"{d}/zoom_{'_'.join(names)}.png")
