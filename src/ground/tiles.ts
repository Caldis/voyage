import { VectorTile } from "@mapbox/vector-tile";
import { PbfReader } from "pbf";
import { RoadTileBuilder, type RoadTileData } from "./road-raster";

/**
 * 瓦片数据源（全部免费，浏览器直连，均允许跨域；请求头不带任何个人信息）：
 * - 影像：EOX Sentinel-2 cloudless 2020（CC BY-NC-SA 4.0，需署名；个人非商业使用）
 * - 地形：AWS Terrain Tiles（Mapzen Terrarium 编码，开放数据）
 * - 水体、道路：OpenFreeMap 矢量瓦片（OpenMapTiles schema，© OpenStreetMap contributors，ODbL）；
 *   道路（T08 夜间灯带）取 transportation 图层，和水体同一张瓦片、同一次请求
 * - 夜光：NASA Black Marble（VIIRS 2016，GIBS，公有领域），最高 z8（约 500 m/像素）
 */

export const IMAGERY_URL = (z: number, x: number, y: number) =>
  `https://tiles.maps.eox.at/wmts/1.0.0/s2cloudless-2020_3857/default/g/${z}/${y}/${x}.jpg`;
// z14 ≈ 10 m/像素，就是 Sentinel-2 的原生分辨率；更高的级别只是放大，没有新信息
export const IMAGERY_MAX_ZOOM = 14;

export const DEM_URL = (z: number, x: number, y: number) =>
  `https://s3.amazonaws.com/elevation-tiles-prod/terrarium/${z}/${x}/${y}.png`;
export const DEM_MAX_ZOOM = 12;

export const VECTOR_MAX_ZOOM = 14;

export const NIGHT_URL = (z: number, x: number, y: number) =>
  `https://gibs.earthdata.nasa.gov/wmts/epsg3857/best/VIIRS_Black_Marble/default/2016-01-01/GoogleMapsCompatible_Level8/${z}/${y}/${x}.png`;
export const NIGHT_MAX_ZOOM = 8;
let vectorTemplate: Promise<string> | null = null;

/** OpenFreeMap 的瓦片地址里带版本号，从 TileJSON 里取 */
function vectorUrl(z: number, x: number, y: number) {
  vectorTemplate ??= fetch("https://tiles.openfreemap.org/planet")
    .then((r) => r.json())
    .then((j: { tiles: string[] }) => j.tiles[0]);
  return vectorTemplate.then((t) => t.replace("{z}", String(z)).replace("{x}", String(x)).replace("{y}", String(y)));
}

/** 简单的 LRU：飞行途中不断有新瓦片进来 */
class Lru<V> {
  private map = new Map<string, V>();
  constructor(private readonly cap: number) {}
  get(k: string) {
    const v = this.map.get(k);
    if (v !== undefined) {
      this.map.delete(k);
      this.map.set(k, v);
    }
    return v;
  }
  delete(k: string) {
    this.map.delete(k);
  }
  set(k: string, v: V) {
    this.map.set(k, v);
    if (this.map.size > this.cap) this.map.delete(this.map.keys().next().value as string);
  }
}

const bitmaps = new Lru<Promise<ImageBitmap | null>>(1500);

/** 加载图片瓦片；失败（海上没有瓦片、网络错误）返回 null，调用方用兜底颜色 */
export function loadBitmap(url: string): Promise<ImageBitmap | null> {
  let p = bitmaps.get(url);
  if (!p) {
    p = fetch(url, { mode: "cors" })
      .then((r) => (r.ok ? r.blob() : null))
      .then((b) => (b ? createImageBitmap(b) : null))
      .catch(() => null);
    bitmaps.set(url, p);
    // 失败（网络错误、限流）不要永久缓存成 null：下次重建这一级时再试
    const key = url;
    p.then((b) => {
      if (!b) bitmaps.delete(key);
    });
  }
  return p;
}

export interface WaterFeatures {
  extent: number;
  /** 水域多边形（每个是若干环，瓦片内坐标）；ocean = 是否海洋 */
  polygons: { rings: { x: number; y: number }[][]; ocean: boolean }[];
  /** 河道折线；width = 估计河宽（米） */
  lines: { points: { x: number; y: number }[]; width: number }[];
  /** 道路（T08）：攒成扁平数组，直接交给栅格化 Worker（见 road-raster.ts）；坐标是 transportation 图层自己的瓦片内坐标 */
  roads: RoadTileData | null;
}

