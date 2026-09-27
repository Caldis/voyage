# TM01 返工验收（口径同审查的 tmp/screenshot/tm01-review/tm01_band.py、tm01_sun.py）：
#   按参考变体的显示亮度分段，比较各变体的高频细节（像素 − σ=2 高斯低通 的 std）；显示 215–235 的像素占窗比例
#   只统计参考变体云缓冲不透明度 > 0.5 的像素（有 .bin 时）
#   --sun x,y：以太阳为圆心 200 px 内 ≥200 / ≥215 / ≥235 的面积
# 用法：python TM01-band.py <根目录> <参考变体> <变体,...> <场景,...> [--sun 场景:x,y]
import sys
import numpy as np
from PIL import Image
sys.stdout.reconfigure(encoding="utf-8")
X, Y, W, H = 420, 120, 760, 1000
W709 = np.array([0.2126, 0.7152, 0.0722])

def gauss(a, s):
    r = int(3 * s); k = np.exp(-0.5 * (np.arange(-r, r + 1) / s) ** 2); k /= k.sum()
    p = np.pad(a, r, mode="edge")
    p = np.apply_along_axis(lambda v: np.convolve(v, k, "valid"), 0, p)
    return np.apply_along_axis(lambda v: np.convolve(v, k, "valid"), 1, p)

def full(p):
    return np.asarray(Image.open(p).convert("RGB"), float) @ W709

args = sys.argv[1:]
sun = {}
if "--sun" in args:
    i = args.index("--sun"); s, xy = args[i + 1].split(":"); sun[s] = tuple(int(v) for v in xy.split(",")); args = args[:i] + args[i + 2:]
root, ref, names, scenes = args[0], args[1], args[2].split(","), args[3].split(",")
BANDS = [(120, 160), (160, 200), (200, 215), (215, 230), (230, 256)]
for s in scenes:
    R = full(f"{root}/{s}/{ref}.png")
    b = R[Y:Y + H, X:X + W]; hb = b - gauss(b, 2)
    # 只统计窗外的云（参考变体云缓冲不透明度 > 0.5）：窗框 / 内衬等舱内像素不归本任务管，两次渲染之间还有自身的噪声
    try:
        O = (1.0 - np.fromfile(f"{root}/{s}/{ref}.bin", dtype=np.float32).reshape(1200, 1600, 4)[::-1][:, :, 3])[Y:Y + H, X:X + W]
        cm = O > 0.5
    except FileNotFoundError:
        cm = np.ones_like(b, bool)
    print(f"\n## {s}\n| 变体 | " + " | ".join(f"{lo}–{hi} ×" for lo, hi in BANDS) + " | 215–235 占窗 |" + (" 太阳 ≥200 / ≥215 / ≥235 px |" if s in sun else ""))
    print("| --- |" + " ---: |" * len(BANDS) + " ---: |" + (" --- |" if s in sun else ""))
    for nm in names:
        F = full(f"{root}/{s}/{nm}.png")
        f = F[Y:Y + H, X:X + W]; hf = f - gauss(f, 2)
        cells = []
        for lo, hi in BANDS:
            m = (b >= lo) & (b < hi) & cm
            cells.append(f"{hf[m].std() / max(hb[m].std(), 1e-9):.2f}" if m.sum() >= 500 else "—")
        row = f"| {nm} | " + " | ".join(cells) + f" | {((f >= 215) & (f < 235)).mean() * 100:.1f}% |"
        if s in sun:
            cx, cy = sun[s]
            yy, xx = np.mgrid[0:F.shape[0], 0:F.shape[1]]
            m = np.hypot(xx - cx, yy - cy) < 200
            row += " " + " / ".join(str(int((F[m] >= t).sum())) for t in (200, 215, 235)) + " |"
        print(row)
