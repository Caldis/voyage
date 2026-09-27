// PERF-12：舱内合成里各段的 GPU 消融（passes.mjs --material sceneMat --variants 用）；首尾各量一次 base 看漂移
export const VARIANTS = [
  ["base", []],
  ["-scratches", [["  vec2 sc = scratches(q, rd, sunC, pixPane);", "  vec2 sc = vec2(0.0);"]]],
  ["-reflAll", [["    vec3 surf = reflGain * reflWB * cabinReflection(pPane, rr, length(pPane - ro), rl, pts);", "    pts = vec3(0.0); vec3 surf = vec3(0.0);"]]],
  ["-wall", [["  vec3 wall = shadeWall(pW, rd, tWall, pixAng, wq, dBezel, seed, wallSeatAO, cl);", "  vec3 wall = vec3(0.1);"]]],
  ["-linen+grain", [["  if (fWeft + fWarp > 0.0) {", "  if (false) {"], ["  if (fA > 0.0) {\n    vec2 pr = mat2", "  if (false) {\n    vec2 pr = mat2"]]],
  ["-reveal", [["  bool rvHit = dBezel < 0.01 && marchFunnel(roL, rd, hit);", "  bool rvHit = false; hit = vec3(0.0);"]]],
  ["-shade", [["  vec3 shade = shadeShade(pShade - vec3(wOff, 0.0), rd, pixShade, cl, shadeBottom, seed);", "  vec3 shade = vec3(0.1);"]]],
  ["-seats", [["  SeatHit seat = traceSeats(ro, rd, tWall, pixAng);", "  SeatHit seat; seat.cov = 0.0; seat.t = -1.0;"]]],
  ["base2", [["  vec3 rd = cabinRay(gl_FragCoord.xy);", "  vec3 rd = cabinRay(gl_FragCoord.xy + 0.0);"]]],
];
