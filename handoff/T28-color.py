"""T28：舱壁亮度 + 色相 + 饱和度，窗外区域的改前 / 改后差异。

用法：python apps/voyage/handoff/T28-color.py <改前目录> [<改后目录>]
口径和美术总监 ART_REVIEW_wave3 一致：舱壁取 x 40–220、y 450–750 里属于舱内（遮罩 < 0.02）的像素；
Y = sRGB 亮度（0–255），色相 / 饱和度取平均色的 HSV。
另给出「舱内全体」的平均色（遮罩 < 0.02 的全部像素），以及两目录之间窗外像素（两边遮罩都 > 0.98）的平均绝对差（0–255）。
"""

import colorsys
import json
import sys
from pathlib import Path

import numpy as np
from PIL import Image

WALL = (slice(450, 750), slice(40, 220))
LUMA = np.array([0.2126, 0.7152, 0.0722])


def load(d: Path, name: str):
    img = np.asarray(Image.open(d / f"{name}.png").convert("RGB"), dtype=np.float64)
    m = np.asarray(Image.open(d / f"{name}-mask.png").convert("RGB"), dtype=np.float64) @ LUMA / 255.0
    return img, m


def hsv(rgb):
    h, s, v = colorsys.rgb_to_hsv(*(rgb / 255.0))
    return h * 360.0, s


def describe(img, m):
    cabin = m < 0.02
    w = img[WALL][cabin[WALL]]
    wall = w.mean(axis=0) if w.size else np.full(3, np.nan)
    allc = img[cabin].mean(axis=0) if cabin.any() else np.full(3, np.nan)
    return wall, allc


def fmt(rgb):
    h, s = hsv(rgb)
    return f"{rgb @ LUMA:.0f} | ({rgb[0]:.0f},{rgb[1]:.0f},{rgb[2]:.0f}) | {h:.0f}° / {s:.2f}"


def main():
    dirs = [Path(p) for p in sys.argv[1:]]
    if not dirs:
        sys.exit(__doc__)
    names = sorted({p.name[: -len("-mask.png")] for p in dirs[0].glob("*-mask.png")})
    print("| 场景 | 版本 | 舱壁 Y | 舱壁色 | 色相 / 饱和度 | 舱内全体 Y | 舱内全体色 | 色相 / 饱和度 | 窗外差 | 帧 ms |")
    print("| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |")
    for n in names:
        base = None
        for d in dirs:
            if not (d / f"{n}-mask.png").exists():
                continue
            img, m = load(d, n)
            wall, allc = describe(img, m)
            diff = ""
            if base is None:
                base = (img, m)
            else:
                win = (m > 0.98) & (base[1] > 0.98)
                if win.any():
                    diff = f"{np.abs(img[win] - base[0][win]).mean():.2f}"
            ms = ""
            j = d / f"{n}.json"
            if j.exists():
                ms = f"{json.loads(j.read_text())['frameMs']:.2f}"
            print(f"| {n} | {d.name} | {fmt(wall)} | {fmt(allc)} | {diff} | {ms} |")


if __name__ == "__main__":
    main()
