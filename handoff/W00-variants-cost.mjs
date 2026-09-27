// W00：云步进奇观变体里各段代码的 GPU 开销归因（W00-mkvar.mjs 转成 passes.mjs 的 --variants JSON，页面内替换片段）
const COMP = ["if (wPending && t + stepLen * jitter >= tW) {", "if (false) {"];
const CAST = ["if (tp > shSeg.x && tp < shSeg.y) sunLight *= wonderCasterVis(tp, shQ);", ""];
const SEG = ["vec2 shSeg = wonderCasterSegment(rd, shQ);", "vec2 shSeg = NO_SEG;"];
const FETCH = ["vec4 sw = texelFetch(uWonderSurf, ivec2(gl_FragCoord.xy), 0);", "vec4 sw = vec4(0.0);"];
export const VARIANTS = [
  ["base", []],
  ["comp", [COMP]],
  ["cast", [CAST]],
  ["seg", [SEG]],
  ["comp+cast", [COMP, CAST]],
  ["fetch", [FETCH]],
  ["all", [COMP, CAST, SEG, FETCH]],
];
