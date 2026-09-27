/// <reference lib="webworker" />
// 地面 clipmap 一级的合成 Worker（T08 起道路，PERF-9 并入水体/夜光，G03 并入高清细节合成，G08 并入影像瓦片的解码与拼接）。
// 收 { id, job, albedo, nightRaw, detail? }：albedo / detail 是瓦片拼接任务（tile-compose.ts 的 ComposeSpec：各瓦片的 JPEG Blob 与画布矩形），
// 在这里解码（按地址缓存解好的位图）、画到 CPU 画布上读回像素；`ground.imageryInWorker = false` 对照时是主线程拼好的 ImageBitmap（G07b 的做法）。
// 之后栅格化水体/河道、合高清细节（imagery-blend.ts）、变换并放大夜光、叠加道路、算 mip 链（road-raster.ts 的 buildGroundLevel），
// 把 { id, water, albedo, detailCoverage, mips… } 转移回去（像素数组是 Transferable；job 的瓦片几何是复制——它们缓存在主线程 tiles.ts 的 LRU 里）。
// 出错时回 { id, error }，主线程停用 Worker、改在主线程算（onmessage 是 async 的，异常不会触发 Worker 的 error 事件，必须自己回报）。
import { buildGroundLevelFrom, type ImagerySrc, type RoadJob } from "./road-raster";
import { DecodedCache } from "./tile-compose";

/**
 * 解码缓存的容量（张，256² 一张 256 KB，满了约 300 MB）：要大于「全部 7 级 + 高清细节两级」一轮重建的瓦片总数（约 900–1100），
 * 否则 LRU 按级轮转访问会整轮不命中。G07b 以前主线程的位图缓存是 1500 张（含夜光 / 地形），这里只放影像
 */
const DECODED_CAP = 1200;
const cache = new DecodedCache(DECODED_CAP);

type Msg = { id: number; job: RoadJob; albedo: ImagerySrc; nightRaw: Uint8ClampedArray; detail: ImagerySrc | null };

// 任务串行（上一个做完才开始下一个）：解码是异步的，不串行的话两个任务交错，后一个的缓存换出会关掉前一个还没画的位图
let chain: Promise<void> = Promise.resolve();
self.onmessage = (e: MessageEvent<Msg>) => {
  chain = chain.then(() => handle(e.data));
};

async function handle({ id, job, albedo, nightRaw, detail }: Msg) {
  const t0 = performance.now();
  try {
    const r = await buildGroundLevelFrom(job, albedo, nightRaw, detail, cache);
    const ms = performance.now() - t0;
    const transfer: Transferable[] = [r.water.buffer, r.albedo.buffer];
    if (r.albedoMips) transfer.push(r.albedoMips.buffer);
    if (r.waterMips) transfer.push(r.waterMips.buffer);
    // G07b：开始时刻换成绝对时间（timeOrigin + now），主线程减去自己的 timeOrigin 就能和帧时间轴对齐（workerStats.recent）
    const t0Abs = performance.timeOrigin + t0;
    (self as unknown as Worker).postMessage(
      { id, water: r.water, albedo: r.albedo, detailCoverage: r.detailCoverage, albedoMips: r.albedoMips, waterMips: r.waterMips, bad: r.bad, ms, t0Abs, phases: r.phases, cached: cache.size },
      transfer,
    );
  } catch (err) {
    (self as unknown as Worker).postMessage({ id, error: err instanceof Error ? `${err.name}: ${err.message}` : String(err) });
  }
}
