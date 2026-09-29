"""WS08-b：前后对照裁图（最近邻放大，看网格 / 硬线是否消失）。
用法：python WS08-b-crop.py 输出.png x,y,w,h 放大倍数 图1.png [图2.png ...]
多张图横向拼接，中间留 8 像素白缝。"""
import sys
from PIL import Image

sys.stdout.reconfigure(encoding="utf-8")
out = sys.argv[1]
x, y, w, h = (int(v) for v in sys.argv[2].split(","))
k = int(sys.argv[3])
ims = [Image.open(p).convert("RGB").crop((x, y, x + w, y + h)).resize((w * k, h * k), Image.NEAREST) for p in sys.argv[4:]]
gap = 8
W = sum(i.width for i in ims) + gap * (len(ims) - 1)
canvas = Image.new("RGB", (W, h * k), (255, 255, 255))
cx = 0
for i in ims:
    canvas.paste(i, (cx, 0))
    cx += i.width + gap
canvas.save(out)
print(out, canvas.size)
