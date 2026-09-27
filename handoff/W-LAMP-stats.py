"""W-LAMP：翼面死白块与灯周径向剖面。

用法：python handoff/W-LAMP-stats.py <job 目录> <变体1,变体2,...> [--mask mask] [--crop 输出前缀]
  - 机翼遮罩取 <job>/<mask>/hdr_WxH.f32 的 R（机翼覆盖率 > 0）；灯芯取 G（wingLights 亮度）的局部极大
  - 死白：显示亮度（Rec.709 luma，0.2126R+0.7152G+0.0722B，与 compare.mjs 同口径）≥ 250 的 8 连通块，
    只数与机翼像素重叠的块，报块数、最大块像素数、> 20 px 的块数
  - 径向剖面：每盏灯（灯芯亮度极大值）周围，只取机翼像素（覆盖率 = 1）按半径分环取亮度中位数
"""
import sys, os, json, glob
import numpy as np
from PIL import Image

sys.stdout.reconfigure(encoding="utf-8")


def load_hdr(d):
    f = glob.glob(os.path.join(d, "hdr_*.f32"))[0]
    w, h = map(int, os.path.basename(f)[4:-4].split("x"))
    return np.fromfile(f, dtype=np.float32).reshape(h, w, 3)


def luma(img):
    a = img[..., :3].astype(np.float64)
    return 0.2126 * a[..., 0] + 0.7152 * a[..., 1] + 0.0722 * a[..., 2]


def components(b):
    """8 连通块，返回标签图与各块大小（纯 numpy + 栈，图不大）"""
    h, w = b.shape
    lab = np.zeros((h, w), np.int32)
    sizes = [0]
    ys, xs = np.nonzero(b)
    cur = 0
    for y0, x0 in zip(ys, xs):
        if lab[y0, x0]:
            continue
        cur += 1
        st = [(y0, x0)]
        lab[y0, x0] = cur
        n = 0
        while st:
            y, x = st.pop()
            n += 1
            for dy in (-1, 0, 1):
                for dx in (-1, 0, 1):
                    yy, xx = y + dy, x + dx
                    if 0 <= yy < h and 0 <= xx < w and b[yy, xx] and not lab[yy, xx]:
                        lab[yy, xx] = cur
                        st.append((yy, xx))
        sizes.append(n)
    return lab, sizes


def lamps(g, cov):
    """灯芯：G 通道（wingLights 亮度）的局部极大，按亮度排序取前几个、彼此相距 > 12 px"""
    pts = []
    flat = np.argsort(g, axis=None)[::-1]
    for idx in flat[:5000]:
        y, x = divmod(int(idx), g.shape[1])
        if g[y, x] <= 0:
            break
        if all((y - py) ** 2 + (x - px) ** 2 > 144 for py, px, _ in pts):
            pts.append((y, x, float(g[y, x])))
        if len(pts) >= 4:
            break
    return pts


def main():
    job = sys.argv[1]
    variants = sys.argv[2].split(",")
    mask_name = "mask"
    if "--mask" in sys.argv:
        mask_name = sys.argv[sys.argv.index("--mask") + 1]
    m = load_hdr(os.path.join(job, mask_name))
    cov = m[..., 0]
    wing = cov > 0
    full = cov >= 0.999
    lp = lamps(m[..., 1], cov)
    out = {"job": os.path.basename(job), "wingPx": int(wing.sum()), "lamps": [(x, y, round(v, 1)) for y, x, v in lp]}
    radii = [3, 5, 8, 11, 15, 20, 26, 34, 44, 56]
    yy, xx = np.mgrid[0 : cov.shape[0], 0 : cov.shape[1]]
    for vn in variants:
        img = np.asarray(Image.open(os.path.join(job, vn, "full.png")).convert("RGB"))
        L = luma(img)
        bright = L >= 250
        lab, sizes = components(bright)
        wl = set(np.unique(lab[bright & wing]).tolist()) - {0}
        ws = sorted((sizes[i] for i in wl), reverse=True)
        rec = {"variant": vn, "whiteBlobsOnWing": len(ws), "maxBlob": ws[0] if ws else 0, "blobsGt20": sum(1 for s in ws if s > 20), "top5": ws[:5],
               "wingMeanL": round(float(L[full].mean()), 2), "wingP99": round(float(np.percentile(L[full], 99)), 1) if full.any() else None}
        prof = []
        for (ly, lx, _) in lp:
            r = np.hypot(yy - ly, xx - lx)
            row = []
            for i, r1 in enumerate(radii):
                r0 = radii[i - 1] if i else 0
                sel = full & (r >= r0) & (r < r1)
                row.append(round(float(np.median(L[sel])), 1) if sel.sum() >= 3 else None)
            prof.append({"lamp": (lx, ly), "ringMedian": row})
        rec["radial"] = prof
        print(json.dumps(rec, ensure_ascii=False))
    print(json.dumps(out, ensure_ascii=False))


main()
