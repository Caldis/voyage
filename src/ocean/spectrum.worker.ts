/// <reference lib="webworker" />
// 海浪频谱 Worker（WX11g）：收 { id, n, bands, wind }，在后台算 buildSpectrum（CPU 约 20–40 ms，放主线程会掉帧），
// 把图集数组转移回主线程：{ id, data, slopeVar, heightVar, ms }。出错回 { id, error }，主线程停用 Worker、改为同步算（同一份代码）。
import { buildSpectrum, type CascadeBand } from "./spectrum";

type Msg = { id: number; n: number; bands: CascadeBand[]; wind: number };

self.onmessage = (e: MessageEvent<Msg>) => {
  const { id, n, bands, wind } = e.data;
  try {
    const t0 = performance.now();
    const r = buildSpectrum(n, bands, wind);
    const ms = performance.now() - t0;
    (self as unknown as Worker).postMessage({ id, data: r.data, slopeVar: r.slopeVar, heightVar: r.heightVar, ms }, [r.data.buffer]);
  } catch (err) {
    (self as unknown as Worker).postMessage({ id, error: String(err) });
  }
};