/**
 * 道路等级 → 夜里被路灯照亮的宽度（米，一条 OSM 线；双向分离的高速在数据里是两条线）与相对照明强度。
 * 经验取值（不是实测）：高速 / 快速路灯杆高、照度高，城市主干道次之，支路最暗。
 * 只收这些等级：隧道（brunnel = tunnel）看不见；施工中（*_construction）、轮渡、铁路、步道、田间路、小区内部路不收。
 */
const ROAD_CLASS: Record<string, { highway: boolean; width: number; weight: number }> = {
  motorway: { highway: true, width: 18, weight: 1.0 },
  trunk: { highway: true, width: 16, weight: 0.9 },
  primary: { highway: false, width: 14, weight: 0.7 },
  secondary: { highway: false, width: 12, weight: 0.45 },
  tertiary: { highway: false, width: 10, weight: 0.2 },
  minor: { highway: false, width: 8, weight: 0.08 },
};

/**
 * 去掉整段落在瓦片以外（缓冲区里）的线段，把折线在那里断开（T08 发现，道路见 road-raster.ts 的 RoadTileBuilder，河道用这里）。
 * 矢量瓦片的线在瓦片外留了 64 单位的缓冲，裁剪时有些线会贴着缓冲区的边走一段（实测每张 z9–z12 瓦片 2–19 段），
 * 画出来就是沿经线 / 纬线笔直延伸几十公里的假线。相邻瓦片会画自己那部分，删掉不缺
 */
function insideTile(line: { x: number; y: number }[], extent: number) {
  const parts: { x: number; y: number }[][] = [];
  let cur: { x: number; y: number }[] = [];
  for (let i = 0; i + 1 < line.length; i++) {
    const a = line[i], b = line[i + 1];
    const out = (a.x < 0 && b.x < 0) || (a.x > extent && b.x > extent) || (a.y < 0 && b.y < 0) || (a.y > extent && b.y > extent);
    if (out) {
      if (cur.length > 1) parts.push(cur);
      cur = [];
      continue;
    }
    if (cur.length === 0) cur.push(a);
    cur.push(b);
  }
  if (cur.length > 1) parts.push(cur);
  return parts;
}

const vectors = new Lru<Promise<WaterFeatures | null>>(800);

// OpenMapTiles 的 waterway 没有宽度字段，按类别估计（米）
const WATERWAY_WIDTH: Record<string, number> = { river: 60, canal: 25, stream: 6, drain: 3, ditch: 2 };

export function loadWater(z: number, x: number, y: number): Promise<WaterFeatures | null> {
  const key = `${z}/${x}/${y}`;
  let p = vectors.get(key);
  if (!p) {
    p = vectorUrl(z, x, y)
      .then((url) => fetch(url, { mode: "cors" }))
      .then((r) => (r.ok ? r.arrayBuffer() : null))
      .then((buf) => {
        if (!buf) return null;
        const tile = new VectorTile(new PbfReader(buf));
        const out: WaterFeatures = { extent: 4096, polygons: [], lines: [], roads: null };
        const water = tile.layers.water;
        if (water) {
          out.extent = water.extent;
          for (let i = 0; i < water.length; i++) {
            const f = water.feature(i);
            if (f.type !== 3) continue;
            out.polygons.push({ rings: f.loadGeometry(), ocean: f.properties.class === "ocean" });
          }
        }
        const ways = tile.layers.waterway;
        if (ways) {
          for (let i = 0; i < ways.length; i++) {
            const f = ways.feature(i);
            if (f.type !== 2) continue;
            const width = WATERWAY_WIDTH[String(f.properties.class)] ?? 3;
            // 同样去掉贴着缓冲区边走的段（见 insideTile，T08 顺手修）
            for (const line of f.loadGeometry()) for (const part of insideTile(line, ways.extent)) out.lines.push({ points: part, width });
          }
        }
        // 道路（T08）
        const tr = tile.layers.transportation;
        if (tr) {
          const rb = new RoadTileBuilder(tr.extent);
          for (let i = 0; i < tr.length; i++) {
            const f = tr.feature(i);
            if (f.type !== 2) continue;
            const c = ROAD_CLASS[String(f.properties.class)];
            if (!c || f.properties.brunnel === "tunnel") continue;
            // ramp = 1：互通立交 / 出入口的匝道（*_link）。T43 用它找互通，城外高速只在互通附近成片亮
            const ramp = Number(f.properties.ramp) === 1;
            for (const line of f.loadGeometry()) rb.add(line, c.width, c.weight, c.highway, ramp);
          }
          out.roads = rb.build();
        }
        return out;
      })
      .catch(() => null);
    vectors.set(key, p);
  }
  return p;
}
