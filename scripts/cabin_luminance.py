"""舱内 / 窗外屏幕亮度统计（T23）。

用法：python apps/voyage/scripts/cabin_luminance.py <截图目录> [更多目录...]（每个目录一列版本，名字取目录名）
输入是 cabin-luminance.playwright.js 截的 <场景>.png 与 <场景>-mask.png（白 = 窗外）。
输出每个场景的屏幕亮度（sRGB 亮度 Y = 0.2126R + 0.7152G + 0.0722B，0–255）：
- 舱壁：窗左侧固定区域 x 40–220、y 450–750 里属于舱内（遮罩 < 0.02）的像素的平均值
- 舱内中位数：全部舱内像素的中位数
- 窗外 p50 / p95 / p99：全部窗外像素（遮罩 > 0.98）的分位数
需要 Pillow 与 numpy。
"""

import sys
from pathlib import Path

import numpy as np
from PIL import Image

SCENES = ["noon-cumulus", "sunset-wing", "dusk-earthshadow", "in-cloud", "night-city", "night-city-light"]
WALL = (slice(450, 750), slice(40, 220))  # y, x


def luma(path: Path) -> np.ndarray:
    a = np.asarray(Image.open(path).convert("RGB"), dtype=np.float64)
    return a @ np.array([0.2126, 0.7152, 0.0722])


def stats(d: Path, name: str):
    img, mask_p = d / f"{name}.png", d / f"{name}-mask.png"
    if not img.exists() or not mask_p.exists():
        return None
    y = luma(img)
    m = luma(mask_p) / 255.0
    cabin, out = m < 0.02, m > 0.98
    wall = y[WALL][cabin[WALL]]
    return {
        "wall": wall.mean() if wall.size else float("nan"),
        "cabin50": np.median(y[cabin]) if cabin.any() else float("nan"),
        "out50": np.percentile(y[out], 50) if out.any() else float("nan"),
        "out95": np.percentile(y[out], 95) if out.any() else float("nan"),
        "out99": np.percentile(y[out], 99) if out.any() else float("nan"),
    }


def main():
    if len(sys.argv) < 2:
        sys.exit(__doc__)
    dirs = [Path(p) for p in sys.argv[1:]]
    print("| 场景 | 版本 | 舱壁 Y | 舱内中位 Y | 窗外 p50 | 窗外 p95 | 窗外 p99 |")
    print("| --- | --- | --- | --- | --- | --- | --- |")
    found = {m.name[: -len("-mask.png")] for d in dirs for m in d.glob("*-mask.png")}
    names = [n for n in SCENES if n in found] + sorted(found - set(SCENES))
    for name in names:
        for d in dirs:
            s = stats(d, name)
            if s is None:
                continue
            print(f"| {name} | {d.name} | {s['wall']:.0f} | {s['cabin50']:.0f} | {s['out50']:.0f} | {s['out95']:.0f} | {s['out99']:.0f} |")


if __name__ == "__main__":
    main()
