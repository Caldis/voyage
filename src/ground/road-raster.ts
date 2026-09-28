import { LocalFrame, tileXToLon, tileYToLat } from "./geo";
import { blendDetail } from "./imagery-blend";
import { buildMipChain, mipScratch } from "./mips";
import { composeTiles, make2d, readBitmap, type ComposeSpec, type DecodedCache } from "./tile-compose";

/**
 * 道路灯带的栅格（T08）：把一级 clipmap 覆盖范围里的道路折线栅格成「到最近道路中心线的有向距离」。
 * 整个过程（瓦片坐标 → 本地公里 → 像素、抽稀、逐段求距离）都在 Web Worker 里跑（road-raster.worker.ts），不占主线程：
 * 一级的道路有几万到十几万个顶点，放在主线程上实测每级 25–180 ms（投影 + 求距离），飞行中每重建一级就卡一下。
 * Worker 起不来时 clipmap.ts 退回主线程同步算。
 *
 * 为什么不直接画「覆盖率」：clipmap 一个像素在巡航高度看出去的中远处是 60–250 m，比屏幕像素在地面上的宽度大 2–3 倍，
 * 覆盖率图双线性放大后每条路都是 2 个纹素宽的软带子（实测 4–6 个屏幕像素），糊。
 * 改存有向距离（在线的右侧为正、左侧为负，单位纹素）：它在线两侧是线性的，双线性插值能在纹素以内准确还原线的位置，
 * 着色器再按屏幕像素的足迹做解析的抗锯齿，得到细而准的线（和 SDF 字体同一个道理）。
 * 另存这条路的「照亮宽度」w（米，= 照明强度 × 路宽，只写在离中心线 ROAD_MASK_TEXELS 以内）：它同时当遮罩用，
 * 把有向距离在两条路之间、或在路的负侧与「无路」之间跳变时插值出来的假零点（假线）挡掉。
 *
 * PERF-9 起，这个 Worker 也顺带把水体/河道栅格化（`buildGroundLevel`）与夜光的逐像素变换（`darkenNight`）
 * 一起搬了进来：CDP CPU 剖析（route-hnd-cts 60× 加速航程）发现这两步在主线程用 Path2D + `getImageData` 做，
 * 是尖峰帧里最大的一块（getImageData 本身、逐顶点投影、canvas 填充/描边的原生开销），见 handoff/PERF-9.md。
 * 水体/河道的几何在 `WaterTileData`（tiles.ts 用 `WaterTileBuilder` 攒好，格式对齐 `RoadTileData`）。
 */

/** 有向距离的编码范围（± 纹素）；ground.glsl.ts 的 ROAD_SD_RANGE 要一致 */
export const ROAD_SD_RANGE = 4;
/** 照亮宽度只写在离中心线这么多纹素以内（兼当假线遮罩） */
export const ROAD_MASK_TEXELS = 2;
/** 照亮宽度的编码上限（米）；ground.glsl.ts 的 ROAD_W_MAX 要一致 */
export const ROAD_W_MAX = 40;

/** 一张矢量瓦片里的道路（tiles.ts 加载时攒好）：xy = 顶点的瓦片内坐标（交错存放），start[i]..start[i+1] 是第 i 条折线 */
export interface RoadTileData {
  extent: number;
  xy: Float32Array;
  start: Uint32Array;
  /** 照亮宽度（米，一条线） */
  width: Float32Array;
  /** 照明强度 0..1 */
  weight: Float32Array;
  highway: Uint8Array;
  /** 1 = 高速 / 快速路的匝道（互通立交、出入口；T43 用来找互通） */
  ramp: Uint8Array;
}

/**
 * 一张矢量瓦片里的水体 / 河道（tiles.ts 加载时攒好，PERF-9）：xy = 多边形顶点（交错存放），
 * ringStart[i]..ringStart[i+1] 是第 i 个环的顶点范围，polyRingStart[p]..polyRingStart[p+1] 是第 p 个多边形
 * 占用的环序号范围（一个多边形可以有多个环：外环 + 内环/岛中岛），polyOcean[p] 标这个多边形是不是海洋。
 * 河道另存一套折线（lxy/lineStart/lineWidth，和道路用的格式同一个道理）。
 * 拆成扁平数组是为了能整批 `postMessage` 转移/复制到 Worker 里用 OffscreenCanvas 栅格化（PERF-9：这一步
 * 原来在主线程用 Path2D 画 + `getImageData` 读回，实测是 route-hnd-cts 60× 加速航程下最大的一块尖峰，见 handoff/PERF-9.md）。
 */
export interface WaterTileData {
  extent: number;
  xy: Float32Array;
  ringStart: Uint32Array;
  polyRingStart: Uint32Array;
  /** 每个多边形是不是海洋（海洋画黄、湖泊河流画红，见 buildGroundLevel） */
  polyOcean: Uint8Array;
  lxy: Float32Array;
  lineStart: Uint32Array;
  /** 河宽（米，一条线） */
  lineWidth: Float32Array;
}

