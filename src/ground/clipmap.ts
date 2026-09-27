import * as THREE from "three";
import { LocalFrame, latToTileY, lonToTileX, tileXToLon, tileYToLat, zoomForResolution } from "./geo";
import { DEM_MAX_ZOOM, DEM_URL, EOX_S2, GSI_PHOTO, NIGHT_MAX_ZOOM, NIGHT_URL, VECTOR_MAX_ZOOM, imageryStats, inBounds, loadBitmap, loadImageryTile, loadWater } from "./tiles";
import { buildGroundLevel, type GroundLevelResult, type RoadJob } from "./road-raster";

/**
 * 地面的 clipmap：以飞机正下方为中心的 7 级方形区域，边长 8、16 … 512 km，
 * 覆盖到巡航高度看得见的地平线（约 370 km）。每级三张图：影像（反照率）、水体遮罩（B 通道存夜光亮度）、地形高度，
 * 都已经换算到本地公里坐标（x 东、z 南），着色器里直接按公里采样，不用管墨卡托。
 *
 * 飞机移动超过该级边长的 1/8 时重建这一级；重建期间这一级仍用旧数据，着色器按 valid 标志回退到粗一级。
 */

// 最细一级 8 km / 2048 ≈ 3.9 m/像素（z14 影像是 Sentinel-2 原生约 10 m，最细一级只是放大；清晰度的收益在第 1–6 级）
export const GROUND_LEVELS = 7;
export const GROUND_BASE_KM = 8;
/**
 * 影像和水体纹理的边长（G06：1024 → 2048）。研究结论（research/IMAGERY.md §1）：巡航时画面落在第 3–6 级，
 * 1024² 时每个纹素比屏幕像素在地面上的横向宽度粗约 3 倍，这才是巡航地面发糊的瓶颈（影像源不是）。
 * 级别的覆盖范围（按距离选级，groundLod）是硬约束——某个距离上只能用盖得住它的那一级，所以同一距离想要细一倍的纹素，
 * 只能把每级的像素数翻倍。配套：mipmap + 各向异性过滤（ground.glsl.ts 的 groundSampleAniso），否则纹素变细后
 * 沿视线方向（斜看时足迹是横向的 5–50 倍）欠采样更严重、飞机一动就闪。方案对比与数字见 handoff/G06.md
 */
export const GROUND_RES = 2048;
const RES = GROUND_RES;
const HRES = 256; // 地形高度
/**
 * 按多大的「每级像素数」选瓦片缩放级：影像在正常流速下按 RES 选（比 1024 时细一级），航程流速 > FINE_MAX_RATE 时按 1024 选
 * （请求量回到 G06 之前的水平，画布上放大 2 倍，60× 下看不出差别；T19a 的限流教训）。
 * 矢量（水体 / 道路）一律按 1024 选：OpenMapTiles 按缩放级取舍道路等级、简化几何，换缩放级会让夜间路网换一版（A 通道零回归），
 * 矢量本身在 2048² 上栅格化，精度不受影响
 */
const TILE_RES_COARSE = 1024;
const FINE_MAX_RATE = 2;
/** 夜光（Black Marble，约 500 m/像素）的画布边长：数据比最细一级还粗几十倍，不必跟到 2048，Worker 里双线性放大（省主线程一次 16 MB 读回） */
const NIGHT_RES = 1024;
/** 一级影像最多取多少张瓦片：2048² 时一边约 8–12 张（缩放级按四舍五入选，瓦片像素 / 纹素在 0.7–1.4 之间） */
const IMAGERY_MAX_TILES = 169;

/**
 * 高清细节层（G03）：只进最细的这几级（第 0 级 8 km、第 1 级 16 km）。研究结论（research/IMAGERY.md §1、§4.1）：
 * 这两级 EOX 是放大后用的（z14 以上没有新信息），高清源收益最大；更粗的级别 EOX 不输航拍，而且巡航时标准视角只看得到第 3–6 级。
 */
const DETAIL_LEVELS = 2;
/**
 * 每级取 GSI 的哪一级瓦片。GSI 从 z14 起才是航拍（z13 及更粗由卫星影像拼成、偏蓝白，实测）。
 * 第 0 级（7.8 m 纹素）取 z15 再 2:1 缩小：z14 的 JPEG 本身已经是缩小过的发灰图，z15 缩小后边缘明显更干净（顺带抗锯齿）；
 * 第 1 级（15.6 m）取 z14 缩小 2:1。都是「源比纹素细一级」
 */
const DETAIL_ZOOMS = [15, 14];
/** 一级最多取多少张高清瓦片（第 1 级 16 km 在 z14 上约 9×9 张；北海道纬度高、瓦片窄，到 10×10） */
const DETAIL_MAX_TILES = 121;
/** 离地高度的开关门限（km，带回差，免得在 6 km 附近来回切换、反复重建）：研究建议「离地低于约 6 km」 */
const DETAIL_AGL_ON = 5.5;
const DETAIL_AGL_OFF = 6.5;
/** 航程流速上限：> 2× 时最细级别不取高清源（60× 时这两级本来就被 setMinLevel 停用了） */
const DETAIL_MAX_RATE = 2;
/**
 * 太阳高度（sin）门限，带回差：+6° 开、+4.5° 关（审查 R1）。路灯在太阳约 +3.4° 就开始亮（groundRoadLights 的 uSunDir.y ≤ 0.06），
 * 城市灯点不看太阳、天一暗就看得见；最细两级从「带细节」换回纯 EOX 要整层重建，这一步必须在灯光看得见之前、白天里做完
 * （白天只是近处细节变淡，看不出来）。聚落地毯本身已改成用混合前的 EOX 算（road-raster.ts 的 urbanAlbedo），A 通道与细节层无关
 */
const DETAIL_SUN_ON = Math.sin((6 * Math.PI) / 180);
const DETAIL_SUN_OFF = Math.sin((4.5 * Math.PI) / 180);
/**
 * GSI 等这么久（毫秒）还没取齐就先按纯 EOX 出这一版（审查 S2）：刚进日本 / 刚降到低空时两级要 100–160 张，
 * 令牌桶排队最长约 20 s，这期间最细一级连 EOX、水体都不跟着重新居中，飞出范围后先退回粗级别发糊。
 * 没取齐时这一级记成「没有细节」，下一帧 update 发现想要细节就再建一次，瓦片已在缓存 / 在途，不会重复请求
 */
