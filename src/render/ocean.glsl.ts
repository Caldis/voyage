/**
 * 海面（GLSL）：波面斜率场、耀斑、离水辐亮度。依赖 ATMOSPHERE_COMMON / CLOUD_COMMON（uCloudOffset）/
 * LIGHTS_COMMON（keyLight / skyIrradiance）/ ISLANDS_COMMON（程序生成岛屿）/ PANE_COMMON（fbm2 / hash12）。
 *
 * 斜率来源（T14）：FFT 海浪（src/ocean/waves.ts）三个级联的纹理数组。
 * 每级存 (∂h/∂x, ∂h/∂z, 斜率二阶矩, Σ|k|h)，用解析的像素足迹做 textureGrad（各向异性过滤 + mip），
 * 过滤掉的斜率方差按 LEAN mapping 并入 Cox–Munk 粗糙度，比 FFT 更短的波（厘米级毛细波）由 Cox–Munk 总方差补齐：总方差守恒。
 */
export const OCEAN_COMMON = /* glsl */ `
uniform sampler2DArray uOceanWaves; // 三个级联：R = ∂h/∂x，G = ∂h/∂z，B = R² + G²，A = Σ|k|·h
uniform vec3 uOceanTile;            // 各级平铺尺寸（m）
uniform vec2 uOceanOrigin[3];       // 飞机累计位移对各级平铺尺寸取余后的小数（CPU 双精度算好）
uniform vec3 uOceanVar;             // 各级整张平铺的总斜率方差 ⟨sx² + sz²⟩
uniform vec4 uOceanFoam;            // x：白浪阈值 τ（对前两级的 Σ|k|h），y：1 = FFT 海浪已接入

float fresnelWater(float c) {
  return 0.02 + 0.98 * pow(1.0 - clamp(c, 0.0, 1.0), 5.0);
}

// 标准正态上尾 Q(x) = P(X > x)（Börjesson–Sundberg 近似，与 src/ocean/spectrum.ts 相同）
float normalTail(float x) {
  float a = abs(x);
  float q = exp(-0.5 * a * a) / ((0.661 * a + 0.339 * sqrt(a * a + 5.51)) * 2.5066283);
  return x >= 0.0 ? q : 1.0 - q;
}

// ---- 海面的波面斜率 ----
struct SeaSlope { vec2 mean; float var; float foam; };

const float WIND_DIR = 0.6;   // 风浪的传播方向（弧度，相对正东；与 src/ocean/spectrum.ts 一致）

// xzM：相对相机的海面坐标（m）；dir2 / footAlong / footAcross：像素足迹（沿视线、垂直视线，m）；
// cmLocal：本地的 Cox–Munk 总方差；rel：本地相对全局风况的粗糙度倍数（阵风斑、风痕、浅水）；calm：湖泊河流 < 1
SeaSlope seaSlope(vec2 xzM, vec2 dir2, float footAlong, float footAcross, float cmLocal, float rel, float calm) {
  SeaSlope s;
  s.mean = vec2(0.0);
  s.foam = 0.0;
  if (uOceanFoam.y < 0.5) { s.var = cmLocal; return s; }
  // 各级的振幅平方倍数：短波对阵风、油膜的响应快而强，长浪几乎不受影响；湖泊没有长浪
  vec3 amp2 = pow(vec3(max(rel, 1e-3)), vec3(0.25, 0.6, 1.0)) * vec3(calm * calm, calm, 1.0);
  vec2 perp = vec2(-dir2.y, dir2.x);
  float lean = 0.0;     // 像素内看不清的斜率方差
  float leanFoam = 0.0; // 前两级的（给白浪用）
  float tr = 0.0;       // 前两级的 Σ|k|h
  float fftLocal = 0.0; // FFT 部分在本地的总方差
  for (int c = 0; c < 3; c++) {
    float L = max(uOceanTile[c], 1.0);
    vec2 uv = xzM / L + uOceanOrigin[c];
    // 像素足迹（各向异性过滤按最多 16:1 算）比两个平铺还大时，这一级只剩整体方差，省掉一次取样
    vec4 t = vec4(0.0, 0.0, uOceanVar[c], 0.0);
    if (max(footAcross, footAlong / 16.0) < 2.0 * L) {
      // 显式梯度：可以在分支里用（没有隐式导数），各向异性过滤按真实的椭圆足迹取样
      t = textureGrad(uOceanWaves, vec3(uv, float(c)), dir2 * (footAlong / L), perp * (footAcross / L));
    }
    float a2 = amp2[c];
    float a = sqrt(a2);
    s.mean += a * t.xy;
    float v = a2 * max(t.z - dot(t.xy, t.xy), 0.0);
    lean += v;
    fftLocal += a2 * uOceanVar[c];
    if (c < 2) { tr += a * t.w; leanFoam += v; }
  }
  // 比 FFT 最短波（约 0.23 m）还短的毛细波：Cox–Munk 总方差减去 FFT 已有的部分
  s.var = lean + max(cmLocal - fftLocal, 0.15 * cmLocal);
  // 白浪：像素内 Σ|k|h 近似服从 N(tr, leanFoam)，超过阈值的面积比例就是白浪覆盖率。
  // 远处 tr → 0、leanFoam → 整体方差，自动回到 Monahan 覆盖率；近处落在陡峭的波峰上
  float sd = sqrt(leanFoam + 1e-4 * uOceanFoam.x * uOceanFoam.x);
  s.foam = normalTail((uOceanFoam.x - tr) / sd);
  return s;
}

// 阵风斑（「猫爪」）：几百米到公里级、顺风拉长的阵风区，毛细波和短波更密，粗糙度更高；随风漂移
float gustFactor(vec2 xzKm) {
  vec2 w = vec2(cos(WIND_DIR), sin(WIND_DIR));
  vec2 q = xzKm - w * (uWind * uTime * 1e-3);
  vec2 p = vec2(dot(q, w) * 0.9, dot(q, vec2(-w.y, w.x)) * 1.7);
  p += (vec2(vnoise(p * 0.5 + 5.3), vnoise(p * 0.5 + 9.1)) - 0.5) * 1.5;
  float g = fbm2(p + 11.3);
  return exp(2.4 * (g - 0.47));
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
  // 像素在海面上的足迹（m）：垂直视线方向 = 距离 × 像素张角，沿视线方向再除以 cos(视线天顶角)
  float footAcross = tGround * 1000.0 * pixelAngle;
  float footAlong = footAcross / max(cosV, 0.02);
  float footprint = max(footAlong, 0.5);
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

  // 波浪纹理坐标要精确到厘米：ro 在 6360 km 处，通用的 raySphere 有抵消误差（近处可达半米，会变成噪点）。
  // 海平面上的点改用稳定的二次方程解 t = c / (−b + √(b² − c))；地形上的水面（有海拔）仍用传进来的 P
  float hCam = uCamR - BOTTOM;
  float bq = uCamR * rd.y;
  float cq = hCam * (2.0 * BOTTOM + hCam);
  float dq = bq * bq - cq;
  float tS = (bq < 0.0 && dq > 0.0) ? cq / (-bq + sqrt(dq)) : tGround;
  vec2 xzM = (abs(tS - tGround) < 0.002 * tGround + 0.005 ? rd.xz * tS : P.xz) * 1000.0;
  vec2 dir2 = length(rd.xz) > 1e-4 ? normalize(rd.xz) : vec2(1.0, 0.0);

  // 本地粗糙度：Cox–Munk 1954 × 阵风斑 × 风痕；潟湖和浅水更平静
  float rel = gustFactor(xzKm) * slickFactor(xzKm) * mix(1.0, 0.45, shallow);
  float cmLocal = (0.003 + 0.00512 * uWind * calm) * rel;
  SeaSlope sl = seaSlope(xzM, dir2, footAlong, footAcross, cmLocal, rel, calm);
  // 近似地把东、南方向当作海面切向（离相机几百 km 内误差很小）
  nView = normalize(n - vec3(sl.mean.x, 0.0, sl.mean.y));
  float sigma2 = sl.var;

  // 天空反射率。波面粗糙，掠射时达不到 1（Schlick 粗糙度近似）
  float cosVn = max(dot(nView, v), 1e-3);
  float rough = sqrt(sigma2);
  fView = 0.02 + (max(1.0 - rough, 0.02) - 0.02) * pow(1.0 - cosVn, 5.0);

  // 离水辐亮度：开阔大洋的反射率，蓝光最高
  // 浅水：海底的白沙透上来，水色变成碧绿
  vec3 waterRefl = mix(vec3(0.002, 0.008, 0.025), vec3(0.03, 0.13, 0.13), shallow * shallow);
  if (body.r >= 0.0) waterRefl = body;
  // 白浪：FFT 接入时落在陡峭波峰上（期望覆盖率仍是 Monahan 1980：≈ 3.84e-6·U^3.41）；没接入时退回均匀覆盖
  float foam = uOceanFoam.y > 0.5 ? min(sl.foam, 1.0) : clamp(3.84e-6 * pow(uWind, 3.41), 0.0, 0.1);
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
    // 结果保持期望值不变（除以 λ），只改变分布。格子按像素足迹的椭圆取（沿视线长、垂直视线短），近处不再是方块
    vec2 fp = vec2(footprint, max(footAcross, 0.5));
    cell = floor(vec2(dot(xzM, dir2), dot(xzM, vec2(-dir2.y, dir2.x))) / fp);
    float u = hash12(cell + floor(uTime * 8.0) * 0.1371);
    float lambda = 5.0 * fp.x * fp.y * exp(-tan2 / sigma2);
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
  if (uDebug == 11) L = vec3(sl.foam, rel * 0.5, 0.0);                     // 白浪覆盖率、本地粗糙度倍数
  if (uDebug == 12) L = vec3(sl.mean * 5.0 + 0.5, 0.0);                   // 可分辨的平均斜率
  return L;
}
`;
