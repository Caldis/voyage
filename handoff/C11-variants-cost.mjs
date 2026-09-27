// C11：resolve 的 3×3 平均的 GPU 开销（passes.mjs --variants，--material clouds.resolveMat --target clouds.history.0）。
// noavg：去掉平均那一行（等于改动前的输出）；avg1：权重固定 1（云里满权重的开销，和 imm 无关）
const LINE = "if (!depthHalf) cur = mix(cur, nsum * (1.0 / 9.0), clamp(uCloudImmersion * 1.0204 - 0.0204, 0.0, 1.0));";
export const VARIANTS = [
  ["noavg", [[LINE, ""]]],
  ["avg1", [[LINE, "if (!depthHalf) cur = nsum * (1.0 / 9.0);"]]],
];
