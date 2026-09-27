"""第 2 步：把 extract_osm.py 的中间 JSON + 国土地理院 DEM 烘焙成前端直接加载的走廊数据。

输出（入库，前端 fetch）：
  public/data/rail/<line>.json   元数据：坐标约定、数组索引表、车站 / 道口 / 桥隧区间 / 跨线桥、标签覆盖率统计
  public/data/rail/<line>.bin    小端二进制，按 json.arrays 里的 offset / length / type 切成 TypedArray
格式说明见 json.format 字段与 research/RAIL_BAKE_REPORT.md。

用法：
  scripts/rail/.venv/Scripts/python scripts/rail/bake.py
依赖：osmium（只在 extract 用）、shapely、numpy、pillow；DEM 瓦片首次运行时下载到缓存。
数据 © OpenStreetMap contributors（ODbL 1.0）；地理院タイル（標高タイル）を加工して作成。
"""
from __future__ import annotations

import heapq
import json
import math
import random
import re
import sys
import time
from collections import Counter, defaultdict

import numpy as np
from shapely import STRtree
from shapely.geometry import LineString, MultiLineString, MultiPolygon, Point, Polygon
from shapely.prepared import prep
from shapely.validation import make_valid

from common import ENU, LINE, OUT_DIR, cache_dir
from dem import GsiDem

STEP = 2.0            # 中心线采样间距（米）
GRID_DS = 10.0        # 走廊高程网格：沿线间距
GRID_DD = 10.0        # 走廊高程网格：横向间距
GRID_HALF = 500.0     # 走廊高程网格：左右各多宽
MAST_SPAN_MAX = 50.0  # 接触网径间上限（JRTT「電車線」：约 50 m）
MAST_STAGGER = 0.2    # 弯道径间估算用的「弦中点偏移」上限（米，估）
SEED = 20260927

FLAG = {"bridge": 1, "tunnel": 2, "embankment": 4, "cutting": 8, "platform": 16, "level_crossing": 32,
        "electrified": 64, "multi_track": 128, "route_member": 256}


# ---------------------------------------------------------------- 工具
class Blob:
    """把若干 TypedArray 顺序写进一个二进制，记录索引。"""

    def __init__(self):
        self.parts: list[bytes] = []
        self.size = 0
        self.index: dict[str, dict] = {}

    def add(self, name: str, arr: np.ndarray, desc: str):
        dt = {np.dtype("float32"): "f32", np.dtype("uint32"): "u32", np.dtype("int32"): "i32",
              np.dtype("uint16"): "u16", np.dtype("int16"): "i16", np.dtype("uint8"): "u8", np.dtype("int8"): "i8"}[arr.dtype]
        pad = (-self.size) % 8
        if pad:
            self.parts.append(b"\0" * pad)
            self.size += pad
        b = np.ascontiguousarray(arr).astype(arr.dtype.newbyteorder("<"), copy=False).tobytes()
        self.index[name] = {"type": dt, "offset": self.size, "length": int(arr.size), "desc": desc}
        self.parts.append(b)
        self.size += len(b)

    def bytes(self) -> bytes:
        return b"".join(self.parts)


def num(v, default=None):
    if v is None:
        return default
    m = re.match(r"^\s*(-?\d+(?:\.\d+)?)", str(v))
    return float(m.group(1)) if m else default


def smooth(a: np.ndarray, sigma_samples: float) -> np.ndarray:
    r = int(math.ceil(sigma_samples * 3))
    k = np.exp(-0.5 * (np.arange(-r, r + 1) / sigma_samples) ** 2)
    k /= k.sum()
    p = np.pad(a, r, mode="edge")
    return np.convolve(p, k, mode="valid")


def iter_polys(g):
    if g.is_empty:
        return
    if isinstance(g, Polygon):
        yield g
    elif isinstance(g, MultiPolygon):
        yield from g.geoms
    elif hasattr(g, "geoms"):
        for h in g.geoms:
            yield from iter_polys(h)


def iter_lines(g):
    if g.is_empty:
        return
    if isinstance(g, LineString):
        yield g
    elif isinstance(g, MultiLineString):
        yield from g.geoms
    elif hasattr(g, "geoms"):
        for h in g.geoms:
            yield from iter_lines(h)


