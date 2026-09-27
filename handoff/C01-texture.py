# 区域的「相邻像素差」（棋盘纹 / 高频噪点）与 RGB 均值（色偏）——luma 均值量不出来的两类回归（C01 返工，审查建议）
#   adj：Rec.709 luma（0–255）上 |I(x+1) − I(x)| 与 |I(y+1) − I(y)| 的均值；rgb：R / G / B 均值；b−r：B − R
# 用法：python C01-texture.py x,y,w,h 图1 [图2 ...]
import sys
import numpy as np
from PIL import Image
sys.stdout.reconfigure(encoding="utf-8")
x, y, w, h = (int(v) for v in sys.argv[1].split(","))
for p in sys.argv[2:]:
    a = np.asarray(Image.open(p).convert("RGB"), dtype=np.float64)[y:y + h, x:x + w]
    L = a @ np.array([0.2126, 0.7152, 0.0722])
    adj = 0.5 * (np.abs(np.diff(L, axis=1)).mean() + np.abs(np.diff(L, axis=0)).mean())
    m = a.reshape(-1, 3).mean(axis=0)
    print(f"{p.replace(chr(92), '/').split('/')[-2]}/{p.replace(chr(92), '/').split('/')[-1]}  luma {L.mean():.1f}  adj {adj:.2f}  rgb {m[0]:.0f}/{m[1]:.0f}/{m[2]:.0f}  b-r {m[2] - m[0]:+.1f}")
