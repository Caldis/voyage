# 并排拼图：python C-FLAT-pair.py <输出.png> <x,y,w,h> <缩放> <图1> <图2> ...（每张图左上角标文件名）
import sys
from PIL import Image, ImageDraw

out, crop, scale = sys.argv[1], [int(v) for v in sys.argv[2].split(",")], float(sys.argv[3])
ims = []
for p in sys.argv[4:]:
    im = Image.open(p).convert("RGB").crop((crop[0], crop[1], crop[0] + crop[2], crop[1] + crop[3]))
    im = im.resize((int(crop[2] * scale), int(crop[3] * scale)), Image.NEAREST if scale >= 1 else Image.LANCZOS)
    d = ImageDraw.Draw(im)
    d.rectangle((0, 0, 260, 18), fill=(0, 0, 0))
    d.text((4, 3), p.replace("\\", "/").split("/")[-2] + "/" + p.replace("\\", "/").split("/")[-1], fill=(255, 255, 0))
    ims.append(im)
W = sum(i.width for i in ims) + 6 * (len(ims) - 1)
canvas = Image.new("RGB", (W, ims[0].height), (255, 0, 255))
x = 0
for i in ims:
    canvas.paste(i, (x, 0))
    x += i.width + 6
canvas.save(out)
