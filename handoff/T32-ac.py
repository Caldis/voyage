# T32：批量跑二维自相关（算法同 T21-autocorr.py），一次看多张截图、多个区域。
# 用法：python T32-ac.py <目录或 png> [视角名前缀...]
#   对目录下每张 png（或单个 png），按文件名前缀选区域：*-top 看画面中上部，*-far 看中远处两块
#   打印每块的纹理标准差和最强的 4 个非中心峰 (dx, dy, 相对强度)；
#   周期平铺在平铺向量处留下 0.2 以上的峰，无周期的随机场只剩 < 0.1 的底噪
import os
import sys
import numpy as np
from PIL import Image

BOXES = {
    "top": [("mid", (0.25, 0.1, 0.8, 0.6))],
    "far": [("far", (0.5, 0.2, 0.97, 0.5)), ("mid", (0.3, 0.55, 0.95, 0.95))],
    "hor": [("hor", (0.5, 0.57, 0.98, 0.76))],
    "user": [("far", (0.55, 0.3, 0.97, 0.65)), ("mid", (0.3, 0.55, 0.9, 0.95))],
}


def blur(x, r):
    k = 2 * r + 1
    for axis in (0, 1):
        for _ in range(2):
            c = np.cumsum(np.pad(x, [(r + 1, r) if i == axis else (0, 0) for i in range(2)], mode="edge"), axis=axis)
            x = (np.take(c, range(k, c.shape[axis]), axis=axis) - np.take(c, range(0, c.shape[axis] - k), axis=axis)) / k
    return x


LO, HI = 3, 14


def peaks(path, box, n=4):
    im = Image.open(path).convert("L")
    w, h = im.size
    im = im.crop((int(box[0] * w), int(box[1] * h), int(box[2] * w), int(box[3] * h)))
    a = np.asarray(im, dtype=np.float64)
    # 带通：先去掉 ≤ 5 px 的成分（three.js 输出抖动 dithering 是 6 px 周期的屏幕空间图案，振幅半个色阶，
    # 不去掉会在 (6,−1)/(6,−3) 处给出 0.5–0.9 的假峰），再去掉约 30 px 以上的大尺度明暗
    hp = blur(a, LO) - blur(a, HI)
    hp -= hp.mean()
    hp *= np.hanning(hp.shape[0])[:, None] * np.hanning(hp.shape[1])[None, :]
    F = np.fft.fft2(hp, s=(2 * hp.shape[0], 2 * hp.shape[1]))
    ac = np.fft.fftshift(np.real(np.fft.ifft2(np.abs(F) ** 2)))
    cy, cx = np.array(ac.shape) // 2
    ac /= ac[cy, cx]
    yy, xx = np.mgrid[: ac.shape[0], : ac.shape[1]]
    r = np.hypot(yy - cy, xx - cx)
    # 只取真正的局部极大（5×5 邻域里最大）：带通后自相关在中心附近有一圈平滑的肩，
    # 直接取最大值会落在肩上（离中心最近的那一圈），不是周期峰
    from numpy.lib.stride_tricks import sliding_window_view
    pad = np.pad(ac, 2, mode="constant", constant_values=-9)
    loc = ac >= sliding_window_view(pad, (5, 5)).max(axis=(2, 3))
    m = (r > 8) & (r < min(hp.shape) * 0.5) & loc & (xx - cx >= 0)
    ys, xs = np.nonzero(m)
    order = np.argsort(-ac[ys, xs])[:n]
    out = [(int(xs[k] - cx), int(ys[k] - cy), round(float(ac[ys[k], xs[k]]), 3)) for k in order]
    # AC_LAGS="dx,dy;dx,dy"：再报这几个位移处（±1 px 内最大）的自相关值——用来看改前的周期峰在改后还剩多少
    lags = os.environ.get("AC_LAGS")
    if lags:
        for lg in lags.split(";"):
            dx, dy = (int(v) for v in lg.split(","))
            out.append(("@%d,%d" % (dx, dy), round(float(ac[cy + dy - 1: cy + dy + 2, cx + dx - 1: cx + dx + 2].max()), 3)))
    return hp.std(), out


LO, HI = int(os.environ.get('AC_LO', 3)), int(os.environ.get('AC_HI', 14))  # 带通半径（px），看大尺度周期时调大
target = sys.argv[1]
files = [os.path.join(target, f) for f in sorted(os.listdir(target)) if f.endswith(".png") and "crop" not in f] if os.path.isdir(target) else [target]
pref = sys.argv[2:]
for f in files:
    name = os.path.basename(f)
    if pref and not any(name.startswith(p) for p in pref):
        continue
    kind = "user" if name[0].isdigit() else ("top" if "-top" in name else "hor" if "-hor" in name else "far")
    for label, box in BOXES[kind]:
        sd, pk = peaks(f, box)
        print(f"{name:24s} {label:4s} std={sd:5.2f} peaks={pk}")
