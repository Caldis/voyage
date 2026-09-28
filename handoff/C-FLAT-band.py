# 按距离分带的云亮度对真值比（C10c 口径的复查）：python C-FLAT-band.py <job 目录> <变体> <真值变体> [dist 变体名，默认 dist]
# 只取真值 α ≥ 0.9 的像素；Y/真值 = 各带 Y 之和 ÷ 真值 Y 之和；暗处 = 真值最暗 30% 像素的 Y 比与对数离散（C10c-shadow 口径）
import sys, os, json
import numpy as np

sys.stdout.reconfigure(encoding="utf-8")
d, v, ref = sys.argv[1], sys.argv[2], sys.argv[3]
dv = sys.argv[4] if len(sys.argv) > 4 else "dist"


def load(n):
    m = json.load(open(os.path.join(d, f"{n}.cloud.json"), encoding="utf-8"))
    a = np.fromfile(os.path.join(d, f"{n}.cloud.f32"), dtype=np.float32).reshape(m["H"], m["W"], 2)
    return a[..., 0], a[..., 1]


A, Y = load(v)
At, Yt = load(ref)
Ad, Yd = load(dv)
D = Yd / np.maximum(Ad, 1e-6)
m = At >= 0.9
out = []
for lo, hi in ((0, 20), (20, 40), (40, 60), (60, 90), (90, 1e9)):
    s = m & (D >= lo) & (D < hi)
    if s.sum() < 100:
        continue
    r = Y[s].sum() / Yt[s].sum()
    lr = np.log(np.maximum(Y[s], 1e-9) / np.maximum(Yt[s], 1e-9))
    thr = np.percentile(Yt[s], 30)
    dk = s & (Yt <= thr)
    rd = Y[dk].sum() / Yt[dk].sum()
    ld = np.log(np.maximum(Y[dk], 1e-9) / np.maximum(Yt[dk], 1e-9))
    out.append(f"{lo}-{hi if hi < 1e8 else '∞'} km: Y/真值 {r:.3f}（逐像素对数离散 MAD {1.4826 * np.median(np.abs(lr - np.median(lr))):.3f}），暗处 30% {rd:.3f}（{1.4826 * np.median(np.abs(ld - np.median(ld))):.3f}），n={int(s.sum())}")
print(f"{os.path.basename(d)} {v} vs {ref}")
print("\n".join("  " + o for o in out))
