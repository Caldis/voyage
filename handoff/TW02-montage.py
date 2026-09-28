"""TW02：把一个目录里几张截图的同一裁剪区竖排拼起来（放大 k 倍），看远塔细节。
用法：python TW02-montage.py 目录 输出.png x y w h k 名字1 名字2 …（名字不带 .png）"""
import sys
from pathlib import Path
from PIL import Image

d, dst, x, y, w, h, k = sys.argv[1], sys.argv[2], *map(int, sys.argv[3:8])
names = sys.argv[8:]
tiles = [Image.open(Path(d) / f"{n}.png").convert("RGB").crop((x, y, x + w, y + h)).resize((w * k, h * k), Image.LANCZOS) for n in names]
out = Image.new("RGB", (w * k, h * k * len(tiles)))
for i, t in enumerate(tiles):
    out.paste(t, (0, i * h * k))
out.save(dst)
