// G07：Worker 里生成一层 mip 链的耗时（离线，node）。用法（apps/voyage 下）：
// node --import ./scripts/lib/ts-resolve.mjs --experimental-transform-types --no-warnings handoff/G07-mipbench.mts [边长=2048]
import { buildMipChain } from "../src/ground/mips";

const res = Number(process.argv[2] ?? 2048);
const px = new Uint8ClampedArray(res * res * 4);
for (let i = 0; i < px.length; i++) px[i] = (i * 2654435761) >>> 24;
for (const kind of ["albedo", "water"] as const) {
  const t: number[] = [];
  for (let k = 0; k < 6; k++) {
    const t0 = performance.now();
    buildMipChain(px, res, kind);
    t.push(performance.now() - t0);
  }
  t.sort((a, b) => a - b);
  console.log(`${kind} ${res}²：中位 ${t[3].toFixed(1)} ms，最快 ${t[0].toFixed(1)} ms`);
}
