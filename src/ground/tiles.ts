import { VectorTile } from "@mapbox/vector-tile";
import { PbfReader } from "pbf";
import { RoadTileBuilder, WaterTileBuilder, type RoadTileData, type WaterTileData } from "./road-raster";

/**
 * 瓦片数据源（全部免费，浏览器直连，均允许跨域；请求头不带任何个人信息）：
 * - 影像：EOX Sentinel-2 cloudless 2025（CC BY-NC-SA 4.0，需署名；个人非商业使用；G01 从 2020 换来）
 * - 高清细节（G03，只在日本、低空 / 看机翼、流速 ≤ 2× 的白天用于最细两级）：国土地理院 全国最新写真（シームレス）
 *   （国土地理院コンテンツ利用規約，出典「国土地理院」+ 地理院タイル一覧的链接；我们把它加工成细节层，要写明加工）
 * - 地形：AWS Terrain Tiles（Mapzen Terrarium 编码，开放数据）
 * - 水体、道路：OpenFreeMap 矢量瓦片（OpenMapTiles schema，© OpenStreetMap contributors，ODbL）；
 *   道路（T08 夜间灯带）取 transportation 图层，和水体同一张瓦片、同一次请求
 * - 夜光：NASA Black Marble（VIIRS 2016，GIBS，公有领域），最高 z8（约 500 m/像素）
 * 许可原文与出处见 README「数据来源与许可」、research/IMAGERY.md §2。
 */

/**
 * 影像源（G02）：地址模板、最高缩放级、覆盖范围、占位图识别、署名。
 * 限速 / 并发按站点（host）走 HOST_LIMITS，同一站点的几个源共用一个令牌桶。
 */
export interface ImagerySource {
  id: string;
  url: (z: number, x: number, y: number) => string;
  /** 这一级以上只是放大，不请求 */
  maxZoom: number;
  /** 粗略覆盖范围：若干个 [南, 西, 北, 东]（度）框，范围外直接不请求。框内没有数据的地方靠 404 负缓存 */
  bounds?: [number, number, number, number][];
  /**
   * 海上没有数据（返回 404）：调用方拿同一级的地形（DEM 海底）先筛掉整张都是海的瓦片再请求。
   * 为什么要筛：浏览器把每个 404 都在控制台记一条「Failed to load resource」error（JS 拦不住），负缓存只能让它每张只出一次
   */
  seaMissing?: boolean;
  /**
   * 占位图识别（留给 Esri 这类「缺数据返回 200 + 同一张占位图」的源，研究见 research/IMAGERY.md §2.1）：
   * 返回 true 视为「确定没有」，和 404 一样负缓存。本次接入的 EOX / GSI 缺数据都是 404，不需要
   */
  isPlaceholder?: (blob: Blob) => boolean | Promise<boolean>;
  /** 面板 / README 的署名（原文见 README「数据来源与许可」） */
  attribution: string;
}

/** EOX 年份：默认 2025（G01 选定，理由见 handoff/G01-03.md）；URL `?eox=2020|2024|…` 可临时切回做 A/B 对照 */
const EOX_YEARS = ["2017", "2018", "2019", "2020", "2021", "2022", "2023", "2024", "2025"];
const EOX_YEAR = (() => {
  try {
    const y = new URLSearchParams(globalThis.location?.search ?? "").get("eox");
    return y && EOX_YEARS.includes(y) ? y : "2025";
  } catch {
    return "2025";
  }
})();

/** 面板署名跟着 ?eox= 切年份走（审查 S4）：index.html 里写的是默认的 2025 */
try {
  if (EOX_YEAR !== "2025") {
    const el = globalThis.document?.getElementById("credit-eox");
    if (el) el.textContent = `Sentinel-2 cloudless ${EOX_YEAR}`;
  }
} catch {
  /* 没有 DOM（不该发生：tiles.ts 只在主线程用）就算了 */
}

