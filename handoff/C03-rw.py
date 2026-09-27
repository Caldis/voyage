# C03 返工汇总：三场景 old / new / final 的对角高频（C03-hf.py 同口径）、横纹能量（C03-streak.py 同口径）、实时时间波动（meta.json 的 rt）
# 用法：python C03-rw.py <根目录>
import sys, os, json
import numpy as np
from PIL import Image
sys.stdout.reconfigure(encoding="utf-8")
root = sys.argv[1]
CROPS = {"clouds-variety": (420, 450, 760, 550), "backlit-cu": (400, 520, 800, 160), "noon-cumulus": (700, 640, 500, 460)}

def box(a, n, axis):
    k = np.ones(n) / n
    return np.apply_along_axis(lambda m: np.convolve(m, k, "valid"), axis, a)

for sc, (x, y, w, h) in CROPS.items():
    d = os.path.join(root, sc)
    if not os.path.isdir(d):
        continue
    meta = json.load(open(os.path.join(d, "meta.json"), encoding="utf-8"))
    print("## " + sc)
    for vn in ("old", "new", "final"):
        L = np.asarray(Image.open(os.path.join(d, vn + ".png")).convert("RGB").crop((x, y, x + w, y + h))).astype(np.float64) @ [0.2126, 0.7152, 0.0722]
        adj = (np.abs(np.diff(L, axis=1)).mean() + np.abs(np.diff(L, axis=0)).mean()) / 2
        F = np.abs(np.fft.fftshift(np.fft.fft2(L - L.mean()))) ** 2
        yy, xx = np.mgrid[0:h, 0:w]
        fy, fx = (yy - h // 2) / h, (xx - w // 2) / w
        r = np.hypot(fx, fy)
        diag = F[(np.abs(fx) > 0.2) & (np.abs(fy) > 0.2)].sum() / F[r > 0.02].sum()
        bh = box(L, 9, 1); streak = np.abs(bh[2:] - 2 * bh[1:-1] + bh[:-2]).mean()
        bv = box(L, 9, 0); iso = np.abs(bv[:, 2:] - 2 * bv[:, 1:-1] + bv[:, :-2]).mean()
        rt = meta.get("rt", {}).get(vn, {})
        print(f"{vn:6s} adj {adj:.3f}  对角高频 {diag:.4f}  streak {streak:.3f}  iso {iso:.3f}  rt {json.dumps(rt, ensure_ascii=False)}")
