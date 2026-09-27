/// <reference lib="webworker" />
// 地面 clipmap 一级的水体 + 道路 + 夜光合成 Worker（T08 起道路，PERF-9 并入水体/夜光，G03 并入高清细节合成）。
// 见 road-raster.ts 的 buildGroundLevel：收 { id, job, albedo, nightRaw, detail? }（G06 起 albedo / detail 是 ImageBitmap，在这里读回像素），
// OffscreenCanvas 栅格化水体/河道、合高清细节（imagery-blend.ts，只改影像 RGB）、变换并放大夜光、叠加道路后，
// 把 { id, water, albedo, detailCoverage } 转移回去
// （像素数组 / 位图都是 Transferable，job 的瓦片几何仍是复制——它们缓存在主线程 tiles.ts 的 LRU 里给下次重建复用，不能转移/detach）。
import { buildGroundLevel, type RoadJob } from "./road-raster";

self.onmessage = (e: MessageEvent<{ id: number; job: RoadJob; albedo: ImageBitmap; nightRaw: Uint8ClampedArray; detail: ImageBitmap | null }>) => {
  const { id, job, albedo, nightRaw, detail } = e.data;
  const t0 = performance.now();
  const { water, albedo: albedoOut, detailCoverage } = buildGroundLevel(job, albedo, nightRaw, detail);
  const ms = performance.now() - t0;
  (self as unknown as Worker).postMessage({ id, water, albedo: albedoOut, detailCoverage, ms }, [water.buffer, albedoOut.buffer]);
};
