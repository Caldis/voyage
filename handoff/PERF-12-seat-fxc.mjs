// PERF-12：座椅内部的离线 FXC 消融（shader-budget --variants 用）
const SCENE = "src/render/scene.ts";
const SEATS = "src/render/seats.glsl.ts";
export const VARIANTS = [
  ["base", []],
  ["-shadeSeat", [{ file: SCENE, find: "  vec3 seatCol = seat.cov > 0.0 ? shadeSeat(ro, rd, seat, pixAng, cl, uShadeBottom) : vec3(0.0);", replace: "  vec3 seatCol = vec3(seat.t * 0.01);" }]],
  ["-wallSeatAO", [{ file: SCENE, find: "  float wallSeatAO = pW.y < 0.08 ? mix(0.55, 1.0, smoothstep(0.0, 0.12, sdSeats(pW))) : 1.0;", replace: "  float wallSeatAO = 1.0;" }]],
  ["-seatAO", [{ file: SEATS, find: "  float ao = seatAO(p, n);", replace: "  float ao = 1.0;" }]],
  ["-seatNormal", [{ file: SEATS, find: "  vec3 n = seatNormal(p, max(0.0006, pixRaw * 0.7), seatId, isShell);", replace: "  vec3 n = -rd;" }]],
  ["-leather", [{ file: SEATS, find: "    Leather lt = leatherSample(uv + seatId * 1.37, pix, kind, seatId * 3.1 + 1.0);", replace: "    Leather lt; lt.albedo = vec3(0.2); lt.slope = vec2(0.0); lt.rough = 0.4;" }]],
  ["-seams", [{ file: SEATS, find: "    vec2 sm = seatSeams(q, fr, wz, pix, coverZone, dn);", replace: "    dn = vec3(0.0); vec2 sm = vec2(0.0);" }]],
  ["-walnut", [{ file: SEATS, find: "  if (wood > 0.0) {", replace: "  if (false) {" }]],
  ["-seatLight", [{ file: SEATS, find: "  vec3 eWin = windowIrradiance(p, nn, cl.lWin);\n  vec3 e = cabinIrradiance(p, nn, cl) * ao + eWin * sqrt(ao) + cl.eSunNormal * max(dot(nn, cl.sunC), 0.0) * sunVis;", replace: "  vec3 eWin = vec3(0.1);\n  vec3 e = vec3(0.1);" }]],
  ["-seatSpec", [{ file: SEATS, find: "  col += keySpec(nn, v, lw, max(a2, 0.12), 0.04, eWin) * sqrt(ao);\n  col += keySpec(nn, v, cl.sunC, a2, 0.04, cl.eSunNormal) * sunVis;\n  col += cabinMoodSpec(p, nn, v, max(a2, 0.08), 0.04, cl.moodI) * ao;", replace: "" }]],
];
