"""把 NASA SVS「Deep Star Maps 2020」的银河背景图转成紧凑的 8 位灰度 JPEG，给夜空渲染用（T09）。

数据源：NASA/Goddard Space Flight Center Scientific Visualization Studio, Deep Star Maps 2020（ID 4851），
    https://svs.gsfc.nasa.gov/4851/
    文件 milkyway_2020_4k.exr（4096×2048，OpenEXR 半精度，线性，ICRF/J2000 赤道坐标的等距柱状投影，
    中央是赤经 0h，赤经向左增大）。页面说明：「a version of the star map that omits the bright (Hipparcos and
    Tycho) stars」——只含 Gaia DR2（空洞用 UCAC3 补）里比约 11.5 等更暗的星，所以和我们用 BSC5（≤ 6.5 等）
    画的点星不会重复成「双重星」。
    署名（SVS 要求）：NASA/Goddard Space Flight Center Scientific Visualization Studio. Gaia DR2: ESA/Gaia/DPAC.
    许可：NASA SVS 的作品按 NASA 媒体使用规定可自由使用（需署名，不得暗示 NASA 背书）；
    其中的 Gaia DR2 数据按 ESA/Gaia/DPAC 的 CC BY-SA 3.0 IGO 署名。见 README「数据来源」。

输出 public/data/milkyway_4k.jpg：4096×2048 单通道 8 位 JPEG（质量 90，约 3 MB；无损 PNG 要 6.2 MB，星点噪声压不下去），
    列 x ↔ 赤经 (x + 0.5) / 4096 × 360°（向右增大，和 sky-assets.ts 的点星图一致），
    行 y ↔ 赤纬 90° − (y + 0.5) / 2048 × 180°（上北下南）；
    值 = 对数编码的亮度：code 0 表示「比 10^LOG_MIN 还暗，按 0」，1..255 线性覆盖 log10(亮度) ∈ [LOG_MIN, 0]。
    亮度是原图的相对单位（R/G/B 按 Rec.709 加权），绝对定标在 sky-assets.ts（MILKY_WAY_UNIT）。

用法（需要 numpy、pillow、OpenEXR，Python 3.12；原图约 35 MB，下到 tmp/ 缓存）：
    uv run --python 3.12 --with numpy --with pillow --with openexr python apps/voyage/scripts/build_milkyway.py
"""
import pathlib
import time
import urllib.request

import numpy as np
import OpenEXR
from PIL import Image

URL = "https://svs.gsfc.nasa.gov/vis/a000000/a004800/a004851/milkyway_2020_4k.exr"
ROOT = pathlib.Path(__file__).resolve().parent.parent
CACHE = ROOT.parent.parent / "tmp" / "milkyway" / "milkyway_2020_4k.exr"
OUT = ROOT / "public" / "data" / "milkyway_4k.jpg"
LOG_MIN = -3.5  # 银极处 Gaia 暗星的积分光约 10^-2.4，再往下对画面没有贡献（远低于夜天光）


def fetch() -> None:
    if CACHE.exists():
        return
    CACHE.parent.mkdir(parents=True, exist_ok=True)
    # 请求头里不带任何个人信息；svs.gsfc.nasa.gov 的 TLS 握手偶尔失败，重试几次
    for attempt in range(10):
        try:
            req = urllib.request.Request(URL, headers={"User-Agent": "voyage-milkyway-build"})
            with urllib.request.urlopen(req, timeout=600) as resp:
                CACHE.write_bytes(resp.read())
            return
        except OSError as e:
            print("重试", attempt, e)
            time.sleep(3)
    raise SystemExit("下载失败")


def main() -> None:
    fetch()
    with OpenEXR.File(str(CACHE)) as f:
        rgb = f.channels()["RGB"].pixels.astype(np.float32)
    h, w = rgb.shape[:2]
    lum = rgb[..., 0] * 0.2126 + rgb[..., 1] * 0.7152 + rgb[..., 2] * 0.0722
    # SVS 的列 x_svs ↔ 赤经 180° − (x_svs + 0.5)/W·360°；换成「赤经向右增大、第 0 列从 0h 开始」是整列的翻转 + 平移，不重采样
    cols = (w // 2 - 1 - np.arange(w)) % w
    lum = lum[:, cols]
    code = np.zeros(lum.shape, np.uint8)
    pos = lum > 10**LOG_MIN
    code[pos] = np.clip(np.round(1 + 254 * (np.log10(lum[pos]) - LOG_MIN) / -LOG_MIN), 1, 255).astype(np.uint8)
    Image.fromarray(code, "L").save(OUT, quality=90, optimize=True)
    # 整体色（亮的银河区域按亮度加权），sky-assets.ts 的 MILKY_WAY_TINT 用它
    m = lum > 0.05
    tint = (rgb[:, cols][m] * lum[m][:, None]).sum(0) / lum[m].sum()
    tint /= tint @ np.array([0.2126, 0.7152, 0.0722])
    print(f"写出 {OUT}（{OUT.stat().st_size / 1e6:.2f} MB），{w}×{h}；亮区平均色（按亮度归一）{np.round(tint, 3)}")
    print(f"被截到 1.0 的像素比例 {np.mean(lum >= 0.999):.2e}；低于下限按 0 的比例 {1 - pos.mean():.3f}")


if __name__ == "__main__":
    main()
