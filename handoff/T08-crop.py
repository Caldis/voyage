"""T08：截图局部放大对比（最近邻放大，看细线是否锯齿、是否糊）。
用法：python T08-crop.py 输出.png x0 y0 w h 放大倍数 图1.png [图2.png ...]
多张图横向拼在一起，方便前后对比。
"""
import sys
from PIL import Image

out, x0, y0, w, h, k = sys.argv[1], *map(int, sys.argv[2:7])
imgs = [Image.open(p).convert("RGB").crop((x0, y0, x0 + w, y0 + h)).resize((w * k, h * k), Image.NEAREST) for p in sys.argv[7:]]
canvas = Image.new("RGB", (sum(i.width for i in imgs) + 8 * (len(imgs) - 1), h * k), (255, 0, 255))
x = 0
for i in imgs:
    canvas.paste(i, (x, 0))
    x += i.width + 8
canvas.save(out)
