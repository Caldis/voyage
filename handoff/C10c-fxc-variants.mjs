// C10c：shader-budget --variants 的补丁（在磁盘上的 src 做替换、计时、立刻改回）。拆冷编译增量来自哪一处
const F = "src/clouds/clouds.ts";
const PROBE = "        if (layerDensity(q, lod, t < 150.0) > 0.2 * dens) pL = q;\n";
const LIGHT6 = "        for (int j = 0; j < 6; j++) {\n          lt += lsL;\n          od += layerDensity(pL";
export const VARIANTS = [
  ["cur", []],
  ["noprobe", [{ file: F, find: PROBE, replace: "" }]],
  // 受光循环是不是被展开了：上界带 uLoopGuard（探测也去掉，和 noprobe 比）
  ["noprobeLG", [{ file: F, find: PROBE, replace: "" }, { file: F, find: LIGHT6, replace: LIGHT6.replace("j < 6", "j < 6 + uLoopGuard") }]],
];