# ---------------------------------------------------------------- 主流程
def main():
    t0 = time.time()
    osm = json.loads((cache_dir() / f"{LINE['id']}_osm.json").read_text(encoding="utf-8"))
    names = LINE["lineNames"]
    report: dict = {"missing": [], "notes": []}

    # ---------- 车站（节点）
    want = [n for n, _ in LINE["stations_km"]]
    st_cands = defaultdict(list)
    for p in osm["points"]:
        t = p["tags"]
        if t.get("railway") in ("station", "halt") or t.get("public_transport") == "station":
            nm = t.get("name", "")
            nm2 = nm[:-1] if nm.endswith("駅") else nm
            if nm2 in want:
                st_cands[nm2].append(p)
    for nm in want:
        if nm not in st_cands:
            report["missing"].append(f"车站「{nm}」在 OSM 里没有 railway=station/halt 节点")

    # 原点：松本站（取 railway=station 的节点；有多个时先取 JR 的）
    def pick(cands):
        cands = sorted(cands, key=lambda p: (p["tags"].get("railway") not in ("station", "halt"),
                                             "JR" not in (p["tags"].get("operator", "") + p["tags"].get("network", ""))))
        return cands[0]

    origin = pick(st_cands[LINE["from"]])
    enu = ENU(origin["lat"], origin["lon"])

    # ---------- 铁路图
    rails = [r for r in osm["rails"] if r["tags"].get("railway") == "rail"]
    route_ways = set()
    for rel in osm["routes"]:
        for m in rel["members"]:
            if m["type"] == "w":
                route_ways.add(m["ref"])
    report["routeRelations"] = [{"id": r["id"], "name": r["tags"].get("name"), "route": r["tags"].get("route"),
                                 "ways": sum(1 for m in r["members"] if m["type"] == "w")} for r in osm["routes"]]

    node_xy: dict[int, tuple] = {}
    adj: dict[int, list] = defaultdict(list)
    way_by_id = {}
    for w in rails:
        way_by_id[w["id"]] = w
        xs, ys = enu.fwd_np(np.array([c[0] for c in w["coords"]]), np.array([c[1] for c in w["coords"]]))
        t = w["tags"]
        name = t.get("name", "")
        pen = 1.0
        if t.get("service") in ("siding", "crossover"):
            pen = 3.0
        elif t.get("service") in ("yard", "spur"):
            pen = 10.0
        if route_ways:
            pen *= 1.0 if w["id"] in route_ways else 2.0
        elif name and not any(n in name for n in names):
            pen *= 3.0
        for i, nid in enumerate(w["nodes"]):
            node_xy[nid] = (float(xs[i]), float(ys[i]))
        for i in range(len(w["nodes"]) - 1):
            a, b = w["nodes"][i], w["nodes"][i + 1]
            L = math.hypot(xs[i + 1] - xs[i], ys[i + 1] - ys[i])
            adj[a].append((b, L * pen, w["id"]))
            adj[b].append((a, L * pen, w["id"]))

    def nearest_node(p):
        x, y = enu.fwd(p["lat"], p["lon"])
        named = {nid for w in rails if any(n in w["tags"].get("name", "") for n in names) or w["id"] in route_ways
                 for nid in w["nodes"]}
        pool = named or node_xy.keys()
        return min(pool, key=lambda n: (node_xy[n][0] - x) ** 2 + (node_xy[n][1] - y) ** 2)

    dest = pick(st_cands[LINE["to"]])
    a, b = nearest_node(origin), nearest_node(dest)
    dist = {a: 0.0}
    prev: dict[int, tuple] = {}
    pq = [(0.0, a)]
    while pq:
        d, u = heapq.heappop(pq)
        if u == b:
            break
        if d > dist.get(u, 1e18):
            continue
        for v, w, wid in adj[u]:
            nd = d + w
            if nd < dist.get(v, 1e18):
                dist[v] = nd
                prev[v] = (u, wid)
                heapq.heappush(pq, (nd, v))
    if b not in prev:
        raise SystemExit("✗ 松本到信濃大町之间的铁路图不连通，检查 OSM 数据")
    path_nodes, path_ways = [b], []
    while path_nodes[-1] != a:
        u, wid = prev[path_nodes[-1]]
        path_nodes.append(u)
        path_ways.append(wid)
    path_nodes.reverse()
    path_ways.reverse()
    P = np.array([node_xy[n] for n in path_nodes])
    seg = np.hypot(np.diff(P[:, 0]), np.diff(P[:, 1]))
    cum = np.concatenate([[0.0], np.cumsum(seg)])
    center_raw = LineString(P)

    # s = 0 放在松本站节点的投影处；s 增大方向 = 往信濃大町
    ox, oy = enu.fwd(origin["lat"], origin["lon"])
    s0 = center_raw.project(Point(ox, oy))
    total = cum[-1]
    report["path"] = {"nodes": len(path_nodes), "ways": len(set(path_ways)), "lengthM": round(total, 1),
                      "startOffsetM": round(-s0, 1)}

    # ---------- 2 m 重采样
    s_raw = np.arange(0.0, total, STEP)
    X = np.interp(s_raw, cum, P[:, 0])
    Y = np.interp(s_raw, cum, P[:, 1])
    seg_way = np.array(path_ways)[np.clip(np.searchsorted(cum, s_raw, side="right") - 1, 0, len(path_ways) - 1)]
    S = s_raw - s0
    Xs, Ys = smooth(X, 5.0), smooth(Y, 5.0)  # σ = 10 m，只用来求切向 / 曲率
    head = np.unwrap(np.arctan2(np.gradient(Ys), np.gradient(Xs)))
    head = smooth(head, 7.5)                   # σ = 15 m
    curv = smooth(np.gradient(head, STEP), 7.5)
    nx, ny = -np.sin(head), np.cos(head)       # 左法向：d > 0 在行进方向（往信濃大町）左侧
    N = len(S)

    # ---------- 逐点标志
    flags = np.zeros(N, np.uint16)
    tagstats = defaultdict(lambda: Counter())
    way_len = Counter()
    for i in range(len(path_ways)):
        way_len[path_ways[i]] += seg[i]
    for wid, L in way_len.items():
        t = way_by_id[wid]["tags"]
        for k in ("electrified", "voltage", "frequency", "maxspeed", "gauge", "usage", "service", "name", "operator",
                  "railway:track_ref", "bridge", "tunnel", "embankment", "cutting", "tracks", "railway:preferred_direction",
                  "railway:traffic_mode", "railway:signal_box", "layer", "railway:cant", "cant"):
            tagstats[k][t.get(k, "（无）")] += L
    for i, wid in enumerate(seg_way):
        t = way_by_id[wid]["tags"]
        f = 0
        if t.get("bridge") not in (None, "no"):
            f |= FLAG["bridge"]
        if t.get("tunnel") not in (None, "no"):
            f |= FLAG["tunnel"]
        if t.get("embankment") == "yes":
            f |= FLAG["embankment"]
        if t.get("cutting") == "yes":
            f |= FLAG["cutting"]
        if t.get("electrified") == "contact_line":
            f |= FLAG["electrified"]
        if wid in route_ways:
            f |= FLAG["route_member"]
        flags[i] = f

    # 股道数：每个采样点的法线（±12 m）与 railway=rail 的交点数
    rail_geoms = [LineString(np.column_stack(enu.fwd_np(np.array([c[0] for c in w["coords"]]),
                                                        np.array([c[1] for c in w["coords"]])))) for w in rails]
    rtree = STRtree(rail_geoms)
    tracks = np.zeros(N, np.uint8)
    for i in range(N):
        nl = LineString([(X[i] - nx[i] * 12, Y[i] - ny[i] * 12), (X[i] + nx[i] * 12, Y[i] + ny[i] * 12)])
        cnt = 0
        for j in rtree.query(nl, predicate="intersects"):
            inter = rail_geoms[j].intersection(nl)
            cnt += len(getattr(inter, "geoms", [inter])) if not inter.is_empty else 0
        tracks[i] = min(cnt, 255)
        if cnt >= 2:
            flags[i] |= FLAG["multi_track"]

    center = LineString(np.column_stack([X, Y]))

    def sd(x, y):
        p = Point(x, y)
        sr = center.project(p)
        i = min(int(sr / STEP), N - 1)
        dx, dy = x - X[i], y - Y[i]
        # 在最近采样点的切向坐标系里修正（2 m 内的线性近似）
        tx, ty = -ny[i], nx[i]
        along = dx * tx + dy * ty
        return float(S[i] + along), float(dx * nx[i] + dy * ny[i])

    # ---------- 车站（投影到 s）
    stations = []
    for nm, km in LINE["stations_km"]:
        if nm not in st_cands:
            continue
        best = None
        for p in st_cands[nm]:
            x, y = enu.fwd(p["lat"], p["lon"])
            s, d = sd(x, y)
            if best is None or abs(d) < abs(best[1]):
                best = (s, d, p)
        s, d, p = best
        stations.append({"name": nm, "km": km, "s": round(s, 1), "d": round(d, 1), "osmNode": p["id"],
                         "tags": {k: v for k, v in p["tags"].items() if k in ("railway", "name:en", "name:ja-Hira", "operator", "station")}})

    # ---------- 站台 → s 区间
    platforms = []
    for ln in osm["lines"]:
        if ln["tags"].get("railway") == "platform" or ln["tags"].get("public_transport") == "platform":
            xs, ys = enu.fwd_np(np.array([c[0] for c in ln["coords"]]), np.array([c[1] for c in ln["coords"]]))
            platforms.append((ln["id"], xs, ys))
    for ar in osm["areas"]:
        if ar["tags"].get("railway") == "platform" or ar["tags"].get("public_transport") == "platform":
            ring = ar["outer"][0]
            xs, ys = enu.fwd_np(np.array([c[0] for c in ring]), np.array([c[1] for c in ring]))
            platforms.append((ar["id"], xs, ys))
    plat_iv = []
    for pid, xs, ys in platforms:
        pts = [sd(x, y) for x, y in zip(xs, ys)]
        if min(abs(d) for _, d in pts) > 25:
            continue
        s_lo, s_hi = min(s for s, _ in pts), max(s for s, _ in pts)
        side = float(np.median([d for _, d in pts]))
        plat_iv.append({"s0": round(s_lo, 1), "s1": round(s_hi, 1), "dMedian": round(side, 1), "osmId": pid})
        flags[(S >= s_lo) & (S <= s_hi)] |= FLAG["platform"]
    for st in stations:
        st["platforms"] = [p for p in plat_iv if p["s0"] - 30 <= st["s"] <= p["s1"] + 30]
        if not st["platforms"]:
            report["missing"].append(f"车站「{st['name']}」附近 25 m 内没有站台（railway=platform）几何")

    # ---------- 道口
    crossings = []
    for p in osm["points"]:
        if p["tags"].get("railway") == "level_crossing":
            x, y = enu.fwd(p["lat"], p["lon"])
            s, d = sd(x, y)
            if abs(d) <= 15 and S[0] <= s <= S[-1]:
                t = p["tags"]
                crossings.append({"s": round(s, 1), "d": round(d, 1), "osmNode": p["id"],
                                  "tags": {k: v for k, v in t.items() if k.startswith("crossing") or k in ("name", "supervised", "railway")}})
    crossings.sort(key=lambda c: c["s"])
    for c in crossings:
        flags[np.abs(S - c["s"]) <= 3] |= FLAG["level_crossing"]

    # 道路与线路平交却没有道口节点：列进报告（不补）
    road_hits = []
    for ln in osm["lines"]:
        t = ln["tags"]
        if "highway" not in t:
            continue
        xs, ys = enu.fwd_np(np.array([c[0] for c in ln["coords"]]), np.array([c[1] for c in ln["coords"]]))
        g = LineString(np.column_stack([xs, ys]))
        if not g.intersects(center):
            continue
        inter = g.intersection(center)
        for q in getattr(inter, "geoms", [inter]):
            if q.is_empty or q.geom_type != "Point":
                continue
            s, _ = sd(q.x, q.y)
            kind = "bridge" if t.get("bridge") not in (None, "no") else ("tunnel" if t.get("tunnel") not in (None, "no") else "grade")
            road_hits.append({"s": round(s, 1), "wayId": ln["id"], "highway": t["highway"], "kind": kind,
                              "layer": t.get("layer"), "name": t.get("name")})
    road_hits.sort(key=lambda r: r["s"])
    overpasses = [r for r in road_hits if r["kind"] == "bridge"]
    underpasses = [r for r in road_hits if r["kind"] == "tunnel"]
    grade_no_xing = []
    for r in road_hits:
        if r["kind"] != "grade":
            continue
        near = [c for c in crossings if abs(c["s"] - r["s"]) <= 12]
        if not near:
            # 线路在桥上时，道路从下面穿过是正常的
            i = int(np.clip(np.searchsorted(S, r["s"]), 0, N - 1))
            if flags[i] & FLAG["bridge"]:
                r["kind"] = "under_rail_bridge"
                underpasses.append(r)
            else:
                grade_no_xing.append(r)
    crossings_unmatched_road = [c for c in crossings if not any(abs(c["s"] - r["s"]) <= 12 for r in road_hits)]

    # ---------- 桥 / 隧道 / 路堤 / 路堑区间
    def intervals(bit, key):
        out = []
        on = (flags & bit) != 0
        i = 0
        while i < N:
            if on[i]:
                j = i
                while j + 1 < N and on[j + 1]:
                    j += 1
                wids = sorted(set(int(w) for w in seg_way[i:j + 1]))
                nm = [way_by_id[w]["tags"].get(f"{key}:name") for w in wids if way_by_id[w]["tags"].get(f"{key}:name")]
                out.append({"s0": round(float(S[i]), 1), "s1": round(float(S[j] + STEP), 1), "ways": wids,
                            "name": nm[0] if nm else None,
                            "type": way_by_id[wids[0]]["tags"].get(key)})
                i = j + 1
            else:
                i += 1
        return out

    bridges = intervals(FLAG["bridge"], "bridge")
    tunnels = intervals(FLAG["tunnel"], "tunnel")
    embankments = intervals(FLAG["embankment"], "embankment")
    cuttings = intervals(FLAG["cutting"], "cutting")

    # 河流与线路的交叉（核对桥是否都标了）
    water_cross = []
    for ln in osm["lines"]:
        t = ln["tags"]
        if t.get("waterway") not in ("river", "stream", "canal", "ditch", "drain"):
            continue
        if t.get("tunnel") in ("culvert", "yes"):
            kind = "culvert"
        else:
            kind = "open"
        xs, ys = enu.fwd_np(np.array([c[0] for c in ln["coords"]]), np.array([c[1] for c in ln["coords"]]))
        g = LineString(np.column_stack([xs, ys]))
        if not g.intersects(center):
            continue
        inter = g.intersection(center)
        for q in getattr(inter, "geoms", [inter]):
            if q.geom_type != "Point":
                continue
            s, _ = sd(q.x, q.y)
            i = int(np.clip(np.searchsorted(S, s), 0, N - 1))
            water_cross.append({"s": round(s, 1), "waterway": t["waterway"], "name": t.get("name"), "kind": kind,
                                "onBridge": bool(flags[max(0, i - 3):i + 4].any() and (flags[max(0, i - 3):i + 4] & FLAG["bridge"]).any())})
    water_cross.sort(key=lambda w: w["s"])

    # ---------- DEM：中心线纵断面
    dem = GsiDem()
    t1 = time.time()
    zg = np.array([dem.sample(*enu.inv(float(X[i]), float(Y[i]))) for i in range(N)])
    report["demCenter"] = {"tilesFetched": dem.fetched, "hits": dict(dem.hits), "nodata": dem.nodata}
    print(f"· 中心线 DEM {N} 点，{time.time() - t1:.0f}s，{dict(dem.hits)}", flush=True)
    # 轨面近似：桥上用两端桥台的高程线性插值（DEM 是地表，桥下是河床），再做 σ = 30 m 平滑
    zr = zg.copy()
    good = ~np.isnan(zr)
    if not good.all():
        zr[~good] = np.interp(np.flatnonzero(~good), np.flatnonzero(good), zr[good])
    for br in bridges + [{"s0": t["s0"], "s1": t["s1"]} for t in tunnels]:
        i0 = int(np.clip(np.searchsorted(S, br["s0"] - 6), 0, N - 1))
        i1 = int(np.clip(np.searchsorted(S, br["s1"] + 6), 0, N - 1))
        if i1 > i0:
            zr[i0:i1 + 1] = np.linspace(zr[i0], zr[i1], i1 - i0 + 1)
    zr = smooth(zr, 15.0)
    grade = np.gradient(smooth(zr, 25.0), STEP) * 1000.0  # ‰

    # ---------- DEM：走廊 (s, d) 网格
    gs = np.arange(S[0], S[-1], GRID_DS)
    gd = np.arange(-GRID_HALF, GRID_HALF + 0.1, GRID_DD)
    grid = np.full((len(gs), len(gd)), -32768, np.int16)
    t1 = time.time()
    for a_i, s in enumerate(gs):
        i = int(np.clip(round((s - S[0]) / STEP), 0, N - 1))
        for b_i, d in enumerate(gd):
            h = dem.sample(*enu.inv(float(X[i] + nx[i] * d), float(Y[i] + ny[i] * d)))
            if not math.isnan(h):
                grid[a_i, b_i] = int(round(h * 10))
        if a_i % 500 == 0:
            print(f"  … 网格行 {a_i}/{len(gs)}，已下载瓦片 {dem.fetched}，{time.time() - t1:.0f}s", flush=True)
    report["demGrid"] = {"tilesFetched": dem.fetched, "tilesMissing404": dem.missing, "hits": dict(dem.hits),
                         "nodataSamples": int((grid == -32768).sum())}

    # ---------- 接触网支柱：OSM 有就用，缺的按规则程序生成
    masts_osm = []
    for p in osm["points"]:
        if p["tags"].get("railway") == "catenary_mast" or p["tags"].get("power") == "catenary_mast":
            x, y = enu.fwd(p["lat"], p["lon"])
            s, d = sd(x, y)
            if abs(d) <= 15:
                masts_osm.append((s, d, p["id"]))
    rng = random.Random(SEED)
    masts = []  # (s, d, source) source: 0 = 程序生成，1 = OSM
    for s, d, _ in masts_osm:
        masts.append((s, d, 1))
    osm_s = np.array(sorted(m[0] for m in masts_osm)) if masts_osm else np.array([])
    xing_s = np.array([c["s"] for c in crossings])
    # 站间分段选支柱一侧（真实一侧未知，程序生成）
    st_s = [st["s"] for st in stations]
    side_of = {}
    for k in range(len(st_s) + 1):
        side_of[k] = rng.choice((-1, 1))
    s = S[0] + 5.0
    while s < S[-1] - 5:
        i = int(np.clip((s - S[0]) / STEP, 0, N - 1))
        j = int(np.clip((s + MAST_SPAN_MAX - S[0]) / STEP, 0, N - 1))
        kmax = float(np.max(np.abs(curv[i:j + 1]))) if j > i else abs(float(curv[i]))
        R = 1.0 / max(kmax, 1e-6)
        span = min(MAST_SPAN_MAX, math.sqrt(8 * R * MAST_STAGGER))
        span = max(span, 20.0)
        span -= rng.uniform(0, 0.12) * span  # 径间只会比上限短
        s_next = s + span
        # 离道口太近就往前挪
        if xing_s.size and np.min(np.abs(xing_s - s_next)) < 6:
            s_next = xing_s[np.argmin(np.abs(xing_s - s_next))] + 6.5
        s = s_next
        if osm_s.size and np.min(np.abs(osm_s - s)) < MAST_SPAN_MAX * 0.6:
            continue
        seg_k = int(np.searchsorted(st_s, s))
        side = side_of[seg_k]
        i = int(np.clip((s - S[0]) / STEP, 0, N - 1))
        if flags[i] & FLAG["tunnel"]:
            continue
        masts.append((s, side * (2.6 + 0.0 * tracks[i]), 0))
    masts.sort()

    # ---------- 走廊内的要素
    corridor = center.buffer(LINE["buffer_m"], quad_segs=8)
    corr_p = prep(corridor)
    minx, miny, maxx, maxy = corridor.bounds

    def ring_xy(ring):
        xs, ys = enu.fwd_np(np.array([c[0] for c in ring]), np.array([c[1] for c in ring]))
        return np.column_stack([xs, ys])

    # 建筑
    btypes, roofs = Counter(), Counter()
    b_list = []
    n_b_all = 0
    for ar in osm["areas"]:
        t = ar["tags"]
        if "building" not in t or t["building"] == "no":
            continue
        n_b_all += 1
        outer = ring_xy(ar["outer"][0])
        c = outer.mean(axis=0)
        if not (minx <= c[0] <= maxx and miny <= c[1] <= maxy) or not corr_p.contains(Point(c)):
            continue
        rings = [ring_xy(r) for r in ar["outer"]] + [ring_xy(r) for r in ar["inner"]]
        holes = [False] * len(ar["outer"]) + [True] * len(ar["inner"])
        s, d = sd(float(c[0]), float(c[1]))
        b_list.append((s, d, t, rings, holes))
        btypes[t["building"]] += 1
        if "roof:shape" in t:
            roofs[t["roof:shape"]] += 1
    b_list.sort(key=lambda b: b[0])

    # 土地利用 / 自然 / 水面：裁到走廊
    def lu_class(t):
        if t.get("building"):
            return None
        if t.get("landuse"):
            v = t["landuse"]
            if v == "farmland" and t.get("crop"):
                return f"landuse=farmland;crop={t['crop']}"
            return f"landuse={v}"
        if t.get("natural") in ("wood", "scrub", "grassland", "heath", "water", "wetland", "bare_rock", "sand", "shingle", "beach"):
            if t["natural"] == "water" and t.get("water"):
                return f"natural=water;water={t['water']}"
            return f"natural={t['natural']}"
        if t.get("waterway") == "riverbank":
            return "waterway=riverbank"
        if t.get("leisure") in ("park", "golf_course", "pitch", "playground", "garden", "nature_reserve"):
            return f"leisure={t['leisure']}"
        if t.get("amenity") in ("school", "parking", "grave_yard", "university", "hospital"):
            return f"amenity={t['amenity']}"
        return None

    lu_classes = Counter()
    lu_list = []
    lu_area = Counter()
    for ar in osm["areas"]:
        cls = lu_class(ar["tags"])
        if not cls:
            continue
        try:
            outers = [ring_xy(r) for r in ar["outer"]]
            inners = [ring_xy(r) for r in ar["inner"]]
            polys = []
            for o in outers:
                po = Polygon(o)
                hs = [Polygon(h) for h in inners if po.intersects(Polygon(h))] if inners else []
                polys.append(Polygon(o, [h.exterior.coords for h in hs]))
            g = make_valid(MultiPolygon(polys) if len(polys) > 1 else polys[0])
        except Exception as e:  # 退化几何
            report["notes"].append(f"多边形 {ar['id']} 组装失败：{e}")
            continue
        if not g.intersects(corridor):
            continue
        g = g.intersection(corridor)
        for pg in iter_polys(g):
            if pg.area < 4:
                continue
            pg = pg.simplify(0.3, preserve_topology=True)
            c = pg.representative_point()
            s, _ = sd(c.x, c.y)
            lu_list.append((s, cls, pg))
            lu_classes[cls] += 1
            lu_area[cls] += pg.area
    lu_list.sort(key=lambda r: r[0])

    # 线要素：道路、水路、电力线、墙
    def line_cls(t):
        if "highway" in t:
            return "road", t["highway"]
        if t.get("waterway") in ("river", "stream", "canal", "ditch", "drain"):
            return "water", t["waterway"]
        if t.get("power") in ("line", "minor_line", "cable"):
            return "power", t["power"]
        if t.get("wall") == "noise_barrier" or t.get("barrier") in ("wall", "fence", "hedge", "guard_rail"):
            return "barrier", t.get("wall") if t.get("wall") == "noise_barrier" else t["barrier"]
        return None, None

    lines_by = defaultdict(list)
    for ln in osm["lines"]:
        kind, cls = line_cls(ln["tags"])
        if not kind:
            continue
        xy = ring_xy(ln["coords"])
        g = LineString(xy)
        if not g.intersects(corridor):
            continue
        for part in iter_lines(g.intersection(corridor)):
            if part.length < 1:
                continue
            c = part.interpolate(0.5, normalized=True)
            s, _ = sd(c.x, c.y)
            lines_by[kind].append((s, cls, ln["tags"], np.array(part.coords)))
    for k in lines_by:
        lines_by[k].sort(key=lambda r: r[0])

    # 点要素：电杆 / 铁塔
    power_pts = []
    for p in osm["points"]:
        if p["tags"].get("power") in ("pole", "tower", "portal"):
            x, y = enu.fwd(p["lat"], p["lon"])
            if corr_p.contains(Point(x, y)):
                s, d = sd(x, y)
                power_pts.append((s, d, x, y, p["tags"]["power"]))
    power_pts.sort()

    # ---------- 写二进制
    blob = Blob()
    blob.add("center.x", X.astype(np.float32), "中心线东坐标（米），每 2 m 一点")
    blob.add("center.y", Y.astype(np.float32), "中心线北坐标（米）")
    blob.add("center.s", S.astype(np.float32), "里程 s（米），0 = 松本站节点的投影")
    blob.add("center.zGround", np.nan_to_num(zg, nan=-9999).astype(np.float32), "中心线处 DEM 地表高程（米，缺 = -9999；桥下是河床）")
    blob.add("center.zRail", zr.astype(np.float32), "轨面高程近似（米）：桥 / 隧道段两端线性插值，σ = 30 m 平滑")
    blob.add("center.grade", grade.astype(np.float32), "纵坡（‰，正 = 往信濃大町上坡），由 zRail 再 σ = 50 m 平滑后求导")
    blob.add("center.heading", head.astype(np.float32), "切向角（弧度，从东向逆时针；σ = 15 m 平滑）")
    blob.add("center.curvature", curv.astype(np.float32), "曲率（1/m，正 = 左转；由 OSM 折线求导后 σ = 15 m 平滑，非设计值）")
    blob.add("center.flags", flags, "位标志，见 json.format.flags")
    blob.add("center.tracks", tracks, "法线 ±12 m 内 railway=rail 的股道数（含本线）")

    blob.add("grid.z", grid.reshape(-1), f"走廊高程网格，行 = s（{GRID_DS} m 一行），列 = d（{GRID_DD} m 一列，-{GRID_HALF}..+{GRID_HALF}），单位 0.1 m，-32768 = 无数据")

    m_arr = np.array(masts, dtype=np.float64).reshape(-1, 3)
    blob.add("masts.s", m_arr[:, 0].astype(np.float32), "接触网支柱里程")
    blob.add("masts.d", m_arr[:, 1].astype(np.float32), "接触网支柱横向偏移（米，+ = 左）")
    blob.add("masts.source", m_arr[:, 2].astype(np.uint8), "0 = 程序生成（示例，非真实位置），1 = OSM railway=catenary_mast")

    def add_polys(prefix, feats, cls_names, extra):
        """feats: [(s, d?, cls, [rings], [isHole])]"""
        verts, ring_start, ring_hole, feat_ring = [], [0], [], [0]
        for f in feats:
            for r, h in zip(f["rings"], f["holes"]):
                r = np.asarray(r)
                if len(r) > 1 and np.allclose(r[0], r[-1]):
                    r = r[:-1]
                verts.append(r)
                ring_start.append(ring_start[-1] + len(r))
                ring_hole.append(1 if h else 0)
            feat_ring.append(len(ring_hole))
        V = np.concatenate(verts).astype(np.float32).reshape(-1) if verts else np.zeros(0, np.float32)
        blob.add(f"{prefix}.verts", V, "顶点 xy 交错（米），环不重复首点")
        blob.add(f"{prefix}.ringStart", np.array(ring_start, np.uint32), "每个环在 verts 里的起始顶点号（长度 = 环数 + 1）")
        blob.add(f"{prefix}.ringHole", np.array(ring_hole, np.uint8), "1 = 内环（洞）")
        blob.add(f"{prefix}.featRing", np.array(feat_ring, np.uint32), "每个要素的第一个环号（长度 = 要素数 + 1）")
        blob.add(f"{prefix}.cls", np.array([cls_names.index(f["cls"]) for f in feats], np.uint8), "类别下标，查 json.layers.<层>.classes")
        blob.add(f"{prefix}.s", np.array([f["s"] for f in feats], np.float32), "要素代表点的里程（已按 s 排序）")
        for name, (arr, desc) in extra.items():
            blob.add(f"{prefix}.{name}", arr, desc)

    b_cls = [c for c, _ in btypes.most_common()]
    b_feats = [{"s": s, "cls": t["building"], "rings": rings, "holes": holes} for s, d, t, rings, holes in b_list]
    roof_names = ["（无）"] + [r for r, _ in roofs.most_common()]
    add_polys("buildings", b_feats, b_cls, {
        "d": (np.array([b[1] for b in b_list], np.float32), "要素中心的横向偏移（米）"),
        "levels": (np.array([int(round(num(b[2].get("building:levels"), 0))) for b in b_list], np.uint8), "building:levels，0 = 未标"),
        "height": (np.array([int(round(num(b[2].get("height"), 0) * 10)) for b in b_list], np.uint16), "height（0.1 m），0 = 未标"),
        "roof": (np.array([roof_names.index(b[2].get("roof:shape", "（无）")) for b in b_list], np.uint8), "roof:shape 下标，0 = 未标"),
    })
    lu_cls = [c for c, _ in lu_classes.most_common()]
    lu_feats = []
    for s, cls, pg in lu_list:
        rings = [np.array(pg.exterior.coords)] + [np.array(h.coords) for h in pg.interiors]
        lu_feats.append({"s": s, "cls": cls, "rings": rings, "holes": [False] + [True] * len(pg.interiors)})
    add_polys("landuse", lu_feats, lu_cls, {})

    line_layers = {}
    for kind, feats in lines_by.items():
        classes = [c for c, _ in Counter(f[1] for f in feats).most_common()]
        verts, start = [], [0]
        for f in feats:
            verts.append(f[3])
            start.append(start[-1] + len(f[3]))
        blob.add(f"{kind}.verts", np.concatenate(verts).astype(np.float32).reshape(-1), "顶点 xy 交错（米）")
        blob.add(f"{kind}.featStart", np.array(start, np.uint32), "每条线的起始顶点号（长度 = 条数 + 1）")
        blob.add(f"{kind}.cls", np.array([classes.index(f[1]) for f in feats], np.uint8), "类别下标")
        blob.add(f"{kind}.s", np.array([f[0] for f in feats], np.float32), "中点里程（已按 s 排序）")
        extra = {}
        if kind == "road":
            st = np.array([(1 if f[2].get("bridge") not in (None, "no") else 0) | (2 if f[2].get("tunnel") not in (None, "no") else 0)
                           for f in feats], np.uint8)
            blob.add("road.struct", st, "1 = 桥，2 = 隧道 / 地下")
            blob.add("road.lanes", np.array([int(num(f[2].get("lanes"), 0)) for f in feats], np.uint8), "lanes，0 = 未标")
        if kind == "power":
            blob.add("power.voltage", np.array([int(round(num(str(f[2].get("voltage", "")).split(";")[0], 0) / 100)) for f in feats], np.uint16),
                     "电压（100 V 单位，取第一个值），0 = 未标")
        line_layers[kind] = {"count": len(feats), "classes": classes}

    pp = np.array([(s, d, x, y) for s, d, x, y, _ in power_pts], np.float32).reshape(-1, 4)
    pk = ["pole", "tower", "portal"]
    blob.add("powerPts.s", pp[:, 0].copy(), "里程")
    blob.add("powerPts.d", pp[:, 1].copy(), "横向偏移")
    blob.add("powerPts.xy", pp[:, 2:4].reshape(-1).copy(), "xy 交错")
    blob.add("powerPts.cls", np.array([pk.index(p[4]) for p in power_pts], np.uint8), "0 = pole，1 = tower，2 = portal")

    # ---------- 统计
    def km_hist(values, lo=S[0], hi=S[-1], width=1000.0):
        edges = np.arange(math.floor(lo / width) * width, hi + width, width)
        h, _ = np.histogram(values, bins=edges)
        return [{"km": round(e / 1000, 0), "n": int(n)} for e, n in zip(edges[:-1], h)]

    near_b = [b[0] for b in b_list if abs(b[1]) <= 300]
    corridor_area = corridor.area
    lu_union_area = sum(lu_area.values())
    lengthM = float(S[-1] - S[0])
    stats = {
        "centerline": {"samples": N, "lengthM": round(lengthM, 1), "sMin": round(float(S[0]), 1), "sMax": round(float(S[-1]), 1),
                       "zRailMin": round(float(zr.min()), 1), "zRailMax": round(float(zr.max()), 1),
                       "gradeAbsMaxPermil": round(float(np.abs(grade).max()), 1),
                       "gradeAbsP99Permil": round(float(np.percentile(np.abs(grade), 99)), 1),
                       "radiusMinM": round(float(1 / max(np.abs(curv).max(), 1e-9)), 0),
                       "multiTrackFraction": round(float((tracks >= 2).mean()), 3),
                       "electrifiedFraction": round(float(((flags & FLAG["electrified"]) != 0).mean()), 3)},
        "wayTagsByLengthM": {k: {v: round(L, 0) for v, L in c.most_common()} for k, c in tagstats.items()},
        "stations": len(stations), "platformIntervals": len(plat_iv),
        "levelCrossings": len(crossings), "roadGradeCrossingsWithoutNode": len(grade_no_xing),
        "crossingNodesWithoutRoad": len(crossings_unmatched_road),
        "overpasses": len(overpasses), "underpasses": len(underpasses),
        "bridges": len(bridges), "tunnels": len(tunnels), "embankments": len(embankments), "cuttings": len(cuttings),
        "waterCrossings": len(water_cross),
        "mastsOsm": len(masts_osm), "mastsGenerated": sum(1 for m in masts if m[2] == 0),
        "buildings": {"inCorridor": len(b_list), "inBbox": n_b_all, "withLevels": sum(1 for b in b_list if "building:levels" in b[2]),
                      "withHeight": sum(1 for b in b_list if "height" in b[2]), "withRoofShape": sum(1 for b in b_list if "roof:shape" in b[2]),
                      "types": dict(btypes.most_common()), "within300mPerKm": km_hist(near_b)},
        "landuse": {"polygons": len(lu_list), "classes": dict(lu_classes.most_common()),
                    "areaKm2ByClass": {k: round(v / 1e6, 3) for k, v in lu_area.most_common()},
                    "corridorAreaKm2": round(corridor_area / 1e6, 2),
                    "coveredFractionUpperBound": round(min(1.0, lu_union_area / corridor_area), 3)},
        "lines": {k: {"count": v["count"], "classes": dict(Counter(f[1] for f in lines_by[k]).most_common())} for k, v in line_layers.items()},
        "powerPoints": dict(Counter(p[4] for p in power_pts)),
    }
    # 土地利用覆盖率按 1 km 分段（±500 m 带内），找空洞
    band = center.buffer(500)
    lu_geoms = [f[2] for f in lu_list]
    lu_tree = STRtree(lu_geoms) if lu_geoms else None
    cover = []
    for k0 in np.arange(math.floor(S[0] / 1000) * 1000, S[-1], 1000.0):
        i0 = int(np.clip((k0 - S[0]) / STEP, 0, N - 1))
        i1 = int(np.clip((k0 + 1000 - S[0]) / STEP, 0, N - 1))
        if i1 - i0 < 2:
            continue
        cell = LineString(np.column_stack([X[i0:i1 + 1], Y[i0:i1 + 1]])).buffer(500, cap_style="flat").intersection(band)
        covered = 0.0
        if lu_tree is not None:
            from shapely.ops import unary_union
            hits = [lu_geoms[j] for j in lu_tree.query(cell, predicate="intersects")]
            if hits:
                covered = unary_union([h.intersection(cell) for h in hits]).area
        cover.append({"km": round(k0 / 1000, 0), "coveredFraction": round(covered / max(cell.area, 1), 3)})
    stats["landuse"]["coverPerKmWithin500m"] = cover

    arrays = blob.index
    meta = {
        "version": 1,
        "id": LINE["id"],
        "name": LINE["name"],
        "generated": time.strftime("%Y-%m-%d"),
        "sources": {
            "osm": {"file": osm["pbf"], "provider": "Geofabrik（download.geofabrik.de/asia/japan/chubu）",
                    "license": "ODbL 1.0", "attribution": "© OpenStreetMap contributors"},
            "dem": {"provider": "国土地理院 標高タイル（DEM5A / DEM5B / DEM5C / DEM10B）",
                    "license": "国土地理院コンテンツ利用規約（CC BY 4.0 互換）",
                    "attribution": "地理院タイル（標高タイル）を加工して作成"},
            "stationKm": "営業キロ：Wikipedia「大糸線」駅一覧",
        },
        "format": {
            "bin": f"{LINE['id']}.bin",
            "endianness": "little",
            "crs": {"type": "local-ENU-tangent-plane", "originLat": enu.lat0, "originLon": enu.lon0, "originName": f"{LINE['from']}駅（OSM node {origin['id']}）",
                    "x": "东（米）", "y": "北（米）", "z": "国土地理院 DEM 标高（米，东京湾平均海面起算），不是 ENU 的 up"},
            "s": "里程（米），沿本线中心线量，0 = 松本站节点的投影，增大方向 = 往信濃大町",
            "d": "横向偏移（米），+ = 行进方向（往信濃大町）左侧",
            "centerStepM": STEP,
            "grid": {"ds": GRID_DS, "dd": GRID_DD, "s0": float(gs[0]), "rows": len(gs), "cols": len(gd), "d0": float(gd[0]), "unit": 0.1, "nodata": -32768},
            "flags": FLAG,
            "arrays": "arrays.<名字> = {type, offset(字节), length(元素数), desc}；new <Type>Array(buf, offset, length)",
        },
        "arrays": arrays,
        "layers": {
            "buildings": {"count": len(b_list), "classes": b_cls, "roofShapes": roof_names},
            "landuse": {"count": len(lu_list), "classes": lu_cls},
            **line_layers,
            "powerPts": {"count": len(power_pts), "classes": pk},
            "masts": {"count": len(masts), "note": "source = 0 的是程序生成：径间 ≤ 50 m，弯道按 √(8·R·0.2 m) 缩短，随机缩短 0–12%，避开道口 ±6 m，站间随机选一侧。位置不是真实的，只用来给节奏。"},
        },
        "stations": stations,
        "platforms": plat_iv,
        "levelCrossings": crossings,
        "bridges": bridges, "tunnels": tunnels, "embankments": embankments, "cuttings": cuttings,
        "overpasses": overpasses, "underpasses": underpasses, "waterCrossings": water_cross,
        "stats": stats,
        "report": {**report, "roadGradeCrossingsWithoutNode": grade_no_xing, "crossingNodesWithoutRoad": crossings_unmatched_road},
    }
    OUT_DIR.mkdir(parents=True, exist_ok=True)
    (OUT_DIR / f"{LINE['id']}.bin").write_bytes(blob.bytes())
    (OUT_DIR / f"{LINE['id']}.json").write_text(json.dumps(meta, ensure_ascii=False, indent=1), encoding="utf-8")
    print(f"✓ {LINE['id']}: bin {blob.size / 1e6:.2f} MB，json {(OUT_DIR / (LINE['id'] + '.json')).stat().st_size / 1e3:.0f} KB，"
          f"{time.time() - t0:.0f}s")
    print(json.dumps({k: stats[k] for k in ("centerline", "stations", "levelCrossings", "bridges", "tunnels", "mastsOsm", "mastsGenerated")}, ensure_ascii=False))


if __name__ == "__main__":
    sys.exit(main())
