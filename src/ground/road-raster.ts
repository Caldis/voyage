import { LocalFrame, tileXToLon, tileYToLat } from "./geo";

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
}

/** 一级 clipmap 的栅格化任务 */
export interface RoadJob {
  res: number;
  lat0: number;
  lon0: number;
  /** 这一级左上角的本地坐标（km）与边长（km） */
  x0: number;
  z0: number;
  size: number;
  zoom: number;
  tiles: { x: number; y: number; data: RoadTileData }[];
}

/** 一级的像素数据（RES² × RGBA，getImageData 的结果）：在 Worker 里就地写入道路，再原样转移回主线程 */
export interface LevelPixels {
  /** 水体遮罩：R 水面、G 海洋；这里写 B = 夜光、A = 道路有向距离 */
  water: Uint8ClampedArray;
  /** 影像：A 通道兼存道路照亮宽度（见 packRoads） */
  albedo: Uint8ClampedArray;
  /** 夜光（buildNight 的结果，R 通道） */
  night: Uint8ClampedArray;
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
  constructor(private readonly extent: number) {}

  add(line: { x: number; y: number }[], width: number, weight: number, highway: boolean) {
    const E = this.extent;
    let open = false;
    for (let i = 0; i + 1 < line.length; i++) {
      const a = line[i], b = line[i + 1];
      const out = (a.x < 0 && b.x < 0) || (a.x > E && b.x > E) || (a.y < 0 && b.y < 0) || (a.y > E && b.y > E);
      if (out) {
        if (open) this.close(width, weight, highway);
        open = false;
        continue;
      }
      if (!open) this.xy.push(a.x, a.y);
      this.xy.push(b.x, b.y);
      open = true;
    }
    if (open) this.close(width, weight, highway);
  }

  private close(width: number, weight: number, highway: boolean) {
    this.start.push(this.xy.length / 2);
    this.width.push(width);
    this.weight.push(weight);
    this.highway.push(highway ? 1 : 0);
  }

  build(): RoadTileData {
    return {
      extent: this.extent,
      xy: new Float32Array(this.xy),
      start: new Uint32Array(this.start),
      width: new Float32Array(this.width),
      weight: new Float32Array(this.weight),
      highway: new Uint8Array(this.highway),
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
      for (let i = 0; i + 1 < m; i++) segment(pts[2 * i], pts[2 * i + 1], pts[2 * i + 2], pts[2 * i + 3], width, hwy);
    }
  }
  const { water, albedo, night } = px;
  const ks = 255 / (2 * R), kw = 127 / ROAD_W_MAX / 255;
  for (let i = 0; i < RES * RES; i++) {
    const i4 = i * 4;
    const n = night[i4];
    water[i4 + 2] = n;
    water[i4 + 3] = 127.5 + sd[i] * ks; // Uint8ClampedArray：写入时自动四舍五入并截到 0..255
    const a = albedo[i4 + 3];
    albedo[i4 + 3] = a < 128 ? a >> 1 : 128 + Math.min(w[i] * (hw[i] ? ROAD_LIT_HIGHWAY[n] : ROAD_LIT_OTHER[n]) * kw, 127);
  }
}

function smooth(e0: number, e1: number, x: number) {
  const t = Math.min(Math.max((x - e0) / (e1 - e0), 0), 1);
  return t * t * (3 - 2 * t);
}

/**
 * 路灯亮不亮（0..255，按夜光 0..255 查表）。数据里没有「有没有路灯」这一项，不去编，由夜光（NASA Black Marble）决定：
 * - 普通道路只在有人居住、夜光亮起来的地方亮（乡间公路基本不装路灯），没有夜光的地方宁可暗；
 * - 高速 / 快速路在城区外也留约 2 成（互通立交、收费站的照明和车流的前灯尾灯），城市之间仍是一条连续的淡线，进城后变亮。
 * 两处阈值是经验取值，按夜景截图调的。
 */
export const ROAD_LIT_HIGHWAY = new Uint16Array(256).map((_, n) => Math.round(255 * (0.2 + 0.8 * smooth(0.02, 0.25, n / 255))));
export const ROAD_LIT_OTHER = new Uint16Array(256).map((_, n) => Math.round(255 * smooth(0.03, 0.3, n / 255)));