const DETAIL_WAIT_MS = 3000;

interface Level {
  size: number;
  cx: number;
  cz: number;
  valid: boolean;
  building: boolean;
  maxHeight: number;
  /** CPU 侧的粗网格（T18 高度下限 / 霾的地区统计）：GRID² 格，每格的最高点、平均高度（km）、陆地比例 */
  grid: CoarseGrid | null;
  /** 当前数据（或正在建的这一版）要没要高清细节（G03）；和「此刻要不要」不一致时触发重建 */
  detail: boolean;
  /** 实际用上高清细节的像素比例（诊断） */
  detailCoverage: number;
  /** 这一版影像是不是按 RES 选的缩放级（G06）；false = 加速航程时按 1024 选的粗一级，流速降下来后要重建 */
  fine: boolean;
}

/** 每级的粗网格边长（格数）。高度图 256² → 每格 8×8 个高度像素；水体 1024² → 每格 32×32 个像素 */
export const GRID = 32;

export interface CoarseGrid {
  cx: number;
  cz: number;
  size: number;
  /** 每格最高点（km，海底按 0） */
  max: Float32Array;
  /** 每格平均高度（km） */
  mean: Float32Array;
  /** 每格陆地比例 0..1（既不在海洋多边形里、DEM 也不低于海平面；两样数据都没取到时按陆地算，保守） */
  land: Float32Array;
}

/** terrainFloor 的结果 */
export interface TerrainFloor {
  /** 这里允许的最低海拔（km） */
  floorKm: number;
  /** 飞机正下方的地形高度（km，海面为 0） */
  groundKm: number;
  /** 有没有数据：false 时 floorKm 只是保守估计 */
  known: boolean;
}

/** 地区统计（霾用）：半径几十公里内的陆地比例、陆地平均高度 */
export interface RegionStats {
  land: number;
  meanLandKm: number;
  known: boolean;
}

/** PERF-8：一次纹理上传任务（一张纹理的一层），排队分帧上传用 */
interface UploadJob {
  tex: THREE.DataArrayTexture;
  layer: number;
  data: ArrayLike<number>;
  layerSize: number;
}

function makeCanvas(w: number, h: number) {
  const c = document.createElement("canvas");
  c.width = w;
  c.height = h;
  const ctx = c.getContext("2d", { willReadFrequently: true });
  if (!ctx) throw new Error("无法创建 2D canvas");
  return ctx;
}

export class GroundClipmap {
  readonly albedo: THREE.DataArrayTexture;
  readonly water: THREE.DataArrayTexture;
  readonly height: THREE.DataArrayTexture;
  /** 每级的 (中心 x, 中心 z, 边长, 是否可用)，着色器直接用 */
  readonly levelUniform = Array.from({ length: GROUND_LEVELS }, () => new THREE.Vector4(0, 0, 1, 0));
  private readonly levels: Level[] = Array.from({ length: GROUND_LEVELS }, (_, i) => ({
    size: GROUND_BASE_KM * 2 ** i,
    cx: NaN,
    cz: NaN,
    valid: false,
    building: false,
    maxHeight: 0,
    grid: null,
    detail: false,
    detailCoverage: 0,
    fine: false,
  }));
  private frame: LocalFrame;
  /** 航程流速（setDetailContext 传进来）：> FINE_MAX_RATE 时影像按粗一级取（G06） */
  private rate = 1;
  /** 高清细节此刻开没开（G03，setDetailContext 按高度 / 视角 / 流速 / 太阳算，带回差） */
  private detailOn = false;
  /** 上一次 update 的飞机位置（km），setDetailContext 算离地高度用 */
  private lastX = 0;
  private lastZ = 0;
  private generation = 0;
  /** 瓦片统计，面板上显示加载状态 */
  pending = 0;
  /**
   * PERF-8：一次重建有 3 张纹理（各一层）要真正上传到 GPU（texSubImage3D）。加速航程时常有几级
   * 几乎同时建完，3 次上传（8.5 MB）挤在同一个真实动画帧里，实测帧间隔尖峰到 20–60 ms（个别情形下
   * 多级叠加到 69 MB / 5 次调用、帧间隔破百毫秒），见 handoff/PERF-6-8.md 的测量。
   * 改成排队，`update()` 每帧最多真正上传其中一张（见 `drainUploads`），一个批次（同一级的 3 张）
   * 全部上传完才把这一级标记为 valid（`l.building` 也要撑到那时候才清，见 `build()`），
   * 避免着色器读到「影像已经是新的、地形还是旧的」这种半新半旧的一级。
   */
  private uploadQueue: { jobs: UploadJob[]; after: () => void }[] = [];

  /** CPU 端的高度（km），始终 32 位；GPU 纹理在不支持浮点线性过滤时存半精度（TR03 审查 B1） */
  private readonly heightCpu: Float32Array;
  private readonly floatHeight: boolean;

