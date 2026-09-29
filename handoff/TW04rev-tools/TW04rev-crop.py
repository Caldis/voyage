"""裁剪对照：python TW04rev-crop.py <根目录> <场景> x y w h [倍数]，左 master 右合并，输出到 <根>/crop/<场景>-x-y.png"""
import os
import sys
from PIL import Image

root, scene = sys.argv[1], sys.argv[2]
x, y, w, h = map(int, sys.argv[3:7])
k = float(sys.argv[7]) if len(sys.argv) > 7 else 2.0
out = os.path.join(root, "crop")
os.makedirs(out, exist_ok=True)
imgs = []
for p in ("p5365", "p5364"):
    fp = os.path.join(root, p, scene + ".png")
    if not os.path.exists(fp):
        fp = os.path.join(root, p, scene)
    im = Image.open(fp).convert("RGB").crop((x, y, x + w, y + h))
    imgs.append(im.resize((int(w * k), int(h * k)), Image.LANCZOS))
c = Image.new("RGB", (imgs[0].width * 2 + 6, imgs[0].height), (255, 0, 0))
c.paste(imgs[0], (0, 0))
c.paste(imgs[1], (imgs[0].width + 6, 0))
name = os.path.join(out, f"{os.path.basename(scene)}-{x}-{y}.png")
c.save(name)
print(name)
