// C-TOFU：shader-budget --variants，拆冷编译增量来自哪一处（在磁盘上的 src 做替换、计时、立刻改回）。
// 用法：node scripts/shader-budget.mjs --wait-quiet --variants handoff/C-TOFU-fxc-variants.mjs --rounds 4 --only cloud-march
// 交付前一轮（竖直倍率还在着色器里算时）：cur 584、nocap −2.4%、竖直倍率撤回 −9.9%、云顶撤回 −4.3% → 竖直倍率挪到 CPU（uCuShape）
const F = "src/clouds/clouds.glsl.ts";
export const VARIANTS = [
  ["cur", []],
  ["nocap", [{ file: F, find: "const float SHAPE_LOD_MAX = 3.0;", replace: "const float SHAPE_LOD_MAX = 6.0;" }]],
  ["notop", [
    { file: F, find: "  float topC = cumulusTop(d, coverage);\n  d = mix(d, max(min(d, CU_VIS_D + CU_TOP_GRAD * (topC - h)), 0.0), cuW);", replace: "" },
  ]],
];
