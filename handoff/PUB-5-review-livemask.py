# PUB-5 审查（用法：python PUB-5-review-livemask.py <ab 输出>/<job> ...；转头 job 的冻结覆盖率与录像机位不一致，掩码只作参考）：live 录像按冻结覆盖率（covOld ∪ covNew 的 R 通道）掩码，统计轮廓带（±4 px）/ 机翼内部 / 窗外的闪烁像素
# 闪烁像素 = 亮度二阶差 > 8 级的帧占比 > 5%（与 ab live 同口径）
import sys, glob, os, json
import numpy as np
from PIL import Image

sys.stdout.reconfigure(encoding="utf-8")
CROP = [400, 480, 440, 420]
REG = {"内整流罩": [30, 300, 190, 100], "中整流罩": [260, 110, 120, 100], "外整流罩": [340, 20, 90, 110]}


def dil(m, r):
    o = m.copy()
    for dy in range(-r, r + 1):
        for dx in range(-r, r + 1):
            o |= np.roll(np.roll(m, dy, 0), dx, 1)
    return o


for jd in sys.argv[1:]:
    x, y, w, h = CROP
    cov = []
    for n in ["covOld", "covNew"]:
        a = np.asarray(Image.open(os.path.join(jd, n + ".png")).convert("RGB"))[y:y + h, x:x + w, 0]
        cov.append(a > 8)
    wing = cov[0] | cov[1]
    band = dil(wing, 4) & dil(~wing, 4)
    inner = wing & ~band
    outer = ~wing & ~band
    print(f"== {os.path.basename(jd)}：带 {band.sum()} 内部 {inner.sum()} 窗外 {outer.sum()}")
    for f in sorted(glob.glob(os.path.join(jd, "live_*_*x*.u8"))):
        name = os.path.basename(f).split("_")[1]
        raw = np.fromfile(f, np.uint8).reshape(-1, h, w, 4).astype(np.float32)
        L = raw[..., 0] * 0.2126 + raw[..., 1] * 0.7152 + raw[..., 2] * 0.0722
        d2 = np.abs(L[2:] - 2 * L[1:-1] + L[:-2])
        frac = (d2 > 8).mean(0)
        fl = frac > 0.05
        s = f"  {name:5s} 带/内部/窗外 {int((fl & band).sum()):5d} / {int((fl & inner).sum()):5d} / {int((fl & outer).sum()):5d}"
        for rn, (rx, ry, rw, rh) in REG.items():
            sub = np.zeros_like(band); sub[ry:ry + rh, rx:rx + rw] = True
            s += f" | {rn} 带 {int((fl & band & sub).sum())} 平均二阶差(带) {d2[:, band & sub].mean():.3f}"
        print(s)
