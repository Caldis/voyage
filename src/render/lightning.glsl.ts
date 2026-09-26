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

// 云地闪主通道：视线到每段折线的最近距离算辉光（比像素还细时按覆盖比例摊薄能量），外加被雨滴散射的淡光晕。
// CPU 只给 16 个点（每段约 110 m），近看是一截截直线；着色器里把每段再按中点位移细分成 8 小段，
// 位移约为段长的 12%（真实通道在几米到几十米的尺度上不停转折），各段的扭折由端点坐标哈希决定，逐帧不变。
uniform vec3 uBolt[16];      // 相机相对坐标（km，地心坐标系）
uniform float uBoltIntensity;
// 线段 a→b 到视线（从原点出发，方向 rd 为单位向量）的最近距离；tRay 是最近点沿视线的距离
float raySegDist(vec3 rd, vec3 a, vec3 b, out float tRay) {
  vec3 ab = b - a;
  float abab = dot(ab, ab);
  float abrd = dot(ab, rd);
  float den = abab - abrd * abrd;
  float s = den > 1e-12 ? clamp((abrd * dot(a, rd) - dot(a, ab)) / den, 0.0, 1.0) : 0.0;
  vec3 q = a + ab * s;
  tRay = max(dot(q, rd), 0.0);
  return length(q - rd * tRay);
}
float boltHash(vec3 p) { return fract(sin(dot(p, vec3(127.1, 311.7, 74.7))) * 43758.5453); }
vec3 boltRadiance(vec3 rd) {
  if (uBoltIntensity <= 0.0) return vec3(0.0);
  vec3 ro = vec3(0.0, uCamR, 0.0);
  float pixelAngle = 2.0 * uTanHalfFov / uResolution.y;
  float coreMax = 0.0;
  float haloSum = 0.0;
  // 上界写成依赖 uniform 的表达式（值不变），防止 FXC 把 15 × 8 次线段距离全部展开（冷编译很慢）
  int nSeg = 15 + min(int(uBoltIntensity), 0);
  int nSub = 8 + min(int(uBoltIntensity), 0);
  for (int i = 0; i < nSeg; i++) {
    int ia = i < 10 ? i : (i == 10 ? 3 : i);
    int ib = i == 10 ? 11 : i + 1;
    vec3 a = uBolt[ia] - ro;
    vec3 b = uBolt[ib] - ro;
    vec3 ab = b - a;
    float segLen = length(ab);
    // 粗略剔除：视线离这一段超过 1 km 就不算细分（光晕 exp(-d/0.1) 在 1 km 外已经可以忽略）
    float tc;
    if (raySegDist(rd, a, b, tc) > 1.0 + segLen * 0.2 || tc <= 0.0) continue;
    // 垂直于这一段的两个方向，用来做扭折
    vec3 e1 = normalize(cross(ab, abs(ab.y) < 0.9 * segLen ? vec3(0.0, 1.0, 0.0) : vec3(1.0, 0.0, 0.0)));
    vec3 e2 = normalize(cross(ab, e1));
    float h0 = boltHash(uBolt[ia]);
    float h1 = boltHash(uBolt[ia] + 1.7);
    // 分叉越往外越暗
    float branch = i >= 10 ? 0.45 * (1.0 - 0.12 * float(i - 10)) : 1.0;
    vec3 prev = a;
    for (int k = 1; k <= nSub; k++) {
      float u = float(k) / 8.0;
      // 两个频率的扭折，两端为 0（和相邻段连续）
      float env = sin(u * 3.14159);
      vec3 off = (e1 * sin(u * 9.4 + h0 * 6.28) + e2 * sin(u * 15.7 + h1 * 6.28) * 0.6
                + e1 * sin(u * 25.1 + h1 * 12.0) * 0.3) * env * segLen * 0.12;
      vec3 cur = k == 8 ? b : a + ab * u + off;
      float t;
      float d = raySegDist(rd, prev, cur, t);
      prev = cur;
      if (t <= 0.0) continue;
      float w = max(0.004, t * pixelAngle);            // 通道本身只有几厘米粗，按像素宽度显示
      float core = exp(-d * d / (w * w)) * (0.004 / w);
      // 通道本身极亮（远处也是一条清晰的细亮线）；雨滴散射出的光晕很淡，否则会糊成一团
      // 光晕只在通道附近（约 100 m），旧版 300 m、亮度高 10 倍，远看是一大团白光，通道本身反而看不清
      float halo = exp(-d / 0.1) * 0.00003 / 8.0;
      // 通道取最大值（相邻小段在接头处都算到同一个像素，相加会出现一串亮点）；光晕沿通道积分，相加
      coreMax = max(coreMax, core * branch);
      haloSum += halo * branch;
    }
  }
  return vec3(0.85, 0.9, 1.0) * uBoltIntensity * 30.0 * (coreMax + haloSum);
}
`;
