"""第 1 步：从 Geofabrik 中部包里把线路范围（bbox）内的相关要素读出来，存成中间 JSON。

输出：<cache>/<line>_osm.json（只在本机，不入库）
  rails     railway=rail / light_rail / narrow_gauge 等的 way（全部标签 + 节点号 + 坐标）
  routes    route=railway / train 且名字含线路名的关系（成员表）
  points    车站、道口、接触网支柱、信号、电杆 / 铁塔、站台（节点）
  lines     道路、河道 / 水渠、电力线、隔音墙（线）
  areas     建筑、土地利用、水面、树林等（多边形，已由 osmium 组装多重多边形）

用法：
  scripts/rail/.venv/Scripts/python scripts/rail/extract_osm.py            # 包不存在时自动下载
数据 © OpenStreetMap contributors，ODbL 1.0。
"""
from __future__ import annotations

import json
import sys
import time
import urllib.request
from pathlib import Path

import osmium

from common import GEOFABRIK_URL, LINE, USER_AGENT, cache_dir

RAIL_KINDS = {"rail", "light_rail", "narrow_gauge", "disused", "abandoned", "construction", "preserved"}
POINT_KEYS = {
    "railway": {"station", "halt", "stop", "level_crossing", "crossing", "catenary_mast", "signal", "switch",
                "buffer_stop", "milestone", "platform", "tram_stop", "railway_crossing"},
    "public_transport": {"station", "stop_position", "platform"},
    "power": {"pole", "tower", "portal", "substation", "transformer"},
}
LINE_KEYS = ("highway", "waterway", "power", "barrier", "wall", "railway")
AREA_KEYS = ("building", "landuse", "natural", "water", "leisure", "amenity", "railway", "power", "waterway", "man_made")
# 线 / 面只保留这些标签（控制中间文件体积；铁路 way 保留全部标签）
KEEP_TAGS = {
    "highway", "name", "ref", "lanes", "width", "surface", "bridge", "tunnel", "layer", "service", "oneway",
    "waterway", "intermittent", "power", "voltage", "cables", "frequency", "line", "barrier", "wall", "height",
    "building", "building:levels", "building:material", "roof:shape", "roof:colour", "roof:material", "roof:levels",
    "min_height", "landuse", "crop", "natural", "water", "leisure", "amenity", "railway", "man_made", "leaf_type",
    "leaf_cycle", "produce", "trees", "operator", "source", "public_transport", "embankment", "cutting",
}


def ensure_pbf() -> Path:
    cache = cache_dir()
    existing = sorted(cache.glob("chubu-*.osm.pbf"))
    if existing:
        return existing[-1]
    # latest 会 302 到带日期的文件名，按最终文件名存
    req = urllib.request.Request(GEOFABRIK_URL, headers={"User-Agent": USER_AGENT})
    with urllib.request.urlopen(req) as r:
        name = Path(r.url).name
        dst = cache / name
        print(f"· 下载 {r.url} → {dst}", flush=True)
        tmp = dst.with_suffix(".part")
        with open(tmp, "wb") as f:
            while True:
                chunk = r.read(1 << 20)
                if not chunk:
                    break
                f.write(chunk)
        tmp.rename(dst)
    return dst


def keep(tags) -> dict:
    return {k: v for k, v in tags if k in KEEP_TAGS}


