import sys
sys.stdout.reconfigure(encoding="utf-8")
from PIL import Image
import numpy as np
# 用法：hf.py x,y,w,h a.png b.png ...  —— 实时单帧：相邻像素差、高通能量（L − 3×3 均值）、对角 / 棋盘频段能量
x, y, w, h = [int(v) for v in sys.argv[1].split(",")]
for f in sys.argv[2:]:
    L = np.asarray(Image.open(f).convert("RGB").crop((x, y, x + w, y + h))).astype(np.float64) @ [0.2126, 0.7152, 0.0722]
    adj = (np.abs(np.diff(L, axis=1)).mean() + np.abs(np.diff(L, axis=0)).mean()) / 2
    k = sum(np.roll(np.roll(L, i, 0), j, 1) for i in (-1, 0, 1) for j in (-1, 0, 1)) / 9
    hp = (L - k)[2:-2, 2:-2]
    F = np.abs(np.fft.fftshift(np.fft.fft2(L - L.mean()))) ** 2
    cy, cx = h // 2, w // 2
    yy, xx = np.mgrid[0:h, 0:w]
    fy, fx = (yy - cy) / h, (xx - cx) / w
    r = np.hypot(fx, fy)
    hi = F[r > 0.3].sum() / F[r > 0.02].sum()
    diagb = F[(np.abs(fx) > 0.2) & (np.abs(fy) > 0.2)].sum() / F[r > 0.02].sum()
    print(f"{f}: 亮度 {L.mean():.2f} adj {adj:.3f} 高通RMS {hp.std():.3f} 高频(>0.3)占比 {hi:.4f} 对角高频占比 {diagb:.4f}")
