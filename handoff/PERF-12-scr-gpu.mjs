// PERF-12：划痕的开销是执行还是存在（寄存器 / 分支结构）
export const VARIANTS = [
  ["base", []],
  ["-scratches", [["  vec2 sc = scratches(q, rd, sunC, pixPane);", "  vec2 sc = vec2(0.0);"]]],
  ["scrOne", [["  for (int n = 0; n < 18 + uLoopGuard; n++) {", "  for (int n = 0; n < 1 + uLoopGuard; n++) {"]]],
  ["scrNoBody", [["      if (h2.y > density) continue;", "      if (h2.y > -1.0) continue;"]]],
  ["scrNoLit", [["      lit += cov * exp(-mis * mis / 0.0004);", ""]]],
];
