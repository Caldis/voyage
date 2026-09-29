// WS09：垂直大陆（OWV）的离线 FXC 逐项撤回
// （node scripts/shader-budget.mjs --variants handoff/WS09-fxc-variants.mjs --only outside-continent --rounds 3，在 apps/voyage 下）。
// --variants 会临时改磁盘上的源文件（测完恢复）；锚点只用单行；撤回写成编译期常量（if (false)）或让结果不被用到（FXC 会删掉死代码）。
const F = "src/wonders/continent.glsl.ts";
export const VARIANTS = [
  ["cur", []],
  ["noSurface", [{ file: F, find: "    if (!isCloud) {", replace: "    if (false) {" }]],
  ["noClouds", [
    { file: F, find: "        tauS += tw;", replace: "" },
    { file: F, find: "          tauS += tb;", replace: "" },
    { file: F, find: "        hS += tw * min(y, ctop);", replace: "" },
    { file: F, find: "          hS += tb * y;", replace: "" },
  ]],
  ["noFall", [{ file: F, find: "      if (fc.w > 0.5) {", replace: "      if (false) {" }]],
  ["noContrail", [{ file: F, find: "  vec2 ct = contContrail(o, d, pixelAngle, T);", replace: "  vec2 ct = vec2(0.0, 1e9);" }]],
  ["noBrink", [{ file: F, find: "        float hq = contBrink(u + float(q - 1) * fu, Hl, fu);", replace: "        float hq = Hl;" }]],
  ["noApFar", [{ file: F, find: "    if (tk > AERIAL_MAX_DISTANCE) {", replace: "    if (false) {" }]],
];
