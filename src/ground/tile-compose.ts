/**
 * 影像瓦片拼接（G08-STITCH）：把一级 clipmap 要的影像 / 高清细节瓦片（主线程取回的 JPEG Blob）解码、画到 RES² 的 CPU 画布上、读回像素。
 * 在地面栅格化 Worker 里跑（road-raster.worker.ts）；Worker 不可用时主线程用同一份代码兜底（clipmap.ts 的 buildGroundLevelAsync）。
 *
 * 为什么挪进 Worker（handoff/G07b.md、G08-STITCH.md）：G06–G07b 是主线程在 GPU 加速的 OffscreenCanvas 上拼瓦片、
 * transferToImageBitmap 交给 Worker，Worker 再 drawImage 到 CPU 画布、getImageData——这一步是对 GPU 资源的同步读回（16 MB），
 * GPU 进程那一刻忙时读回排队，页面的合成 / WebGL 命令排在后面，1× 巡航约每分钟 1 帧卡到 23–47 ms。
 * 主线程改 CPU 画布又会出现每次建级约 59 ms 的长任务（G07b 否决）。这里整条链路都是 CPU：
 * createImageBitmap(Blob) 解码出的是软件位图，画布是 willReadFrequently（CPU 栅格），getImageData 只是内存拷贝，不经 GPU 进程。
 *
 * 平台：Worker 里的 OffscreenCanvas 2D 要 Chrome 69+ / Firefox 105+ / Safari 16.4+；Worker 里 createImageBitmap(Blob) 要 Safari 15+。
 * 都不支持时 Worker 报错，clipmap 停用 Worker、改在主线程跑同一份代码（主线程没有 OffscreenCanvas 时用 <canvas>）。
 */

/** 一张要画的瓦片：key = 瓦片地址（解码缓存的键，也是主线程 Blob 缓存的键），x/y/w/h = 在画布上的矩形（像素，可以是小数） */
export interface ComposeTile {
  key: string;
  blob: Blob;
  x: number;
  y: number;
  w: number;
  h: number;
}

/** 一张画布的拼接任务：fill = 先涂的底色（最粗一级的深海色），null 时留透明（缺瓦片处 A = 0，着色器回退到粗一级） */
export interface ComposeSpec {
  kind: "compose";
  res: number;
  fill: string | null;
  tiles: ComposeTile[];
}

export interface ComposeResult {
  px: Uint8ClampedArray;
  /** 解码失败的瓦片（损坏的 JPEG 等）：主线程把它们从 Blob 缓存里删掉，下次重建重取 */
  bad: string[];
  /** 这次解码了几张（没命中解码缓存的） / 命中了几张 */
  decoded: number;
  hits: number;
  /** 解码完成（离开始多少毫秒）、画完并读回（离开始多少毫秒） */
  decodeMs: number;
  readMs: number;
  /** 这个线程的 CPU 画布画位图带边缘抗锯齿（走了裁剪 + 垫底的慢路径，见 drawTileCrisp）；Chrome 为 false */
  aa: boolean;
}

/** 解码缓存（按瓦片地址，LRU）：换出时 close() 释放位图内存。只在一个任务内使用时安全——调用方保证任务串行、
 * 容量大于一个任务的瓦片数（这样本任务刚取 / 刚放进来的位图不会在画之前被换出） */
export class DecodedCache {
  private map = new Map<string, ImageBitmap>();
  constructor(readonly cap: number) {}
  get(k: string) {
    const v = this.map.get(k);
    if (v) {
      this.map.delete(k);
      this.map.set(k, v);
    }
    return v;
  }
  set(k: string, v: ImageBitmap) {
    this.map.get(k)?.close();
    this.map.delete(k);
    this.map.set(k, v);
    while (this.map.size > this.cap) {
      const old = this.map.keys().next().value as string;
      this.map.get(old)?.close();
      this.map.delete(old);
    }
  }
  get size() {
    return this.map.size;
  }
}

/** 能不能在当前线程建 2D 画布（Worker 里要 OffscreenCanvas 2D） */
export function canvas2dSupported() {
  try {
    if (typeof OffscreenCanvas !== "undefined" && new OffscreenCanvas(1, 1).getContext("2d")) return true;
  } catch {
    /* 落到下面 */
  }
  return typeof document !== "undefined";
}

/** RES² 的 2D 画布：优先 OffscreenCanvas（主线程 / Worker 都有），没有时（Safari 16.4 以前的主线程兜底）用 <canvas>。
 * willRead = CPU 栅格：getImageData 不经 GPU 进程（G07b 的尖峰根因），代价是画的时候走 CPU */
export function make2d(res: number, willRead: boolean): OffscreenCanvasRenderingContext2D | CanvasRenderingContext2D {
  const opts = willRead ? { willReadFrequently: true } : undefined;
  if (typeof OffscreenCanvas !== "undefined") {
    const ctx = new OffscreenCanvas(res, res).getContext("2d", opts) as OffscreenCanvasRenderingContext2D | null;
    if (ctx) return ctx;
  }
  if (typeof document === "undefined") throw new Error("这个 Worker 不支持 OffscreenCanvas 2D");
  const c = document.createElement("canvas");
  c.width = c.height = res;
  const ctx = c.getContext("2d", opts) as CanvasRenderingContext2D | null;
  if (!ctx) throw new Error("无法创建 2D canvas");
  return ctx;
}

/**
 * 解码 + 拼接 + 读回。瓦片按 spec 的顺序画（主线程按覆盖范围逐行排好，结果与到达顺序无关；
 * G07b 以前按到达顺序画，相邻瓦片小数边界上的抗锯齿像素随网络时序变）
 */
