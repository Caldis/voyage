/**
 * 海面（GLSL）：波面斜率场、耀斑、离水辐亮度。依赖 ATMOSPHERE_COMMON / CLOUD_COMMON（uCloudOffset）/
 * LIGHTS_COMMON（keyLight / skyIrradiance）/ ISLANDS_COMMON（程序生成岛屿）/ PANE_COMMON（fbm2 / hash12）。
 * 从 scene.ts 拆出（T01 纯重构，未改动任何算法或参数）。
 */
export const OCEAN_COMMON = /* glsl */ `
float fresnelWater(float c) {
  return 0.02 + 0.98 * pow(1.0 - clamp(c, 0.0, 1.0), 5.0);
}

// ---- 海面的波面斜率 ----
// 12 个方向的波（两道涌浪 + 风浪，波长 250 m → 6 m 几何递减，方向围绕风向按黄金角散开，避免规则的干涉纹），
// 按深水色散关系 ω = √(gk) 传播。
// 波长大于像素覆盖范围的画成法线扰动；更短的把斜率方差并入 Cox–Munk 的「未分辨方差」（LEAN mapping 的思路），总方差守恒。
struct SeaSlope { vec2 mean; float var; };

const float WIND_DIR = 0.6;   // 风向（弧度，相对正东）

SeaSlope seaSlope(vec2 xzMeters, float footprint, float windVar) {
  const float G = 9.81;
  SeaSlope s;
  s.mean = vec2(0.0);
  float resolvedVar = 0.0;
  float windScale = clamp(uWind / 7.0, 0.0, 2.0);
  for (int i = 0; i < 12; i++) {
    float fi = float(i);
    float lambda = 250.0 * pow(0.72, fi);
    float ang;
    float ka;
    if (i < 2) {
      // 涌浪：远处风暴传来的长浪，方向和本地风无关，坡度小
      ang = WIND_DIR + 2.2 + fi * 0.4;
      ka = 0.025;
    } else {
      ang = WIND_DIR + (fract(fi * 0.618034) - 0.5) * 2.2;
      ka = mix(0.035, 0.07, fi / 11.0) * windScale;
    }
    float k = 2.0 * M_PI / lambda;
    vec2 dir = vec2(cos(ang), sin(ang));
    float phase = k * dot(dir, xzMeters) - sqrt(G * k) * uTime + fi * 2.39;
    // 波长比像素覆盖范围大 4 倍以上才算「看得清」，中间平滑过渡
    float resolved = smoothstep(2.0, 6.0, lambda / footprint);
    s.mean += resolved * ka * dir * cos(phase);
    resolvedVar += resolved * 0.5 * ka * ka;
  }
  s.var = max(windVar - resolvedVar, 0.002);
  return s;
}

// 风痕：顺风方向拉长的平静带，粗糙度低，在耀斑里显成一条条纹路。边缘放软、加扭曲，免得低空时出现笔直的「断层」
float slickFactor(vec2 xzKm) {
  vec2 w = vec2(cos(WIND_DIR), sin(WIND_DIR));
  vec2 p = vec2(dot(xzKm, w) * 0.35, dot(xzKm, vec2(-w.y, w.x)) * 2.2);
  p += (vec2(fbm2(p * 0.9 + 3.1), fbm2(p * 0.9 + 7.7)) - 0.5) * 1.2;
  float n = fbm2(p * 0.6);
  return mix(1.1, 0.55, smoothstep(0.45, 0.75, n));
}

// 海面在海面处的辐亮度，不含天空反射（天空反射在 outsideRadiance 里单独算）。
// nView 输出带波浪扰动的平均法线，给天空反射用
// body：水体本身的反射率（< 0 用开阔大洋的默认值；真实地面时取卫星影像的水色）；calm：风浪系数（湖泊河流 < 1）
vec3 oceanRadiance(vec3 P, vec3 rd, float tGround, vec3 body, float calm, out float fView, out vec3 nView) {
  vec3 n = normalize(P);
  vec3 v = -rd;
  float cosV = max(dot(n, v), 1e-3);
  float cosS = dot(n, uKeyDir);
  // 主光源（太阳或月亮）垂直于光线的直射照度，被云挡住的地方打折扣
  vec3 eSun = keyLight(BOTTOM, n) * cloudShadow(P, uKeyDir);
  vec3 eSky = skyIrradiance(BOTTOM, n);

  // 海面坐标随飞机前进平移（和云场用同一个位移），海面才会从窗外流过
  vec2 xzKm = P.xz + uCloudOffset;
  float pixelAngle = 2.0 * uTanHalfFov / uResolution.y;
  float footprint = max(tGround * 1000.0 * pixelAngle / max(cosV, 0.05), 0.5); // 像素在海面上覆盖的长度（m）
  // ---- 岛屿（程序生成的示例） ----
  vec4 isl = (uIslandDensity > 0.0 && uGroundOn < 0.5) ? islandField(xzKm) : vec4(10.0, 0.0, 1.0, 0.0);
  if (isl.x < 0.0) {
    // 陆地：地形高度求法线；按海拔和坡度分沙滩、植被、岩石
    const float E = 0.03; // km
    float h0 = islandHeight(xzKm, isl);
    float hx = islandHeight(xzKm + vec2(E, 0.0), islandField(xzKm + vec2(E, 0.0)));
    float hz = islandHeight(xzKm + vec2(0.0, E), islandField(xzKm + vec2(0.0, E)));
    vec3 nL = normalize(n - vec3((hx - h0) / E, 0.0, (hz - h0) / E));
    float slope = 1.0 - dot(nL, n);
    float tex = fbm2(xzKm * 40.0);
    vec3 forest = mix(vec3(0.03, 0.06, 0.025), vec3(0.06, 0.09, 0.035), tex);
    vec3 rock = vec3(0.11, 0.1, 0.085) * (0.8 + 0.4 * tex);
    vec3 sand = vec3(0.42, 0.38, 0.3);
    vec3 albedo = mix(forest, rock, smoothstep(0.15, 0.35, slope) + smoothstep(0.6, 0.9, h0 / max(isl.z * 0.25, 0.01)) * 0.5);
    // 沙滩：海岸线往内一小圈；环礁的礁岛本身大半是白沙
    float sandW = max(smoothstep(-0.05, -0.015, isl.x), 0.6 * step(0.5, isl.y));
    albedo = mix(albedo, sand, sandW);
    fView = 0.0;
    nView = nL;
    return albedo / M_PI * (eSun * max(dot(nL, uKeyDir), 0.0) + eSky * (0.5 + 0.5 * dot(nL, n)));
  }
  float shallow = isl.w;

  float windVar = (0.003 + 0.00512 * uWind * calm) * slickFactor(xzKm) * mix(1.0, 0.45, shallow); // Cox–Munk 1954；潟湖和浅水更平静
  SeaSlope sl = seaSlope(xzKm * 1000.0, footprint, windVar);
  // 近似地把东、南方向当作海面切向（离相机几百 km 内误差很小）
  nView = normalize(n - vec3(sl.mean.x, 0.0, sl.mean.y));
  float sigma2 = sl.var;

  // 天空反射率。波面粗糙，掠射时达不到 1（Schlick 粗糙度近似）
  float cosVn = max(dot(nView, v), 1e-3);
  float rough = sqrt(sigma2);
  fView = 0.02 + (max(1.0 - rough, 0.02) - 0.02) * pow(1.0 - cosVn, 5.0);

  // 离水辐亮度：开阔大洋的反射率，蓝光最高；风大时加一点白浪（Monahan 1980：覆盖率 ≈ 3.84e-6·U^3.41）
  // 浅水：海底的白沙透上来，水色变成碧绿
  vec3 waterRefl = mix(vec3(0.002, 0.008, 0.025), vec3(0.03, 0.13, 0.13), shallow * shallow);
  if (body.r >= 0.0) waterRefl = body;
  float foam = clamp(3.84e-6 * pow(uWind, 3.41), 0.0, 0.1);
  // 岸边和礁石外缘的碎浪
  foam += 0.5 * (1.0 - smoothstep(0.0, 0.025, isl.x)) * (0.6 + 0.4 * fbm2(xzKm * 60.0 + uTime * 0.2));
  vec3 L = ((1.0 - fView) * waterRefl + foam * 0.6) / M_PI * (eSun * max(cosS, 0.0) + eSky);

  // 太阳耀斑：L = E·F·p(斜率) / (4·cosθv·cos⁴β)，斜率分布以可分辨波浪的法线为中心
  vec3 hv = normalize(uKeyDir + v);
  float cb = dot(hv, nView);
  vec2 cell = vec2(0.0);
  if (cosS > 0.0 && cb > 0.0) {
    float cb2 = cb * cb;
    float tan2 = (1.0 - cb2) / cb2;
    float p = exp(-tan2 / sigma2) / (M_PI * sigma2);
    // 波光粼粼：像素里「恰好把阳光反射进眼睛」的小波面数服从泊松分布，λ ∝ 像素覆盖面积 × 斜率概率。
    // 耀斑中心 λ 大，画面平滑；尾部 λ < 1，只剩稀疏的亮点闪烁；高空时像素覆盖大，λ 大，自然变平滑。
    // 结果保持期望值不变（除以 λ），只改变分布
    cell = floor(xzKm * 1000.0 / max(footprint, 0.5));
    float u = hash12(cell + floor(uTime * 8.0) * 0.1371);
    float lambda = 5.0 * footprint * footprint * exp(-tan2 / sigma2);
    float sparkle;
    if (lambda < 4.0) {
      float pHit = 1.0 - exp(-lambda);
      sparkle = u < pHit ? 1.0 / max(pHit, 1e-4) : 0.0;
    } else {
      sparkle = 1.0 + (u * 2.0 - 1.0) * sqrt(3.0 / lambda);
    }
    L += eSun * fresnelWater(dot(v, hv)) * p / (4.0 * cosV * cb2 * cb2) * sparkle;
  }
  if (uDebug == 8) L = vec3(sigma2 * 20.0, footprint / 50.0, 0.0);
  if (uDebug == 9) L = eSun / max(uKeyIlluminance, vec3(1e-9));
  if (uDebug == 10) L = vec3(fract(cell.x * 0.1), fract(cell.y * 0.1), 0.0);
  return L;
}
`;
