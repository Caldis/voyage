// W-EDGE 接手（第三个代理）：定稿各项的离线 FXC 编译代价（单项撤回）
// node scripts/shader-budget.mjs --variants handoff/W-EDGE-variants-fxc2.mjs --only wing,wing-wet --rounds 3
const W = "src/render/wing.glsl.ts";
const S = "src/render/wing-shading.glsl.ts";
const NOHOT = { file: S, find: "if (k == 0 && single > 0.5 && c < 1.0 && uWingEdgeAA > 0 && dot(", replace: "if (false && k == 0 && single > 0.5 && c < 1.0 && uWingEdgeAA > 0 && dot(" };
const NOSPLIT = [
  { file: W, find: "if (d < 0.4 * fp && w.t < 0.0 && j != 5 && shadowSteps > 0) { w.t = t; dHit = d; }\n        else if (d >= 0.4 * fp && j != 5 && w.t >= 0.0) w.t = -1.0;", replace: "" },
];
const NOVERIFY = [
  { file: W, find: "nearSil ? 0.0 : 13.0", replace: "0.0" },
  { file: W, find: "      } else if (n.z > 12.5) {", replace: "      } else if (false) {" },
];
export const VARIANTS = [
  ["cur", []],
  ["无亮点超采样", [NOHOT]],
  ["无着色点分离", NOSPLIT],
  ["无一次验深", NOVERIFY],
  ["三项全撤", [NOHOT, ...NOSPLIT, ...NOVERIFY]],
];
