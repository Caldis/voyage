// SPEC-BOW：窗外光学变体（outside-extras）离线 FXC 编译时间按单项撤回对照
// node scripts/shader-budget.mjs --variants handoff/SPEC-BOW-fxc-variants.mjs --only outside-extras --rounds 3
const F = "src/render/optics.glsl.ts";
const NO_SHADOW = { file: F, find: "sunTransmittance(rP, dot(nP, uSunDir)) * opticsRainLit(P);", replace: "sunTransmittance(rP, dot(nP, uSunDir));" };
const NO_RAIN = { file: F, find: "  vec4 rain = opticsRain(rd);", replace: "  vec4 rain = vec4(0.0, 0.0, 0.0, 1.0);" };
const NO_ARC = { file: F, find: " + opticsArcRadiance(rd, cloud.a);\n#else", replace: ";\n#else" };
const NO_CBOW = { file: F, find: "  if (uBowOn.y > 0.0 && c < 0.9063 && c > 0.6018) f *= opticsCloudBow(rd, c, cloudOpacity);", replace: "" };
const NO_SKY = { file: F, find: "(viewT * skyIrradiance(rP, nP) * 0.08 + airL)", replace: "(airL)" };
export const VARIANTS = [
  ["cur", []],
  ["无云影", [NO_SHADOW]],
  ["无天空光", [NO_SKY]],
  ["无雨区", [NO_RAIN]],
  ["无弧 / 日柱", [NO_ARC]],
  ["无云虹", [NO_CBOW]],
  ["全撤", [NO_RAIN, NO_ARC, NO_CBOW]],
];
