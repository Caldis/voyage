// W-STAIR：离线 FXC 编译时间按单项撤回对照
// node scripts/shader-budget.mjs --variants handoff/W-STAIR-variants-fxc.mjs --only wing --rounds 3
const W = "src/render/wing.glsl.ts";
const S = "src/render/wing-shading.glsl.ts";
export const VARIANTS = [
  ["cur", []],
  ["无分段下界", [{ file: W, find: "if (uFlap > 1e-3 || uSlat > 1e-3) {\n    float z = P.z - ROOT_Z;", replace: "if (false) {\n    float z = P.z - ROOT_Z;" }]],
  ["无饿死规则", [{ file: W, find: "else if (marchSteps < uWingSteps / 4 && t <= tExit && i >= limit - 1 && (uWingDebug & 8192) == 0) { w.cov = 1.0; w.bumpVar = -1.0; }", replace: "" }]],
  ["无中心样本", [{ file: S, find: "    acc += colC * (lC > lCap ? lCap / lC : 1.0);\n    covSum += 1.0;\n", replace: "" }]],
];