export async function composeTiles(spec: ComposeSpec, cache: DecodedCache | null): Promise<ComposeResult> {
  const t0 = performance.now();
  const bad: string[] = [];
  let decoded = 0;
  let hits = 0;
  const bmps = await Promise.all(
    spec.tiles.map(async (t) => {
      const c = cache?.get(t.key);
      if (c) {
        hits++;
        return c;
      }
      try {
        const b = await createImageBitmap(t.blob);
        decoded++;
        return b;
      } catch {
        bad.push(t.key);
        return null;
      }
    }),
  );
  // 解码都完成后再统一放进缓存（放进去的顺序 = spec 顺序，和到达时序无关）
  if (cache) spec.tiles.forEach((t, i) => bmps[i] && cache.get(t.key) !== bmps[i] && cache.set(t.key, bmps[i]!));
  const decodeMs = performance.now() - t0;
  const res = spec.res;
  const ctx = make2d(res, true);
  // 瓦片与纹素不是 1:1（缩放级按四舍五入选，fine = false 时放大 2 倍），缩放不要走最近邻 / 低质量
  ctx.imageSmoothingQuality = "high";
  if (spec.fill) {
    ctx.fillStyle = spec.fill;
    ctx.fillRect(0, 0, res, res);
  }
  spec.tiles.forEach((t, i) => {
    const b = bmps[i];
    if (b) drawTileCrisp(ctx, b, t);
  });
  // 没有缓存（主线程兜底）时画完就释放
  if (!cache) for (const b of bmps) b?.close();
  const px = ctx.getImageData(0, 0, res, res).data;
  return { px, bad, decoded, hits, decodeMs, readMs: performance.now() - t0, aa: aaProbe === true };
}

/**
 * 按「像素中心落在矩形里」画一张瓦片，边上不做覆盖率抗锯齿（G08 发现）。
 * 瓦片矩形的边是小数：CPU 画布的 drawImage 对边上像素按覆盖率混合，相邻两张瓦片在接缝像素上各盖一部分，
 * 叠出来 A < 1——影像 A 通道 < 0.5 是「缺影像比例」，着色器在这条缝上回退到粗一级，画面上就是一条沿瓦片边的暗细线
 * （fuji-day 同页 A/B 最大差 26，肉眼可见）。GPU 画布（G07b 以前）画位图不做边缘抗锯齿，没有这个问题。
 * 做法：先按像素中心规则裁一个整像素的矩形（整数边的裁剪没有部分覆盖），在里面先画一张四边各外扩 1 像素的垫底，
 * 再在原矩形上画正片——内部像素完全被正片盖住，边上像素是「正片 × 覆盖率 + 垫底 × 余下」，颜色就是瓦片边缘的颜色，A = 1。
 * 相邻瓦片的矩形不严格对接（本地坐标按各自纬度的 cos 换算经度，东西向相邻的两张边上差零点几到几个像素），
 * 重叠处后画的赢（spec 顺序），缝隙处照旧透明，和 GPU 画布一致
 */
function drawTileCrisp(ctx: OffscreenCanvasRenderingContext2D | CanvasRenderingContext2D, b: ImageBitmap, t: ComposeTile) {
  // Chrome 的 CPU 画布对轴对齐的 drawImage 本来就不做边缘抗锯齿（实测 handoff/G08-seam.mjs：与这里的裁剪画法逐字节相同），
  // 省掉裁剪和垫底（一级 100 多张瓦片，垫底让拼接耗时翻倍）；别的浏览器探测到做了抗锯齿时才走下面
  if (!drawAntialiased(ctx)) {
    ctx.drawImage(b, t.x, t.y, t.w, t.h);
    return;
  }
  const x0 = Math.ceil(t.x - 0.5), x1 = Math.ceil(t.x + t.w - 0.5);
  const y0 = Math.ceil(t.y - 0.5), y1 = Math.ceil(t.y + t.h - 0.5);
  if (x1 <= x0 || y1 <= y0) return;
  ctx.save();
  ctx.beginPath();
  ctx.rect(x0, y0, x1 - x0, y1 - y0);
  ctx.clip();
  ctx.drawImage(b, t.x - 1, t.y - 1, t.w + 2, t.h + 2);
  ctx.drawImage(b, t.x, t.y, t.w, t.h);
  ctx.restore();
}

/** 这个线程的 CPU 画布画位图时边缘做不做抗锯齿（只探测一次）：把一张 2×2 不透明位图画到 (0.5, 0.5) 起的 2×2 矩形，看边上像素的 A */
let aaProbe: boolean | undefined;
function drawAntialiased(ctx: OffscreenCanvasRenderingContext2D | CanvasRenderingContext2D) {
  if (aaProbe !== undefined) return aaProbe;
  try {
    const src = make2d(2, true);
    src.fillStyle = "#fff";
    src.fillRect(0, 0, 2, 2);
    const probe = make2d(4, true);
    probe.imageSmoothingQuality = ctx.imageSmoothingQuality;
    const c = src.canvas;
    probe.drawImage("transferToImageBitmap" in c ? c.transferToImageBitmap() : c, 0.5, 0.5, 2, 2);
    const a = probe.getImageData(0, 0, 4, 4).data;
    aaProbe = false;
    for (let k = 3; k < a.length; k += 4) if (a[k] > 0 && a[k] < 255) aaProbe = true;
  } catch {
    aaProbe = true;
  }
  return aaProbe;
}

/** G07b 及以前的做法（`ground.imageryInWorker = false` 对照用）：主线程拼好的位图在这里读回像素（非预乘，getImageData 的约定），读完关掉位图 */
export function readBitmap(bmp: ImageBitmap, res: number): Uint8ClampedArray {
  const ctx = make2d(res, true);
  ctx.drawImage(bmp, 0, 0);
  bmp.close();
  return ctx.getImageData(0, 0, res, res).data;
}
