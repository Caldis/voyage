"""T43：对若干个截图目录（T43-shots.mjs 的输出）按固定区域跑 T43-stats.py，方便前后对照。
用法：python T43-report.py 目录1 [目录2 ...]
区域（1600×1200 视口）：
  night-city 城区    700,900,550,250   （富士市区，灯点密）
  night-city 城郊    450,700,500,150
  route 城外         420,850,700,250   （关东平原，村镇之间）
  route 远处         420,620,700,150
  4km 城外           430,820,450,200
"""
import os
import subprocess
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
REG = [
    ("night-city", "城区", (700, 900, 550, 250)),
    ("night-city", "城郊", (450, 700, 500, 150)),
    ("route-hnd-cts-night", "城外", (420, 850, 700, 250)),
    ("route-hnd-cts-night", "远处", (420, 620, 700, 150)),
    ("hnd-night-4km", "城外", (430, 820, 450, 200)),
]
for d in sys.argv[1:]:
    for scene, label, r in REG:
        a, b = os.path.join(d, scene + ".png"), os.path.join(d, scene + "_noroad.png")
        if not os.path.exists(a):
            continue
        print(label, end=" ", flush=True)
        subprocess.run([sys.executable, os.path.join(HERE, "T43-stats.py"), a, b, *map(str, r)], check=False)
