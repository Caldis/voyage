"""C12b：把某个场景 / 模式 / 检查点的真值与各变体 HDR 亮度拼成对照图（上排：色调映射后的图，下排：|V − T| 放大）。
用法：python C12b-viz.py <目录> <场景> <模式> <检查点> <输出.png> [变体,变体,...] [放大倍数=2]
"""
import json, os, sys
import numpy as np
from PIL import Image, ImageDraw
sys.stdout.reconfigure(encoding="utf-8")
root, job, mode, cp, outp = sys.argv[1:6]
S = json.load(open(os.path.join(root, "summary.json"), encoding="utf-8"))
row = next(r for r in S["rows"] if r["job"] == job)
vns = sys.argv[6].split(",") if len(sys.argv) > 6 and sys.argv[6] else list(row["variants"])
zoom = int(sys.argv[7]) if len(sys.argv) > 7 else 2
res = row["variants"][vns[0]][mode]
w, h = res["w"], res["h"]


def load(p):
    return np.fromfile(p, dtype=np.float32).reshape(h, w)[::-1].astype(np.float64)


T = load(os.path.join(root, job, mode, "_truth", f"cp{cp}.f32"))
k = 1.0 / max(np.percentile(T, 90), 1e-9)


def tm(A):
    x = A * k
    return np.clip(255 * (x / (1 + x)) ** (1 / 2.2), 0, 255).astype(np.uint8)


def dm(A):
    return np.clip(np.abs(A - T) * k * 255 * 4, 0, 255).astype(np.uint8)


tiles = [("truth", T)] + [(vn, load(os.path.join(root, job, mode, vn, f"cp{cp}.f32"))) for vn in vns]
W = len(tiles) * w
img = Image.new("L", (W, 2 * h + 14), 0)
d = ImageDraw.Draw(img)
for i, (n, A) in enumerate(tiles):
    img.paste(Image.fromarray(tm(A)), (i * w, 14))
    img.paste(Image.fromarray(dm(A) if n != "truth" else np.zeros_like(tm(A))), (i * w, 14 + h))
    d.text((i * w + 4, 1), n, fill=255)
img = img.resize((img.width * zoom, img.height * zoom), Image.NEAREST)
img.save(outp)
print(outp)