export const EOX_S2: ImagerySource = {
  id: `eox-s2-${EOX_YEAR}`,
  url: (z, x, y) => `https://tiles.maps.eox.at/wmts/1.0.0/s2cloudless-${EOX_YEAR}_3857/default/g/${z}/${y}/${x}.jpg`,
  // z14 ≈ 10 m/像素，就是 Sentinel-2 的原生分辨率；更高的级别只是放大，没有新信息
  maxZoom: 14,
  attribution: `Sentinel-2 cloudless ${EOX_YEAR} by EOX IT Services GmbH (Contains modified Copernicus Sentinel data ${EOX_YEAR})，CC BY-NC-SA 4.0`,
};

/**
 * 国土地理院 全国最新写真（シームレス）（G03）：航拍正射影像，z14 起约 7–8 m/像素仍是航拍（z13 及更粗由卫星影像等拼成，偏蓝白）。
 * 日本以外、海上返回 404（带 CORS 头，能读到状态码），走负缓存。框故意取粗（审查 S1：细框漏了佐渡北半、粟岛、纪伊半岛东南岸、隐岐岛后），
 * 只负责挡住朝鲜半岛（含郁陵岛、济州岛）、中国大陆、台湾、萨哈林、俄罗斯滨海；框里的海面由调用方按 DEM 筛掉（seaMissing），
 * 剩下偶发的 404（北方领土等 GSI 可能没数据的地方）由负缓存兜住，每张只出一次
 */
export const GSI_PHOTO: ImagerySource = {
  id: "gsi-seamlessphoto",
  url: (z, x, y) => `https://cyberjapandata.gsi.go.jp/xyz/seamlessphoto/${z}/${x}/${y}.jpg`,
  maxZoom: 18,
  bounds: [
    [30.0, 129.1, 34.8, 132.3], // 九州（含对马、五岛；北界 34.8 挡釜山 35.1°N，西界挡济州岛）
    [32.5, 130.8, 37.0, 136.6], // 中国、四国、近畿（含隐岐、纪伊半岛全境；北界 37.0 挡郁陵岛 37.5°N、独岛 37.24°N）
    [33.0, 135.5, 41.6, 142.6], // 中部、关东、东北（含佐渡、粟岛、伊豆半岛）
    [41.0, 139.0, 45.8, 148.9], // 北海道（北界 45.8 挡萨哈林南端 45.9°N）
    [24.0, 122.9, 30.9, 131.5], // 南西诸岛（西界挡台湾）
    [24.0, 138.5, 33.0, 142.6], // 伊豆诸岛、小笠原
  ],
  seaMissing: true,
  attribution: "国土地理院（地理院タイル・全国最新写真（シームレス）を加工して作成）",
};

/** 旧接口：clipmap 以外的地方仍按 EOX 取（和 EOX_S2 一致） */
export const IMAGERY_URL = EOX_S2.url;
export const IMAGERY_MAX_ZOOM = EOX_S2.maxZoom;

/** (lat, lon) 在不在这个源的覆盖框里；margin（度）把框往外放宽，判断「一片区域和框有没有交集」时用 */
export function inBounds(src: ImagerySource, lat: number, lon: number, margin = 0) {
  const b = src.bounds;
  return !b || b.some(([s, w, n, e]) => lat >= s - margin && lat <= n + margin && lon >= w - margin && lon <= e + margin);
}

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
  has(k: string) {
    return this.map.has(k);
  }
}

