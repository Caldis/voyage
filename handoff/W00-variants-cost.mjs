// W00：云步进里各段奇观代码的 GPU 开销归因（handoff/T37-mkvar.mjs 转成 passes.mjs 的 --variants JSON，页面内替换片段）
const CAP = ["i >= (hasW ? 288 : 192)", "i >= 192"];
const COMP = ["if (wPending && t + stepLen * jitter >= tW) {", "if (false) {"];
const MED1 = ["if (inWm) wSig = wonderMedium(wonderLocal(p, ro), wAlb, wEm);", ""];
const MED2 = ["} else if (inWm && max(wEm.r, max(wEm.g, wEm.b)) > 0.0) {", "} else if (false) {"];
const CAST = ["if (tp > shSeg.x && tp < shSeg.y) sunLight *= wonderCasterVis(tp, shQ);", ""];
const SURF = ["vec4 sw = texelFetch(uWonderSurf, ivec2(gl_FragCoord.xy), 0);", "vec4 sw = vec4(0.0);"];
const GAP = ["if (hasW) {\n      if (t > cSeg.y && t < wSeg.x) t = wSeg.x;", "if (false) {\n      if (t > cSeg.y && t < wSeg.x) t = wSeg.x;"];
export const VARIANTS = [
  ["base", []],
  ["cap", [CAP]],
  ["comp", [COMP]],
  ["med", [MED1, MED2]],
  ["cast", [CAST]],
  ["surf", [SURF]],
  ["gap", [GAP]],
  ["all", [CAP, COMP, MED1, MED2, CAST, SURF, GAP]],
];
