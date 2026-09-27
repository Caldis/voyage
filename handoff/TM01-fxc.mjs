// TM01 离线 FXC 归因（shader-budget --variants）：对定稿代码逐项撤回
//   早先的对照（写法已改掉）：软拐角写成 max(g, 0) + 0.5·max(0.5 − |g|, 0)² 时 exposure-final −11~−15%（去掉它），
//   换成等价的铰链写法后持平；高光段的四个铰链逐个写时 −1~−5%，向量化后持平
const EXP = "src/render/exposure.ts";
const HI = "vec3 a = toneMapping(x * exp2(dayHighlightGain(x) * hiGate));";
const SOFT = "mix(max(g, 0.0), 0.5 * kq * kq + max(g - 0.5, 0.0), uDayEvSoft)";
export const VARIANTS = [
  ["final", []],
  ["noHi", [{ file: EXP, find: HI, replace: "vec3 a = toneMapping(x);" }]],
  ["noSoft", [{ file: EXP, find: SOFT, replace: "max(g, 0.0)" }]],
  ["softNoSw", [{ file: EXP, find: SOFT, replace: "(0.5 * kq * kq + max(g - 0.5, 0.0))" }]],
  ["noStruct", [{ file: EXP, find: " m.day = day; m.uniformField = uniformField;", replace: "" }]],
];
