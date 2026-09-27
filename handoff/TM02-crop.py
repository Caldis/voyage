# TM02：并排裁剪对照（原尺寸 × 放大倍数，最后一格 = 变体 − 参考的差 × 增益，灰 = 0）
# 用法：python TM02-crop.py <根目录> <场景> <参考> <变体,...> x,y,w,h [放大=2] [差增益=16] > 输出到 <根目录>/<场景>/crop-x_y.png
import sys, os
import numpy as np
from PIL import Image
root, sc, ref, names, box = sys.argv[1], sys.argv[2], sys.argv[3], sys.argv[4].split(","), sys.argv[5]
z = int(sys.argv[6]) if len(sys.argv) > 6 else 2
gain = float(sys.argv[7]) if len(sys.argv) > 7 else 16
x, y, w, h = (int(v) for v in box.split(","))
load = lambda n: np.asarray(Image.open(os.path.join(root, sc, n + ".png")).convert("RGB"), float)[y:y + h, x:x + w]
R = load(ref)
tiles = [R] + [load(n) for n in names]
W709 = np.array([0.2126, 0.7152, 0.0722])
for n in names:
    d = (load(n) - R) @ W709
    tiles.append(np.repeat(np.clip(128 + d * gain, 0, 255)[..., None], 3, axis=2))
img = np.concatenate([np.pad(t, ((0, 0), (0, 4), (0, 0)), constant_values=255) for t in tiles], axis=1).astype(np.uint8)
im = Image.fromarray(img).resize((img.shape[1] * z, img.shape[0] * z), Image.NEAREST)
out = os.path.join(root, sc, f"crop-{x}_{y}.png")
im.save(out)
print(out)
