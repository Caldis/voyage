// PERF-WING 第三版候选：灯位置在两个入口（wingView、wingLights）开头各算一次（直线代码、常数下标），
// 全局只在各自函数里活着，不从 main 一直活到 wingLights
// node scripts/shader-budget.mjs --variants handoff/PERF-WING-lamps3.mjs --only wing,wing-wet --rounds 5
const S = "src/render/wing-shading.glsl.ts";
const P = "src/render/wing-pass.ts";
export const W_TWO = [
  { file: P, find: "  wingLampsSetup();                // 三盏灯的位置，每个像素算一次（PERF-WING，见 wing-shading.glsl.ts）\n", replace: "" },
  { file: S, find: "  vec3 lA = vec3(uSeatSign * sunC.x, sunC.y, sunC.z);\n  vec3 right = uCamBasis[0];", replace: "  wingLampsSetup();\n  vec3 lA = vec3(uSeatSign * sunC.x, sunC.y, sunC.z);\n  vec3 right = uCamBasis[0];" },
  { file: S, find: "  vec3 rdA = vec3(uSeatSign * rd.x, rd.y, rd.z);  // 机体系里的视线方向\n", replace: "  vec3 rdA = vec3(uSeatSign * rd.x, rd.y, rd.z);  // 机体系里的视线方向\n  wingLampsSetup();\n" },
];
export const VARIANTS = [
  ["A main 一次（当前）", []],
  ["W 两个入口各一次", W_TWO],
];
