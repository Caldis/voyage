# 一块屏幕区域（显示像素）的距离中位数与各变体 Y 高频 / 均值，截图 8 bit 高频
import sys, json, os
import numpy as np
from PIL import Image
sys.stdout.reconfigure(encoding="utf-8")
root, job, box, vns = sys.argv[1], sys.argv[2], list(map(int, sys.argv[3].split(","))), sys.argv[4].split(",")
def load(vn):
    m = json.load(open(os.path.join(root, job, vn + ".cloud.json")))
    a = np.fromfile(os.path.join(root, job, vn + ".cloud.f32"), dtype=np.float32).reshape(m["H"], m["W"], 2)[::-1]
    return a, m["W"] / 1600
d, s = load("dist")
x0, y0, x1, y1 = [int(v * s) for v in box]
km = (d[..., 1] / np.maximum(d[..., 0], 1e-4))[y0:y1, x0:x1]
print("距离中位 km", float(np.median(km)), "p10/p90", float(np.percentile(km, 10)), float(np.percentile(km, 90)))
def hf(Y):
    p = np.pad(Y, 1, mode="edge")
    b = sum(p[1 + dy:1 + dy + Y.shape[0], 1 + dx:1 + dx + Y.shape[1]] for dy in (-1, 0, 1) for dx in (-1, 0, 1)) / 9
    return np.abs(Y - b)
for v in vns:
    a, _ = load(v)
    Y = a[..., 1][y0:y1, x0:x1]
    im = np.asarray(Image.open(os.path.join(root, job, v + ".png")).convert("L")).astype(float)[box[1]:box[3], box[0]:box[2]]
    print(f"  {v:8s} Y 均值 {Y.mean():.3f}  HDR 高频/均值 {hf(Y).mean() / Y.mean():.4f}  截图 8bit 高频 {hf(im).mean():.2f}")