/** 攒 WaterTileData（tiles.ts 用），写法对齐 RoadTileBuilder */
export class WaterTileBuilder {
  private xy: number[] = [];
  private ringStart: number[] = [0];
  private polyRingStart: number[] = [0];
  private polyOcean: number[] = [];
  private lxy: number[] = [];
  private lineStart: number[] = [0];
  private lineWidth: number[] = [];

  /** rings：外环 + 若干内环（同一个多边形，evenodd 填充） */
  addPolygon(rings: { x: number; y: number }[][], ocean: boolean) {
    for (const ring of rings) {
      for (const p of ring) this.xy.push(p.x, p.y);
      this.ringStart.push(this.xy.length / 2);
    }
    this.polyRingStart.push(this.ringStart.length - 1);
    this.polyOcean.push(ocean ? 1 : 0);
  }

  addLine(points: { x: number; y: number }[], width: number) {
    for (const p of points) this.lxy.push(p.x, p.y);
    this.lineStart.push(this.lxy.length / 2);
    this.lineWidth.push(width);
  }

  build(extent: number): WaterTileData {
    return {
      extent,
      xy: new Float32Array(this.xy),
      ringStart: new Uint32Array(this.ringStart),
      polyRingStart: new Uint32Array(this.polyRingStart),
      polyOcean: new Uint8Array(this.polyOcean),
      lxy: new Float32Array(this.lxy),
      lineStart: new Uint32Array(this.lineStart),
      lineWidth: new Float32Array(this.lineWidth),
    };
  }
}

/** 一级 clipmap 的栅格化任务 */
export interface RoadJob {
  res: number;
  /** 夜光原图（nightRaw）的边长（G06：夜光按 1024 取、在这里放大到 res） */
  nightRes: number;
  lat0: number;
  lon0: number;
  /** 这一级左上角的本地坐标（km）与边长（km） */
  x0: number;
  z0: number;
  size: number;
  zoom: number;
  tiles: { x: number; y: number; data: RoadTileData }[];
  /** 同一批瓦片的水体 / 河道几何（PERF-9，和道路一起搬进 Worker 合成，见 buildGroundLevel） */
  water: { x: number; y: number; data: WaterTileData }[];
  /** 河道折线的最大画宽（米，TR03）：不给 = 按类别估计的宽度原样画（飞机）；火车模式给一个小值，见 GroundClipmap.waterwayMaxM */
  waterwayMaxM?: number;
  /** G07：顺带生成影像 / 水体这一层的 mip 链（mips.ts），主线程按层按级上传、不再调整个数组的 generateMipmap */
  mips?: boolean;
  /** G07b：影像 mip 的浮点临时缓冲是否复用（默认复用；false = G07 的每级新分配，同页 A/B 用） */
  mipScratch?: boolean;
  /** G07b：水体画布用 CPU 栅格（willReadFrequently，默认）；false = G07 及以前的 GPU 画布（同页 A/B 用） */
  waterCpu?: boolean;
}

/** 一级的像素数据（RES² × RGBA，getImageData 的结果）：在 Worker 里就地写入道路，再原样转移回主线程 */
export interface LevelPixels {
  /** 水体遮罩：R 水面、G 海洋；这里写 B = 夜光、A = 道路有向距离 */
  water: Uint8ClampedArray;
  /** 影像：A 通道兼存道路照亮宽度（见 packRoads） */
  albedo: Uint8ClampedArray;
  /** 夜光（buildNight 的结果减蓝底、放大到 RES²，单通道，G06 起不再是 RGBA 交错） */
  night: Uint8ClampedArray;
  /**
   * 判建成区（聚落地毯）用的影像：混高清细节之前的纯 EOX（G03 审查 R1）。不给就用 albedo。
   * 这样 A 通道的道路照亮宽度与细节层完全无关——细节层开关、黄昏时最细两级重建，路灯都不会换一版
   */
  urbanAlbedo?: Uint8ClampedArray;
}

/**
 * 把一张瓦片的道路攒成扁平数组（tiles.ts 用）。先去掉整段落在瓦片以外（缓冲区里）的线段，把折线在那里断开：
 * 矢量瓦片的线在瓦片外留了 64 单位的缓冲，裁剪时有些线会贴着缓冲区的边走一段（实测每张 z9–z12 瓦片 2–19 段），
 * 画出来就是沿经线 / 纬线笔直延伸几十公里的假路（从舷窗斜看是一条横贯画面的水平亮线）。相邻瓦片会画自己那部分，删掉不缺
 */
export class RoadTileBuilder {
  private xy: number[] = [];
  private start: number[] = [0];
  private width: number[] = [];
  private weight: number[] = [];
  private highway: number[] = [];
  private ramp: number[] = [];
  constructor(private readonly extent: number) {}

