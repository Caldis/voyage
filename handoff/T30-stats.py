"""T30：窗上倒影与舱壁的屏幕亮度对照。

用法：python apps/voyage/handoff/T30-stats.py <目录> [<目录> ...]
目录里是 T28-shots.mjs 输出的 <场景>.png / <场景>-mask.png。
- 舱壁：x 40–220、y 450–750 里遮罩 < 0.02 的像素（与 T28-color.py 同口径），平均 sRGB 亮度 Y（0–255）。
- 窗上半（倒影区）：x 900–1250、y 150–450 里遮罩 > 0.98 的像素（机翼右边，夜里只有倒影 + 夜空），平均 Y 和 95 分位。
- 窗下半暗处：x 360–1250、y 560–760 里遮罩 > 0.98 的像素的 20 分位（地面暗处被倒影抬起多少 = 「纱」）。
- 城市灯光：x 400–1250、y 850–1100 窗内像素的 99.5 分位与平均（灯光是否仍清楚）。
- 窗内平均色度：窗内全体像素的平均 RGB 归一（看是否偏褐）。
"""

import sys
from pathlib import Path

import numpy as np
from PIL import Image

LUMA = np.array([0.2126, 0.7152, 0.0722])


def load(d: Path, name: str):
    img = np.asarray(Image.open(d / f"{name}.png").convert("RGB"), dtype=np.float64)
    m = np.asarray(Image.open(d / f"{name}-mask.png").convert("RGB"), dtype=np.float64) @ LUMA / 255.0
    return img, m


def region(img, m, ys, xs, win):
    sub = img[ys, xs]
    mm = m[ys, xs]
    sel = mm > 0.98 if win else mm < 0.02
    return sub[sel]


def main():
    dirs = [Path(a) for a in sys.argv[1:]]
    names = sorted({p.stem for p in dirs[0].glob("*.png") if not p.stem.endswith("-mask")})
    print(f"{'场景':<20}{'目录':<10}{'舱壁Y':>7}{'上半Y':>7}{'上半p95':>8}{'下半p20':>8}{'灯p99.5':>8}{'灯均':>6}  窗内色(r:g:b)")
    for n in names:
        for d in dirs:
            if not (d / f"{n}.png").exists():
                continue
            img, m = load(d, n)
            wall = region(img, m, slice(450, 750), slice(40, 220), False) @ LUMA
            up = region(img, m, slice(150, 450), slice(900, 1250), True) @ LUMA
            lo = region(img, m, slice(560, 760), slice(360, 1250), True) @ LUMA
            city = region(img, m, slice(850, 1100), slice(400, 1250), True) @ LUMA
            win = img[m > 0.98].mean(axis=0)
            c = win / max(win.sum(), 1e-6) * 3
            f = lambda a, q=None: (np.nan if a.size == 0 else (a.mean() if q is None else np.percentile(a, q)))
            print(f"{n:<20}{d.name:<10}{f(wall):7.1f}{f(up):7.1f}{f(up, 95):8.1f}{f(lo, 20):8.1f}{f(city, 99.5):8.1f}{f(city):6.1f}  {c[0]:.2f}:{c[1]:.2f}:{c[2]:.2f}")


if __name__ == "__main__":
    main()
