"""C12b：静止显示截图的放大并排（同一帧号），看颗粒 / 斜纹。
用法：python C12b-zoom.py <目录> <场景> <输出.png> <变体,变体,...> [帧=f00] [放大=3] [裁剪 x,y,w,h（截图内坐标）]
"""
import os, sys
from PIL import Image, ImageDraw
root, job, outp, vns = sys.argv[1:5]
fr = sys.argv[5] if len(sys.argv) > 5 else "f00"
z = int(sys.argv[6]) if len(sys.argv) > 6 else 3
box = tuple(int(x) for x in sys.argv[7].split(",")) if len(sys.argv) > 7 else None
ims = []
for vn in vns.split(","):
    im = Image.open(os.path.join(root, job, "static", vn, fr + ".png")).convert("RGB")
    if box:
        im = im.crop((box[0], box[1], box[0] + box[2], box[1] + box[3]))
    ims.append((vn, im.resize((im.width * z, im.height * z), Image.NEAREST)))
W = sum(i.width for _, i in ims) + 4 * (len(ims) - 1)
out = Image.new("RGB", (W, ims[0][1].height + 16), (0, 0, 0))
d = ImageDraw.Draw(out)
x = 0
for n, im in ims:
    out.paste(im, (x, 16))
    d.text((x + 4, 2), n, fill=(255, 255, 0))
    x += im.width + 4
out.save(outp)
print(outp)
