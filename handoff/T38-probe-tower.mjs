// T38（T44 遗留）定位：云步进在视线透射率首次降到 0.6 的那个样本上记下
//   (直射项亮度, 环境光亮度, 受光光学厚度, 高度 km)，写进云缓冲（读 --read '{"target":"cloud",...}'，坐标是 GL 左下原点）
const lum = (v) => `dot(${v}, vec3(0.2126, 0.7152, 0.0722))`;
export const PATCHES = [
  {
    mat: "clouds.marchMat",
    target: "clouds.raw",
    replace: [
      ["  float T = 1.0;\n  float depthSum = 0.0;", "  float T = 1.0;\n  vec4 dbg = vec4(0.0);\n  float dbgSet = 0.0;\n  float depthSum = 0.0;"],
      ["      vec3 S = sunLight + ambient;", `      vec3 S = sunLight + ambient;\n      if (dbgSet < 0.5 && T * exp(-sigma * stepLen) < 0.6) { dbg = vec4(${lum("sunLight")}, ${lum("ambient")}, od, r - BOTTOM); dbgSet = 1.0; }`],
      ["  gl_FragColor = vec4(min(L, vec3(60000.0)), T);", "  gl_FragColor = dbg;"],
    ],
  },
];
