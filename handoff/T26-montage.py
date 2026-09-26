# T26：把若干截图裁出窗口区域、缩小后拼成一张（带文件名标签），便于并排比较。
# 用法：python handoff/T26-montage.py 输出.png 列数 图1 图2 ...
import sys
from PIL import Image, ImageDraw

out, cols, files = sys.argv[1], int(sys.argv[2]), sys.argv[3:]
CROP = (380, 0, 1225, 1150)  # 1600×1200 截图里舷窗的大致范围
S = 0.5
tiles = []
for f in files:
    im = Image.open(f).convert("RGB").crop(CROP)
    im = im.resize((int(im.width * S), int(im.height * S)))
    ImageDraw.Draw(im).text((8, 8), f.replace("\\", "/").split("/")[-1], fill=(255, 40, 40))
    tiles.append(im)
w, h = tiles[0].size
rows = (len(tiles) + cols - 1) // cols
canvas = Image.new("RGB", (w * cols, h * rows), (0, 0, 0))
for i, t in enumerate(tiles):
    canvas.paste(t, ((i % cols) * w, (i // cols) * h))
canvas.save(out)
