// T38（T44 遗留）按 pass 逐项归因：在同一页面里撤回各项改动，看云步进的开销
//   node scripts/passes.mjs --port 5238 --only typhoon-bands --variants handoff/T38-variants-cost.mjs --target clouds.raw
const H = ["        h01 = mix(h01, clamp((r - BOTTOM) / 10.0, 0.0, 1.0), outK);\n        ambFloor = mix(ambFloor, 0.4, outK);", ""];
const L = ["          gLightLen = ls;\n", ""];
const W = ["  rb *= 1.0 + (0.07 * sin(alt * 21.0 / Ht + ph) + 0.045 * sin(alt * 37.0 / Ht + 2.3 * ph + 1.7)) * smoothstep(0.1, 0.3, hh);", ""];
export const VARIANTS = [["base", []], ["noAmb", [H]], ["noLen", [L]], ["noWaist", [W]], ["noAll", [H, L, W]], ["base2", []]];