  /** floatHeight：设备支持 OES_texture_float_linear 时为 true（R32F 线性过滤）；否则高度纹理退回半精度 */
  constructor(lat0: number, lon0: number, floatHeight = true) {
    this.floatHeight = floatHeight;
    this.frame = new LocalFrame(lat0, lon0);
    const tex = (data: Uint8Array | Float32Array, w: number, format: THREE.PixelFormat, type: THREE.TextureDataType, mips = false) => {
      const t = new THREE.DataArrayTexture(data, w, w, GROUND_LEVELS);
      t.format = format;
      t.type = type;
      // G06：影像和水体带 mipmap + 各向异性（着色器用 textureGrad 按像素足迹取样）。每次上传一层后 three 会对整个数组
      // 重新 generateMipmap（GPU 上做，见 handoff/G06.md 的计时）。
      // 注意：两张纹理的 A 通道都是编码值（影像 A = 缺影像比例 / 道路照亮宽度，水体 A = 道路有向距离），mip 平均后没有意义，
      // 着色器里凡是读 A 的地方都必须 textureLod(…, 0.0) 只读第 0 级（groundRoadTap）；各向异性取样只用 RGB（缺影像比例例外，见 groundSampleAniso）
      t.minFilter = mips ? THREE.LinearMipmapLinearFilter : THREE.LinearFilter;
      t.magFilter = THREE.LinearFilter;
      t.wrapS = t.wrapT = THREE.ClampToEdgeWrapping;
      t.generateMipmaps = mips;
      if (mips) t.anisotropy = 16; // three 按设备上限截断
      // 一开始不上传（全是 0 的 2 × 117 MB）：第一次真正有数据时（upload）才置 true，之后按层上传
      t.source.dataReady = !mips;
      t.needsUpdate = true;
      return t;
    };
    this.albedo = tex(new Uint8Array(RES * RES * 4 * GROUND_LEVELS), RES, THREE.RGBAFormat, THREE.UnsignedByteType, true);
    this.albedo.colorSpace = THREE.SRGBColorSpace;
    this.water = tex(new Uint8Array(RES * RES * 4 * GROUND_LEVELS), RES, THREE.RGBAFormat, THREE.UnsignedByteType, true);
    // 高度用 32 位浮点（TR03）：半精度在 0.5–1 km 海拔上只有约 0.5 m 一级（1–2 km 约 1 m），飞机上看不出来；
    // 火车眼高 2.5 m 掠射时，平原被量化成一级级半米高的台地，远处地平线成了阶梯状的锯齿。
    // R32F 的线性过滤要 OES_texture_float_linear——three 只在设备支持时才启用，不支持时 R32F 线性采样读出 0、地形全丢，
    // 所以不支持时 GPU 纹理退回半精度（上传时转换），CPU 端 heightCpu 仍是 32 位（TR03 审查 B1）
    this.heightCpu = new Float32Array(HRES * HRES * GROUND_LEVELS);
    this.height = floatHeight
      ? tex(this.heightCpu, HRES, THREE.RedFormat, THREE.FloatType)
      : tex(new Uint16Array(HRES * HRES * GROUND_LEVELS) as unknown as Uint8Array, HRES, THREE.RedFormat, THREE.HalfFloatType);
  }

  get localFrame() {
    return this.frame;
  }

  /** 换了起点（换预设）：所有级别作废重建 */
  reset(lat0: number, lon0: number) {
    this.frame = new LocalFrame(lat0, lon0);
    this.generation++;
    for (const l of this.levels) {
      l.valid = false;
      l.building = false;
      l.cx = l.cz = NaN;
      l.grid = null;
      l.detail = false;
      l.detailCoverage = 0;
    }
    this.levelUniform.forEach((v) => (v.w = 0));
    // 排队里还没上传的批次都属于旧生成：马上要被新一轮重建覆盖，丢掉即可（PERF-8）
    this.uploadQueue = [];
  }

  /** 附近地形的最高点（km），给着色器的高度场求交定上界 */
  get maxHeightKm() {
    let m = 0;
    for (const l of this.levels) if (l.valid) m = Math.max(m, l.maxHeight);
    return m;
  }

  /**
   * 最细的几级停用（T19a 加速播放）：60× 时飞机每秒走 15 km，8–32 km 的细级别每一两帧就要重建一次，
   * 瓦片请求量按「飞过的距离 × 细级别数」暴涨，影像服务器会限流（实测 60× 每分钟约 7000 个 EOX 请求、上万个被拒）。
   * 停用的级别标成不可用（着色器退到更粗一级），在途的构建完成后也不再启用。
   */
  setMinLevel(n: number) {
    this.minLevel = Math.max(0, Math.min(GROUND_LEVELS - 1, n));
    for (let i = 0; i < this.minLevel; i++) {
      const l = this.levels[i];
      l.valid = false;
      l.cx = l.cz = NaN;
      l.grid = null;
      this.levelUniform[i].w = 0;
    }
  }
  private minLevel = 0;

  /**
   * 河道折线（OpenMapTiles 的 waterway，没有宽度字段，tiles.ts 按类别估：river 60 m、canal 25 m）的最大画宽（米）。
   * 飞机上无所谓；火车贴地时，一条被标成 river 的十几米小河按 60 m 画，就是铁路边一片 70 m 宽的「湖」（TR03 实测 12.65 km 处）。
   * 火车模式设成一个小值（rail/mode.ts）：宽河本来就有水面多边形（riverbank），折线只需补上没有多边形的细河道。改了要 reset() 才生效
   */
  waterwayMaxM = Infinity;

  /**
   * 高清细节层的开关条件（G03），每帧在 update 之前调用：离地 < 约 6 km 或「看机翼」视角、航程流速 ≤ 2×、白天、不在火车模式。
   * 条件变了，最细两级按新条件重建（旧数据在新的一版建好之前照常用）。不调用时一直是关的（和 G03 之前一样）
   */
  /** 调试开关：false 时高清细节层整个关掉（A/B 对照用，`__voyage.ground.detailEnabled = false`，最细两级随即按纯 EOX 重建） */
  detailEnabled = true;

  setDetailContext(altitudeKm: number, wingView: boolean, rate: number, sunDirY: number, allowed = true) {
    const on = this.detailOn;
    const agl = altitudeKm - (this.heightAt(this.lastX, this.lastZ) ?? 0);
    const low = agl < (on ? DETAIL_AGL_OFF : DETAIL_AGL_ON);
    const day = sunDirY > (on ? DETAIL_SUN_OFF : DETAIL_SUN_ON);
    this.detailOn = this.detailEnabled && allowed && (low || wingView) && rate <= DETAIL_MAX_RATE && day;
    this.rate = rate;
  }

  /** 第 i 级以 (cx, cz) 为中心时要不要高清细节 */
  private wantDetail(i: number, cx: number, cz: number) {
    if (!this.detailOn || i >= DETAIL_LEVELS) return false;
    const [lat, lon] = this.frame.toGeo(cx, cz);
    return inBounds(GSI_PHOTO, lat, lon, 0.1); // 放宽约半个第 1 级：级别中心在框外、边上压着日本也要
  }

  /** 调试 / 验收：各站点请求统计 + 各级的高清细节状态（`__voyage.ground.imageryStats`） */
  get imageryStats() {
    return {
      source: EOX_S2.id,
      detailOn: this.detailOn,
      levels: this.levels.slice(0, DETAIL_LEVELS).map((l) => ({ detail: l.detail, coverage: +l.detailCoverage.toFixed(3) })),
      fine: this.levels.map((l) => l.fine),
      worker: { ...workerStats },
      hosts: imageryStats(),
    };
  }

