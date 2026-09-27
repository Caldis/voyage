import * as THREE from "three";
import { LocalFrame, latToTileY, lonToTileX, tileXToLon, tileYToLat, zoomForResolution } from "./geo";
import { DEM_MAX_ZOOM, DEM_URL, IMAGERY_MAX_ZOOM, IMAGERY_URL, NIGHT_MAX_ZOOM, NIGHT_URL, VECTOR_MAX_ZOOM, loadBitmap, loadWater } from "./tiles";

/**
 * 地面的 clipmap：以飞机正下方为中心的 7 级方形区域，边长 8、16 … 512 km，
 * 覆盖到巡航高度看得见的地平线（约 370 km）。每级三张图：影像（反照率）、水体遮罩（B 通道存夜光亮度）、地形高度，
 * 都已经换算到本地公里坐标（x 东、z 南），着色器里直接按公里采样，不用管墨卡托。
 *
 * 飞机移动超过该级边长的 1/8 时重建这一级；重建期间这一级仍用旧数据，着色器按 valid 标志回退到粗一级。
 */

// 最细一级 8 km / 1024 ≈ 7.8 m/像素，用 z14 影像（Sentinel-2 原生约 10 m）：低空时近处的影像清晰一倍
export const GROUND_LEVELS = 7;
export const GROUND_BASE_KM = 8;
const RES = 1024; // 影像和水体
const HRES = 256; // 地形高度

