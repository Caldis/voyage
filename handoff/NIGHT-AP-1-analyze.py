"""NIGHT-AP：按 ROI 统计各变体窗外 HDR（cd/m²）与屏幕 sRGB。
云 / 远塔像素用「noAP 变体与 base 的亮度差」自动取掩膜（noAP 只动云与远塔），背景像素取掩膜之外。
用法：python analyze.py <场景目录> <rois.json>
rois.json：{"名字": [x0, y0, x1, y1, "cloud"|"bg"|"all"], ...}（显示坐标，左上原点）"""
import json
import sys
import colorsys
import numpy as np
from PIL import Image

sys.stdout.reconfigure(encoding="utf-8")
d = sys.argv[1]
rois = json.load(open(sys.argv[2], encoding="utf-8"))
variants = sys.argv[3].split(",") if len(sys.argv) > 3 else ["base", "moonAP", "noAP", "keepOff", "moonAP_keepOff", "key2", "base2"]


def load(n):
    m = json.load(open(f"{d}/{n}.json"))
    a = np.fromfile(f"{d}/{n}.f32", dtype=np.float32).reshape(m["h"], m["w"], 3)
    a = a[::-1] * 1000.0  # GL 左下原点 → 左上；kcd/m² → cd/m²
    a = np.repeat(np.repeat(a, 2, axis=0), 2, axis=1)  # 回到显示分辨率
    png = np.asarray(Image.open(f"{d}/{n}.png").convert("RGB")).astype(np.float64)
    return a, png


Y = lambda a: a[..., 0] * 0.2126 + a[..., 1] * 0.7152 + a[..., 2] * 0.0722
data = {n: load(n) for n in variants}
base, noap = data["base"][0], data["noAP"][0]
cloud = np.abs(Y(noap) - Y(base)) / np.maximum(Y(base), 1e-9) > 0.15


def hue(rgb):
    r, g, b = rgb / max(rgb.max(), 1e-12)
    h, s, v = colorsys.rgb_to_hsv(r, g, b)
    return h * 360, s


out = {}
print(f"场景 {d}；掩膜：noAP 与 base 亮度相对差 > 15% 记为云 / 远塔像素")
for name, (x0, y0, x1, y1, kind) in rois.items():
    sl = (slice(y0, y1), slice(x0, x1))
    m = cloud[sl] if kind == "cloud" else (~cloud[sl] if kind == "bg" else np.ones_like(cloud[sl]))
    npx = int(m.sum())
    print(f"\n[{name}] 框 {x0},{y0}–{x1},{y1} 取 {kind} 像素 {npx}")
    print(f"  {'变体':16s} {'L cd/m²':>10s} {'R:G:B（G=1）':>18s} {'色相°':>6s} {'饱和':>5s} | {'屏幕 sRGB':>14s} {'屏幕色相':>6s}")
    for n in variants:
        a, png = data[n]
        if npx == 0:
            continue
        rgb = a[sl][m].mean(axis=0)
        L = float(Y(rgb[None])[0])
        h, s = hue(rgb)
        prgb = png[sl][m].mean(axis=0)
        ph, ps = hue(prgb)
        out.setdefault(name, {})[n] = {"L": L, "rgb": [float(x) for x in rgb], "hue": float(h), "sat": float(s), "png": [float(x) for x in prgb], "pngHue": float(ph)}
        print(f"  {n:16s} {L:10.5f} {rgb[0]/rgb[1]:6.2f}:{1:4.2f}:{rgb[2]/rgb[1]:5.2f} {h:6.0f} {s:5.2f} | {prgb[0]:4.0f} {prgb[1]:4.0f} {prgb[2]:4.0f} {ph:6.0f}")
json.dump(out, open(f"{d}/roi-stats.json", "w", encoding="utf-8"), ensure_ascii=False, indent=1)
