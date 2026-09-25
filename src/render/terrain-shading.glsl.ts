/**
 * 真实地面的着色（GLSL）：陆地按影像反照率 + 地形法线，水面复用海面反射模型，加城市夜光。
 * 依赖 GROUND_COMMON（terrainHit / sampleGround / terrainNormal / terrainShadow）/ LIGHTS_COMMON /
 * OCEAN_COMMON（oceanRadiance）/ LIGHTNING_COMMON（flashIlluminance）。从 scene.ts 拆出（T01 纯重构，未改动任何算法或参数）。
 */
export const TERRAIN_SHADING_COMMON = /* glsl */ `
// 真实地面：地形求交，陆地按影像反照率 + 地形法线着色，水面复用海面的反射模型（水色取影像）。
// 返回 w < 0 表示这条视线没打到地面（或还没有地面数据），交给原来的海面 / 天空处理
vec4 groundRadiance(vec3 ro, vec3 rd) {
  float tT = terrainHit(ro, rd);
  if (tT <= 0.0) return vec4(0.0, 0.0, 0.0, -1.0);
  vec3 P = ro + rd * tT;
  vec3 up = normalize(P);
  vec2 g = P.xz + uCloudOffset;
  float pixelAngle = 2.0 * uTanHalfFov / uResolution.y;
  float lod = groundLod(length(P.xz), tT * pixelAngle);
  vec4 alb = sampleGround(uGroundAlbedo, g, lod);
  if (alb.w <= 0.0) return vec4(0.0, 0.0, 0.0, -1.0);
  vec3 wat = sampleGround(uGroundWater, g, lod).rgb;
  // 相机到地面的空气透视：用空气透视 LUT（地形不在海平面，天空视图 LUT 的地面部分不适用）
  vec3 uvw = aerialPerspectiveUvw(rd, uSunDir, tT);
  vec3 apL = texture(uAerialInscatterS, uvw).rgb * uSunIlluminance;
  vec3 apT = texture(uAerialTransmittanceS, uvw).rgb;
  float h = length(P) - BOTTOM;
  vec3 L = vec3(0.0);
  // 陆地
  vec3 eFlash = flashIlluminance(P);
  if (wat.r < 0.999) {
    vec3 n = terrainNormal(g, up, lod);
    float ndl = dot(n, uKeyDir);
    vec3 eKey = keyLight(BOTTOM + h, up) * cloudShadow(P, uKeyDir);
    if (ndl > 0.0) eKey *= terrainShadow(P, uKeyDir, lod);
    vec3 eSky = skyIrradiance(BOTTOM + h, up);
    vec3 land = alb.rgb / M_PI * (eKey * max(ndl, 0.0) + eSky * (0.5 + 0.5 * dot(n, up)) + eFlash);
    // 城市灯光：亮度来自 NASA Black Marble（~500 m 分辨率），位置用影像里的城市区域（灰白、低饱和）落到街区上，
    // 再加一点街区尺度的明暗。色温取钠灯和 LED 混合的暖白。约 3 cd/m²（市中心从上往下看的量级）
    float night = wat.b;
    if (night > 0.004) {
      float lumA = dot(alb.rgb, vec3(0.2126, 0.7152, 0.0722));
      float sat = (max(max(alb.r, alb.g), alb.b) - min(min(alb.r, alb.g), alb.b)) / max(lumA, 1e-3);
      float urban = smoothstep(0.04, 0.14, lumA) * (1.0 - smoothstep(0.25, 0.7, sat));
      urban *= urban;
      // 一盏盏灯：每个 30 m 格子里在随机位置放一个圆点（半径约 3 m），亮度随机；
      // 点比像素小时按覆盖比例保持能量——近处是清晰的小圆点，远处自然平均成均匀亮度，不会显出方块
      float fpM = max(tT * pixelAngle * 1000.0, 0.5);
      vec2 gm = g * 1000.0 / 30.0;
      vec2 cell = floor(gm);
      vec2 jit = hash22(cell * 1.7 + 3.1);
      float dM = length(gm - cell - (0.15 + 0.7 * jit)) * 30.0;           // 到这盏灯的距离（米）
      float rEff = max(3.0, fpM * 0.7);
      float dot1 = exp(-dM * dM / (rEff * rEff)) * (3.0 / rEff) * (3.0 / rEff) * 100.0; // 期望值约 1（30² / (π·3²) ≈ 32，再乘分布的平均）
      float bright = pow(jit.y, 3.0) * 4.0;
      float blocks = dot1 * bright * (0.6 + 0.8 * hash12(floor(g * 1000.0 / 180.0)));
      float emit = pow(night, 2.0) * smoothstep(0.15, 0.5, urban) * 2.5 * blocks;
      land += vec3(1.0, 0.72, 0.42) * 3e-3 * emit;
    }
    L += (1.0 - wat.r) * land;
  }
  // 水面：海洋按设定风速，湖泊河流平静得多；水色取卫星影像（它本身就是从上往下看到的水色）
  float fView = 0.0;
  if (wat.r > 0.001) {
    vec3 nView;
    float calm = mix(0.25, 1.0, wat.g);
    vec3 water = oceanRadiance(P, rd, tT, alb.rgb * 0.7, calm, fView, nView) + alb.rgb * 0.7 / M_PI * eFlash;
    vec3 skyCam = skyRadiance(reflect(rd, nView), false);
    L = L * apT + wat.r * (water * apT + fView * max(skyCam - apL, vec3(0.0)));
    return vec4(L + apL, 1.0);
  }
  return vec4(L * apT + apL, 1.0);
}
`;
