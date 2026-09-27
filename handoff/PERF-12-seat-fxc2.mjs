// PERF-12：座椅着色调用方式对离线 FXC 的影响（shader-budget --variants 用）
const SCENE = "src/render/scene.ts";
const CALL = "  vec3 seatCol = seat.cov > 0.0 ? shadeSeat(ro, rd, seat, pixAng, cl, uShadeBottom) : vec3(0.0);";
export const VARIANTS = [
  ["base", []],
  ["ifSeat", [{ file: SCENE, find: CALL, replace: "  vec3 seatCol = vec3(0.0);\n  if (seat.cov > 0.0) seatCol = shadeSeat(ro, rd, seat, pixAng, cl, uShadeBottom);" }]],
  ["loopSeat", [{ file: SCENE, find: CALL, replace: "  vec3 seatCol = vec3(0.0);\n  for (int si = 0; si < 1 + uLoopGuard; si++) { if (seat.cov > 0.0) seatCol = shadeSeat(ro, rd, seat, pixAng, cl, uShadeBottom); }" }]],
];