  add(line: { x: number; y: number }[], width: number, weight: number, highway: boolean, ramp = false) {
    const E = this.extent;
    let open = false;
    for (let i = 0; i + 1 < line.length; i++) {
      const a = line[i], b = line[i + 1];
      const out = (a.x < 0 && b.x < 0) || (a.x > E && b.x > E) || (a.y < 0 && b.y < 0) || (a.y > E && b.y > E);
      if (out) {
        if (open) this.close(width, weight, highway, ramp);
        open = false;
        continue;
      }
      if (!open) this.xy.push(a.x, a.y);
      this.xy.push(b.x, b.y);
      open = true;
    }
    if (open) this.close(width, weight, highway, ramp);
  }

  private close(width: number, weight: number, highway: boolean, ramp: boolean) {
    this.start.push(this.xy.length / 2);
    this.width.push(width);
    this.weight.push(weight);
    this.highway.push(highway ? 1 : 0);
    this.ramp.push(highway && ramp ? 1 : 0);
  }

  build(): RoadTileData {
    return {
      extent: this.extent,
      xy: new Float32Array(this.xy),
      start: new Uint32Array(this.start),
      width: new Float32Array(this.width),
      weight: new Float32Array(this.weight),
      highway: new Uint8Array(this.highway),
      ramp: new Uint8Array(this.ramp),
    };
  }
}

/** 相邻保留顶点至少隔这么多像素：粗级别上一条路几百个顶点挤在几个像素里，逐段求距离的开销全浪费在这里 */
const MIN_STEP_PX = 0.75;

/**
 * 栅格化一级的道路并写进这一级的像素（就地修改 px.water / px.albedo）：
 * - 水体纹理 B = 夜光（原来 clipmap.build 里做的那一步，挪到这里一起做，省掉主线程上一遍 1M 像素的循环）；
 * - 水体纹理 A = 到最近道路中心线的有向距离：0.5 + sd / (2·ROAD_SD_RANGE)，没有路的地方是 1；
 * - 影像纹理 A 兼存道路照亮宽度：原来的含义「这里有没有影像」保留——没有影像（alpha < 128，瓦片没取到）时存 alpha / 2
 *   （着色器按 A·2 还原成原来的覆盖比例），有影像时存 128 + 照亮宽度 × 路灯亮不亮（按夜光查表）的 7 位编码。
 */