  /** 每帧调用：飞机当前的本地坐标（km） */
  update(x: number, z: number) {
    this.lastX = x;
    this.lastZ = z;
    // PERF-8：先把上一批排队的纹理上传推进一格（每帧最多一张），再决定要不要触发新的重建
    this.drainUploads();
    // 粗的级别先建，远景先出来
    // G06：流速 ≤ 2× 时影像按 2048² 选缩放级（fine）；加速时按 1024 选、请求量不涨。已经是 fine 的一版在加速时照常用（不为变粗重建），
    // 流速降回来以后还不是 fine 的级别重建一次
    const fine = this.rate <= FINE_MAX_RATE;
    for (let i = GROUND_LEVELS - 1; i >= this.minLevel; i--) {
      const l = this.levels[i];
      if (l.building) continue;
      const snap = l.size / 8;
      const cx = Math.round(x / snap) * snap;
      const cz = Math.round(z / snap) * snap;
      const detail = this.wantDetail(i, cx, cz);
      if (cx === l.cx && cz === l.cz && detail === l.detail && (l.fine || !fine)) continue;
      void this.build(i, cx, cz, detail, fine);
    }
  }

  /**
   * 高度下限（T18）：在 (x, z)（本地 km）周围 radiusKm 内逐格取「这一格要求的最低海拔」的最大值。
   * 陆地格要求 = 格内最高点 + aglLandKm，离得越远越放宽（到 radiusKm 处降到 seaKm 的水平）；海洋格要求 = seaKm。
   * 陆地比例低的格（海岸、小岛）按比例在两者之间插值。用覆盖得下整个圆的最细一级（≥ 64 km 级，格宽 ≥ 2 km）；
   * 一级都没有时 known = false，调用方自己保守处理。
   */
  terrainFloor(x: number, z: number, aglLandKm: number, seaKm: number, radiusKm = 16): TerrainFloor {
    const g = this.gridCovering(x, z, radiusKm, 3);
    if (!g) return { floorKm: seaKm, groundKm: 0, known: false };
    const cell = g.size / GRID;
    const x0 = g.cx - g.size / 2;
    const z0 = g.cz - g.size / 2;
    const i0 = Math.max(0, Math.floor((x - radiusKm - x0) / cell));
    const i1 = Math.min(GRID - 1, Math.floor((x + radiusKm - x0) / cell));
    const j0 = Math.max(0, Math.floor((z - radiusKm - z0) / cell));
    const j1 = Math.min(GRID - 1, Math.floor((z + radiusKm - z0) / cell));
    let floor = seaKm;
    for (let j = j0; j <= j1; j++) {
      for (let i = i0; i <= i1; i++) {
        // 点到格子（矩形）的最近距离
        const dx = Math.max(x0 + i * cell - x, 0, x - (x0 + (i + 1) * cell));
        const dz = Math.max(z0 + j * cell - z, 0, z - (z0 + (j + 1) * cell));
        const d = Math.hypot(dx, dz);
        if (d > radiusKm) continue;
        const k = j * GRID + i;
        // 近处（3 km 内）要求满额，往外平滑放宽到 radiusKm 处只剩「格内最高点 + 海面的要求」
        const relax = THREE.MathUtils.smoothstep(d, 3, radiusKm);
        const landReq = g.max[k] + seaKm + (aglLandKm - seaKm) * (1 - relax);
        const w = THREE.MathUtils.smoothstep(g.land[k], 0, 0.3);
        floor = Math.max(floor, seaKm + (landReq - seaKm) * w);
      }
    }
    return { floorKm: floor, groundKm: this.heightAt(x, z) ?? 0, known: true };
  }

  /** 地区统计：radiusKm 内的陆地比例、陆地平均高度（用 ≥ 128 km 级的粗网格） */
  regionStats(x: number, z: number, radiusKm = 40): RegionStats {
    const g = this.gridCovering(x, z, radiusKm, 4);
    if (!g) return { land: 0, meanLandKm: 0, known: false };
    const cell = g.size / GRID;
    const x0 = g.cx - g.size / 2;
    const z0 = g.cz - g.size / 2;
    let wSum = 0, landSum = 0, hSum = 0;
    for (let j = 0; j < GRID; j++) {
      for (let i = 0; i < GRID; i++) {
        const d = Math.hypot(x0 + (i + 0.5) * cell - x, z0 + (j + 0.5) * cell - z);
        if (d > radiusKm) continue;
        const k = j * GRID + i;
        wSum += 1;
        landSum += g.land[k];
        hSum += g.mean[k];
      }
    }
    if (wSum === 0) return { land: 0, meanLandKm: 0, known: false };
    return { land: landSum / wSum, meanLandKm: landSum > 1e-3 ? hSum / landSum : 0, known: true };
  }

  /** 正下方的地形高度（km）：最细的可用级别双线性取样；没有数据返回 null */
  heightAt(x: number, z: number): number | null {
    const data = this.heightCpu;
    for (let i = 0; i < GROUND_LEVELS; i++) {
      const l = this.levels[i];
      if (!l.valid) continue;
      const u = (x - l.cx) / l.size + 0.5;
      const v = (z - l.cz) / l.size + 0.5;
      if (u < 0.01 || u > 0.99 || v < 0.01 || v > 0.99) continue;
      const fx = u * HRES - 0.5, fz = v * HRES - 0.5;
      const ix = Math.max(0, Math.min(HRES - 2, Math.floor(fx)));
      const iz = Math.max(0, Math.min(HRES - 2, Math.floor(fz)));
      const tx = THREE.MathUtils.clamp(fx - ix, 0, 1), tz = THREE.MathUtils.clamp(fz - iz, 0, 1);
      const base = i * HRES * HRES;
      const h = (a: number, b: number) => data[base + b * HRES + a];
      const top = h(ix, iz) * (1 - tx) + h(ix + 1, iz) * tx;
      const bot = h(ix, iz + 1) * (1 - tx) + h(ix + 1, iz + 1) * tx;
      return top * (1 - tz) + bot * tz;
    }
    return null;
  }

