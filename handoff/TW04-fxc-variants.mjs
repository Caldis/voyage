// TW04 冷编译归因：shader-budget --variants 用（逐项撤回，看 cloud-march-storm 掉多少）。
// node scripts/shader-budget.mjs --variants handoff/TW04-fxc-variants.mjs --only cloud-march-storm --rounds 2
// 注意：会直接改磁盘上的源文件（跑完还原），不要在起着本 worktree 开发服务器时跑（README）
const G = "src/clouds/clouds.glsl.ts";
const M = "src/clouds/clouds.ts";
export const VARIANTS = [
  ["base", []],
  ["nolobe", [{ file: G, find: "  float lobe = 0.13 * (cs2.y * cos(a2) + cs2.x * sin(a2)) + 0.07 * (cs3.y * cos(a3) + cs3.x * sin(a3));", replace: "  float lobe = 0.0;" }]],
  ["nofine", [{ file: G, find: "             + fineW * (0.3 * stormCap(nB.b) + 0.16 * stormCap(nB.a)) + 0.25 * (nB.r - 0.55);", replace: "             + 0.25 * (nB.r - 0.55);" }]],
  ["sat3fixed", [{ file: G, find: "    if (k >= nSat) break;", replace: "" }, { file: G, find: "  for (int k = 0; k < 4 + min(uStormCount, 0); k++) {", replace: "  for (int k = 0; k < 3 + min(uStormCount, 0); k++) {" }]],
  ["nowxlight", [{ file: M, find: "      if (stormW > 0.5 && soft) { ls = 0.24; lightSteps = 6; }", replace: "" }]],
];
