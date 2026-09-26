"""把两组截图并排拼成一张对照图（上一行改前，下一行改后），T23 用。

用法：python apps/voyage/scripts/contact_sheet.py <改前目录> <改后目录> <输出.png> 场景1 场景2 ...
"""

import sys
from pathlib import Path

from PIL import Image, ImageDraw

a, b, out = Path(sys.argv[1]), Path(sys.argv[2]), Path(sys.argv[3])
names = sys.argv[4:]
W, H = 400, 300
sheet = Image.new("RGB", (W * len(names), H * 2 + 20), (20, 20, 20))
d = ImageDraw.Draw(sheet)
for i, n in enumerate(names):
    for j, root in enumerate((a, b)):
        p = root / f"{n}.png"
        if p.exists():
            sheet.paste(Image.open(p).convert("RGB").resize((W, H), Image.LANCZOS), (i * W, 20 + j * H))
    d.text((i * W + 6, 4), n, fill=(230, 230, 230))
out.parent.mkdir(parents=True, exist_ok=True)
sheet.save(out)
print(out)
