// W-EDGE：离线 FXC 编译时间按单项撤回对照（找冷编译花在哪）
// node scripts/shader-budget.mjs --variants handoff/W-EDGE-variants-fxc.mjs --only wing --rounds 3
const W = "src/render/wing.glsl.ts";
const PROBE = { file: W, find: "        if (w.cov == 1.0 && (silPx < 3.0", replace: "        if (false && w.cov == 1.0 && (silPx < 3.0" };
const CONT = [
  { file: W, find: "      if (d < 0.4 * fp && j == 5 && gWingPart != w.part) {", replace: "      if (false) {" },
  { file: W, find: "        if (!extend && (t > tExit || i >= limit - 1) && j == 5) {", replace: "        if (false) {" },
];
const NOCONT = { file: W, find: "        continue;\n      }\n      // 软阴影", replace: "      } else {\n      // 软阴影" };
const NOCONT2 = { file: W, find: "      if (ts > 24.0) break;\n    }\n  }", replace: "      if (ts > 24.0) break;\n    }\n    }\n  }" };
const TOTAL = { file: W, find: "  int total = marchSteps * 3 + 4 + shadowSteps + (shadowSteps > 0 ? 48 : 0);", replace: "  int total = marchSteps * 3 + 4 + shadowSteps;" };
export const VARIANTS = [
  ["cur", []],
  ["无 continue", [NOCONT, NOCONT2]],
  ["循环上限还原", [TOTAL]],
  ["无探测入口", [PROBE]],
  ["无延续段", CONT],
  ["四项全撤", [NOCONT, NOCONT2, TOTAL, PROBE, ...CONT]],
];
