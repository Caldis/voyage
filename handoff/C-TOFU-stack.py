# 竖排拼图：python ctofu_stack.py <job 目录> <变体,变体,...> x,y,w,h <放大倍数> <输出.png>
import sys
from PIL import Image, ImageDraw

d, names, crop, z, out = sys.argv[1], sys.argv[2].split(","), [int(v) for v in sys.argv[3].split(",")], float(sys.argv[4]), sys.argv[5]
x, y, w, h = crop
tiles = []
for n in names:
    im = Image.open(f"{d}/{n}.png").convert("RGB").crop((x, y, x + w, y + h))
    im = im.resize((int(w * z), int(h * z)), Image.LANCZOS if z < 1 else Image.NEAREST)
    ImageDraw.Draw(im).text((6, 4), n, fill=(255, 0, 0))
    tiles.append(im)
W = max(t.width for t in tiles)
H = sum(t.height for t in tiles) + 2 * (len(tiles) - 1)
o = Image.new("RGB", (W, H), (0, 0, 0))
yy = 0
for t in tiles:
    o.paste(t, (0, yy))
    yy += t.height + 2
o.save(out)
print(out, o.size)
