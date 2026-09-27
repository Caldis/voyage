// 生成云步进抖动用的蓝噪声纹理（C12），输出 src/clouds/blue-noise.ts（自生成数据，无第三方许可问题）。
// 方法：Ulichney 1993「void-and-cluster」，环面（首尾相接）高斯能量 σ = 1.5，窗口半径 8。
// 两个通道用不同的种子各生成一张（R：主步进抖动；G：受光步进挑细节格点的随机数 gDetailRnd），两张互不相关。
// 确定性：固定种子的 mulberry32，同一份脚本在任何机器上生成逐字节相同的结果（脚本末尾打印校验和，写进输出文件头）。
// 用法：node apps/voyage/scripts/gen-blue-noise.mjs [边长，默认 128]
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const SIZE = Number(process.argv[2] ?? 128);
const SIGMA = 1.5;
const R = 8;
const SEEDS = [0x9e3779b9, 0x85ebca6b];

function mulberry32(a) {
  return () => {
    a |= 0; a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** 返回每个像素的秩（0..N−1）。秩越小越先放下；按秩归一就是蓝噪声阈值图 */
function voidAndCluster(W, seed) {
  const N = W * W;
  const K = [];
  for (let dy = -R; dy <= R; dy++) for (let dx = -R; dx <= R; dx++) K.push([dx, dy, Math.exp(-(dx * dx + dy * dy) / (2 * SIGMA * SIGMA))]);
  const E = new Float64Array(N);
  const bits = new Uint8Array(N);
  const add = (p, s) => {
    const x = p % W, y = (p / W) | 0;
    for (const [dx, dy, k] of K) E[((y + dy + W) % W) * W + ((x + dx + W) % W)] += s * k;
  };
  // 最紧的簇：值为 1 的像素里能量最大的；最大的空洞：值为 0 的像素里能量最小的（同分取先遇到的，确定性）
  const tightest = () => { let b = -1, v = -Infinity; for (let p = 0; p < N; p++) if (bits[p] && E[p] > v) { v = E[p]; b = p; } return b; };
  const largestVoid = () => { let b = -1, v = Infinity; for (let p = 0; p < N; p++) if (!bits[p] && E[p] < v) { v = E[p]; b = p; } return b; };

  // 初始图样：随机撒 10%，再「最紧的簇挪到最大的空洞」直到不再变化
  const rnd = mulberry32(seed);
  const ones0 = Math.round(N * 0.1);
  let placed = 0;
  while (placed < ones0) { const p = Math.floor(rnd() * N); if (!bits[p]) { bits[p] = 1; add(p, 1); placed++; } }
  for (let it = 0; it < 10 * N; it++) {
    const c = tightest();
    bits[c] = 0; add(c, -1);
    const v = largestVoid();
    if (v === c) { bits[c] = 1; add(c, 1); break; }
    bits[v] = 1; add(v, 1);
  }
  const proto = bits.slice();
  const protoE = E.slice();
  const rank = new Int32Array(N).fill(-1);
  // 第一阶段：从初始图样里逐个拿掉最紧的簇，秩从 ones0 − 1 往下编
  for (let r = ones0 - 1; r >= 0; r--) { const c = tightest(); bits[c] = 0; add(c, -1); rank[c] = r; }
  // 第二、三阶段：回到初始图样，逐个往最大的空洞里放。环面上核的总和恒定，「0 的最紧簇」就是「1 的最大空洞」，两阶段合成一段
  bits.set(proto); E.set(protoE);
  for (let r = ones0; r < N; r++) { const v = largestVoid(); bits[v] = 1; add(v, 1); rank[v] = r; }
  return rank;
}

const N = SIZE * SIZE;
const out = new Uint8Array(N * 2);
const t0 = Date.now();
SEEDS.forEach((seed, ch) => {
  const rank = voidAndCluster(SIZE, seed);
  for (let p = 0; p < N; p++) out[2 * p + ch] = Math.floor(((rank[p] + 0.5) / N) * 256);
});
let sum = 0;
for (let i = 0; i < out.length; i++) sum = (Math.imul(sum, 31) + out[i]) >>> 0;
const b64 = Buffer.from(out).toString("base64");
const here = path.dirname(fileURLToPath(import.meta.url));
const dst = path.join(here, "..", "src", "clouds", "blue-noise.ts");
const lines = b64.match(/.{1,120}/g).map((s) => `  "${s}"`).join(" +\n");
fs.writeFileSync(
  dst,
  `// 自动生成，不要手改：node apps/voyage/scripts/gen-blue-noise.mjs ${SIZE}（C12）
// 蓝噪声阈值图 ${SIZE}×${SIZE}，两个通道（RG8，行优先，逐像素 [R, G]），void-and-cluster σ = ${SIGMA}，种子 ${SEEDS.map((s) => "0x" + s.toString(16)).join(" / ")}。
// 本仓库自己生成的数据，没有第三方许可问题。校验和 ${sum.toString(16)}
export const BLUE_NOISE_SIZE = ${SIZE};
export const BLUE_NOISE_RG8_BASE64 =
${lines};
`,
);
console.log(`写出 ${dst}：${SIZE}² × 2，用时 ${Date.now() - t0} ms，校验和 ${sum.toString(16)}`);
