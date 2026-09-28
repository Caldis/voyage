"""wedge3：分析 mksweep 的序列：覆盖率的时间二阶差（对参考图），按路径切换归因；可限定子区域。
python sweepana.py <dump.json> [区域名=x,y,w,h（裁剪内坐标）...] [--img 输出.png 区域名]"""
import base64
import json
import sys

import numpy as np
from PIL import Image

sys.stdout.reconfigure(encoding="utf-8")
d = json.load(open(sys.argv[1], encoding="utf-8"))["jsOut"]
CX, CY, CW, CH = d["crop"]
regions = {"全部": [0, 0, CW, CH]}
img = None
args = sys.argv[2:]
i = 0
while i < len(args):
    if args[i] == "--img":
        img = (args[i + 1], args[i + 2])
        i += 3
        continue
    k, v = args[i].split("=")
    regions[k] = [int(x) for x in v.split(",")]
    i += 1


def dec(k):
    return np.frombuffer(base64.b64decode(d[k]), np.uint8).reshape(CH, CW).astype(np.float64)


def seq(prefix):
    ks = sorted(k for k in d if k.startswith(prefix) and k[len(prefix):].isdigit() and len(k) == len(prefix) + 2)
    return np.stack([dec(k) for k in ks]) / 255.0 if ks else None


S = {"new": seq("cp"), "ref": seq("cr"), "old": seq("co")}
for k in sorted({k[1:-2] for k in d if k.startswith("c") and k[-2:].isdigit() and k[1:-2] not in ("p", "r", "o", "")}):
    S[k] = seq("c" + k)
P = np.stack([np.round(dec(k)).astype(int) for k in sorted(k for k in d if k.startswith("path_cp") and k[7:].isdigit())])
n = S["ref"].shape[0]
print("帧数", n, "参考覆盖率逐帧变化的像素", int((np.abs(np.diff(S["ref"], axis=0)) > 0.02).any(0).sum()))
for rn, (x, y, w, h) in regions.items():
    sl = (slice(None), slice(y, y + h), slice(x, x + w))
    print(f"== {rn} {x},{y},{w},{h}")
    for name, A in S.items():
        a = A[sl]
        d2 = np.abs(a[2:] - 2 * a[1:-1] + a[:-2])
        err = np.abs(a - S["ref"][sl])
        edge = (a > 0) & (a < 1) | (S["ref"][sl] > 0) & (S["ref"][sl] < 1)
        print(f"  {name:>8}: Σ|二阶差| {d2.sum():8.1f}  >0.25 的 {int((d2 > 0.25).sum()):6d}  >0.5 的 {int((d2 > 0.5).sum()):5d}   平均|对参考误差|（边缘）{err[edge].mean():.3f}")
    # 归因：new 的大二阶差（>0.25）发生时，中间帧与前后帧的路径码组合
    a = S["new"][sl]
    p = P[sl]
    d2 = np.abs(a[2:] - 2 * a[1:-1] + a[:-2])
    big = d2 > 0.25
    combos = {}
    for (t, yy, xx) in zip(*np.nonzero(big)):
        c = (int(p[t, yy, xx]), int(p[t + 1, yy, xx]), int(p[t + 2, yy, xx]))
        combos[c] = combos.get(c, 0) + 1
    top = sorted(combos.items(), key=lambda kv: -kv[1])[:12]
    print("  new 大二阶差的路径码（前, 中, 后）：", top)
    # 各路径的平均误差（有符号）
    r = S["ref"][sl]
    for code in range(16):
        m = (p == code) & ((a > 0) & (a < 1) | (r > 0) & (r < 1))
        if m.sum() > 20:
            e = (a - r)[m]
            print(f"    码 {code:2d}: {int(m.sum()):6d} 像素帧，误差 {e.mean():+.3f}，|误差| {np.abs(e).mean():.3f}")
if img:
    out, rn = img
    x, y, w, h = regions[rn]
    tiles = []
    for name, A in S.items():
        a = A[:, y:y + h, x:x + w]
        d2 = np.abs(a[2:] - 2 * a[1:-1] + a[:-2]).sum(0)
        tiles.append(np.clip(d2 / 2, 0, 1))
    im = np.concatenate([np.pad(t, ((0, 0), (0, 2)), constant_values=1) for t in tiles], 1)
    Image.fromarray((im * 255).astype(np.uint8)).resize((im.shape[1] * 4, im.shape[0] * 4), Image.NEAREST).save(out)
