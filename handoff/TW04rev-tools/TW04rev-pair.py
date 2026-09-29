"""TW04 审查：左 master（5365）、右 合并（5364）并排，缩到一半；另输出 sea-sc 两边的逐像素差（默认程序应一致）。"""
import os
import sys
from PIL import Image, ImageChops, ImageStat

sys.stdout.reconfigure(encoding="utf-8")
root = sys.argv[1]
a_dir = os.path.join(root, "p5365")
b_dir = os.path.join(root, "p5364")
out = os.path.join(root, "pair")
os.makedirs(out, exist_ok=True)
for f in sorted(os.listdir(b_dir)):
    if not f.endswith(".png"):
        continue
    a = Image.open(os.path.join(a_dir, f)).convert("RGB")
    b = Image.open(os.path.join(b_dir, f)).convert("RGB")
    w, h = a.size
    s = 0.5
    c = Image.new("RGB", (int(w * s) * 2 + 8, int(h * s)), (255, 0, 0))
    c.paste(a.resize((int(w * s), int(h * s))), (0, 0))
    c.paste(b.resize((int(w * s), int(h * s))), (int(w * s) + 8, 0))
    c.save(os.path.join(out, f))
    d = ImageChops.difference(a, b).convert("L")
    st = ImageStat.Stat(d)
    n8 = sum(1 for v in d.getdata() if v > 8)
    print(f"{f}: mean diff {st.mean[0]:.2f} max {d.getextrema()[1]} >8 px {n8}")
