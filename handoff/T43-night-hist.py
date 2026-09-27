"""T43：看 NASA Black Marble（GIBS z8，和 tiles.ts 的 NIGHT_URL 同一个源）在某片区域的夜光值分布，给「乡道亮不亮」的阈值定标。
用法：python T43-night-hist.py [lat lon]   （默认关东平原北部 36.2, 139.6）
输出这张 256² 瓦片 R 通道（0..1）的分位数，以及「≥ 阈值」的像素比例。
"""
import io
import math
import sys
import urllib.request

import numpy as np
from PIL import Image

lat, lon = (float(sys.argv[1]), float(sys.argv[2])) if len(sys.argv) > 2 else (36.2, 139.6)
z = 8
n = 2 ** z
x = int((lon + 180) / 360 * n)
r = math.radians(lat)
y = int((1 - math.log(math.tan(r) + 1 / math.cos(r)) / math.pi) / 2 * n)
url = f"https://gibs.earthdata.nasa.gov/wmts/epsg3857/best/VIIRS_Black_Marble/default/2016-01-01/GoogleMapsCompatible_Level8/{z}/{y}/{x}.png"
req = urllib.request.Request(url, headers={"User-Agent": "voyage-dev"})
a = np.asarray(Image.open(io.BytesIO(urllib.request.urlopen(req, timeout=30).read())).convert("RGB"), dtype=np.float64)[..., 0] / 255
print(url)
print("分位 10/25/50/75/90/97:", " ".join(f"{np.percentile(a, p):.3f}" for p in (10, 25, 50, 75, 90, 97)))
for t in (0.05, 0.1, 0.15, 0.2, 0.3, 0.45, 0.6):
    print(f"  ≥ {t:.2f}: {np.mean(a >= t) * 100:.1f}%")
