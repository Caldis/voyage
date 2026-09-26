// T26 诊断：下午逆光时背光眼壁为什么融进天空（逐项去掉：下方反射光 / 天空光 / 空气透视）
export const VARIANTS = [
  ["base", []],
  ["noBelow", [["float albedoBelow = uHurricane.w > 0.5 ? 0.35 : 0.06 + 0.5 * uCoverage;", "float albedoBelow = uHurricane.w > 0.5 ? 0.0 : 0.06 + 0.5 * uCoverage;"]]],
  ["noSky", [["vec3 eSky = skyIrradiance(r, up);", "vec3 eSky = vec3(0.0);"]]],
  ["noAP", [["L = L * apT + apL * (1.0 - T);", "L = L;"]]],
  ["noSun", [["vec3 S = sunLight + ambient;", "vec3 S = ambient;"]]],
];
