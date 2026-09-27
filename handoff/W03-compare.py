# W03 返工：前后对照（奇观附近 3× 放大）+ 64 px 缩略图（看剪影还像不像蘑菇云）。
# 用法：python apps/voyage/handoff/W03-compare.py <改前目录> <改后目录> <输出目录>
import sys, os
from PIL import Image, ImageDraw

before, after, out = sys.argv[1:4]
os.makedirs(out, exist_ok=True)
# 场景 → 奇观在画面里的中心（1600×1200，80 km）
SC = {"floatcity-day": (880, 545), "floatcity-dusk": (800, 545), "floatcity-front": (800, 545)}
thumbs = []
for n, (cx, cy) in SC.items():
    tiles = []
    for d in (before, after):
        im = Image.open(f"{d}/{n}.png").convert("RGB")
        tiles.append(im.crop((cx - 130, cy - 100, cx + 130, cy + 100)).resize((780, 600), Image.LANCZOS))
        # 64 px 高的缩略图：奇观本身约 130 px 高，裁 150×150 缩成 64×64（再放大 3 倍便于看，最近邻，不添细节）
        th = im.crop((cx - 75, cy - 85, cx + 75, cy + 65)).resize((64, 64), Image.LANCZOS)
        thumbs.append((n, d, th.resize((192, 192), Image.NEAREST)))
    m = Image.new("RGB", (1560, 630), (0, 0, 0))
    m.paste(tiles[0], (0, 30)); m.paste(tiles[1], (780, 30))
    g = ImageDraw.Draw(m)
    g.text((10, 8), f"{n}  before", fill=(255, 255, 255)); g.text((790, 8), "after", fill=(255, 255, 255))
    m.save(f"{out}/cmp-{n}.png")
m = Image.new("RGB", (192 * 6 + 50, 192 + 30), (0, 0, 0))
g = ImageDraw.Draw(m)
for i, (n, d, th) in enumerate(thumbs):
    x = i * 192 + (i // 2) * 10
    m.paste(th, (x, 30))
    g.text((x + 4, 8), n.replace("floatcity-", "") + (" before" if d == before else " after"), fill=(255, 255, 255))
m.save(f"{out}/thumb64.png")
print("ok", out)
