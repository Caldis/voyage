# 把若干截图裁同一块、横向拼起来（带标签），看频闪帧的观感
# 用法：python handoff/STROBE-FLASH-montage.py <输出.png> <x,y,w,h> <缩放> <图1> [<图2> …]
import sys
from PIL import Image, ImageDraw

out, box, scale, files = sys.argv[1], [int(v) for v in sys.argv[2].split(",")], float(sys.argv[3]), sys.argv[4:]
x, y, w, h = box
tw, th = int(w * scale), int(h * scale)
cols = min(len(files), 3)
rows = (len(files) + cols - 1) // cols
M = Image.new("RGB", (tw * cols, (th + 20) * rows), (40, 40, 40))
d = ImageDraw.Draw(M)
for i, f in enumerate(files):
    im = Image.open(f).convert("RGB").crop((x, y, x + w, y + h)).resize((tw, th))
    cx, cy = (i % cols) * tw, (i // cols) * (th + 20)
    M.paste(im, (cx, cy + 20))
    d.text((cx + 4, cy + 4), f.replace("\\", "/").split("/")[-1], fill=(255, 255, 0))
M.save(out)
print("写出", out, M.size)
