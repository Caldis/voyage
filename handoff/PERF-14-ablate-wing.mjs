// PERF-14 消融 2：机翼程序（离线 FXC）
const WP = "src/render/wing-pass.ts";
const WS = "src/render/wing-shading.glsl.ts";
const WG = "src/render/wing.glsl.ts";
export const VARIANTS = [
  ["base", []],
  // 航行灯 / 频闪 / 尾灯本身（亮点 + 云雾光晕）
  ["noLights", [{ file: WP, find: "  col += wingLights(ro, rd) * WING_PANE_T * m;", replace: "" }]],
  // 翼尖灯照亮翼面
  ["noLampLit", [{ file: WS, find: "  for (int i = min(uWingSteps, 0); i < 3; i++) {  // 起点依赖 uniform：不让 FXC 展开成三份\n    vec3 d = wingLampPos(i) - P;", replace: "  for (int i = min(uWingSteps, 0); i < 0; i++) {\n    vec3 d = wingLampPos(i) - P;" }]],
  // 灯全拆（照明 + 灯本身）
  ["noAllLamps", [
    { file: WP, find: "  col += wingLights(ro, rd) * WING_PANE_T * m;", replace: "" },
    { file: WS, find: "  for (int i = min(uWingSteps, 0); i < 3; i++) {  // 起点依赖 uniform：不让 FXC 展开成三份\n    vec3 d = wingLampPos(i) - P;", replace: "  for (int i = min(uWingSteps, 0); i < 0; i++) {\n    vec3 d = wingLampPos(i) - P;" },
  ]],
  // 两处 wingEnv 调用只留一处
  ["oneEnv", [{ file: WS, find: "  vec3 envBase = wingEnv(r, m.rough, eSky, eDown, belowAlbedo);", replace: "  vec3 envBase = envSharp;" }]],
  // 窗板水珠（waterOnPane）
  ["noWater", [{ file: WP, find: "    float wetRim = waterOnPane(q, pixPane, -uSeatSign, uTime, uWetness).w;", replace: "    float wetRim = 0.0;" }]],
  // 材质整体换常数
  ["noSurface", [{ file: WS, find: "  WingSurface m = wingSurface(P, pix, nA.y, w.part);", replace: "  WingSurface m = wingPaint(WING_PAINT, 0.25);" }]],
  // 小翼材质
  ["noTipSurf", [{ file: WG, find: "  if (part == 1) m = wingTipSurface(P, pix);\n  else if", replace: "  if (part == 1) m = wingPaint(WING_PAINT, 0.25);\n  else if" }]],
  // 短舱材质
  ["noNacSurf", [{ file: WG, find: "  else if (part == 6) m = wingNacelleSurface(P, pix);", replace: "  else if (part == 6) m = wingPaint(WING_PAINT, 0.25);" }]],
  // 蒙皮细节（主翼 / 襟翼 / 扰流板 / 缝翼）
  ["noPanelSurf", [{ file: WG, find: "  else m = wingPanelSurface(P, pix, up, part);", replace: "  else m = wingPaint(WING_PAINT, 0.25);" }]],
  // 机身投影
  ["noFuseShadow", [{ file: WS, find: "  float shadow = wingFuselageShadow(P, lA) * step(0.0, nl) * w.shadow;", replace: "  float shadow = step(0.0, nl) * w.shadow;" }]],
  // 云雾
  ["noFog", [{ file: WS, find: "      if (uCameraFog > 0.0) {\n        float tFog", replace: "      if (uCameraFog > 1e30) {\n        float tFog" }]],
];