export function packRoads(job: RoadJob, px: LevelPixels) {
  const RES = job.res;
  const R = ROAD_SD_RANGE;
  const frame = new LocalFrame(job.lat0, job.lon0);
  const k = RES / job.size;
  const texelM = (job.size / RES) * 1000;
  const sd = new Float32Array(RES * RES).fill(R);
  const dist = new Float32Array(RES * RES).fill(R);
  const w = new Float32Array(RES * RES);
  const hw = new Uint8Array(RES * RES);
  let pts = new Float32Array(2 * 4096);
  // 互通立交（T43）：高速 / 快速路匝道经过的格子（格子约 250 m，太粗的级别上至少 1 像素）
  const cellPx = Math.max(1, RAMP_CELL_KM * k);
  const GN = Math.ceil(RES / cellPx);
  const rampCells = new Uint8Array(GN * GN);
  let anyRamp = false;
  const markRamp = (ax: number, ay: number, bx: number, by: number) => {
    const len = Math.hypot(bx - ax, by - ay);
    const steps = Math.max(1, Math.ceil(len / (0.5 * cellPx)));
    for (let s = 0; s <= steps; s++) {
      const cx = Math.floor((ax + ((bx - ax) * s) / steps) / cellPx), cy = Math.floor((ay + ((by - ay) * s) / steps) / cellPx);
      if (cx < 0 || cy < 0 || cx >= GN || cy >= GN) continue;
      rampCells[cy * GN + cx] = 1;
      anyRamp = true;
    }
  };

  const segment = (ax: number, ay: number, bx: number, by: number, width: number, hwy: number) => {
    const dx = bx - ax, dy = by - ay;
    const len2 = dx * dx + dy * dy;
    if (len2 < 1e-8) return;
    const x0 = Math.max(0, Math.floor(Math.min(ax, bx) - R)), x1 = Math.min(RES - 1, Math.ceil(Math.max(ax, bx) + R));
    const y0 = Math.max(0, Math.floor(Math.min(ay, by) - R)), y1 = Math.min(RES - 1, Math.ceil(Math.max(ay, by) + R));
    const inv = 1 / len2;
    for (let py = y0; py <= y1; py++) {
      const cy = py + 0.5 - ay;
      const row = py * RES;
      for (let qx = x0; qx <= x1; qx++) {
        const cx = qx + 0.5 - ax;
        let t = (cx * dx + cy * dy) * inv;
        t = t < 0 ? 0 : t > 1 ? 1 : t;
        const ex = cx - t * dx, ey = cy - t * dy;
        const d2 = ex * ex + ey * ey;
        const kk = row + qx;
        const cur = dist[kk];
        if (d2 >= cur * cur) continue;
        const d = Math.sqrt(d2);
        dist[kk] = d;
        sd[kk] = dx * cy - dy * cx >= 0 ? d : -d;
        w[kk] = d < ROAD_MASK_TEXELS ? width : 0;
        hw[kk] = hwy;
      }
    }
  };

  for (const { x: tx, y: ty, data } of job.tiles) {
    const E = data.extent;
    const n = data.width.length;
    for (let r = 0; r < n; r++) {
      const s0 = data.start[r], s1 = data.start[r + 1];
      if (2 * (s1 - s0) > pts.length) pts = new Float32Array(4 * (s1 - s0));
      // 投影到像素并抽稀
      let m = 0, lx = 0, ly = 0;
      for (let s = s0; s < s1; s++) {
        const lat = tileYToLat(ty + data.xy[2 * s + 1] / E, job.zoom);
        const lon = tileXToLon(tx + data.xy[2 * s] / E, job.zoom);
        const [x, z] = frame.toLocal(lat, lon);
        const X = (x - job.x0) * k, Y = (z - job.z0) * k;
        if (m > 0 && s < s1 - 1 && (X - lx) * (X - lx) + (Y - ly) * (Y - ly) < MIN_STEP_PX * MIN_STEP_PX) continue;
        pts[2 * m] = X;
        pts[2 * m + 1] = Y;
        lx = X;
        ly = Y;
        m++;
      }
      if (m < 2) continue;
      // 整条折线都在这一级以外（加上距离场的范围）就跳过
      let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
      for (let i = 0; i < m; i++) {
        minX = Math.min(minX, pts[2 * i]); maxX = Math.max(maxX, pts[2 * i]);
        minY = Math.min(minY, pts[2 * i + 1]); maxY = Math.max(maxY, pts[2 * i + 1]);
      }
      if (maxX < -R || maxY < -R || minX > RES + R || minY > RES + R) continue;
      // 双向分离的高速在数据里是相隔 20–40 m 的两条线；纹素比这宽时两条线在距离场里并成一条，照亮宽度按两条算
      const hwy = data.highway[r];
      const width = data.width[r] * data.weight[r] * (hwy && data.weight[r] >= 1 && texelM > 20 ? 2 : 1);
      if (width <= 0) continue;
      if (data.ramp[r]) for (let i = 0; i + 1 < m; i++) markRamp(pts[2 * i], pts[2 * i + 1], pts[2 * i + 2], pts[2 * i + 3]);
      for (let i = 0; i + 1 < m; i++) segment(pts[2 * i], pts[2 * i + 1], pts[2 * i + 2], pts[2 * i + 3], width, hwy);
    }
  }
  const { water, albedo, night } = px;
  const ua = px.urbanAlbedo ?? albedo;

  // 聚落（T43）：和城市灯点（terrain-shading.glsl.ts 的 groundLand）同一个判据——影像里灰白、低饱和的像素是建成区，
  // 灯点亮度 ∝ 夜光² × 建成区。按约 250 m 的格子求「夜光² × 建成区」的平均，再在约 0.4 km 半径内摊平，就是这一片灯点地毯的相对亮度。
  // 为什么不只看夜光：Black Marble 是拉伸过的可视化产品，关东平原一半以上的像素 ≥ 0.45（实测，handoff/T43-night-hist.py），
  // 只按夜光的话田里的乡道也全亮——正是「像地图」的根因。影像能分出村镇和农田，夜光再给出亮度。
  const carpetCells = new Float32Array(GN * GN);
  const cellCount = new Float32Array(GN * GN);
  for (let qy = 0; qy < RES; qy++) {
    const cy = Math.min(Math.floor(qy / cellPx), GN - 1);
    for (let qx = 0; qx < RES; qx++) {
      const i4 = (qy * RES + qx) * 4;
      if (albedo[i4 + 3] < 128) continue; // 缺影像
      const c = cy * GN + Math.min(Math.floor(qx / cellPx), GN - 1);
      const nn = night[qy * RES + qx] / 255;
      cellCount[c]++;
      if (nn < 0.02) continue;
      carpetCells[c] += nn * nn * urbanOf(ua[i4], ua[i4 + 1], ua[i4 + 2]);
    }
  }
  for (let c = 0; c < GN * GN; c++) carpetCells[c] = cellCount[c] > 0 ? carpetCells[c] / cellCount[c] : 0;
  const carpet = boxBlur(carpetCells, GN, Math.max(1, Math.round(CARPET_REACH_KM / (cellPx / k))));
  // 互通：匝道经过的格子在约 0.6 km 半径内的比例，≥ 约 1/8 就算完全在互通里
  const ic = anyRamp ? boxBlur(rampCells, GN, Math.max(1, Math.round(RAMP_REACH_KM / (cellPx / k)))) : null;
  const at = (f: Float32Array, qx: number, qy: number) => {
    const fx = Math.min(Math.max((qx + 0.5) / cellPx - 0.5, 0), GN - 1), fy = Math.min(Math.max((qy + 0.5) / cellPx - 0.5, 0), GN - 1);
    const x0 = Math.floor(fx), y0 = Math.floor(fy), x1 = Math.min(x0 + 1, GN - 1), y1 = Math.min(y0 + 1, GN - 1);
    const tx = fx - x0, ty = fy - y0;
    const a = f[y0 * GN + x0] * (1 - tx) + f[y0 * GN + x1] * tx;
    const b = f[y1 * GN + x0] * (1 - tx) + f[y1 * GN + x1] * tx;
    return a * (1 - ty) + b * ty;
  };
  // 城外高速的断续段：世界坐标上的值噪声（和级别无关，各级一致）。纹素比段长还粗时淡出成平均值，免得粗级别上是采样出来的随机斑
  const segFade = smooth(0.3 * SEG_KM * 1000, 0.9 * SEG_KM * 1000, texelM);

  const ks = 255 / (2 * R), kw = 127 / ROAD_W_MAX; // lit 是 0..1
  for (let i = 0; i < RES * RES; i++) {
    const i4 = i * 4;
    const n = night[i];
    water[i4 + 2] = n;
    water[i4 + 3] = 127.5 + sd[i] * ks; // Uint8ClampedArray：写入时自动四舍五入并截到 0..255
    const a = albedo[i4 + 3];
    if (a < 128) {
      albedo[i4 + 3] = a >> 1;
      continue;
    }
    let lit = 0;
    if (w[i] > 0) {
      const qx = i % RES, qy = (i - qx) / RES;
      const cp = at(carpet, qx, qy);
      lit = cityLit(cp);
      if (hw[i]) {
        const X = job.x0 + (qx + 0.5) / k, Z = job.z0 + (qy + 0.5) / k;
        const seg = smooth(0.58, 0.68, 0.75 * vnoise(X / SEG_KM, Z / SEG_KM) + 0.25 * vnoise(X / (0.4 * SEG_KM) + 17.3, Z / (0.4 * SEG_KM) + 5.1));
        const segF = seg + (HWY_SEG_MEAN - seg) * segFade;
        lit = Math.max(lit, highwayRural(cp, ic ? smooth(0, 0.12, at(ic, qx, qy)) : 0, segF));
      }
    }
    albedo[i4 + 3] = 128 + Math.min(w[i] * lit * kw, 127);
  }
}

