"""T08：两张截图的差异统计（白天场景应当不受道路灯带影响）。
用法：python T08-diff.py a.png b.png
输出：平均绝对差、差 > 8 的像素占比、A 比 B 亮 / B 比 A 亮的像素各占多少（单向成片 = 系统性变化，双向稀疏 = 噪声）。
"""
import sys
import numpy as np
from PIL import Image

a = np.asarray(Image.open(sys.argv[1]).convert("RGB"), dtype=np.float64)
b = np.asarray(Image.open(sys.argv[2]).convert("RGB"), dtype=np.float64)
d = (b - a).mean(axis=2)
print(f"平均绝对差 {np.abs(d).mean():.3f}；|差|>8 占 {(np.abs(d) > 8).mean() * 100:.3f}%；B 更亮 {(d > 8).mean() * 100:.3f}% / A 更亮 {(d < -8).mean() * 100:.3f}%")
