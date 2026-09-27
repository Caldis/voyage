"""T34：窗上倒影与舱壁的显示亮度对照（sRGB Y 0–255）。

用法：python apps/voyage/handoff/T34-stats.py <目录> [<目录> ...]
目录里是 T34-shots.mjs 输出的 <场景>.png / -mask.png / -refl.png。
- 舱壁：x 40–220、y 450–750 里遮罩 < 0.02 的像素平均 Y（与 T28 / T30 同口径）。
- 倒影：-refl.png（uDebug 31，窗外置黑、只留倒影）里窗内（遮罩 > 0.98）x 900–1220、y 100–1100
  （机翼翼尖右边，避开机翼和窗板边缘的亮边）的像素：均值、p99（面状倒影最亮处；光点只占几百像素，不进 p99）、最大值（光点）。
- 亮带：上述区域逐行均值的最大值（美术总监说的「亮带」）。
- 面状 p99：-surf.png（uDebug 33，不含阅读灯光点）同一区域的 p99。
- 比值：面状倒影 p99 ÷ 舱壁均值（睡眠 / 全关要 ≤ 0.5）。灯本身比墙亮是对的，光点不进这个比值。
"""

import sys
from pathlib import Path

import numpy as np
from PIL import Image

LUMA = np.array([0.2126, 0.7152, 0.0722])


def y(path: Path):
    return np.asarray(Image.open(path).convert("RGB"), dtype=np.float64) @ LUMA


def main():
    dirs = [Path(a) for a in sys.argv[1:]]
    names = sorted({p.stem for p in dirs[0].glob("*.png") if not p.stem.endswith(("-mask", "-refl", "-surf"))})
    print(f"{'场景':<22}{'目录':<8}{'舱壁Y':>7}{'倒影均':>7}{'倒影p99':>8}{'亮带':>7}{'光点max':>8}{'面状p99':>8}{'面/墙':>7}")
    for n in names:
        for d in dirs:
            if not (d / f"{n}-refl.png").exists():
                continue
            img = y(d / f"{n}.png")
            m = y(d / f"{n}-mask.png") / 255.0
            r = y(d / f"{n}-refl.png")
            wall = img[450:750, 40:220][m[450:750, 40:220] < 0.02].mean()
            ys, xs = slice(100, 1100), slice(900, 1220)
            sel = m[ys, xs] > 0.98
            rr = r[ys, xs]
            vals = rr[sel]
            rows = np.array([rr[i][sel[i]].mean() for i in range(rr.shape[0]) if sel[i].sum() > 50])
            p99 = np.percentile(vals, 99)
            sp = d / f"{n}-surf.png"
            sp99 = np.percentile(y(sp)[ys, xs][sel], 99) if sp.exists() else np.nan
            print(f"{n:<22}{d.name:<8}{wall:7.1f}{vals.mean():7.1f}{p99:8.1f}{rows.max():7.1f}{vals.max():8.1f}{sp99:8.1f}{sp99 / wall:7.2f}")


if __name__ == "__main__":
    main()
