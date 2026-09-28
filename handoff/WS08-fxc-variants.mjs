// WS08：天环在窗外 OW 变体里的离线 FXC 逐项撤回
// （node scripts/shader-budget.mjs --variants handoff/WS08-fxc-variants.mjs --only outside-extras --rounds 3）。
// --variants 会临时改磁盘上的源文件（测完恢复）；锚点只用单行；撤回写成编译期常量（if (false)）。
const F = "src/wonders/ring.glsl.ts";
const O = "src/render/outside-pass.ts";
export const VARIANTS = [
  ["cur", []],
  ["noRing", [{ file: O, find: "  L = orbitRing(L, rd, hitGround);", replace: "" }]],
  ["loopGuard", [{ file: F, find: "  for (int i = 0; i < 4; i++) {", replace: "  for (int i = 0; i < 4 + uLoopGuard; i++) {" }]],
  ["noLampPts", [{ file: F, find: "    float lamps = mix(ringLampPts(vec2(sAl, v), rd, P, A, B, n, r, pixA, abs(d2.x), 8.0, 0.8, 13.0 + 31.0 * uRingDet.w, Lp, Lh, Sr),", replace: "    float lamps = mix(0.0," }]],
  ["noPillar", [
    { file: F, find: "  if (tpl > 0.0) {", replace: "  if (false) {" },
    { file: F, find: "  if (cP > 0.0) {", replace: "  if (false) {" },
  ]],
  ["noSeg", [
    { file: F, find: "  float segVar = ringSegHash(sx, fTb, Sr, 31.0 + uRingDet.w * 97.0);", replace: "  float segVar = 0.5;" },
    { file: F, find: "  float truss = ringSegIs(sx, fTb, Sr, 7.0 + uRingDet.w * 97.0, 0.13);", replace: "  float truss = 0.13;" },
  ]],
  ["noPulse", [
    { file: F, find: "  float pls1 = sqrt(225.0 / sgE2) * exp(-0.5 * ph1 * ph1 * 490000.0 / sgE2);", replace: "  float pls1 = 0.0;" },
    { file: F, find: "  float pls2 = sqrt(225.0 / sgE2) * exp(-0.5 * ph2 * ph2 * 490000.0 / sgE2);", replace: "  float pls2 = 0.0;" },
  ]],
];
