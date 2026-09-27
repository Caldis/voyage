"""国土地理院 标高瓦片（PNG 编码）取样。

优先级：DEM5A（激光测量，5 m）→ DEM5B（摄影测量，5 m）→ DEM5C → DEM10B（10 m，z14）。
PNG 编码：x = R·2^16 + G·2^8 + B；x < 2^23 → h = 0.01·x；x = 2^23 → 无数据；x > 2^23 → h = 0.01·(x − 2^24)。
出处：https://maps.gsi.go.jp/development/demtile.html
瓦片缓存在 <cache>/gsi/，只请求一次；请求头只带通用 UA。
加工声明（利用规约要求）：「地理院タイル（標高タイル）を加工して作成」。
"""
from __future__ import annotations

import io
import math
import time
import urllib.error
import urllib.request

import numpy as np
from PIL import Image

from common import USER_AGENT, cache_dir

LAYERS = [("dem5a_png", 15), ("dem5b_png", 15), ("dem5c_png", 15), ("dem10b_png", 14)]
BASE = "https://cyberjapandata.gsi.go.jp/xyz/{layer}/{z}/{x}/{y}.png"


class GsiDem:
    def __init__(self):
        self.tiles: dict[tuple, np.ndarray | None] = {}
        self.fetched = 0
        self.missing = 0
        self.hits = {name: 0 for name, _ in LAYERS}
        self.nodata = 0

    def _tile(self, layer: str, z: int, x: int, y: int):
        key = (layer, z, x, y)
        if key in self.tiles:
            return self.tiles[key]
        d = cache_dir() / "gsi" / layer / str(z) / str(x)
        d.mkdir(parents=True, exist_ok=True)
        f = d / f"{y}.png"
        miss = d / f"{y}.none"
        arr = None
        if f.exists():
            data = f.read_bytes()
        elif miss.exists():
            data = None
        else:
            url = BASE.format(layer=layer, z=z, x=x, y=y)
            data = None
            for attempt in range(4):
                try:
                    req = urllib.request.Request(url, headers={"User-Agent": USER_AGENT})
                    with urllib.request.urlopen(req, timeout=30) as r:
                        data = r.read()
                    f.write_bytes(data)
                    self.fetched += 1
                    break
                except urllib.error.HTTPError as e:
                    if e.code == 404:
                        miss.write_text("")
                        self.missing += 1
                        break
                    time.sleep(1.5 * (attempt + 1))
                except (urllib.error.URLError, TimeoutError, ConnectionError):
                    time.sleep(1.5 * (attempt + 1))
            else:
                raise RuntimeError(f"取不到 {url}")
            time.sleep(0.05)  # 对服务器客气一点
        if data is not None:
            rgb = np.asarray(Image.open(io.BytesIO(data)).convert("RGB"), dtype=np.int64)
            v = (rgb[..., 0] << 16) | (rgb[..., 1] << 8) | rgb[..., 2]
            h = np.where(v < (1 << 23), v * 0.01, (v - (1 << 24)) * 0.01).astype(np.float64)
            h[v == (1 << 23)] = np.nan
            arr = h
        self.tiles[key] = arr
        return arr

    def _px(self, layer: str, z: int, gx: int, gy: int) -> float:
        t = self._tile(layer, z, gx >> 8, gy >> 8)
        if t is None:
            return math.nan
        return float(t[gy & 255, gx & 255])

    def _bilinear(self, layer: str, z: int, lat: float, lon: float) -> float:
        n = 256 * (1 << z)
        fx = (lon + 180.0) / 360.0 * n - 0.5
        s = math.sin(math.radians(lat))
        fy = (0.5 - math.log((1 + s) / (1 - s)) / (4 * math.pi)) * n - 0.5
        x0, y0 = math.floor(fx), math.floor(fy)
        tx, ty = fx - x0, fy - y0
        v00 = self._px(layer, z, x0, y0)
        v10 = self._px(layer, z, x0 + 1, y0)
        v01 = self._px(layer, z, x0, y0 + 1)
        v11 = self._px(layer, z, x0 + 1, y0 + 1)
        vals = [(v00, (1 - tx) * (1 - ty)), (v10, tx * (1 - ty)), (v01, (1 - tx) * ty), (v11, tx * ty)]
        good = [(v, w) for v, w in vals if not math.isnan(v)]
        wsum = sum(w for _, w in good)
        # 四个像素里缺一两个（数据边缘）时按剩余权重归一；全缺才算无数据
        if len(good) < 3 or wsum < 1e-6:
            return math.nan
        return sum(v * w for v, w in good) / wsum

    def sample(self, lat: float, lon: float) -> float:
        for layer, z in LAYERS:
            h = self._bilinear(layer, z, lat, lon)
            if not math.isnan(h):
                self.hits[layer] += 1
                return h
        self.nodata += 1
        return math.nan
