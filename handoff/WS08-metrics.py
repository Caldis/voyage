"""WS08 尺度指标：同机位「开 / 关天环」两张图相减得掩码，量面积（M2）、是否出画（M7）、横向跨度。
用法：python WS08-metrics.py on.png off.png [阈值=3]
窗口区域按「关」图里非舱壁的像素估（舷窗约 840 × 1150 px）；1600×1200、垂直视场 50° 时 22.5 px/°。"""
import sys
import numpy as np
from PIL import Image

a = np.asarray(Image.open(sys.argv[1]).convert("RGB")).astype(np.int16)
b = np.asarray(Image.open(sys.argv[2]).convert("RGB")).astype(np.int16)
thr = int(sys.argv[3]) if len(sys.argv) > 3 else 3
m = np.abs(a - b).max(2) > thr
H, W = m.shape
ys, xs = np.nonzero(m)
win = 840 * 1150
print(f"{sys.argv[1]}: 掩码像素 {m.sum()}，占舷窗 {100 * m.sum() / win:.1f}%")
if len(xs):
    print(f"  横向 x {xs.min()}–{xs.max()}（{(xs.max() - xs.min()) / 22.5:.0f}°），纵向 y {ys.min()}–{ys.max()}（{(ys.max() - ys.min()) / 22.5:.0f}°）")
    # 出画：掩码碰到舷窗的左右边（x < 420 或 > 1180）或上沿（y < 60）
    print(f"  出画：左 {bool((xs < 420).any())}、右 {bool((xs > 1180).any())}、上 {bool((ys < 60).any())}")
    # 每列的覆盖宽度（带的粗细，像素）
    cols = [int(m[:, x].sum()) for x in range(xs.min(), xs.max() + 1, 40)]
    print("  每 40 列的竖向覆盖像素：", cols)
