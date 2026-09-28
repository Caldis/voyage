// PERF-WING 第三轮消融（不等价）：着色内部各块的份额
// node scripts/shader-budget.mjs --variants handoff/PERF-WING-abl3.mjs --only wing --rounds 3
const W = "src/render/wing.glsl.ts";
const S = "src/render/wing-shading.glsl.ts";
const P = "src/render/wing-pass.ts";
export const VARIANTS = [
  ["base", []],
  ["着色里灯位置换常数", [{ file: S, find: "    vec3 d = wingLampPos(i) - P;", replace: "    vec3 d = vec3(float(i), 1.0, 16.0) - P;" }]],
  ["灯光晕里灯位置换常数", [{ file: S, find: "    vec3 a = wingLampPos(i);", replace: "    vec3 a = vec3(float(i), 1.0, 16.0);" }]],
  ["无照翼面配光", [{ file: S, find: "    vec3 e = wingLampSurfI(i, -l) / (dd + 0.0025) * 1e-3 * nlS;", replace: "    vec3 e = l / (dd + 0.0025) * 1e-3 * nlS;" }]],
  ["无 Iavg 第二次配光", [{ file: S, find: "      vec3 Iavg = i == 1 ? I : wingLampIntensity(i, vec3(1.0, 0.0, 0.3)) * 0.3;", replace: "      vec3 Iavg = I;" }]],
  ["无 wingLights", [{ file: P, find: "  col += wingLights(ro, rd) * WING_PANE_T * m;", replace: "" }]],
  ["无小翼材质", [{ file: W, find: "  if (part == 1) m = wingTipSurface(P, pix);\n  else if", replace: "  if" }]],
  ["无短舱材质", [{ file: W, find: "  else if (part == 6) m = wingNacelleSurface(P, pix);\n", replace: "" }]],
  ["无翼面材质", [{ file: W, find: "  else m = wingPanelSurface(P, pix, up, part);", replace: "  else m = wingPaint(vec3(pix), up);" }]],
];
