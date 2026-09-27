"""T28：改前 / 改后并排拼图（每行一个场景，左改前右改后，缩到一半）。
用法：python apps/voyage/handoff/T28-montage.py <改前目录> <改后目录> <输出.png> 场景1 场景2 ...
"""

import sys
from pathlib import Path

from PIL import Image

a, b, out, *names = sys.argv[1:]
rows = []
for n in names:
    ims = [Image.open(Path(d) / f"{n}.png").convert("RGB").resize((800, 600)) for d in (a, b)]
    row = Image.new("RGB", (1600, 600))
    row.paste(ims[0], (0, 0))
    row.paste(ims[1], (800, 0))
    rows.append(row)
m = Image.new("RGB", (1600, 600 * len(rows)))
for i, r in enumerate(rows):
    m.paste(r, (0, 600 * i))
m.save(out)
print(out)
