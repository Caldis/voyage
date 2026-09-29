# PUB-5 审查：把 PUB-3b 整流罩裁剪区（620,560,200,120）的爬行分解成「主翼后缘斜线」与「其余（整流罩轮廓 + 本体）」两份
import sys, glob, os
import numpy as np
from PIL import Image

sys.stdout.reconfigure(encoding="utf-8")
X, Y, Wd, H = 620, 560, 200, 120


def load(d):
    fs = sorted(glob.glob(os.path.join(d, "f*.png")))
    L = np.stack([np.asarray(Image.open(f).convert("RGB"), dtype=np.float64) @ np.array([0.2126, 0.7152, 0.0722]) for f in fs])
    A = L[:, Y:Y + H, X:X + Wd]
    m = A.mean(0)
    d2 = np.abs(A[2:] - 2 * A[1:-1] + A[:-2]).mean(0)
    d1 = np.abs(A[1:] - A[:-1]).mean(0)
    return m, d2, d1


def te_mask(m, d2=None):
    # 主翼后缘：先验直线 x ≈ 139 − 1.18y 附近 ±8 像素里逐行找 |二阶差| 的时间均值最大处（后缘过渡带约 4 像素宽），再拟合，取 ±4 像素
    ys = np.arange(H)
    xs = []
    for y in ys:
        x0 = int(139 - 1.18 * y); lo = max(0, x0 - 8); hi = min(Wd, x0 + 9)
        xs.append(lo + int(np.argmax(m[y, lo:hi - 1] - m[y, lo + 1:hi])))
    a, b = np.polyfit(ys, np.array(xs) + 0.5, 1)
    yy, xx = np.mgrid[0:H, 0:Wd]
    return np.abs(xx - (a * yy + b)) / np.hypot(1, a) <= 4, (a, b, H)


# 用法：python PUB-5-review-decomp.py <flicker 帧目录> [...]（裁剪区固定为 PUB-3b 的 620,560,200,120）
for tag in sys.argv[1:]:
    m, d2, d1 = load(tag)
    te, fit = te_mask(m)
    br = m > 12
    tot = m[br].sum()
    mv = br & (d1 > 0.5)
    c_te = d2[te & br].sum() / tot
    c_rest = d2[~te & br].sum() / tot
    n_te, n_rest = int((mv & te).sum()), int((mv & ~te).sum())
    per_te = d2[mv & te].mean()
    per_rest = d2[mv & ~te].mean()
    # 反事实：其余部分的会动像素若和主翼后缘每像素一样好，整区爬行多少
    cf = (d2[te & br].sum() + per_te * n_rest) / tot
    print(f"{tag}: 拟合 x={fit[0]:.3f}y+{fit[1]:.1f}（{fit[2]} 行）")
    print(f"  整区 {c_te + c_rest:.5f} = 主翼后缘斜线 {c_te:.5f} + 其余 {c_rest:.5f}")
    print(f"  会动像素 后缘 {n_te} / 其余 {n_rest}；每像素|二阶差| 后缘 {per_te:.3f} / 其余 {per_rest:.3f}")
    print(f"  反事实（其余像素与后缘同样好）整区 {cf:.5f}；只算其余（后缘挖掉）{c_rest:.5f}")