  /** 从 minLevel 起往粗找第一个「粗网格能盖住以 (x, z) 为圆心、radiusKm 为半径的圆」的级别 */
  private gridCovering(x: number, z: number, radiusKm: number, minLevel: number): CoarseGrid | null {
    for (let i = minLevel; i < GROUND_LEVELS; i++) {
      const l = this.levels[i];
      const g = l.grid;
      if (!g || !l.valid) continue;
      if (Math.abs(x - g.cx) + radiusKm <= g.size / 2 && Math.abs(z - g.cz) + radiusKm <= g.size / 2) return g;
    }
    // 圆超出了最粗一级（离起点很远的边缘情况）：用包含这个点的最粗可用一级，能盖多少算多少
    for (let i = GROUND_LEVELS - 1; i >= minLevel; i--) {
      const l = this.levels[i];
      const g = l.grid;
      if (g && l.valid && Math.abs(x - g.cx) < g.size / 2 && Math.abs(z - g.cz) < g.size / 2) return g;
    }
    return null;
  }

  private async build(i: number, cx: number, cz: number, detail: boolean, fine: boolean) {
    const l = this.levels[i];
    const gen = this.generation;
    l.building = true;
    // 数据齐了但还没排进上传队列（早退 / 网络失败）时，这里负责清 building；一旦排队成功，
    // 交给下面的 after 回调清（要等 3 张纹理都真正传完，见类头「PERF-8」注释）
    let queued = false;
    try {
      const heightP = this.buildHeight(l.size, cx, cz);
      const [albedo0, vec, height, nightRaw, detailPx] = await Promise.all([
        this.buildImagery(l.size, cx, cz, i === GROUND_LEVELS - 1, fine),
        this.buildWater(l.size, cx, cz),
        heightP,
        this.buildNight(l.size, cx, cz),
        // 高清细节等地形先到：用 DEM 筛掉整张是海的瓦片（GSI 海上 404，见 tiles.ts 的 seaMissing）
        detail ? heightP.then((h) => this.buildDetail(l.size, cx, cz, h.data, DETAIL_ZOOMS[i], performance.now() + DETAIL_WAIT_MS)) : Promise.resolve(null),
      ]);
      // 水体/河道栅格化、夜光的逐像素变换、道路灯带（T08）叠加：都在 Worker 里做（road-raster.ts 的
      // buildGroundLevel，PERF-9 把水体/夜光也从主线程挪了进来，见类头「PERF-8」注释旁边的说明），
      // 像素缓冲区转移过去再转移回来，主线程上不跑 getImageData / 逐顶点投影 / 1M 像素的循环
      // G03：高清细节（GSI）也交给 Worker，和 EOX 做「高频取 GSI、低频取 EOX」的合成（imagery-blend.ts）
      // 高清瓦片没在限时内取齐：这一版按纯 EOX 出，记成没有细节，下次重建补上（见 DETAIL_WAIT_MS）
      const detailDone = detail && detailPx !== null && detailPx.complete;
      if (!detailDone) detailPx?.px?.close();
      if (gen !== this.generation || i < this.minLevel) {
        albedo0.close();
        if (detailDone) detailPx.px?.close();
        return;
      }
      const { water, albedo, detailCoverage } = await buildGroundLevelAsync(vec.job, albedo0, nightRaw, detailDone ? detailPx.px : null);
      if (gen !== this.generation || i < this.minLevel) return;
      queued = true;
      this.queueUpload(
        [
          { tex: this.albedo, layer: i, data: albedo, layerSize: RES * RES * 4 },
          { tex: this.water, layer: i, data: water, layerSize: RES * RES * 4 },
          { tex: this.height, layer: i, data: height.data, layerSize: HRES * HRES },
        ],
        () => {
          if (gen === this.generation) l.building = false;
          if (gen !== this.generation || i < this.minLevel) return;
          l.cx = cx;
          l.cz = cz;
          // 想要细节但这版没合上（没取齐）时记成 false，update 会再建一次；一张都取不到（全是「确定没有」）算完成，不反复重建
          l.detail = detail && (detailPx === null || detailPx.complete);
          l.detailCoverage = detailCoverage;
          l.fine = fine;
          l.valid = true;
          l.maxHeight = height.max;
          l.grid = coarseGrid(cx, cz, l.size, height.data, height.sea, water);
          this.levelUniform[i].set(cx, cz, l.size, 1);
        },
      );
    } finally {
      if (!queued && gen === this.generation) l.building = false;
    }
  }

  private upload(tex: THREE.DataArrayTexture, layer: number, data: ArrayLike<number>, layerSize: number) {
    if (tex === this.height) {
      this.heightCpu.set(data, layer * layerSize);
      if (!this.floatHeight) {
        const half = tex.image.data as unknown as Uint16Array;
        const o = layer * layerSize;
        for (let k = 0; k < layerSize; k++) half[o + k] = THREE.DataUtils.toHalfFloat(this.heightCpu[o + k]);
      }
    } else {
      (tex.image.data as unknown as { set(a: ArrayLike<number>, o: number): void }).set(data, layer * layerSize);
    }
    tex.source.dataReady = true;
    tex.addLayerUpdate(layer);
    tex.needsUpdate = true;
  }

  private queueUpload(jobs: UploadJob[], after: () => void) {
    this.uploadQueue.push({ jobs, after });
  }

  /** PERF-8：每帧最多真正上传一张纹理（一层），把一次重建的 3 次 texSubImage3D 摊到几帧；
   * 队首批次的 3 张都传完才触发它的 after（把这一级标记为 valid），见类头注释 */
  private drainUploads() {
    const batch = this.uploadQueue[0];
    if (!batch) return;
    const job = batch.jobs.shift();
    if (job) this.upload(job.tex, job.layer, job.data, job.layerSize);
    if (batch.jobs.length === 0) {
      this.uploadQueue.shift();
      batch.after();
    }
  }

