/// <reference lib="webworker" />
// 地面 clipmap 一级的合成 Worker（T08 起道路，PERF-9 并入水体/夜光，G03 并入高清细节合成）。
// 收 { id, job, albedo, nightRaw, detail? }：albedo / detail（road-raster.ts 的 ImagerySrc）通常是拼接 Worker（tile-compose.worker.ts，G08）
// 已经拼好的像素；拼接 Worker 停用时是瓦片拼接任务（ComposeSpec，在这里解码拼接）；`ground.imageryInWorker = false` 对照时是主线程拼好的
// ImageBitmap（G07b 的做法）。之后栅格化水体/河道、合高清细节（imagery-blend.ts）、变换并放大夜光、叠加道路、算 mip 链
// （road-raster.ts 的 buildGroundLevel），把 { id, water, albedo, detailCoverage, mips… } 转移回去
// （像素数组是 Transferable；job 的瓦片几何是复制——它们缓存在主线程 tiles.ts 的 LRU 里）。
// 出错时回 { id, error }，主线程停用 Worker、改在主线程算（onmessage 是 async 的，异常不会触发 Worker 的 error 事件，必须自己回报）。
import { buildGroundLevelFrom, type ImagerySrc, type RoadJob } from "./road-raster";
import { DecodedCache } from "./tile-compose";

/** 只在拼接 Worker 停用、由这里自己拼时用到（容量理由见 tile-compose.worker.ts）；不用时不占内存 */
const cache = new DecodedCache(1200);

type Msg = { id: number; job: RoadJob; albedo: ImagerySrc; nightRaw: Uint8ClampedArray; detail: ImagerySrc | null };

// 任务串行（上一个做完才开始下一个）：自己拼时解码是异步的，不串行的话两个任务交错，后一个的缓存换出会关掉前一个还没画的位图
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