export type GroundLevelResult = Pick<LevelPixels, "water" | "albedo"> & {
  /** 高清细节（G03）实际用上的像素比例；没有细节层时是 0 */
  detailCoverage: number;
  /** G07：第 1 级起的 mip 链（按级连续存放，见 mips.ts）；job.mips 为假时是 null */
  albedoMips: Uint8Array | null;
  waterMips: Uint8Array | null;
  /** G07b：各阶段耗时（毫秒），归因帧尖峰用：read = 位图读回像素（影像 + 细节），mips = 两张 mip 链；
   * marks = 各阶段结束时刻（离开始多少毫秒）：read / water（水体栅格化）/ waterRead（水体 getImageData）/ detail / night / roads / mips */
  phases?: { readMs: number; mipMs: number; marks: [string, number][]; decoded?: number; hits?: number; aa?: boolean };
};

/**
 * 一级的水体 + 道路 + 夜光合成入口（PERF-9）：栅格化水体/河道（OffscreenCanvas，Worker 和主线程兜底都能用）
 * → 夜光变换 → 叠加道路（packRoads，逻辑不变）。原来这一步分散在主线程的 clipmap.ts（`buildWater` 用
 * Path2D + `getImageData`，`buildNight` 多一个逐像素变换循环）里，CDP CPU 剖析（route-hnd-cts 60× 加速航程，
 * 见 handoff/PERF-9.md）显示这是尖峰帧里最大的一块：`getImageData` 本身、逐顶点的 `tileYToLat`/`tileXToLon`
 * 投影、canvas 填充/描边的原生开销都在这里。搬进 Worker 后主线程只需要传两张已经解码好的像素数组
 * （`albedo`、`nightRaw`，两个都走 Transferable）和瓦片的几何数据（水体/河道顶点，仍然是复制——它们缓存在
 * `tiles.ts` 的 LRU 里给下次重建复用，不能转移/detach，见类头 `RoadJob.water` 注释）。
 */
/**
 * 影像 / 高清细节的来源（G08）：拼接 Worker 拼好的 RES² RGBA 像素（默认）；拼接 Worker 停用时是瓦片拼接任务（Blob，在这里解码拼接）；
 * `ground.imageryInWorker = false` 时是主线程拼好的位图（G07b 的做法，对照用）
 */
