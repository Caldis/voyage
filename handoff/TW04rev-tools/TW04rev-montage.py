"""把若干张图横排拼接：python TW04rev-montage.py <输出> <缩放> <图1> <图2> ..."""
import sys
from PIL import Image

out, k = sys.argv[1], float(sys.argv[2])
ims = [Image.open(p).convert("RGB") for p in sys.argv[3:]]
ims = [im.resize((int(im.width * k), int(im.height * k)), Image.LANCZOS) for im in ims]
W = sum(im.width for im in ims) + 6 * (len(ims) - 1)
H = max(im.height for im in ims)
c = Image.new("RGB", (W, H), (255, 0, 0))
x = 0
for im in ims:
    c.paste(im, (x, 0))
    x += im.width + 6
c.save(out)
print(out)
