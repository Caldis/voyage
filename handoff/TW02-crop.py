"""TW02：截图裁剪放大（看远塔细节）。用法：python TW02-crop.py 输入.png 输出.png x y w h [倍数]"""
import sys
from PIL import Image

src, dst, x, y, w, h = sys.argv[1], sys.argv[2], *map(int, sys.argv[3:7])
k = int(sys.argv[7]) if len(sys.argv) > 7 else 3
im = Image.open(src).crop((x, y, x + w, y + h))
im.resize((w * k, h * k), Image.NEAREST).save(dst)
