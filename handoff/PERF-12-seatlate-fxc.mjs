// PERF-12：把 shadeSeat 挪到窗板分支之后调用，对离线 FXC 的影响（仅计时实验，早退路径的颜色不对）
const SCENE = "src/render/scene.ts";
export const VARIANTS = [
  ["base", []],
  ["seatLate", [
    { file: SCENE, find: "  vec3 seatCol = seat.cov > 0.0 ? shadeSeat(ro, rd, seat, pixAng, cl, uShadeBottom) : vec3(0.0);\n", replace: "" },
    { file: SCENE, find: "    gl_FragColor = vec4(mix(wall, seatCol, seat.cov), 0.0);", replace: "    gl_FragColor = vec4(wall, 0.0);" },
    { file: SCENE, find: "  vec3 colFixed = mix(mix(wall, mix((1.0 - inPane) * reveal, shade, shaded), inBezel), seatCol, seat.cov);", replace: "  vec3 colFixed = mix(mix(wall, mix((1.0 - inPane) * reveal, shade, shaded), inBezel), vec3(0.0), seat.cov);" },
    { file: SCENE, find: "  vec3 col = colFixed + kView * view;", replace: "  vec3 col = colFixed + kView * view;\n  if (seat.cov > 0.0) col += seat.cov * shadeSeat(ro, rd, seat, pixAng, cl, uShadeBottom);" },
  ]],
];
