# C01 / C02 锐度指标（改自 tmp/cloud-sharp/csharp_metrics.py，指标定义不变，另加云像素的显示亮度分位与截白比例）
#   w1090 / op_w1090：强边缘 10–90% 上升宽度（px，亮度 / 不透明度）；边缘点集取自参考变体
#   int_rng：云芯（不透明度 > 0.97 腐蚀后）亮度 (p95 − p5) / 均值；int_c：云芯去 σ=3 低频后的 std / 均值
#   rim：云边（不透明度 0.2–0.8）平均亮度 / 云芯平均亮度
#   yp99：研究报告口径（裁剪框内较亮 65% 区域的 p99 显示 luma）；yp99c：不透明度 > 0.5 的云像素 p99；clip：云像素里任一通道 ≥ 254 的比例
# 用法：python c01-metrics.py <根目录> <参考变体> <变体,...> [场景,...]
import sys, os, json
import numpy as np
from PIL import Image
sys.stdout.reconfigure(encoding="utf-8")

CROPS = {
    "noon-cumulus": (700, 640, 500, 460),
    "sunset-wing": (420, 700, 760, 440),
    "clouds-variety": (420, 450, 760, 550),
    "cu-side": (420, 350, 760, 600),
    "backlit-cu": (400, 520, 800, 160),
}

def gauss(img, s):
    r = int(3 * s + 0.5)
    x = np.arange(-r, r + 1)
    k = np.exp(-x * x / (2 * s * s)); k /= k.sum()
    p = np.pad(img, r, mode="reflect")
    t = np.apply_along_axis(lambda m: np.convolve(m, k, "valid"), 0, p)
    return np.apply_along_axis(lambda m: np.convolve(m, k, "valid"), 1, t)

def rgb_png(path, box):
    x, y, w, h = box
    return np.asarray(Image.open(path).convert("RGB"), dtype=np.float64)[y:y + h, x:x + w]

def luma(a):
    return (a / 255.0) @ np.array([0.2126, 0.7152, 0.0722])

def opacity_bin(path, box, W=1600, H=1200):
    x, y, w, h = box
    d = np.fromfile(path, dtype=np.float32).reshape(H, W, 4)[::-1]
    return 1.0 - d[y:y + h, x:x + w, 3].astype(np.float64)

def bilin(img, xs, ys):
    h, w = img.shape
    xs = np.clip(xs, 0, w - 1.001); ys = np.clip(ys, 0, h - 1.001)
    x0 = np.floor(xs).astype(int); y0 = np.floor(ys).astype(int)
    fx = xs - x0; fy = ys - y0
    return (img[y0, x0] * (1 - fx) * (1 - fy) + img[y0, x0 + 1] * fx * (1 - fy)
            + img[y0 + 1, x0] * (1 - fx) * fy + img[y0 + 1, x0 + 1] * fx * fy)

def edge_set(ref, n=400):
    g = gauss(ref, 1.0)
    gy, gx = np.gradient(g)
    mag = np.hypot(gx, gy)
    mag[:10] = mag[-10:] = 0; mag[:, :10] = mag[:, -10:] = 0
    idx = np.argsort(mag.ravel())[::-1]
    pts = []
    taken = np.zeros_like(mag, bool)
    for i in idx:
        yy, xx = divmod(i, mag.shape[1])
        if taken[max(0, yy - 3):yy + 4, max(0, xx - 3):xx + 4].any():
            continue
        taken[yy, xx] = True
        pts.append((xx, yy, gx[yy, xx] / mag[yy, xx], gy[yy, xx] / mag[yy, xx]))
        if len(pts) >= n:
            break
    return pts

def widths(img, pts):
    out = []
    s = np.linspace(-8, 8, 161)
    for (x, y, dx, dy) in pts:
        prof = bilin(img, x + s * dx, y + s * dy)
        lo, hi = prof[:20].mean(), prof[-20:].mean()
        if hi - lo < 0.02:
            continue
        n = (prof - lo) / (hi - lo)
        c = 80
        if n[c::-1].min() > 0.1 or n[c:].max() < 0.9:
            continue
        i10 = c - np.argmax(n[c::-1] <= 0.1)
        i90 = c + np.argmax(n[c:] >= 0.9)
        out.append((i90 - i10) * 0.1)
    return np.array(out)

def scene_metrics(d, box, refname, names):
    ref = luma(rgb_png(os.path.join(d, refname + ".png"), box))
    pts = edge_set(ref)
    refo = opacity_bin(os.path.join(d, refname + ".bin"), box)
    ptso = edge_set(refo)
    mask = gauss(ref, 3.0) > np.percentile(ref, 35)
    meta = json.load(open(os.path.join(d, "meta.json"), encoding="utf-8"))
    res = {}
    for nm in names:
        p = os.path.join(d, nm + ".png")
        if not os.path.exists(p):
            continue
        A = rgb_png(p, box)
        L = luma(A)
        w = widths(L, pts)
        O = opacity_bin(os.path.join(d, nm + ".bin"), box)
        wo = widths(O, ptso)
        inner = gauss((O > 0.97).astype(float), 2.0) > 0.99
        edge = (O > 0.2) & (O < 0.8)
        cl = O > 0.5
        r = dict(w1090=round(float(np.median(w)), 2), op_w=round(float(np.median(wo)), 2),
                 ymean=round(float(L[mask].mean() * 255), 1), yp99=round(float(np.percentile(L[mask], 99) * 255), 1),
                 yp99c=round(float(np.percentile(L[cl], 99) * 255), 1) if cl.sum() > 50 else None,
                 clip=round(float((A[cl].max(axis=1) >= 254).mean()), 4) if cl.sum() > 50 else None)
        if inner.sum() > 100:
            hp = (L - gauss(L, 3.0))[inner]
            r.update(int_rng=round(float((np.percentile(L[inner], 95) - np.percentile(L[inner], 5)) / L[inner].mean()), 3),
                     int_c=round(float(hp.std() / L[inner].mean()), 4),
                     rim=round(float(L[edge].mean() / L[inner].mean()), 3), rim90=round(float(np.percentile(L[edge], 90) / L[inner].mean()), 3),
                     core=round(float(L[inner].mean() * 255), 1))
        r["o"] = meta["variants"].get(nm, {}).get("adapted", [None])[0]
        res[nm] = r
    return res

def main():
    root, refname = sys.argv[1], sys.argv[2]
    names = sys.argv[3].split(",")
    scenes = sys.argv[4].split(",") if len(sys.argv) > 4 else [s for s in CROPS if os.path.isdir(os.path.join(root, s))]
    out = {}
    for sc in scenes:
        d = os.path.join(root, sc)
        if not os.path.isdir(d):
            continue
        res = scene_metrics(d, CROPS[sc], refname, names)
        out[sc] = res
        keys = ["o", "ymean", "yp99", "yp99c", "clip", "core", "int_rng", "int_c", "rim", "rim90", "w1090", "op_w"]
        print("\n## " + sc)
        print("| 变体 | " + " | ".join(keys) + " |")
        for nm, r in res.items():
            print("| " + nm + " | " + " | ".join(str(r.get(k, "")) for k in keys) + " |")
    json.dump(out, open(os.path.join(root, "metrics.json"), "w", encoding="utf-8"), ensure_ascii=False, indent=1)

main()
