// T44 逐项归因（页面内替换云步进着色器片段，配合 T37-mkvar.mjs 转成 passes.mjs 的 --variants）
const THICK = [
  "max(min(0.9 * exp(-(r - Re * 3.5) / (Re * 1.3)), 0.9) * mix(1.0, 0.4 + 0.9 * fibS, thin),\n                                       mix(0.0, 0.012 + 0.04 * fibS * fibS, thin))",
  "mix(0.9, 0.3 * fibS, thin)",
];
const CBASE = ["canopyBase += 1.2 * (nCb.r - 0.5) + 0.8 * hurCap(nCb.g) * smoothstep(Re * 3.5, Re * 6.0, r);", ""];
const NO = ["vec4 nO = textureLod(uShapeNoise, vec3(u * 11.0, alt / 18.0, 0.53), max(lod - 4.0, 0.0));", "vec4 nO = vec4(0.5);"];
const FADE = ["* (1.0 - smoothstep(Re * 3.3, Re * 4.1, r + Re * 0.35 * (nT.a - 0.5)));", ";"];
export const VARIANTS = [
  ["base", []],
  ["thickCanopy", [THICK]],
  ["noCanopyBase", [CBASE]],
  ["noNO", [NO]],
  ["noFade", [FADE]],
  ["base2", []],
];
