/// <reference lib="webworker" />
// 道路灯带栅格化的 Worker（T08）：见 road-raster.ts 的 packRoads。收 { id, job, px }，就地写好 px.water / px.albedo 后原样转移回去
import { packRoads, type LevelPixels, type RoadJob } from "./road-raster";

self.onmessage = (e: MessageEvent<{ id: number; job: RoadJob; px: LevelPixels }>) => {
  const { id, job, px } = e.data;
  packRoads(job, px);
  (self as unknown as Worker).postMessage({ id, px }, [px.water.buffer, px.albedo.buffer, px.night.buffer]);
};