  /** 这一级覆盖的瓦片范围，以及把瓦片画进 canvas 的变换 */
  private tileCover(size: number, cx: number, cz: number, zoom: number, px: number) {
    const x0 = cx - size / 2;
    const z0 = cz - size / 2;
    const [latN] = this.frame.toGeo(cx, z0);
    const [latS] = this.frame.toGeo(cx, z0 + size);
    // 经度范围取南北两端里更宽的那个（x 的换算随纬度变化）
    const lons = [this.frame.toGeo(x0, z0)[1], this.frame.toGeo(x0 + size, z0)[1], this.frame.toGeo(x0, z0 + size)[1], this.frame.toGeo(x0 + size, z0 + size)[1]];
    const tx0 = Math.floor(lonToTileX(Math.min(...lons), zoom));
    const tx1 = Math.floor(lonToTileX(Math.max(...lons), zoom));
    const ty0 = Math.floor(latToTileY(latN, zoom));
    const ty1 = Math.floor(latToTileY(latS, zoom));
    const toPx = (lat: number, lon: number): [number, number] => {
      const [x, z] = this.frame.toLocal(lat, lon);
      return [((x - x0) / size) * px, ((z - z0) / size) * px];
    };
    const tiles: { x: number; y: number }[] = [];
    const n = 2 ** zoom;
    for (let ty = Math.max(ty0, 0); ty <= Math.min(ty1, n - 1); ty++)
      for (let tx = tx0; tx <= tx1; tx++) tiles.push({ x: ((tx % n) + n) % n, y: ty });
    return { tiles, toPx, latC: this.frame.toGeo(cx, cz)[0] };
  }

  /**
   * coarsest：最粗一级。其他级别里没取到的瓦片留成透明（alpha = 0），着色器用粗一级补上；最粗一级没有更粗的，只能涂深海色。
   * fine（G06）：按 RES（2048）选缩放级；false 时按 1024 选（加速航程，请求量不涨），画布上放大。
   * 返回 ImageBitmap（G06）：瓦片画在 OffscreenCanvas 上、transferToImageBitmap 交给 Worker 读回像素——
   * 2048² 的 getImageData 是 16 MB，放在主线程就是一个长任务（PERF-9 当时就把它列为残留的尖峰来源）
   */
  private async buildImagery(size: number, cx: number, cz: number, coarsest: boolean, fine: boolean) {
    const [latC] = this.frame.toGeo(cx, cz);
    let zoom = zoomForResolution(size / (fine ? RES : TILE_RES_COARSE), latC, EOX_S2.maxZoom);
    let cover = this.tileCover(size, cx, cz, zoom, RES);
    while (cover.tiles.length > IMAGERY_MAX_TILES && zoom > 1) cover = this.tileCover(size, cx, cz, --zoom, RES);
    const canvas = new OffscreenCanvas(RES, RES);
    const ctx = canvas.getContext("2d") as OffscreenCanvasRenderingContext2D;
    ctx.imageSmoothingQuality = "high"; // 瓦片与纹素不是 1:1（缩放级按四舍五入选），缩小时不要走最近邻 / 低质量
    // 没有瓦片的地方（加载失败）：最粗一级涂成深海色；其他级别留透明，由着色器回退到粗一级。
    // 以前一律涂深海色：一张 z14 瓦片偶发取不到，低空时陆地上就出现一块直边的深藏青多边形（T02 复审发现）
    if (coarsest) {
      ctx.fillStyle = "rgb(8, 22, 40)";
      ctx.fillRect(0, 0, RES, RES);
    }
    this.pending += cover.tiles.length;
    await Promise.all(
      cover.tiles.map(async (t) => {
        const bmp = await loadImageryTile(EOX_S2, zoom, t.x, t.y);
        this.pending--;
        if (!bmp) return;
        const [ax, ay] = cover.toPx(tileYToLat(t.y, zoom), tileXToLon(t.x, zoom));
        const [bx, by] = cover.toPx(tileYToLat(t.y + 1, zoom), tileXToLon(t.x + 1, zoom));
        ctx.drawImage(bmp, ax, ay, bx - ax, by - ay);
      }),
    );
    return canvas.transferToImageBitmap();
  }

  /**
   * 高清细节层（G03）：国土地理院航拍画到这一级的 RES² 上，没取到的地方留透明（A = 覆盖率）。一张都没取到返回 null
   * （出了日本 / 海上是 404，tiles.ts 负缓存后不再请求）。合成在 Worker 里做（imagery-blend.ts）
   */
  private async buildDetail(size: number, cx: number, cz: number, heightKm: Float32Array, zoom: number, deadline: number) {
    const all = this.tileCover(size, cx, cz, zoom, RES);
    if (all.tiles.length > DETAIL_MAX_TILES) return null;
    const cover = { ...all, tiles: all.tiles.filter((t) => this.detailTileWanted(all.toPx, zoom, t.x, t.y, heightKm)) };
    // G06：和 buildImagery 一样画在 OffscreenCanvas 上、交 ImageBitmap 给 Worker 读回（2048² 时源与纹素 1:1，1024 时是 2:1 缩小）
    const canvas = new OffscreenCanvas(RES, RES);
    const ctx = canvas.getContext("2d") as OffscreenCanvasRenderingContext2D;
    ctx.imageSmoothingQuality = "high";
    let got = 0;
    let settled = 0;
    this.pending += cover.tiles.length;
    const all$ = Promise.all(
      cover.tiles.map(async (t) => {
        const bmp = await loadImageryTile(GSI_PHOTO, zoom, t.x, t.y);
        this.pending--;
        settled++;
        if (!bmp || performance.now() > deadline) return;
        got++;
        const [ax, ay] = cover.toPx(tileYToLat(t.y, zoom), tileXToLon(t.x, zoom));
        const [bx, by] = cover.toPx(tileYToLat(t.y + 1, zoom), tileXToLon(t.x + 1, zoom));
        ctx.drawImage(bmp, ax, ay, bx - ax, by - ay);
      }),
    );
    // 限时：到点还没齐就不等了（在途的请求照常完成、进缓存，给下一次重建用）
    const wait = Math.max(0, deadline - performance.now());
    let timer: ReturnType<typeof setTimeout> | undefined;
    await Promise.race([all$, new Promise<void>((r) => (timer = setTimeout(r, wait)))]);
    clearTimeout(timer);
    const complete = settled === cover.tiles.length;
    if (got === 0) return complete ? null : { px: null, complete: false };
    return { px: complete ? canvas.transferToImageBitmap() : null, complete };
  }

