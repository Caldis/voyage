// PERF-14 消融 1：舱内程序 (a)/(b) 两个结构方案的最小原型（离线 FXC）
const S = "src/render/scene.ts";
const SE = "src/render/seats.glsl.ts";
const SEAT_CALL = "  SeatHit seat = traceSeats(ro, rd, tWall, pixAng);\n  vec3 seatCol = seat.cov > 0.0 ? shadeSeat(ro, rd, seat, pixAng, cl, uShadeBottom) : vec3(0.0);";
export const VARIANTS = [
  ["base", []],
  // PERF-12 已知：shadeSeat 换常数 −42%
  ["seatConst", [{ file: S, find: "vec3 seatCol = seat.cov > 0.0 ? shadeSeat(ro, rd, seat, pixAng, cl, uShadeBottom) : vec3(0.0);", replace: "vec3 seatCol = seat.cov > 0.0 ? vec3(0.1) : vec3(0.0);" }]],
  // (a) 舱内一侧：座椅的追踪与着色都搬走，只读一张纹理（借 uOutside 这个现成的 sampler 做原型）
  ["a_cabinTex", [{ file: S, find: SEAT_CALL, replace: "  vec4 sT = texelFetch(uOutside, ivec2(gl_FragCoord.xy) + ivec2(1, 0), 0);\n  SeatHit seat; seat.cov = sT.a; seat.t = 0.0;\n  vec3 seatCol = sT.rgb;" }]],
  // (b) 上界：座椅这一层的光照（cabinIrradiance / windowIrradiance / keySpec×3 / cabinEnv / 香槟金属）换成常数，只留材质
  ["b_seatNoLight", [
    { file: SE, find: "  vec3 eWin = windowIrradiance(p, nn, cl.lWin);\n  vec3 e = cabinIrradiance(p, nn, cl) * ao + eWin * sqrt(ao) + cl.eSunNormal * max(dot(nn, cl.sunC), 0.0) * sunVis;", replace: "  vec3 eWin = cl.lWin;\n  vec3 e = cl.eCabin * ao + eWin * sqrt(ao) + cl.eSunNormal * max(dot(nn, cl.sunC), 0.0) * sunVis;" },
    { file: SE, find: "    col += keySpec(nn, v, l, a, 0.04, eS);", replace: "    col += eS * a * 0.01;" },
    { file: SE, find: "  vec3 envR = cabinEnv(r, cl);\n  if (mirror > 0.0) envR = mix(envR, cl.lWin, sunThroughWindow(p, r, shadeBottom) * mirror);", replace: "  vec3 envR = cl.eCabin * mirror;" },
    { file: SE, find: "  if (metal > 0.0) col = mix(col, cabinChampagne(p, nn, rd, 0.28, ao, e, cl), metal);", replace: "  if (metal > 0.0) col = mix(col, e * 0.3, metal);" },
  ]],
];
