// PERF-WING 第二版候选：灯位置「用到的地方各算一次、常数下标」（不跨 wingView 活着，避免全局变量拉长寄存器生命期）
// node scripts/shader-budget.mjs --variants handoff/PERF-WING-lamps2.mjs --only wing,wing-wet --rounds 5
// 基线 = 当前提交（A：main 里 wingLampsSetup 一次，存全局）
const S = "src/render/wing-shading.glsl.ts";
const P = "src/render/wing-pass.ts";
export const V_LOCAL = [
  { file: S, find: "  float aBaseL = max(sqrt(m.rough * m.rough * m.rough * m.rough + 2.0 * max(w.bumpVar, 0.0)), 0.02);\n", replace: "  float aBaseL = max(sqrt(m.rough * m.rough * m.rough * m.rough + 2.0 * max(w.bumpVar, 0.0)), 0.02);\n  vec3 vL0 = wingLampPos(0), vL1 = wingLampPos(1), vL2 = wingLampPos(2);\n" },
  { file: S, find: "    vec3 d = wingLampAt(i) - P;", replace: "    vec3 d = (i == 0 ? vL0 : (i == 1 ? vL1 : vL2)) - P;" },
  { file: S, find: "  vec3 rdA = vec3(uSeatSign * rd.x, rd.y, rd.z);  // 机体系里的视线方向\n", replace: "  vec3 rdA = vec3(uSeatSign * rd.x, rd.y, rd.z);  // 机体系里的视线方向\n  vec3 gL0 = wingLampPos(0), gL1 = wingLampPos(1), gL2 = wingLampPos(2);\n" },
  { file: S, find: "    vec3 a = wingLampAt(i);", replace: "    vec3 a = i == 0 ? gL0 : (i == 1 ? gL1 : gL2);" },
  { file: P, find: "  wingLampsSetup();                // 三盏灯的位置，每个像素算一次（PERF-WING，见 wing-shading.glsl.ts）\n", replace: "" },
];
export const VARIANTS = [
  ["A 全局（当前）", []],
  ["V 就地常数下标", V_LOCAL],
];
