// PERF-12：舱内合成里倒影以外各段的 GPU 消融（passes.mjs --material sceneMat --variants 用）
export const VARIANTS = [
  ["base", []],
  ["-stars", [["    view += starPoints(rdW) * sunTransmittance(uCamR, rdW.y) * (PANE_TRANSMITTANCE * (outside.a - 1.0));", ""]]],
  ["-scratches", [["  vec2 sc = scratches(q, rd, sunC, pixPane);", "  vec2 sc = vec2(0.0);"]]],
  ["-smudges", [["  float sm = smudges(q);", "  float sm = 0.0;"]]],
  ["-wipe", [["  float wm = wipeMarks(q, pixPane);", "  float wm = 0.0;"]]],
  ["-waterFn", [["  vec4 wat = waterOnPane(q, pixPane, -uSeatSign, uTime, uWetness);", "  vec4 wat = vec4(0.0);"]]],
  ["-wall", [["  vec3 wall = shadeWall(pW, rd, tWall, pixAng, wq, dBezel, seed, wallSeatAO, cl);", "  vec3 wall = vec3(0.1);"]]],
  ["-reveal", [["  bool rvHit = dBezel < 0.01 && marchFunnel(roL, rd, hit);", "  bool rvHit = false; hit = vec3(0.0);"]]],
  ["-shade", [["  vec3 shade = shadeShade(pShade - vec3(wOff, 0.0), rd, pixShade, cl, shadeBottom, seed);", "  vec3 shade = vec3(0.1);"]]],
  ["-seats", [["  SeatHit seat = traceSeats(ro, rd, tWall, pixAng);", "  SeatHit seat; seat.cov = 0.0; seat.t = -1.0;"]]],
];
