// PERF-WING 第二轮消融（不等价）：着色占机翼冷编译约 69%，看它贵在「自身」还是「在子射线循环里」
// node scripts/shader-budget.mjs --variants handoff/PERF-WING-abl2.mjs --only wing --rounds 3
const S = "src/render/wing-shading.glsl.ts";
const CALL = "      col = shadeWing(ro + rdk * w.t, rdk, w, sunC, eSky, eDown, belowAlbedo);";
export const VARIANTS = [
  ["base", []],
  ["着色挪到子射线循环外（粗）", [
    { file: S, find: CALL, replace: "      col = vec3(w.t, w.nA.x, w.shadow); wS = w; rS = rdk;" },
    { file: S, find: "  for (int k = min(uWingSteps, 0); k < 5; k++) {", replace: "  WingTraceResult wS = WingTraceResult(0.0, 0.0, vec3(0.0), vec3(0.0), 1.0, 0, false, 0.0, 0, 0.0, false); vec3 rS = rd;\n  for (int k = min(uWingSteps, 0); k < 5; k++) {" },
    { file: S, find: "  if (covSum <= 0.0) return vec4(0.0);", replace: "  for (int s = min(uWingSteps, 0); s < 1; s++) { if (wS.t < -1e9) break; acc += shadeWing(ro + rS * wS.t, rS, wS, sunC, eSky, eDown, belowAlbedo); }\n  if (covSum <= 0.0) return vec4(0.0);" },
  ]],
  ["无材质", [{ file: S, find: "  WingSurface m = wingSurface(P, pix, nA.y, w.part);", replace: "  WingSurface m = wingPaint(vec3(pix), nA.y);" }]],
  ["无灯照", [{ file: S, find: "    vec3 d = wingLampPos(i) - P;", replace: "    break; vec3 d = wingLampPos(i) - P;" }]],
  ["无环境反射", [{ file: S, find: "    vec3 e = wingEnv(r, i == 0 ? m.coatRough : m.rough, eSky, eDown, belowAlbedo);", replace: "    vec3 e = r * m.rough;" }]],
];