interface Level {
  size: number;
  cx: number;
  cz: number;
  valid: boolean;
  building: boolean;
  maxHeight: number;
  /** CPU 侧的粗网格（T18 高度下限 / 霾的地区统计）：GRID² 格，每格的最高点、平均高度（km）、陆地比例 */
  grid: CoarseGrid | null;
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
  }));
  private frame: LocalFrame;
  private generation = 0;
  /** 瓦片统计，面板上显示加载状态 */
  pending = 0;

  constructor(lat0: number, lon0: number) {
    this.frame = new LocalFrame(lat0, lon0);
    const tex = (data: Uint8Array | Uint16Array, w: number, format: THREE.PixelFormat, type: THREE.TextureDataType) => {
      const t = new THREE.DataArrayTexture(data, w, w, GROUND_LEVELS);
      t.format = format;
      t.type = type;
      t.minFilter = THREE.LinearFilter;
      t.magFilter = THREE.LinearFilter;
      t.wrapS = t.wrapT = THREE.ClampToEdgeWrapping;
      t.generateMipmaps = false;
      t.needsUpdate = true;
      return t;
    };
    this.albedo = tex(new Uint8Array(RES * RES * 4 * GROUND_LEVELS), RES, THREE.RGBAFormat, THREE.UnsignedByteType);
    this.albedo.colorSpace = THREE.SRGBColorSpace;
    this.water = tex(new Uint8Array(RES * RES * 4 * GROUND_LEVELS), RES, THREE.RGBAFormat, THREE.UnsignedByteType);
    this.height = tex(new Uint16Array(HRES * HRES * GROUND_LEVELS), HRES, THREE.RedFormat, THREE.HalfFloatType);
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
    }
    this.levelUniform.forEach((v) => (v.w = 0));
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

  /** 每帧调用：飞机当前的本地坐标（km） */
  update(x: number, z: number) {
    // 粗的级别先建，远景先出来
    for (let i = GROUND_LEVELS - 1; i >= this.minLevel; i--) {
      const l = this.levels[i];
      if (l.building) continue;
      const snap = l.size / 8;
      const cx = Math.round(x / snap) * snap;
      const cz = Math.round(z / snap) * snap;
      if (cx === l.cx && cz === l.cz) continue;
      void this.build(i, cx, cz);
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
    const data = this.height.image.data as unknown as Uint16Array;
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
      const h = (a: number, b: number) => THREE.DataUtils.fromHalfFloat(data[base + b * HRES + a]);
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

  private async build(i: number, cx: number, cz: number) {
    const l = this.levels[i];
    const gen = this.generation;
    l.building = true;
    try {
      const [albedo, water, height, night] = await Promise.all([
        this.buildImagery(l.size, cx, cz, i === GROUND_LEVELS - 1),
        this.buildWater(l.size, cx, cz),
        this.buildHeight(l.size, cx, cz),
        this.buildNight(l.size, cx, cz),
      ]);
      if (gen !== this.generation || i < this.minLevel) return;
      // 夜光亮度放进水体纹理的 B 通道
      for (let k = 0; k < RES * RES; k++) water[k * 4 + 2] = night[k * 4];
      this.upload(this.albedo, i, albedo, RES * RES * 4);
      this.upload(this.water, i, water, RES * RES * 4);
      this.upload(this.height, i, height.data, HRES * HRES);
      l.cx = cx;
      l.cz = cz;
      l.valid = true;
      l.maxHeight = height.max;
      l.grid = coarseGrid(cx, cz, l.size, height.data, height.sea, water);
      this.levelUniform[i].set(cx, cz, l.size, 1);
    } finally {
      if (gen === this.generation) l.building = false;
    }
  }

  private upload(tex: THREE.DataArrayTexture, layer: number, data: ArrayLike<number>, layerSize: number) {
    (tex.image.data as unknown as { set(a: ArrayLike<number>, o: number): void }).set(data, layer * layerSize);
    tex.addLayerUpdate(layer);
    tex.needsUpdate = true;
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

  /** coarsest：最粗一级。其他级别里没取到的瓦片留成透明（alpha = 0），着色器用粗一级补上；最粗一级没有更粗的，只能涂深海色 */
  private async buildImagery(size: number, cx: number, cz: number, coarsest: boolean) {
    const [latC] = this.frame.toGeo(cx, cz);
    let zoom = zoomForResolution(size / RES, latC, IMAGERY_MAX_ZOOM);
    let cover = this.tileCover(size, cx, cz, zoom, RES);
    while (cover.tiles.length > 49 && zoom > 1) cover = this.tileCover(size, cx, cz, --zoom, RES);
    const ctx = makeCanvas(RES, RES);
    // 没有瓦片的地方（加载失败）：最粗一级涂成深海色；其他级别留透明，由着色器回退到粗一级。
    // 以前一律涂深海色：一张 z14 瓦片偶发取不到，低空时陆地上就出现一块直边的深藏青多边形（T02 复审发现）
    ctx.clearRect(0, 0, RES, RES);
    if (coarsest) {
      ctx.fillStyle = "rgb(8, 22, 40)";
      ctx.fillRect(0, 0, RES, RES);
    }
    this.pending += cover.tiles.length;
    await Promise.all(
      cover.tiles.map(async (t) => {
        const bmp = await loadBitmap(IMAGERY_URL(zoom, t.x, t.y));
        this.pending--;
        if (!bmp) return;
        const [ax, ay] = cover.toPx(tileYToLat(t.y, zoom), tileXToLon(t.x, zoom));
        const [bx, by] = cover.toPx(tileYToLat(t.y + 1, zoom), tileXToLon(t.x + 1, zoom));
        ctx.drawImage(bmp, ax, ay, bx - ax, by - ay);
      }),
    );
    return ctx.getImageData(0, 0, RES, RES).data;
  }

  /** 夜光（NASA Black Marble）：只取亮度，存成灰度。分辨率粗（~500 m），着色器里再用影像里的城市区域把它「落」到街区上 */
  private async buildNight(size: number, cx: number, cz: number) {
    const [latC] = this.frame.toGeo(cx, cz);
    let zoom = zoomForResolution(size / RES, latC, NIGHT_MAX_ZOOM);
    let cover = this.tileCover(size, cx, cz, zoom, RES);
    while (cover.tiles.length > 25 && zoom > 1) cover = this.tileCover(size, cx, cz, --zoom, RES);
    const ctx = makeCanvas(RES, RES);
    ctx.fillStyle = "black";
    ctx.fillRect(0, 0, RES, RES);
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
    const px = ctx.getImageData(0, 0, RES, RES).data;
    // Black Marble 的底图把陆地画成暗蓝色：取「亮度减去蓝色底」，只留下灯光
    const out = new Uint8ClampedArray(RES * RES * 4);
    for (let k = 0; k < RES * RES; k++) {
      const r = px[k * 4], g = px[k * 4 + 1], b = px[k * 4 + 2];
      out[k * 4] = Math.max(0, Math.min(255, (r * 0.6 + g * 0.4 - b * 0.35) * 1.3));
    }
    return out;
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
    const data = new Uint16Array(HRES * HRES);
    // 海底（Terrarium 带海底地形，海里是负值）：给 CPU 侧的海陆判断用。瓦片没取到的地方是 0 m，按陆地算（保守）
    const sea = new Uint8Array(HRES * HRES);
    let max = 0;
    for (let k = 0; k < HRES * HRES; k++) {
      // Terrarium：高度(m) = R·256 + G + B/256 − 32768；海底深度截到海平面
      const m = px[k * 4] * 256 + px[k * 4 + 1] + px[k * 4 + 2] / 256 - 32768;
      const km = Math.max(m, 0) / 1000;
      max = Math.max(max, km);
      data[k] = THREE.DataUtils.toHalfFloat(km);
      sea[k] = m < -5 ? 1 : 0;
    }
    return { data, max, sea };
  }

  private async buildWater(size: number, cx: number, cz: number) {
    const [latC] = this.frame.toGeo(cx, cz);
    let zoom = zoomForResolution(size / RES, latC, VECTOR_MAX_ZOOM);
    let cover = this.tileCover(size, cx, cz, zoom, RES);
    while (cover.tiles.length > 36 && zoom > 1) cover = this.tileCover(size, cx, cz, --zoom, RES);
    const ctx = makeCanvas(RES, RES);
    ctx.fillStyle = "black";
    ctx.fillRect(0, 0, RES, RES);
    const kmPerPx = size / RES;
    this.pending += cover.tiles.length;
    const results = await Promise.all(cover.tiles.map((t) => loadWater(zoom, t.x, t.y).then((w) => ({ t, w }))));
    this.pending -= cover.tiles.length;
    for (const { t, w } of results) {
      if (!w) continue;
      const proj = (p: { x: number; y: number }) =>
        cover.toPx(tileYToLat(t.y + p.y / w.extent, zoom), tileXToLon(t.x + p.x / w.extent, zoom));
      // R = 水面，G = 海洋（海洋有大风浪，湖泊河流平静）
      for (const poly of w.polygons) {
        ctx.beginPath();
        for (const ring of poly.rings) {
          ring.forEach((p, k) => {
            const [x, y] = proj(p);
            if (k === 0) ctx.moveTo(x, y);
            else ctx.lineTo(x, y);
          });
          ctx.closePath();
        }
        ctx.fillStyle = poly.ocean ? "rgb(255,255,0)" : "rgb(255,0,0)";
        ctx.fill("evenodd");
      }
      ctx.lineCap = "round";
      ctx.lineJoin = "round";
      for (const line of w.lines) {
        const widthPx = line.width / 1000 / kmPerPx;
        // 比一个像素还窄的河道按覆盖比例画淡一点，免得远处闪烁
        ctx.lineWidth = Math.max(widthPx, 1);
        ctx.globalAlpha = Math.min(widthPx, 1);
        ctx.strokeStyle = "rgb(255,0,0)";
        ctx.beginPath();
        line.points.forEach((p, k) => {
          const [x, y] = proj(p);
          if (k === 0) ctx.moveTo(x, y);
          else ctx.lineTo(x, y);
        });
        ctx.stroke();
        ctx.globalAlpha = 1;
      }
    }
    return ctx.getImageData(0, 0, RES, RES).data;
  }
}

/** 把一级的高度图 / 水体遮罩压成 GRID² 的粗网格（最高点、平均高度、陆地比例），CPU 侧查询用（T18） */
function coarseGrid(cx: number, cz: number, size: number, height: Uint16Array, sea: Uint8Array, water: Uint8ClampedArray): CoarseGrid {
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
          const h = THREE.DataUtils.fromHalfFloat(height[k]);
          m = Math.max(m, h);
          sum += h;
          seaCount += sea[k];
        }
      }
      // 水体遮罩的海洋通道（G）：隔一个像素取样就够了
      let ocean = 0, n = 0;
      for (let b = 0; b < ws; b += 2) {
        for (let a = 0; a < ws; a += 2) {
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