  /**
   * 这张高清瓦片值不值得请求：中心在覆盖框里，而且在这一级范围内至少有一个地形像素高于海平面 0.5 m。
   * 不能只按「海底 < −5 m」判海：近岸的 DEM 来自 SRTM，海面是 0 m 而不是负值（骏河湾北岸实测整排 z14 瓦片被当成陆地、全部 404）；
   * 整张 2 km 瓦片都 ≤ 0.5 m 的陆地极少，误筛了也只是那里没有细节（照常显示 EOX）
   */
  private detailTileWanted(toPx: (lat: number, lon: number) => [number, number], z: number, x: number, y: number, heightKm: Float32Array) {
    if (!inBounds(GSI_PHOTO, tileYToLat(y + 0.5, z), tileXToLon(x + 0.5, z))) return false;
    if (!GSI_PHOTO.seaMissing) return true;
    const [ax, ay] = toPx(tileYToLat(y, z), tileXToLon(x, z));
    const [bx, by] = toPx(tileYToLat(y + 1, z), tileXToLon(x + 1, z));
    const s = HRES / RES;
    const x0 = Math.max(0, Math.floor(Math.min(ax, bx) * s)), x1 = Math.min(HRES - 1, Math.ceil(Math.max(ax, bx) * s));
    const y0 = Math.max(0, Math.floor(Math.min(ay, by) * s)), y1 = Math.min(HRES - 1, Math.ceil(Math.max(ay, by) * s));
    for (let j = y0; j <= y1; j++) for (let i = x0; i <= x1; i++) if (heightKm[j * HRES + i] > 0.0005) return true;
    return false;
  }

  /** 夜光（NASA Black Marble）：只取亮度，分辨率粗（~500 m），着色器里再用影像里的城市区域把它「落」到街区上。
   * 「亮度减去蓝色底」的变换（Black Marble 的底图把陆地画成暗蓝色）挪进了 Worker（PERF-9，见 road-raster.ts
   * 的 darkenNight）：这里只做取瓦片、画布合成、getImageData 这三步（canvas 合成必须在有 2D 上下文的线程上做，
   * 这一版没有把它挪进 Worker，见 handoff/PERF-9.md「还剩下什么」），返回原始 RGBA，不再在主线程跑一遍 1M 像素的变换循环。 */
  private async buildNight(size: number, cx: number, cz: number) {
    const [latC] = this.frame.toGeo(cx, cz);
    let zoom = zoomForResolution(size / NIGHT_RES, latC, NIGHT_MAX_ZOOM);
    let cover = this.tileCover(size, cx, cz, zoom, NIGHT_RES);
    while (cover.tiles.length > 25 && zoom > 1) cover = this.tileCover(size, cx, cz, --zoom, NIGHT_RES);
    const ctx = makeCanvas(NIGHT_RES, NIGHT_RES);
    ctx.fillStyle = "black";
    ctx.fillRect(0, 0, NIGHT_RES, NIGHT_RES);
    this.pending += cover.tiles.length;
    await Promise.all(
      cover.tiles.map(async (t) => {
        const bmp = await loadBitmap(NIGHT_URL(zoom, t.x, t.y));
        this.pending--;
        if (!bmp) return;
        const [ax, ay] = cover.toPx(tileYToLat(t.y, zoom), tileXToLon(t.x, zoom));
        const [bx, by] = cover.toPx(tileYToLat(t.y + 1, zoom), tileXToLon(t.x + 1, zoom));
        ctx.drawImage(bmp, ax, ay, bx - ax, by - ay);
      }),
    );
    return ctx.getImageData(0, 0, NIGHT_RES, NIGHT_RES).data;
  }

  private async buildHeight(size: number, cx: number, cz: number) {
    const [latC] = this.frame.toGeo(cx, cz);
    let zoom = zoomForResolution(size / HRES, latC, DEM_MAX_ZOOM);
    let cover = this.tileCover(size, cx, cz, zoom, HRES);
    while (cover.tiles.length > 25 && zoom > 1) cover = this.tileCover(size, cx, cz, --zoom, HRES);
    const ctx = makeCanvas(HRES, HRES);
    // 高度编码在 RGB 三个通道里，插值会把通道混坏，必须用最近邻
    ctx.imageSmoothingEnabled = false;
    ctx.fillStyle = "rgb(128, 0, 0)"; // Terrarium 编码的 0 m
    ctx.fillRect(0, 0, HRES, HRES);
    this.pending += cover.tiles.length;
    await Promise.all(
      cover.tiles.map(async (t) => {
        const bmp = await loadBitmap(DEM_URL(zoom, t.x, t.y));
        this.pending--;
        if (!bmp) return;
        const [ax, ay] = cover.toPx(tileYToLat(t.y, zoom), tileXToLon(t.x, zoom));
        const [bx, by] = cover.toPx(tileYToLat(t.y + 1, zoom), tileXToLon(t.x + 1, zoom));
        ctx.drawImage(bmp, ax, ay, bx - ax, by - ay);
      }),
    );
    const px = ctx.getImageData(0, 0, HRES, HRES).data;
    const data = new Float32Array(HRES * HRES);
    // 海底（Terrarium 带海底地形，海里是负值）：给 CPU 侧的海陆判断用。瓦片没取到的地方是 0 m，按陆地算（保守）
    const sea = new Uint8Array(HRES * HRES);
    let max = 0;
    for (let k = 0; k < HRES * HRES; k++) {
      // Terrarium：高度(m) = R·256 + G + B/256 − 32768；海底深度截到海平面
      const m = px[k * 4] * 256 + px[k * 4 + 1] + px[k * 4 + 2] / 256 - 32768;
      const km = Math.max(m, 0) / 1000;
      max = Math.max(max, km);
      data[k] = km;
      sea[k] = m < -5 ? 1 : 0;
    }
    return { data, max, sea };
  }

