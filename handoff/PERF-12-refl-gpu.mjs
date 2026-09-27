// PERF-12：倒影内部的细分消融（passes.mjs --material sceneMat --variants 用，[查找, 替换] 对）
export const VARIANTS = [
  ["base", []],
  ["-oppWindows", [["  col = mix(col, mix(winL, shadeL, cShade), 1.0 - smoothstep(-wW, wW, dWin));", ""]]],
  ["-ceiling", [["  col = mix(col, ceilL, smoothstep(RF_CEIL - wW, RF_CEIL + wW, hW.y));", ""]]],
  ["-oppBin", [["  col = mix(col, underL, clamp(cUnder, 0.0, 1.0));\n  col = mix(col, obL, clamp(cFace, 0.0, 1.0));", ""]]],
  ["-cBin", [["  col = mix(col, underL, clamp(mix(cCU, cCUg, RF_GHOST_EDGE), 0.0, 1.0));\n  col = mix(col, cbL, clamp(cCF, 0.0, 1.0));", ""]]],
  ["-seatPlane", [["  if (r.y < 0.0) {\n    float tS", "  if (false) {\n    float tS"]]],
  ["-blobs", [["  col = mix(col, bodyDark, cBody * (1.0 - L.lit));\n  col *= 1.0 - 0.13 * L.lit * max(cBody, cHead);", ""]]],
  ["-cols", [["for (int kr = 0; kr < RF_NCOL + uLoopGuard; kr++) {", "for (int kr = 0; kr < 0; kr++) {"]]],
  ["-pts", [["  if (max(moodOn, L.lit) <= 0.0) return vec3(0.0);", "  return vec3(0.0);"]]],
];
