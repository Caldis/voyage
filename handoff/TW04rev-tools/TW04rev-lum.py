"""区域平均亮度：python TW04rev-lum.py x y w h 图1 图2 ...（按行带 100 px 打印）"""
import sys
from PIL import Image, ImageStat

sys.stdout.reconfigure(encoding="utf-8")
x, y, w, h = map(int, sys.argv[1:5])
for p in sys.argv[5:]:
    im = Image.open(p).convert("L").crop((x, y, x + w, y + h))
    bands = [f"{ImageStat.Stat(im.crop((0, y0, w, min(h, y0 + 100)))).mean[0]:.1f}" for y0 in range(0, h, 100)]
    print(p.split("TW04rev")[-1], f"{ImageStat.Stat(im).mean[0]:.2f}", " ".join(bands))
