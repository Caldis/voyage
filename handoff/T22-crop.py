"""T22：把几组截图里的同一块区域裁出来横向拼接（放大用最近邻），另存一张拉伸对比度（5–95 百分位）的 -x 版本。
用法：python T22-crop.py 输出.png x0 y0 x1 y1 放大倍数 图1 图2 ...
"""
import sys
import numpy as np
from PIL import Image

out, x0, y0, x1, y1, k = sys.argv[1], *map(int, sys.argv[2:6]), float(sys.argv[6])
ims = [Image.open(p).convert("RGB").crop((x0, y0, x1, y1)) for p in sys.argv[7:]]
w, h = int((x1 - x0) * k), int((y1 - y0) * k)
canvas = Image.new("RGB", (w * len(ims) + 8 * (len(ims) - 1), h), (255, 0, 255))
for i, im in enumerate(ims):
    canvas.paste(im.resize((w, h), Image.NEAREST), (i * (w + 8), 0))
canvas.save(out)
a = np.asarray(canvas).astype(float)
lo, hi = np.percentile(a, 5), np.percentile(a, 95)
Image.fromarray(np.clip((a - lo) / max(hi - lo, 1) * 255, 0, 255).astype("uint8")).save(out.replace(".png", "-x.png"))