// ---- 按站点限速（G02）：令牌桶（每分钟配额 + 突发量）+ 并发上限，排队按先来后到 ----
// 数值是礼貌上限，不是各服务公布的额度（都没公布，见 research/IMAGERY.md §2）：
// - EOX：正常飞行启动时 7 级一次要两三百张，要放得下；60× 航程实测约 550/分（T19a），上限留一倍余量。
//   限流的真正手段仍是 setMinLevel（加速时停用细级别），这里只防失控
// - 国土地理院：只在低空取最细两级，一次最多几十张；按礼貌节流给得紧一些
// - 其他站点（地形 / 夜光 / 矢量）：只限并发，不限速
interface HostLimit {
  perMin: number;
  burst: number;
  concurrent: number;
}
const HOST_LIMITS: Record<string, HostLimit> = {
  "tiles.maps.eox.at": { perMin: 1200, burst: 400, concurrent: 32 },
  "cyberjapandata.gsi.go.jp": { perMin: 300, burst: 80, concurrent: 6 },
};
const DEFAULT_LIMIT: HostLimit = { perMin: 1e6, burst: 1e6, concurrent: 16 };

/** 每个站点的请求统计（`__voyage.ground.imageryStats`；T19a 的 requestsPerRealMin 是浏览器侧计数，这里多了结果分类） */
export interface HostStats {
  /** 真正发出去的请求 */
  requests: number;
  ok: number;
  /** 确定没有（404 / 410 / 占位图），已负缓存 */
  missing: number;
  /** 命中负缓存、没有再发的次数 */
  missingSkipped: number;
  /** 429 / 5xx：不缓存，下次重建再试 */
  throttled: number;
  /** 网络错误（含限流时不带 CORS 头的错误页，浏览器报成 CORS 失败）：不缓存 */
  failed: number;
  /** 当前在排队（令牌或并发不够）的数量、历史最大值 */
  queued: number;
  queuedMax: number;
  inFlight: number;
  /** 最近几张「确定没有」的瓦片地址（排查用，最多 16 条） */
  recentMissing: string[];
}

class HostGate {
  readonly stats: HostStats = { requests: 0, ok: 0, missing: 0, missingSkipped: 0, throttled: 0, failed: 0, queued: 0, queuedMax: 0, inFlight: 0, recentMissing: [] };
  private tokens: number;
  private last = performance.now();
  private waiters: (() => void)[] = [];
  private timer: ReturnType<typeof setTimeout> | null = null;
  constructor(private readonly lim: HostLimit) {
    this.tokens = lim.burst;
  }
  private refill() {
    const now = performance.now();
    this.tokens = Math.min(this.lim.burst, this.tokens + ((now - this.last) / 60000) * this.lim.perMin);
    this.last = now;
  }
  private pump() {
    this.refill();
    while (this.waiters.length && this.stats.inFlight < this.lim.concurrent && this.tokens >= 1) {
      this.tokens -= 1;
      this.stats.inFlight++;
      this.stats.queued--;
      this.waiters.shift()!();
    }
    // 还有人在等且是缺令牌（不是缺并发槽）：定时再来
    if (this.waiters.length && this.stats.inFlight < this.lim.concurrent && !this.timer) {
      const ms = Math.max(5, ((1 - this.tokens) / this.lim.perMin) * 60000);
      this.timer = setTimeout(() => {
        this.timer = null;
        this.pump();
      }, ms);
    }
  }
  acquire(): Promise<void> {
    return new Promise((resolve) => {
      this.waiters.push(resolve);
      this.stats.queued++;
      this.stats.queuedMax = Math.max(this.stats.queuedMax, this.stats.queued);
      this.pump();
    });
  }
  release() {
    this.stats.inFlight--;
    this.pump();
  }
}

const gates = new Map<string, HostGate>();
function gateOf(url: string) {
  const host = new URL(url).host;
  let g = gates.get(host);
  if (!g) gates.set(host, (g = new HostGate(HOST_LIMITS[host] ?? DEFAULT_LIMIT)));
  return g;
}

/** 各站点的请求统计快照（调试 / 验收用） */
export function imageryStats(): Record<string, HostStats> {
  return Object.fromEntries([...gates].map(([h, g]) => [h, { ...g.stats, recentMissing: [...g.stats.recentMissing] }]));
}