export type ImagerySrc = Uint8ClampedArray | ComposeSpec | ImageBitmap;

/**
 * 一级的完整合成（Worker 与主线程兜底共用）：影像 / 高清细节还不是像素时先拼成像素（tile-compose.ts），再走 buildGroundLevel。
 * 阶段时刻（phases.marks，离开始多少毫秒）：[eoxDecode / eoxStitch / gsiDecode / gsiStitch（自己拼时）] / read / water / waterRead / detail / night / roads / mips。
 * bad = 解码失败的瓦片地址（主线程从 Blob 缓存里删掉）
 */
export async function buildGroundLevelFrom(
  job: RoadJob,
  albedoSrc: ImagerySrc,
  nightRaw: Uint8ClampedArray,
  detailSrc: ImagerySrc | null,
  cache: DecodedCache | null,
): Promise<GroundLevelResult & { bad: string[] }> {
  const t0 = performance.now();
  const RES = job.res;
  const bad: string[] = [];
  const marks: [string, number][] = [];
  let decoded = 0, hits = 0, aa = false;
  const read = async (src: ImagerySrc, tag: string) => {
    if (src instanceof Uint8ClampedArray) return src;
    if (!("kind" in src)) return readBitmap(src, RES);
    const ts = performance.now() - t0;
    const r = await composeTiles(src, cache);
    // 解码完成、拼接 + 读回完成两个时刻（影像：decode / stitch；高清细节：gsiDecode / gsiStitch）
    marks.push([`${tag}Decode`, ts + r.decodeMs], [`${tag}Stitch`, ts + r.readMs]);
    bad.push(...r.bad);
    decoded += r.decoded;
    hits += r.hits;
    aa ||= r.aa;
    return r.px;
  };
  const albedo = await read(albedoSrc, "eox");
  const detail = detailSrc ? await read(detailSrc, "gsi") : null;
  const readMs = performance.now() - t0;
  const r = buildGroundLevel(job, albedo, nightRaw, detail, t0, marks);
  r.phases!.readMs = readMs;
  r.phases!.decoded = decoded;
  r.phases!.hits = hits;
  r.phases!.aa = aa;
  return { ...r, bad };
}

export function buildGroundLevel(
  job: RoadJob,
  albedo: Uint8ClampedArray,
  nightRaw: Uint8ClampedArray,
  detail: Uint8ClampedArray | null = null,
  t0 = performance.now(),
  marks: [string, number][] = [],
): GroundLevelResult {
  const RES = job.res;
  const mark = (name: string) => marks.push([name, performance.now() - t0]);
  mark("read");
  const readMs = performance.now() - t0;
  // G07b：水体画布走 CPU 栅格。默认的 GPU 加速画布在 getImageData 时要经 GPU 进程同步读回 16 MB，
  // 期间页面的合成 / WebGL 命令排在后面，主线程帧间隔跳到 23–31 ms（1× 巡航约 1.4 次 / 分钟，G07b-spikes.mjs 归因到 waterRead 阶段）；
  // CPU 栅格多花约 5 ms（在 Worker 里），读回只是内存拷贝。海岸线抗锯齿与 GPU 版有个别像素不同（同页 A/B 平均差 0、p99 ≤ 0.33）
  const ctx = make2d(RES, job.waterCpu !== false);
  ctx.fillStyle = "black";
  ctx.fillRect(0, 0, RES, RES);
  const frame = new LocalFrame(job.lat0, job.lon0);
  const k = RES / job.size;
  const kmPerPx = job.size / RES;
  for (const { x: tx, y: ty, data: w } of job.water) {
    const E = w.extent;
    const proj = (px: number, py: number): [number, number] => {
      const lat = tileYToLat(ty + py / E, job.zoom);
      const lon = tileXToLon(tx + px / E, job.zoom);
      const [x, z] = frame.toLocal(lat, lon);
      return [(x - job.x0) * k, (z - job.z0) * k];
    };
    for (let p = 0; p < w.polyOcean.length; p++) {
      ctx.beginPath();
      for (let r = w.polyRingStart[p]; r < w.polyRingStart[p + 1]; r++) {
        const s0 = w.ringStart[r], s1 = w.ringStart[r + 1];
        for (let s = s0; s < s1; s++) {
          const [x, y] = proj(w.xy[2 * s], w.xy[2 * s + 1]);
          if (s === s0) ctx.moveTo(x, y);
          else ctx.lineTo(x, y);
        }
        ctx.closePath();
      }
      ctx.fillStyle = w.polyOcean[p] ? "rgb(255,255,0)" : "rgb(255,0,0)";
      ctx.fill("evenodd");
    }
    ctx.lineCap = "round";
    ctx.lineJoin = "round";
    for (let l = 0; l < w.lineWidth.length; l++) {
      const s0 = w.lineStart[l], s1 = w.lineStart[l + 1];
      const widthPx = Math.min(w.lineWidth[l], job.waterwayMaxM ?? Infinity) / 1000 / kmPerPx;
      ctx.lineWidth = Math.max(widthPx, 1);
      ctx.globalAlpha = Math.min(widthPx, 1);
      ctx.strokeStyle = "rgb(255,0,0)";
      ctx.beginPath();
      for (let s = s0; s < s1; s++) {
        const [x, y] = proj(w.lxy[2 * s], w.lxy[2 * s + 1]);
        if (s === s0) ctx.moveTo(x, y);
        else ctx.lineTo(x, y);
      }
      ctx.stroke();
      ctx.globalAlpha = 1;
    }
  }
  mark("water");
  const water = ctx.getImageData(0, 0, RES, RES).data;
  mark("waterRead");
  // 高清细节（G03）：只改影像 RGB（要用上面刚栅格化的水体遮罩挡掉水面），必须在 packRoads 之前——
  // packRoads 读影像 alpha 判缺影像、再把 A 改写成道路照亮宽度编码
  const urbanAlbedo = detail ? albedo.slice() : undefined;
  const detailCoverage = detail ? blendDetail(albedo, detail, water, RES).coverage : 0;
  mark("detail");
  const night = upsample(darkenNight(nightRaw), job.nightRes, RES);
  mark("night");
  const px: LevelPixels = { water, albedo, night, urbanAlbedo };
  packRoads(job, px);
  mark("roads");
  // G07：mip 必须在 packRoads 之后算（影像 A 的覆盖比例要按最终编码解）
  const tMip = performance.now();
  mipScratch.reuse = job.mipScratch !== false;
  const albedoMips = job.mips ? buildMipChain(px.albedo, RES, "albedo") : null;
  const waterMips = job.mips ? buildMipChain(px.water, RES, "water") : null;
  const mipMs = performance.now() - tMip;
  mark("mips");
  return { water: px.water, albedo: px.albedo, detailCoverage, albedoMips, waterMips, phases: { readMs, mipMs, marks } };
}