def main():
    t0 = time.time()
    pbf = ensure_pbf()
    bb = LINE["bbox"]
    S, N, W, E = bb["s"], bb["n"], bb["w"], bb["e"]

    def inside(lon, lat):
        return S <= lat <= N and W <= lon <= E

    rails, routes, points, lines, areas = [], [], [], [], []
    names = LINE["lineNames"]
    area_filter = osmium.filter.KeyFilter(*AREA_KEYS)
    # 没有标签的对象（绝大多数节点）不交给 Python：位置索引与多边形组装在过滤之前做，不受影响
    fp = osmium.FileProcessor(str(pbf)).with_areas(area_filter).with_filter(osmium.filter.EmptyTagFilter())
    n_seen = 0
    for o in fp:
        n_seen += 1
        if o.is_node():
            t = o.tags
            hit = any(t.get(k) in vs for k, vs in POINT_KEYS.items())
            if hit and o.location.valid() and inside(o.location.lon, o.location.lat):
                points.append({"id": o.id, "tags": dict(t), "lon": o.location.lon, "lat": o.location.lat})
        elif o.is_way():
            t = o.tags
            rw = t.get("railway")
            is_rail = rw in RAIL_KINDS
            is_line = any(k in t for k in LINE_KEYS) and not t.get("area") == "yes"
            if not (is_rail or is_line):
                continue
            pts = [(n.lon, n.lat) for n in o.nodes if n.location.valid()]
            if len(pts) < 2 or not any(inside(x, y) for x, y in pts):
                continue
            if is_rail:
                rails.append({"id": o.id, "tags": dict(t), "nodes": [n.ref for n in o.nodes if n.location.valid()],
                              "coords": [[round(x, 7), round(y, 7)] for x, y in pts]})
            elif "highway" in t or "waterway" in t or t.get("power") in ("line", "minor_line", "cable") \
                    or t.get("wall") == "noise_barrier" or t.get("barrier") in ("wall", "fence", "hedge", "guard_rail") \
                    or t.get("railway") == "platform":
                lines.append({"id": o.id, "tags": keep(t), "coords": [[round(x, 7), round(y, 7)] for x, y in pts]})
        elif o.is_relation():
            t = o.tags
            if t.get("type") == "route" and t.get("route") in ("railway", "train", "tracks") \
                    and any(nm in (t.get("name", "") + t.get("name:ja", "")) for nm in names):
                routes.append({"id": o.id, "tags": dict(t),
                               "members": [{"type": m.type, "ref": m.ref, "role": m.role} for m in o.members]})
        elif o.is_area():
            outers = []
            inners = []
            hit = False
            for outer in o.outer_rings():
                ring = [(n.lon, n.lat) for n in outer if n.location.valid()]
                if len(ring) < 4:
                    continue
                if not hit and any(inside(x, y) for x, y in ring[:: max(1, len(ring) // 32)] + ring[-1:]):
                    hit = True
                outers.append([[round(x, 7), round(y, 7)] for x, y in ring])
                for inner in o.inner_rings(outer):
                    iring = [(n.lon, n.lat) for n in inner if n.location.valid()]
                    if len(iring) >= 4:
                        inners.append([[round(x, 7), round(y, 7)] for x, y in iring])
            if not hit:
                # 大多边形（森林等）可能全部顶点都在 bbox 外却覆盖 bbox：用外包框相交再判一次
                for ring in outers:
                    xs = [p[0] for p in ring]
                    ys = [p[1] for p in ring]
                    if min(xs) <= E and max(xs) >= W and min(ys) <= N and max(ys) >= S:
                        hit = True
                        break
            if hit and outers:
                areas.append({"id": o.orig_id(), "fromWay": o.from_way(), "tags": keep(o.tags),
                              "outer": outers, "inner": inners})
        if n_seen % 5_000_000 == 0:
            print(f"  … {n_seen / 1e6:.0f}M 个对象，{time.time() - t0:.0f}s", flush=True)

    out = cache_dir() / f"{LINE['id']}_osm.json"
    doc = {"pbf": pbf.name, "bbox": bb, "rails": rails, "routes": routes, "points": points, "lines": lines, "areas": areas}
    out.write_text(json.dumps(doc, ensure_ascii=False), encoding="utf-8")
    print(f"✓ {pbf.name}: rails {len(rails)} / routes {len(routes)} / points {len(points)} / lines {len(lines)} / "
          f"areas {len(areas)}，{time.time() - t0:.0f}s → {out}")


if __name__ == "__main__":
    sys.exit(main())
