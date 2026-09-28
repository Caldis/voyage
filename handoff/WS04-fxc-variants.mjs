// WS04：离线 FXC 逐项撤回（node scripts/shader-budget.mjs --variants handoff/WS04-fxc-variants.mjs --only wonder-layer --rounds 2）。
// 会临时改磁盘上的源文件（测完自动恢复）；撤回写成编译期常量（if (false)）。锚点只用单行。
const F = "src/wonders/floatcity.glsl.ts";
export const VARIANTS = [
  ["cur", []],
  ["noContrail", [{ file: F, find: "  if (flcBig()) e1 = flcContrail(o, d, seg, pixAng);", replace: "" }]],
  ["noWisp", [{ file: F, find: "  if (big && c.y + FLC_BIG_BASE < 5.2 && rev > 0.2 && length(c.xz) < 1.95 * K.x + 3.5) sWisp", replace: "  if (false) sWisp" }]],
  ["noShadeBig", [
    { file: F, find: "    if (big) alb *= 0.8 + 0.45", replace: "    if (false) alb *= 0.8 + 0.45" },
    { file: F, find: "    alb *= 1.0 - 0.7 * arch * wall;\n    if (big) {", replace: "    alb *= 1.0 - 0.7 * arch * wall;\n    if (false) {" },
    { file: F, find: "    if (big) moss += 0.55", replace: "    if (false) moss += 0.55" },
  ]],
  ["noCrown2", [{ file: F, find: "    if (flcBig() && d < 0.25) {", replace: "    if (false) {" }]],
  ["noMedSeg", [{ file: F, find: "    bool rising = uWonderParams.x < 0.7;", replace: "    return seg; bool rising = uWonderParams.x < 0.7;" }]],
];