const bitmaps = new Lru<Promise<ImageBitmap | null>>(1500);
/**
 * 「确定没有」的瓦片（G02）：404 / 410、占位图。记住不再请求——GSI 出了日本、海上每次重建都会返回几十个 404，
 * 以前失败一律不缓存（为了网络抖动 / 限流后能重试），出了日本就反复白发。网络错误、429 / 5xx 仍不缓存，下次重建再试
 */
const missing = new Lru<true>(20000);
function markMissing(gate: HostGate, url: string) {
  missing.set(url, true);
  gate.stats.missing++;
  const r = gate.stats.recentMissing;
  r.push(url);
  if (r.length > 16) r.shift();
}

/**
 * 加载图片瓦片；取不到返回 null（调用方留透明、由着色器回退到粗一级，或用兜底颜色）。
 * source 给了就用它的占位图识别；按站点限速与并发（HOST_LIMITS）
 */
export function loadBitmap(url: string, source?: ImagerySource): Promise<ImageBitmap | null> {
  const gate = gateOf(url);
  if (missing.has(url)) {
    gate.stats.missingSkipped++;
    return Promise.resolve(null);
  }
  let p = bitmaps.get(url);
  if (!p) {
    p = (async () => {
      await gate.acquire();
      gate.stats.requests++;
      try {
        const r = await fetch(url, { mode: "cors" });
        if (r.status === 404 || r.status === 410) {
          markMissing(gate, url);
          return null;
        }
        if (!r.ok) {
          gate.stats.throttled++;
          return null;
        }
        const blob = await r.blob();
        if (source?.isPlaceholder && (await source.isPlaceholder(blob))) {
          markMissing(gate, url);
          return null;
        }
        const bmp = await createImageBitmap(blob);
        gate.stats.ok++;
        return bmp;
      } catch {
        gate.stats.failed++;
        return null;
      } finally {
        gate.release();
      }
    })();
    bitmaps.set(url, p);
    // 失败（网络错误、限流、确定没有）都不放在位图缓存里：前两种下次重建时再试，确定没有的由 missing 挡住
    const key = url;
    p.then((b) => {
      if (!b) bitmaps.delete(key);
    });
  }
  return p;
}

/** 按影像源取一张瓦片（覆盖范围由调用方先用 inBounds 判断，见 clipmap.buildImagery） */
export function loadImageryTile(src: ImagerySource, z: number, x: number, y: number): Promise<ImageBitmap | null> {
  return loadBitmap(src.url(z, x, y), src);
}

export interface WaterFeatures {
  extent: number;
  /** 水体 / 河道（PERF-9）：攒成扁平数组（见 road-raster.ts 的 WaterTileData），直接交给栅格化 Worker，
   * 不再在主线程用 Path2D 画 + getImageData 读回（CDP CPU 剖析显示这是尖峰帧里最大的一块，见 handoff/PERF-9.md） */
  water: WaterTileData;
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
        let extent = 4096;
        const wtb = new WaterTileBuilder();
        const water = tile.layers.water;
        if (water) {
          extent = water.extent;
          for (let i = 0; i < water.length; i++) {
            const f = water.feature(i);
            if (f.type !== 3) continue;
            wtb.addPolygon(f.loadGeometry(), f.properties.class === "ocean");
          }
        }
        const ways = tile.layers.waterway;
        if (ways) {
          for (let i = 0; i < ways.length; i++) {
            const f = ways.feature(i);
            if (f.type !== 2) continue;
            const width = WATERWAY_WIDTH[String(f.properties.class)] ?? 3;
            // 同样去掉贴着缓冲区边走的段（见 insideTile，T08 顺手修）
            for (const line of f.loadGeometry()) for (const part of insideTile(line, ways.extent)) wtb.addLine(part, width);
          }
        }
        const out: WaterFeatures = { extent, water: wtb.build(extent), roads: null };
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
