/**
 * 云地闪（GLSL）：闪光对地 / 海面的照度，以及闪电通道本身在视线里的辉光。依赖 ATMOSPHERE_COMMON（M_PI）/
 * CLOUD_COMMON（uCloudOffset、uFlash）。从 scene.ts 拆出（T01 纯重构，未改动任何算法或参数）。
 */
export const LIGHTNING_COMMON = /* glsl */ `
// 闪电从云底向下照亮地面 / 海面的照度（klux）：按平方反比衰减，经验标定到「夜里 5 km 外约 10 lux」
vec3 flashIlluminance(vec3 P) {
  if (uFlash.w <= 0.0) return vec3(0.0);
  vec3 fp = vec3(uFlash.x - uCloudOffset.x, BOTTOM + min(uFlash.y, 1.3), uFlash.z - uCloudOffset.y);
  vec3 pw = vec3(P.x, length(P), P.z);
  float d2 = dot(pw - fp, pw - fp);
  return vec3(0.8, 0.85, 1.0) * uFlash.w * 4e-5 / (0.04 + d2 / 25.0);
}

// 云地闪主通道：视线到每段折线的最近距离算辉光（比像素还细时按覆盖比例摊薄能量），外加被雨滴散射的淡光晕
uniform vec3 uBolt[16];      // 相机相对坐标（km，地心坐标系）
uniform float uBoltIntensity;
float segDist3(vec3 rd, vec3 a, vec3 b, out float tRay) {
  vec3 ab = b - a;
  // 视线（从原点出发）与线段的最近点：在线段上取几个点里最近的，够用且稳定
  float best = 1e9;
  tRay = 0.0;
  for (int k = 0; k <= 8; k++) {
    vec3 q = a + ab * (float(k) / 8.0);
    float t = max(dot(q, rd), 0.0);
    float d = length(q - rd * t);
    if (d < best) { best = d; tRay = t; }
  }
  return best;
}
vec3 boltRadiance(vec3 rd) {
  if (uBoltIntensity <= 0.0) return vec3(0.0);
  vec3 ro = vec3(0.0, uCamR, 0.0);
  float pixelAngle = 2.0 * uTanHalfFov / uResolution.y;
  vec3 L = vec3(0.0);
  for (int i = 0; i < 15; i++) {
    int ia = i < 10 ? i : (i == 10 ? 3 : i);
    int ib = i < 10 ? i + 1 : i + 1;
    if (i == 10) ib = 11;
    float t;
    float d = segDist3(rd, uBolt[ia] - ro, uBolt[ib] - ro, t);
    if (t <= 0.0) continue;
    float w = max(0.004, t * pixelAngle);            // 通道本身只有几厘米粗，按像素宽度显示
    float core = exp(-d * d / (w * w)) * (0.004 / w);
    // 通道本身极亮（远处也是一条清晰的细亮线）；雨滴散射出的光晕很淡，否则会糊成一团
    float halo = exp(-d / 0.3) * 0.0003;
    float branch = i >= 10 ? 0.4 : 1.0;
    L += vec3(0.85, 0.9, 1.0) * uBoltIntensity * 30.0 * (core + halo) * branch;
  }
  return L;
}
`;
