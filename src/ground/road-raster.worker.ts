/// <reference lib="webworker" />
// 地面 clipmap 一级的水体 + 道路 + 夜光合成 Worker（T08 起道路，PERF-9 并入水体/夜光）。
// 见 road-raster.ts 的 buildGroundLevel：收 { id, job, albedo, nightRaw }，OffscreenCanvas 栅格化水体/河道、
// 变换夜光、叠加道路后，把 { id, water, albedo } 转移回去（两个像素数组都是 Transferable，job 的瓦片几何仍是
// 复制——它们缓存在主线程 tiles.ts 的 LRU 里给下次重建复用，不能转移/detach）。
import { buildGroundLevel, type RoadJob } from "./road-raster";

self.onmessage = (e: MessageEvent<{ id: number; job: RoadJob; albedo: Uint8ClampedArray; nightRaw: Uint8ClampedArray }>) => {
  const { id, job, albedo, nightRaw } = e.data;
  const { water, albedo: albedoOut } = buildGroundLevel(job, albedo, nightRaw);
  (self as unknown as Worker).postMessage({ id, water, albedo: albedoOut }, [water.buffer, albedoOut.buffer]);
};
