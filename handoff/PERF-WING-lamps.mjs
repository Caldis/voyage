// PERF-WING：灯的位置每个像素只算一次（等价重构候选）
// node scripts/shader-budget.mjs --variants handoff/PERF-WING-lamps.mjs --only wing,wing-wet --rounds 3
const S = "src/render/wing-shading.glsl.ts";
const P = "src/render/wing-pass.ts";
const DEF_END = "  return wingTipToAircraft(sg, n, x);\n}\n";
const USE = [
  { file: S, find: "    vec3 d = wingLampPos(i) - P;", replace: "    vec3 d = wingLampAt(i) - P;" },
  { file: S, find: "    vec3 a = wingLampPos(i);", replace: "    vec3 a = wingLampAt(i);" },
  { file: P, find: "  float refL = dot(", replace: "  wingLampsSetup();\n  float refL = dot(" },
];
const AT = "vec3 wingLampAt(int i) { return i == 0 ? gWingLamp0 : (i == 1 ? gWingLamp1 : gWingLamp2); }\n";
export const VARIANTS = [
  ["base", []],
  ["A 三次常数调用", [
    { file: S, find: DEF_END, replace: DEF_END + "vec3 gWingLamp0 = vec3(0.0);\nvec3 gWingLamp1 = vec3(0.0);\nvec3 gWingLamp2 = vec3(0.0);\nvoid wingLampsSetup() { gWingLamp0 = wingLampPos(0); gWingLamp1 = wingLampPos(1); gWingLamp2 = wingLampPos(2); }\n" + AT },
    ...USE,
  ]],
  ["B 守卫循环", [
    { file: S, find: DEF_END, replace: DEF_END + "vec3 gWingLamp0 = vec3(0.0);\nvec3 gWingLamp1 = vec3(0.0);\nvec3 gWingLamp2 = vec3(0.0);\nvoid wingLampsSetup() {\n  for (int i = min(uWingSteps, 0); i < 3; i++) {\n    vec3 p = wingLampPos(i);\n    if (i == 0) gWingLamp0 = p; else if (i == 1) gWingLamp1 = p; else gWingLamp2 = p;\n  }\n}\n" + AT },
    ...USE,
  ]],
];