/** Black Marble 的底图把陆地画成暗蓝色：取「亮度减去蓝色底」，只留下灯光（原来在主线程的 clipmap.ts
 * `buildNight` 里逐像素做，PERF-9 挪进这里和水体/道路一起在 Worker 里算）。输出单通道 */
function darkenNight(pxRaw: Uint8ClampedArray): Uint8ClampedArray {
  const out = new Uint8ClampedArray(pxRaw.length >> 2);
  for (let k = 0, i = 0; k < pxRaw.length; k += 4, i++) {
    const r = pxRaw[k], g = pxRaw[k + 1], b = pxRaw[k + 2];
    out[i] = Math.max(0, Math.min(255, (r * 0.6 + g * 0.4 - b * 0.35) * 1.3));
  }
  return out;
}

/** 单通道 n² → m² 双线性放大（像素中心对齐，和 canvas 按比例画上去一致；n === m 时原样返回） */
function upsample(src: Uint8ClampedArray, n: number, m: number): Uint8ClampedArray {
  if (n === m) return src;
  const out = new Uint8ClampedArray(m * m);
  const s = n / m;
  for (let y = 0; y < m; y++) {
    const fy = Math.min(Math.max((y + 0.5) * s - 0.5, 0), n - 1);
    const y0 = Math.floor(fy), y1 = Math.min(y0 + 1, n - 1), ty = fy - y0;
    const r0 = y0 * n, r1 = y1 * n;
    for (let x = 0; x < m; x++) {
      const fx = Math.min(Math.max((x + 0.5) * s - 0.5, 0), n - 1);
      const x0 = Math.floor(fx), x1 = Math.min(x0 + 1, n - 1), tx = fx - x0;
      const a = src[r0 + x0] + (src[r0 + x1] - src[r0 + x0]) * tx;
      const b = src[r1 + x0] + (src[r1 + x1] - src[r1 + x0]) * tx;
      out[y * m + x] = a + (b - a) * ty;
    }
  }
  return out;
}

/** GN×GN 网格的盒式平均（半径 rc 格，可分离，边界外按 0 计） */
function boxBlur(src: Uint8Array | Float32Array, GN: number, rc: number) {
  const tmp = new Float32Array(GN * GN), out = new Float32Array(GN * GN);
  for (let y = 0; y < GN; y++) {
    let acc = 0;
    for (let x = -rc; x < GN + rc; x++) {
      if (x + rc < GN && x + rc >= 0) acc += src[y * GN + x + rc];
      if (x - rc - 1 >= 0 && x - rc - 1 < GN) acc -= src[y * GN + x - rc - 1];
      if (x >= 0 && x < GN) tmp[y * GN + x] = acc;
    }
  }
  const norm = 1 / ((2 * rc + 1) * (2 * rc + 1));
  for (let x = 0; x < GN; x++) {
    let acc = 0;
    for (let y = -rc; y < GN + rc; y++) {
      if (y + rc < GN && y + rc >= 0) acc += tmp[(y + rc) * GN + x];
      if (y - rc - 1 >= 0 && y - rc - 1 < GN) acc -= tmp[(y - rc - 1) * GN + x];
      if (y >= 0 && y < GN) out[y * GN + x] = acc * norm;
    }
  }
  return out;
}

