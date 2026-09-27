// G07b：mip 浮点临时缓冲复用 vs 每级新分配——输出逐字节相同、耗时与 GC（离线，node）。
// 用法（apps/voyage 下）：node --expose-gc --import ./scripts/lib/ts-resolve.mjs --experimental-transform-types --no-warnings handoff/G07b-mipscratch.mts [边长=2048] [轮数=20]
import { PerformanceObserver } from "node:perf_hooks";
import { buildMipChain, mipScratch } from "../src/ground/mips";

const res = Number(process.argv[2] ?? 2048);
const rounds = Number(process.argv[3] ?? 20);
const px = new Uint8ClampedArray(res * res * 4);
for (let i = 0; i < px.length; i++) px[i] = (i * 2654435761) >>> 24;

// 1. 逐字节相同（复用缓冲跑两次，确认上一次的残留不影响结果）
mipScratch.reuse = false;
const ref = buildMipChain(px, res, "albedo");
mipScratch.reuse = true;
buildMipChain(px, res, "albedo");
const got = buildMipChain(px, res, "albedo");
let diff = 0;
for (let i = 0; i < ref.length; i++) if (ref[i] !== got[i]) diff++;
console.log(`逐字节差异：${diff} / ${ref.length}`);

// 2. 耗时与 GC（每种做法 rounds 次，按 Worker 的实际顺序：影像 + 水体）
let gcMs = 0;
let gcN = 0;
const obs = new PerformanceObserver((list) => {
  for (const e of list.getEntries()) {
    gcMs += e.duration;
    gcN++;
  }
});
obs.observe({ entryTypes: ["gc"] });
for (const reuse of [false, true, false, true]) {
  mipScratch.reuse = reuse;
  (globalThis as { gc?: () => void }).gc?.();
  await new Promise((r) => setTimeout(r, 50));
  gcMs = 0;
  gcN = 0;
  const t: number[] = [];
  for (let k = 0; k < rounds; k++) {
    const t0 = performance.now();
    buildMipChain(px, res, "albedo");
    buildMipChain(px, res, "water");
    t.push(performance.now() - t0);
  }
  await new Promise((r) => setTimeout(r, 50));
  t.sort((a, b) => a - b);
  console.log(`${reuse ? "复用" : "新分配"}：中位 ${t[rounds >> 1].toFixed(1)} ms，最慢 ${t[rounds - 1].toFixed(1)} ms；GC ${gcN} 次，合计 ${gcMs.toFixed(1)} ms`);
}
obs.disconnect();
process.exit(diff ? 1 : 0);
