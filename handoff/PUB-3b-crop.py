# PUB-3b：截图局部放大（最近邻），用法：python PUB-3b-crop.py 输入.png x y w h 倍数 输出.png
import sys
from PIL import Image

src, x, y, w, h, k, dst = sys.argv[1], *map(int, sys.argv[2:7]), sys.argv[7]
im = Image.open(src).crop((x, y, x + w, y + h))
im.resize((w * k, h * k), Image.NEAREST).save(dst)
