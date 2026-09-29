"""两张图的差：python TW04rev-diff.py a.png b.png [x y w h] [热图输出]。打印 mean / max / >8 像素数，按行带（每 100 像素）列 mean。"""
import sys
from PIL import Image, ImageChops, ImageStat

sys.stdout.reconfigure(encoding="utf-8")
a = Image.open(sys.argv[1]).convert("RGB")
b = Image.open(sys.argv[2]).convert("RGB")
if len(sys.argv) >= 7:
    x, y, w, h = map(int, sys.argv[3:7])
    a = a.crop((x, y, x + w, y + h))
    b = b.crop((x, y, x + w, y + h))
d = ImageChops.difference(a, b).convert("L")
px = list(d.getdata())
print(f"mean {sum(px) / len(px):.3f} max {max(px)} >8 {sum(1 for v in px if v > 8)} / {len(px)}")
W, H = d.size
rows = []
for y0 in range(0, H, 100):
    band = d.crop((0, y0, W, min(H, y0 + 100)))
    rows.append(f"{y0}:{ImageStat.Stat(band).mean[0]:.2f}")
print(" ".join(rows))
if len(sys.argv) >= 8:
    d.point(lambda v: min(255, v * 8)).save(sys.argv[7])
