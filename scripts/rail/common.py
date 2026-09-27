"""火车线路烘焙的公共配置：线路定义、路径、坐标换算。

坐标约定（前端照此解读）：
- 水平坐标是以原点为切点的局部 ENU 平面（WGS84 椭球 → ECEF → 东 / 北分量），单位米；
  x 向东、y 向北。35 km 范围内与真实地面距离的偏差 < 0.5 m。
- 高程是国土地理院 DEM 的标高（相对东京湾平均海面的正高），单位米，不是 ENU 的 up 分量。
"""
from __future__ import annotations

import math
import os
from pathlib import Path

HERE = Path(__file__).resolve().parent
VOYAGE = HERE.parent.parent
# 缓存目录可以用环境变量指到仓库外（原始包 500 MB，worktree 删掉后还能复用）
CACHE = Path(os.environ.get("VOYAGE_RAIL_CACHE", HERE / "cache"))
OUT_DIR = VOYAGE / "public" / "data" / "rail"

# Geofabrik 中部地区包；文件名带日期，便于在报告里写明数据时点
GEOFABRIK_URL = "https://download.geofabrik.de/asia/japan/chubu-latest.osm.pbf"
# 外部请求只带通用 UA，不放任何个人信息（仓库规矩）
USER_AGENT = "voyage-rail-bake/1.0 (+offline data bake; OSM/GSI)"

LINE = {
    "id": "oito-matsumoto-shinanoomachi",
    "name": "JR 大糸線 松本—信濃大町",
    "lineNames": ["大糸線"],
    "from": "松本",
    "to": "信濃大町",
    # 取数范围（比走廊外扩约 3 km），只用来粗筛，走廊裁剪按到中心线的距离做
    "bbox": {"s": 36.19, "n": 36.54, "w": 137.80, "e": 138.02},
    # 走廊两侧要素的保留距离（米）
    "buffer_m": 1500.0,
    # 营运里程（官方营业キロ，用来和 OSM 量出的里程对照；出处见烘焙报告）
    # 出处：Wikipedia「大糸線」駅一覧（JR 東日本の営業キロ）
    "stations_km": [
        ("松本", 0.0), ("北松本", 0.7), ("島内", 2.6), ("島高松", 3.8), ("梓橋", 5.2),
        ("一日市場", 6.8), ("中萱", 8.4), ("南豊科", 10.4), ("豊科", 11.4), ("柏矢町", 14.2),
        ("穂高", 16.2), ("有明", 18.4), ("安曇追分", 19.9), ("細野", 22.8), ("北細野", 23.8),
        ("信濃松川", 26.0), ("安曇沓掛", 28.6), ("信濃常盤", 30.9), ("南大町", 34.0), ("信濃大町", 35.1),
    ],
}


def cache_dir() -> Path:
    CACHE.mkdir(parents=True, exist_ok=True)
    return CACHE


# ---------- WGS84 → 局部 ENU ----------
_A = 6378137.0
_F = 1 / 298.257223563
_E2 = _F * (2 - _F)


def _ecef(lat: float, lon: float, h: float = 0.0):
    la, lo = math.radians(lat), math.radians(lon)
    n = _A / math.sqrt(1 - _E2 * math.sin(la) ** 2)
    return ((n + h) * math.cos(la) * math.cos(lo), (n + h) * math.cos(la) * math.sin(lo), (n * (1 - _E2) + h) * math.sin(la))


class ENU:
    """以 (lat0, lon0) 为切点的局部 ENU 平面投影（只取东、北分量）。"""

    def __init__(self, lat0: float, lon0: float):
        self.lat0, self.lon0 = lat0, lon0
        self.o = _ecef(lat0, lon0)
        la, lo = math.radians(lat0), math.radians(lon0)
        self.e = (-math.sin(lo), math.cos(lo), 0.0)
        self.n = (-math.sin(la) * math.cos(lo), -math.sin(la) * math.sin(lo), math.cos(la))

    def fwd(self, lat: float, lon: float):
        p = _ecef(lat, lon)
        d = (p[0] - self.o[0], p[1] - self.o[1], p[2] - self.o[2])
        return (d[0] * self.e[0] + d[1] * self.e[1] + d[2] * self.e[2], d[0] * self.n[0] + d[1] * self.n[1] + d[2] * self.n[2])

    def fwd_np(self, lon, lat):
        """向量化版本：lon / lat 是 numpy 数组，返回 (x, y) 两个数组。"""
        import numpy as np
        la, lo = np.radians(lat), np.radians(lon)
        n = _A / np.sqrt(1 - _E2 * np.sin(la) ** 2)
        px = n * np.cos(la) * np.cos(lo) - self.o[0]
        py = n * np.cos(la) * np.sin(lo) - self.o[1]
        pz = n * (1 - _E2) * np.sin(la) - self.o[2]
        return (px * self.e[0] + py * self.e[1] + pz * self.e[2], px * self.n[0] + py * self.n[1] + pz * self.n[2])

    def inv(self, x: float, y: float):
        """近似反算（迭代两次，35 km 内误差 < 1 mm），只用于 DEM 取样。"""
        # 初值：球面近似
        lat = self.lat0 + math.degrees(y / 6371000.0)
        lon = self.lon0 + math.degrees(x / (6371000.0 * math.cos(math.radians(self.lat0))))
        for _ in range(4):
            fx, fy = self.fwd(lat, lon)
            lat += math.degrees((y - fy) / 6371000.0)
            lon += math.degrees((x - fx) / (6371000.0 * math.cos(math.radians(lat))))
        return lat, lon