/** sRGB 8 位 → 线性（影像纹理是 SRGBColorSpace，着色器里读到的是线性值） */
const SRGB_LIN = new Float32Array(256).map((_, v) => {
  const c = v / 255;
  return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
});

/** 这个影像像素是不是建成区（0..1）：和 groundLand 的城市灯点判据一致（灰白、低饱和，再取平方、过 smoothstep(0.15, 0.5)） */
function urbanOf(r8: number, g8: number, b8: number) {
  const r = SRGB_LIN[r8], g = SRGB_LIN[g8], b = SRGB_LIN[b8];
  const lumA = 0.2126 * r + 0.7152 * g + 0.0722 * b;
  const sat = (Math.max(r, g, b) - Math.min(r, g, b)) / Math.max(lumA, 1e-3);
  let u = smooth(0.04, 0.14, lumA) * (1 - smooth(0.25, 0.7, sat));
  u *= u;
  return smooth(0.15, 0.5, u);
}

function smooth(e0: number, e1: number, x: number) {
  const t = Math.min(Math.max((x - e0) / (e1 - e0), 0), 1);
  return t * t * (3 - 2 * t);
}

function hash2(ix: number, iy: number) {
  let h = Math.imul(ix | 0, 0x27d4eb2d) ^ Math.imul(iy | 0, 0x165667b1);
  h = Math.imul(h ^ (h >>> 15), 0x85ebca6b);
  h = Math.imul(h ^ (h >>> 13), 0xc2b2ae35);
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
}

/** 二维值噪声（0..1，平滑插值） */
function vnoise(x: number, y: number) {
  const ix = Math.floor(x), iy = Math.floor(y);
  let fx = x - ix, fy = y - iy;
  fx = fx * fx * (3 - 2 * fx);
  fy = fy * fy * (3 - 2 * fy);
  const a = hash2(ix, iy), b = hash2(ix + 1, iy), c = hash2(ix, iy + 1), d = hash2(ix + 1, iy + 1);
  return (a + (b - a) * fx) * (1 - fy) + (c + (d - c) * fx) * fy;
}

/** 匝道格子边长（km）与互通的照亮半径（km）：日本的互通 / JCT 整片装高杆灯，范围约是匝道外扩几百米（经验值） */
const RAMP_CELL_KM = 0.25;
const RAMP_REACH_KM = 0.6;
/** 断续段噪声的尺度（km）与它在远处淡出时取的平均值（两层噪声过 smooth(0.58, 0.68) 后大约 1/4 是亮段） */
const SEG_KM = 0.35;
const HWY_SEG_MEAN = 0.25;

/** 聚落「地毯」的摊平半径（km） */
const CARPET_REACH_KM = 0.4;
/** 地毯亮度（夜光² × 建成区比例的片区平均）到这个值时道路满亮（市中心约 0.3–0.5） */
const CARPET_FULL = 0.7;

/**
 * 路灯亮不亮（T43 重做；T08 的版本只看夜光，见 git 历史）。数据里没有「有没有路灯」这一项，不去编，
 * 原则是**亮度跟着聚落走，不跟着路网走**，聚落亮度 cp 用和城市灯点同一个量（夜光² × 建成区，见 packRoads）：
 * - 城里（各等级，cityLit）：和 cp 成正比，这样道路和同一片灯点地毯的亮度比在市中心和郊区大致不变；
 *   cp 很小（农田、山林：影像不是建成区）时直接关——乡道默认不亮，只在村镇里亮。
 * - 城外的高速 / 快速路（highwayRural）：一串断续的亮段——互通立交（匝道附近）满亮、沿线村镇处 7 成，
 *   中间只有稀疏的短段 45%（车流、服务区、收费站；数据里没有这些位置，用噪声代表「有的地方有、有的地方没有」，只控制比例、不编造地点），
 *   整体再乘 HWY_RURAL。
 * 比例是按夜航照片和截图定的经验值（handoff/T43.md 有量化结果）。
 */
function cityLit(cp: number) {
  return Math.min(1, (cp / CARPET_FULL) ** 0.6) * smooth(0.004, 0.015, cp);
}

const HWY_RURAL = 0.08;
function highwayRural(cp: number, ic: number, seg: number) {
  const settle = smooth(0.02, 0.08, cp);
  return HWY_RURAL * Math.max(ic, 0.7 * settle, 0.45 * seg);
}
