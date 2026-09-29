// PERF-TW04 冷编译归因：shader-budget --variants 用（逐项撤回，看 cloud-march-storm 掉多少）。
// node scripts/shader-budget.mjs --variants handoff/PERF-TW04-fxc-variants.mjs --only cloud-march-storm --rounds 2
// 注意：会直接改磁盘上的源文件（跑完还原），先停掉本 worktree 的开发服务器（README）
const G = "src/clouds/clouds.glsl.ts";
const M = "src/clouds/clouds.ts";
export const VARIANTS = [
  ["base", []],
  ["noSatLite", [{ file: G, find: "  float sdf = stormTowersSdf(si, c, xz, alt, lod, ao);\n  float pilL = gPileusD;", replace: "  float sdf = towerSdf(xz, alt, c.xy, c.z, c.w + 0.7 + 0.6 * uStormSd[si].y, 0.72, lod, uStormSd[si].xy, 0.35, ao);\n  float pilL = 0.0;" }]],
  ["noShadowOD", [{ file: M, find: "      if (stormW < 0.5 && uStormCount > 0) sunLight *= 1.0 / (1.0 + 0.1125 * anvilShadowOD(p.xz + uCloudOffset, r - BOTTOM, uKeyDir));", replace: "" }]],
  ["noBoost", [{ file: G, find: "  gCovBoost = gWeatherOn && uStormCount > 0 ? stormLayerBoost(p.xz + uCloudOffset) : 0.0;", replace: "  gCovBoost = 0.0;" }]],
  ["noShieldMain", [{ file: G, find: "      float sh = anvilShield(xz, alt, lod, detail) * uCloudDensity;", replace: "      float sh = 0.0;" }]],
  ["noPileus", [{ file: G, find: "    if (k == 0 && fract(sd.x * 7.31 + sd.y * 3.17) < 0.0) gPileusD = pileusShape(xz, alt, ax, tk, Rk, hk, sd.y);", replace: "" }]],
];
