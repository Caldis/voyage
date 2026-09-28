// WS05：OW 变体（outside-extras）离线 FXC 逐项撤回
// node scripts/shader-budget.mjs --variants handoff/WS05-fxc-variants.mjs --only outside-extras --rounds 3
// 注意：--variants 会改磁盘上的源文件（测完自动恢复）；锚点只用单行。撤回写成编译期常量。
const F = "src/render/wonder-sky.glsl.ts";
export const VARIANTS = [
  ["cur", []],
  ["noJianmu", [{ file: F, find: "  bool tether = uWonderShape.z < 0.5;", replace: "  bool tether = true;" }]],
  ["noFins", [{ file: F, find: "  if (s < 16.0) {", replace: "  if (false) {" }]],
  ["noPads", [{ file: F, find: "      for (int m = 0; m < 3 + uLoopGuard; m++) {", replace: "      for (int m = 0; m < 0; m++) {" }]],
  ["noTrunkTex", [{ file: F, find: "  if (cov > 0.0) {", replace: "  if (false) {" }]],
  ["noDeck", [{ file: F, find: "  if (s < 16.0 && b < -1e-4) {", replace: "  if (false) {" }]],
  ["noRings", [{ file: F, find: "  if (s > 5.0 && s < 28.0) {", replace: "  if (false) {" }]],
  ["noFruit", [{ file: F, find: "  if (folC > 0.0) {", replace: "  if (false) {" }]],
  ["noLeafIrr", [{ file: F, find: "  vec3 LL = leafA * mott / M_PI * (wonderIrr(nL, a, eSun, eMoon, eSkyUp, eUp) + (eSun + eMoon) * 0.12 * fwd);", replace: "  vec3 LL = leafA * eSun;" }]],
  ["noFinIrr", [{ file: F, find: "  vec3 LF = bark * vec3(0.9, 1.0, 0.9) * (0.85 + 0.3 * vnoise(vec2(X * 0.4, s * 0.5))) / M_PI * wonderIrr(nFin, a, eSun, eMoon, eSkyUp, eUp);", replace: "  vec3 LF = bark * eSun;" }]],
];
