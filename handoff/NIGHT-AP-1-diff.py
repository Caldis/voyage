"""两两比较变体：HDR 相对差与屏幕 8 位差。用法：python diff.py <目录> a,b a,c ..."""
import json
import sys
import numpy as np
from PIL import Image

sys.stdout.reconfigure(encoding="utf-8")
d = sys.argv[1]


def load(n):
    m = json.load(open(f"{d}/{n}.json"))
    a = np.fromfile(f"{d}/{n}.f32", dtype=np.float32).reshape(m["h"], m["w"], 3)
    png = np.asarray(Image.open(f"{d}/{n}.png").convert("RGB")).astype(np.int32)
    return a, png


for pair in sys.argv[2:]:
    x, y = pair.split(",")
    (a, pa), (b, pb) = load(x), load(y)
    rel = np.abs(a - b) / np.maximum(np.maximum(np.abs(a), np.abs(b)), 1e-12)
    dp = np.abs(pa - pb)
    print(f"{x} vs {y}: HDR 不同像素 {int((rel.max(axis=2) > 0).sum())}，相对差最大 {rel.max():.3g}，p99 {np.percentile(rel, 99):.3g}；"
          f"屏幕 最大 {dp.max()}，平均 {dp.mean():.4f}，>1 级像素 {int((dp.max(axis=2) > 1).sum())}，整窗均值差 {(pa.mean(axis=(0,1)) - pb.mean(axis=(0,1))).round(3).tolist()}")
