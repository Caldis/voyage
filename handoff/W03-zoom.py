# W03：把一组截图里奇观附近的一块裁出来放大拼在一起（目视比较用）。
# 用法：python apps/voyage/handoff/W03-zoom.py <目录> <场景1,场景2,...> [cx cy 半宽 半高 倍数] [输出名]
import sys
from PIL import Image

d = sys.argv[1]
names = sys.argv[2].split(",")
cx, cy, hw, hh, k = (int(x) for x in (sys.argv[3:8] if len(sys.argv) >= 8 else (880, 540, 130, 100, 3)))
out = sys.argv[8] if len(sys.argv) >= 9 else "zoom.png"
tiles = []
for n in names:
    im = Image.open(f"{d}/{n}.png").convert("RGB").crop((cx - hw, cy - hh, cx + hw, cy + hh))
    tiles.append(im.resize((2 * hw * k, 2 * hh * k), Image.LANCZOS))
W = sum(t.width for t in tiles)
m = Image.new("RGB", (W, tiles[0].height))
x = 0
for t in tiles:
    m.paste(t, (x, 0))
    x += t.width
m.save(f"{d}/{out}")
print(f"{d}/{out}", m.size)
