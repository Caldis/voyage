import sys, re, base64
sys.stdout.reconfigure(encoding="utf-8")
import numpy as np
src = open(sys.argv[1], encoding="utf-8").read()
n = int(re.search(r"BLUE_NOISE_SIZE = (\d+)", src).group(1))
b64 = "".join(re.findall(r'"([A-Za-z0-9+/=]+)"', src))
a = np.frombuffer(base64.b64decode(b64), np.uint8).reshape(n, n, 2).astype(np.float64)
def spec(img, name):
    h, w = img.shape
    F = np.abs(np.fft.fftshift(np.fft.fft2(img - img.mean()))) ** 2
    yy, xx = np.mgrid[0:h, 0:w]
    fy, fx = (yy - h // 2) / h, (xx - w // 2) / w
    r = np.hypot(fx, fy)
    tot = F[r > 0].sum()
    bands = [(0, 0.05), (0.05, 0.1), (0.1, 0.2), (0.2, 0.3), (0.3, 0.5), (0.5, 0.8)]
    s = " ".join(f"{lo:.2f}-{hi:.2f}:{F[(r > lo) & (r <= hi)].sum() / tot:.3f}" for lo, hi in bands)
    diag = F[(np.abs(fx) > 0.2) & (np.abs(fy) > 0.2)].sum() / tot
    # 各向异性：按角度 8 个扇区（r > 0.2）的能量
    ang = np.arctan2(fy, fx) % np.pi
    sec = [F[(r > 0.2) & (ang >= k * np.pi / 8) & (ang < (k + 1) * np.pi / 8)].sum() / tot for k in range(8)]
    print(f"{name:10s} {s} diag {diag:.3f} 扇区 " + " ".join(f"{x:.3f}" for x in sec))
R, G = a[..., 0] / 256, a[..., 1] / 256
print("直方图均匀：", np.histogram(R, 8, (0, 1))[0], np.histogram(G, 8, (0, 1))[0])
print("R/G 相关：", np.corrcoef(R.ravel(), G.ravel())[0, 1])
spec(R, "蓝噪声R")
spec(G, "蓝噪声G")
y, x = np.mgrid[0:n, 0:n] + 0.5
ign = np.mod(52.9829189 * np.mod(0.06711056 * x + 0.00583715 * y, 1), 1)
spec(ign, "IGN")
rng = np.random.default_rng(1)
spec(rng.random((n, n)), "白噪声")
for f in range(3):
    spec(np.mod(R + f * 0.61803, 1), f"蓝+φ·{f}")
