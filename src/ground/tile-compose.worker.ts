/// <reference lib="webworker" />
// 影像瓦片拼接 Worker（G08-STITCH）：收 { id, albedo, detail }（ComposeSpec：各瓦片的 JPEG Blob 与画布矩形），
// 解码（按地址缓存解好的位图）、在 CPU 画布上拼、读回像素，把 { id, albedo, detail } 像素数组转移回主线程，
// 主线程再原样转移给地面合成 Worker（road-raster.worker.ts）。
// 为什么单独一个 Worker：拼一级 2048² 在 CPU 上要 40–100 ms，放进合成 Worker 就串在它的关键路径上（首载 7 级排队，粗版就位慢约 0.5 s，
// handoff/G08-STITCH.md）；单独一个线程时它和上一级的水体 / 道路 / mip 并行。
// 出错时回 { id, error }，主线程停用这个 Worker，改由合成 Worker 自己拼（同一份代码）。
import { DecodedCache, composeTiles, type ComposeSpec } from "./tile-compose";

/**
 * 解码缓存的容量（张，256² 一张 256 KB，满了约 300 MB）：要大于「全部 7 级 + 高清细节两级」一轮重建的瓦片总数（约 900–1100），
 * 否则 LRU 按级轮转访问会整轮不命中。G07b 以前主线程的位图缓存是 1500 张（含夜光 / 地形），这里只放影像
 */
const cache = new DecodedCache(1200);

type Msg = { id: number; albedo: ComposeSpec; detail: ComposeSpec | null };

// 任务串行：解码是异步的，不串行的话两个任务交错，后一个的缓存换出会关掉前一个还没画的位图
let chain: Promise<void> = Promise.resolve();
self.onmessage = (e: MessageEvent<Msg>) => {
  chain = chain.then(() => handle(e.data));
};

async function handle({ id, albedo, detail }: Msg) {
  const t0 = performance.now();
  try {
    const a = await composeTiles(albedo, cache);
    const tD = performance.now() - t0;
    const d = detail ? await composeTiles(detail, cache) : null;
    const ms = performance.now() - t0;
    // 阶段时刻（离开始多少毫秒）：影像解码完 / 影像拼完读回；高清细节同理
    const marks: [string, number][] = [["eoxDecode", a.decodeMs], ["eoxStitch", a.readMs]];
    if (d) marks.push(["gsiDecode", tD + d.decodeMs], ["gsiStitch", tD + d.readMs]);
    const transfer: Transferable[] = [a.px.buffer];
    if (d) transfer.push(d.px.buffer);
    (self as unknown as Worker).postMessage(
      {
        id, albedo: a.px, detail: d?.px ?? null, bad: [...a.bad, ...(d?.bad ?? [])], ms, t0Abs: performance.timeOrigin + t0, marks,
        decoded: a.decoded + (d?.decoded ?? 0), hits: a.hits + (d?.hits ?? 0), aa: a.aa, cached: cache.size,
      },
      transfer,
    );
  } catch (err) {
    (self as unknown as Worker).postMessage({ id, error: err instanceof Error ? `${err.name}: ${err.message}` : String(err) });
  }
}
