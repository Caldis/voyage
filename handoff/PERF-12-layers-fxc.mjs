// PERF-12：各着色层对离线 FXC 的份额（shader-budget --variants 用）
const SCENE = "src/render/scene.ts";
export const VARIANTS = [
  ["base", []],
  ["-shadeSeat", [{ file: SCENE, find: "  vec3 seatCol = seat.cov > 0.0 ? shadeSeat(ro, rd, seat, pixAng, cl, uShadeBottom) : vec3(0.0);", replace: "  vec3 seatCol = vec3(seat.t * 0.01);" }]],
  ["-shadeReveal", [{ file: SCENE, find: "    reveal = shadeReveal(hit, n, rd, length(hit - roL), pixAng, cl, mix(cl.lGlow, lWin, isMain), isMain, shadeBottom, seed);", replace: "    reveal = n * 0.1;" }]],
  ["-shadeWall", [{ file: SCENE, find: "    wall = shadeWall(pW, rd, tWall, pixAng, wq, dBezel, seed, wallSeatAO, cl);", replace: "    wall = pW * wallSeatAO;" }]],
  ["-shadeShade", [{ file: SCENE, find: "shade = shadeShade(pShade - vec3(wOff, 0.0), rd, pixShade, cl, shadeBottom, seed);", replace: "shade = pShade;" }]],
  ["-reflection", [{ file: SCENE, find: "    vec3 surf = reflGain * reflWB * cabinReflection(pPane, rr, length(pPane - ro), rl, pts);", replace: "    pts = vec3(0.0); vec3 surf = vec3(0.0);" }]],
];
