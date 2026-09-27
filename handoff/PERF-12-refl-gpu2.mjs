// PERF-12：倒影开销是「执行」还是「占寄存器」——代码照编、运行时用恒假的 uniform 跳过
export const VARIANTS = [
  ["base", []],
  ["reflUniformOff", [["  if (rl.readOn > 0.0 || reflMax > 0.003 * dot(view, vec3(0.2126, 0.7152, 0.0722))) {", "  if (uLoopGuard > 0 && (rl.readOn > 0.0 || reflMax > 0.003 * dot(view, vec3(0.2126, 0.7152, 0.0722)))) {"]]],
  ["-reflAll", [["    vec3 surf = reflGain * reflWB * cabinReflection(pPane, rr, length(pPane - ro), rl, pts);", "    pts = vec3(0.0); vec3 surf = vec3(0.0);"]]],
  ["colsUniformOff", [["for (int k = 0; k < RF_NCOL + uLoopGuard; k++) {", "for (int k = 0; k < RF_NCOL * uLoopGuard; k++) {"]]],
];
