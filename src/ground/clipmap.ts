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
    }
    this.levelUniform.forEach((v) => (v.w = 0));
  }

  /** 附近地形的最高点（km），给着色器的高度场求交定上界 */
  get maxHeightKm() {
    let m = 0;
    for (const l of this.levels) if (l.valid) m = Math.max(m, l.maxHeight);
    return m;
  }

  /** 每帧调用：飞机当前的本地坐标（km） */
  update(x: number, z: number) {
    // 粗的级别先建，远景先出来
    for (let i = GROUND_LEVELS - 1; i >= 0; i--) {
      const l = this.levels[i];
      if (l.building) continue;
      const snap = l.size / 8;
      const cx = Math.round(x / snap) * snap;
      const cz = Math.round(z / snap) * snap;
      if (cx === l.cx && cz === l.cz) continue;
      void this.build(i, cx, cz);
    }
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
      if (gen !== this.generation) return;
      // 夜光亮度放进水体纹理的 B 通道
      for (let k = 0; k < RES * RES; k++) water[k * 4 + 2] = night[k * 4];
      this.upload(this.albedo, i, albedo, RES * RES * 4);
      this.upload(this.water, i, water, RES * RES * 4);
      this.upload(this.height, i, height.data, HRES * HRES);
      l.cx = cx;
      l.cz = cz;
      l.valid = true;
      l.maxHeight = height.max;
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
    let max = 0;
    for (let k = 0; k < HRES * HRES; k++) {
      // Terrarium：高度(m) = R·256 + G + B/256 − 32768；海底深度截到海平面
      const m = px[k * 4] * 256 + px[k * 4 + 1] + px[k * 4 + 2] / 256 - 32768;
      const km = Math.max(m, 0) / 1000;
      max = Math.max(max, km);
      data[k] = THREE.DataUtils.toHalfFloat(km);
    }
    return { data, max };
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
