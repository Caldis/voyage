# PUB-5：几张同尺寸截图的同一区域放大（最近邻），上下排列，左侧不加标签（顺序按参数）。
# 用法：python PUB-5-zoom.py 输出.png x,y,w,h 倍数 图1.png 图2.png ...
import sys
from PIL import Image

out, box, k = sys.argv[1], sys.argv[2], int(sys.argv[3])
x, y, w, h = map(int, box.split(","))
tiles = [Image.open(p).convert("RGB").crop((x, y, x + w, y + h)).resize((w * k, h * k), Image.NEAREST) for p in sys.argv[4:]]
canvas = Image.new("RGB", (w * k, sum(t.height for t in tiles) + 6 * (len(tiles) - 1)), (255, 0, 255))
yy = 0
for t in tiles:
    canvas.paste(t, (0, yy))
    yy += t.height + 6
canvas.save(out)