  /**
   * 只取瓦片、攒任务（PERF-9）：水体/河道的栅格化（Path2D 填充/描边 + getImageData）挪进了 Worker
   * （`road-raster.ts` 的 `buildGroundLevel`，和道路 SDF、夜光变换一起做），这里不再碰 canvas——
   * CDP CPU 剖析（route-hnd-cts 60× 加速航程）显示原来这一步（含逐顶点的 tileYToLat/tileXToLon 投影）
   * 是尖峰帧里最大的一块，见 handoff/PERF-9.md。
   */
  private async buildWater(size: number, cx: number, cz: number) {
    const [latC] = this.frame.toGeo(cx, cz);
    // 缩放级按 1024 选（G06）：换缩放级会让 OpenMapTiles 取舍的道路等级 / 简化程度变，夜间路网就换了一版；几何在 RES² 上栅格化
    let zoom = zoomForResolution(size / TILE_RES_COARSE, latC, VECTOR_MAX_ZOOM);
    let cover = this.tileCover(size, cx, cz, zoom, RES);
    while (cover.tiles.length > 36 && zoom > 1) cover = this.tileCover(size, cx, cz, --zoom, RES);
    this.pending += cover.tiles.length;
    const results = await Promise.all(cover.tiles.map((t) => loadWater(zoom, t.x, t.y).then((w) => ({ t, w }))));
    this.pending -= cover.tiles.length;
    // 水体/河道 + 道路（T08）：几何数据攒成任务，投影、栅格化、求距离全在 Worker 里做（见 road-raster.ts），
    // 等影像和夜光都齐了由 build 交出去
    const [lat0, lon0] = [this.frame.lat0, this.frame.lon0];
    const water = results.flatMap(({ t, w }) => (w ? [{ x: t.x, y: t.y, data: w.water }] : []));
    const tiles = results.flatMap(({ t, w }) => (w?.roads ? [{ x: t.x, y: t.y, data: w.roads }] : []));
    const job: RoadJob = { res: RES, nightRes: NIGHT_RES, lat0, lon0, x0: cx - size / 2, z0: cz - size / 2, size, zoom, tiles, water, waterwayMaxM: this.waterwayMaxM };
    return { job };
  }
}

// ---- 地面栅格化的 Worker（T08 道路，PERF-9 并入水体/夜光）：一个常驻 Worker，按请求号对应回调；
// 起不来时在主线程同步算（buildGroundLevel 用的是 OffscreenCanvas，主线程 / Worker 都能跑）----
// 像素缓冲区是转移过去的（主线程这边随即失效），所以 Worker 中途出错时没法在这里补算：让这次构建失败，
// build 的 finally 清掉 building 标志，下一帧 update 发现这一级还没建好会重建，那时已经改走主线程
let roadWorker: Worker | null | undefined;
/** Worker 每级合成耗时（G06 诊断：`__voyage.ground.imageryStats.worker`） */
const workerStats = { count: 0, totalMs: 0, maxMs: 0, lastMs: 0 };
let roadReq = 0;
const roadPending = new Map<number, { resolve: (r: GroundLevelResult) => void; reject: (e: Error) => void }>();

function buildGroundLevelAsync(
  job: RoadJob,
  albedo: ImageBitmap,
  nightRaw: Uint8ClampedArray,
  detail: ImageBitmap | null,
): Promise<GroundLevelResult> {
  if (roadWorker === undefined) {
    try {
      roadWorker = new Worker(new URL("./road-raster.worker.ts", import.meta.url), { type: "module" });
      roadWorker.onmessage = (e: MessageEvent<GroundLevelResult & { id: number; ms: number }>) => {
        workerStats.count++;
        workerStats.totalMs += e.data.ms;
        workerStats.maxMs = Math.max(workerStats.maxMs, e.data.ms);
        workerStats.lastMs = e.data.ms;
        const req = roadPending.get(e.data.id);
        roadPending.delete(e.data.id);
        req?.resolve({ water: e.data.water, albedo: e.data.albedo, detailCoverage: e.data.detailCoverage });
      };
      roadWorker.onerror = (e) => {
        console.warn("地面栅格化 Worker 出错，改在主线程计算", e.message);
        roadWorker?.terminate();
        roadWorker = null;
        for (const req of roadPending.values()) req.reject(new Error("地面栅格化 Worker 出错"));
        roadPending.clear();
      };
    } catch {
      roadWorker = null;
    }
  }
  if (!roadWorker) {
    return Promise.resolve(buildGroundLevel(job, albedo, nightRaw, detail));
  }
  const id = ++roadReq;
  const worker = roadWorker;
  return new Promise((resolve, reject) => {
    roadPending.set(id, { resolve, reject });
    // 瓦片水体/道路几何数据复制过去（还留在 LRU 缓存里给下次重建用），像素缓冲区与 ImageBitmap 转移（不复制）
    const transfer: Transferable[] = detail ? [albedo, nightRaw.buffer, detail] : [albedo, nightRaw.buffer];
    worker.postMessage({ id, job, albedo, nightRaw, detail }, transfer);
  });
}

/** 把一级的高度图 / 水体遮罩压成 GRID² 的粗网格（最高点、平均高度、陆地比例），CPU 侧查询用（T18） */
function coarseGrid(cx: number, cz: number, size: number, height: Float32Array, sea: Uint8Array, water: Uint8ClampedArray): CoarseGrid {
  const max = new Float32Array(GRID * GRID);
  const mean = new Float32Array(GRID * GRID);
  const land = new Float32Array(GRID * GRID);
  const hs = HRES / GRID;
  const ws = RES / GRID;
  for (let j = 0; j < GRID; j++) {
    for (let i = 0; i < GRID; i++) {
      let m = 0, sum = 0, seaCount = 0;
      for (let b = 0; b < hs; b++) {
        for (let a = 0; a < hs; a++) {
          const k = (j * hs + b) * HRES + i * hs + a;
          const h = height[k];
          m = Math.max(m, h);
          sum += h;
          seaCount += sea[k];
        }
      }
      // 水体遮罩的海洋通道（G）：每格取 16×16 个样本就够了（1024² 时隔一个像素，2048² 时隔三个，主线程上的开销不随 RES 涨）
      let ocean = 0, n = 0;
      const wStep = Math.max(1, ws >> 4);
      for (let b = 0; b < ws; b += wStep) {
        for (let a = 0; a < ws; a += wStep) {
          const k = ((j * ws + b) * RES + i * ws + a) * 4;
          ocean += water[k + 1] > 127 ? 1 : 0;
          n++;
        }
      }
      const k = j * GRID + i;
      max[k] = m;
      mean[k] = sum / (hs * hs);
      // 两个来源取「更像海」的那个：矢量水体偶发缺瓦片时靠 DEM 的海底地形兜底，反之亦然
      land[k] = 1 - Math.max(ocean / n, seaCount / (hs * hs));
    }
  }
  return { cx, cz, size, max, mean, land };
}
