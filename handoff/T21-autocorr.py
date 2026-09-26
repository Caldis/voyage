# T21：截图里海面纹理的周期性检测（二维自相关）。
# 用法：python T21-autocorr.py <png> [x0 y0 x1 y1 按比例]  → 打印最强的几个非中心自相关峰（位置 px、相对强度）
# 周期平铺会在平铺向量处留下明显的峰（相对强度 0.2 以上）；无周期的随机场只剩噪声（< 0.1）。
import sys
import numpy as np
from PIL import Image

path = sys.argv[1]
box = [float(a) for a in sys.argv[2:6]] if len(sys.argv) >= 6 else [0.25, 0.25, 0.75, 0.75]
im = Image.open(path).convert("L")
w, h = im.size
im = im.crop((int(box[0] * w), int(box[1] * h), int(box[2] * w), int(box[3] * h)))
a = np.asarray(im, dtype=np.float64)


def blur(x, r):
    # 盒式模糊两次近似高斯，去掉云影、耀斑波瓣这种大尺度亮度变化，只留纹理
    k = 2 * r + 1
    for axis in (0, 1):
        for _ in range(2):
            c = np.cumsum(np.pad(x, [(r + 1, r) if i == axis else (0, 0) for i in range(2)], mode="edge"), axis=axis)
            x = (np.take(c, range(k, c.shape[axis]), axis=axis) - np.take(c, range(0, c.shape[axis] - k), axis=axis)) / k
    return x


hp = a - blur(a, 12)
hp -= hp.mean()
hp *= np.hanning(hp.shape[0])[:, None] * np.hanning(hp.shape[1])[None, :]
F = np.fft.fft2(hp, s=(2 * hp.shape[0], 2 * hp.shape[1]))
ac = np.fft.fftshift(np.real(np.fft.ifft2(np.abs(F) ** 2)))
cy, cx = np.array(ac.shape) // 2
ac /= ac[cy, cx]
yy, xx = np.mgrid[: ac.shape[0], : ac.shape[1]]
r = np.hypot(yy - cy, xx - cx)
# 只看离中心 6 px 以外、窗口尺寸一半以内的峰
m = (r > 6) & (r < min(hp.shape) * 0.5)
acm = np.where(m, ac, -1)
peaks = []
for _ in range(6):
    i = np.unravel_index(np.argmax(acm), acm.shape)
    peaks.append((int(i[1] - cx), int(i[0] - cy), round(float(acm[i]), 3)))
    acm[max(i[0] - 5, 0): i[0] + 6, max(i[1] - 5, 0): i[1] + 6] = -1
    j = (2 * cy - i[0], 2 * cx - i[1])  # 对称的另一个峰也去掉
    acm[max(j[0] - 5, 0): j[0] + 6, max(j[1] - 5, 0): j[1] + 6] = -1
print(path.split("\\")[-1].split("/")[-1], "std=%.2f" % hp.std(), "peaks(dx,dy,rel):", peaks)
