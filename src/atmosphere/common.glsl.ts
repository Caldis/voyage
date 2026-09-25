/**
 * 物理大气的公共 GLSL：介质参数、相函数、LUT 参数化。
 * 方案来自 Hillaire 2020《A Scalable and Production Ready Sky and Atmosphere Rendering Technique》，
 * 透射率 LUT 的参数化沿用 Bruneton 2017。长度单位一律为 km，坐标原点在地心，y 轴向上。
 */

export const LUT_SIZE = {
  transmittance: [256, 64],
  multiScattering: [32, 32],
  skyView: [192, 108],
  irradiance: [64, 16],
  aerial: [32, 64, 32],
} as const;

/** 空气透视 LUT 覆盖的最远距离（km）：巡航高度看到的地平线约 370 km */
export const AERIAL_MAX_DISTANCE_KM = 400;

const f = (n: number) => n.toFixed(1);

export const ATMOSPHERE_COMMON = /* glsl */ `
#define M_PI 3.14159265358979

const float BOTTOM = 6360.0;   // 地球半径
const float TOP = 6460.0;      // 大气层顶
// 地表处的系数，单位 1/km（Hillaire 2020 表 1，地球参数）
const vec3 RAYLEIGH_SCATTERING = vec3(5.802, 13.558, 33.1) * 1e-3;
const float RAYLEIGH_SCALE_HEIGHT = 8.0;
const float MIE_SCATTERING = 3.996e-3;
const float MIE_ABSORPTION = 4.40e-3;
const float MIE_SCALE_HEIGHT = 1.2;
const float MIE_G = 0.8;
const vec3 OZONE_ABSORPTION = vec3(0.650, 1.881, 0.085) * 1e-3;
// 多次散射与天空辐照度里用到的地面反照率：当前场景下方是海面
const vec3 GROUND_ALBEDO = vec3(0.06);
// 太阳角半径（弧度）
const float SUN_ANGULAR_RADIUS = 0.004654;

const vec2 TRANSMITTANCE_SIZE = vec2(${f(LUT_SIZE.transmittance[0])}, ${f(LUT_SIZE.transmittance[1])});
const vec2 MULTI_SCATTERING_SIZE = vec2(${f(LUT_SIZE.multiScattering[0])}, ${f(LUT_SIZE.multiScattering[1])});
const vec2 SKY_VIEW_SIZE = vec2(${f(LUT_SIZE.skyView[0])}, ${f(LUT_SIZE.skyView[1])});
const vec3 AERIAL_SIZE = vec3(${f(LUT_SIZE.aerial[0])}, ${f(LUT_SIZE.aerial[1])}, ${f(LUT_SIZE.aerial[2])});
const float AERIAL_MAX_DISTANCE = ${f(AERIAL_MAX_DISTANCE_KM)};
const vec2 IRRADIANCE_SIZE = vec2(${f(LUT_SIZE.irradiance[0])}, ${f(LUT_SIZE.irradiance[1])});

uniform sampler2D uTransmittanceLut;
uniform sampler2D uMultiScatteringLut;

struct Medium {
  vec3 rayleigh;   // 瑞利散射系数
  float mie;       // 米氏散射系数
  vec3 extinction; // 总消光系数
};

Medium sampleMedium(float h) {
  float dR = exp(-h / RAYLEIGH_SCALE_HEIGHT);
  float dM = exp(-h / MIE_SCALE_HEIGHT);
  float dO = max(0.0, 1.0 - abs(h - 25.0) / 15.0); // 臭氧层：25 km 处最浓的帐篷形分布
  Medium m;
  m.rayleigh = RAYLEIGH_SCATTERING * dR;
  m.mie = MIE_SCATTERING * dM;
  m.extinction = m.rayleigh + vec3((MIE_SCATTERING + MIE_ABSORPTION) * dM) + OZONE_ABSORPTION * dO;
  return m;
}

float rayleighPhase(float c) { return 3.0 / (16.0 * M_PI) * (1.0 + c * c); }

// Cornette-Shanks 相函数
float miePhase(float c) {
  float g2 = MIE_G * MIE_G;
  float k = 3.0 / (8.0 * M_PI) * (1.0 - g2) / (2.0 + g2);
  return k * (1.0 + c * c) / pow(max(1.0 + g2 - 2.0 * MIE_G * c, 1e-4), 1.5);
}

// 射线与以地心为球心的球求交，返回最近的正距离，没有交点返回 -1。
// 判别式写成 (R - r·sinθ)(R + r·sinθ)，避免 km 级大数相减在地平线附近丢精度。
float raySphere(vec3 ro, vec3 rd, float R) {
  float r = length(ro);
  float mu = dot(ro, rd) / r;
  float rs = r * sqrt(max(0.0, 1.0 - mu * mu));
  float disc = (R - rs) * (R + rs);
  if (disc < 0.0) return -1.0;
  float s = sqrt(disc);
  float t0 = -r * mu - s;
  float t1 = -r * mu + s;
  if (t0 > 0.0) return t0;
  if (t1 > 0.0) return t1;
  return -1.0;
}

float unitToUv(float x, float n) { return 0.5 / n + x * (1.0 - 1.0 / n); }
float uvToUnit(float u, float n) { return (u - 0.5 / n) / (1.0 - 1.0 / n); }

// ---- 透射率 LUT（Bruneton 参数化：高度 r、天顶角余弦 mu → uv） ----
vec2 transmittanceUv(float r, float mu) {
  float H = sqrt(TOP * TOP - BOTTOM * BOTTOM);
  float rho = sqrt(max(0.0, r * r - BOTTOM * BOTTOM));
  float disc = r * r * (mu * mu - 1.0) + TOP * TOP;
  float d = max(0.0, -r * mu + sqrt(max(0.0, disc)));
  float dMin = TOP - r;
  float dMax = rho + H;
  float xMu = (d - dMin) / (dMax - dMin);
  float xR = rho / H;
  return vec2(unitToUv(xMu, TRANSMITTANCE_SIZE.x), unitToUv(xR, TRANSMITTANCE_SIZE.y));
}

// 从 (r, mu) 出发直到大气层顶的透射率；只对不穿过地面的射线有意义
vec3 transmittanceToTop(float r, float mu) {
  return texture(uTransmittanceLut, transmittanceUv(r, mu)).rgb;
}

// 到太阳的透射率：太阳被地球挡住时为 0，按太阳圆盘大小做软过渡
vec3 sunTransmittance(float r, float mu) {
  float sinH = BOTTOM / r;
  float cosH = -sqrt(max(0.0, 1.0 - sinH * sinH));
  float visible = smoothstep(-SUN_ANGULAR_RADIUS, SUN_ANGULAR_RADIUS, mu - cosH);
  return transmittanceToTop(r, mu) * visible;
}

// ---- 多次散射 LUT（太阳天顶角余弦、高度） ----
vec3 multiScattering(float r, float sunCosZenith) {
  vec2 uv = vec2(
    unitToUv(clamp(0.5 + 0.5 * sunCosZenith, 0.0, 1.0), MULTI_SCATTERING_SIZE.x),
    unitToUv(clamp((r - BOTTOM) / (TOP - BOTTOM), 0.0, 1.0), MULTI_SCATTERING_SIZE.y)
  );
  return texture(uMultiScatteringLut, uv).rgb;
}

// 沿视线积分单次散射 + 多次散射（结果以「太阳照度 = 1」为单位），最多积分到 tLimit，同时输出这段路径的透射率。
// 采样点按距离平方分布：近处密、远处疏。
vec3 integrateSegment(vec3 ro, vec3 rd, vec3 sunDir, float tLimit, float sampleCount, out vec3 transmittance) {
  float tBottom = raySphere(ro, rd, BOTTOM);
  float tTop = raySphere(ro, rd, TOP);
  float tMax = min(tBottom > 0.0 ? tBottom : tTop, tLimit);
  transmittance = vec3(1.0);
  if (tMax <= 0.0) return vec3(0.0);
  float cosTheta = dot(rd, sunDir);
  float pR = rayleighPhase(cosTheta);
  float pM = miePhase(cosTheta);
  vec3 L = vec3(0.0);
  vec3 T = vec3(1.0);
  float tPrev = 0.0;
  for (int i = 0; i < 64; i++) {
    if (float(i) >= sampleCount) break;
    float s = (float(i) + 1.0) / sampleCount;
    float tNext = tMax * s * s;
    float dt = tNext - tPrev;
    vec3 p = ro + rd * (tPrev + 0.3 * dt);
    float r = length(p);
    Medium m = sampleMedium(r - BOTTOM);
    float sunCos = dot(p / r, sunDir);
    vec3 stepT = exp(-m.extinction * dt);
    vec3 S = (m.rayleigh * pR + m.mie * pM) * sunTransmittance(r, sunCos)
           + (m.rayleigh + m.mie) * multiScattering(r, sunCos);
    L += T * (S - S * stepT) / max(m.extinction, vec3(1e-7));
    T *= stepT;
    tPrev = tNext;
  }
  transmittance = T;
  return L;
}

vec3 integrateScattering(vec3 ro, vec3 rd, vec3 sunDir, float sampleCount) {
  vec3 T;
  return integrateSegment(ro, rd, sunDir, 1e9, sampleCount, T);
}

// ---- 天空视图 LUT（Hillaire 2020 的非线性参数化，地平线附近分辨率最高） ----
vec2 skyViewUv(bool hitGround, float viewZenithCos, float lightViewCos, float r) {
  float vHorizon = sqrt(max(0.0, r * r - BOTTOM * BOTTOM));
  float beta = acos(clamp(vHorizon / r, -1.0, 1.0));
  float zenithHorizonAngle = M_PI - beta;
  float viewZenith = acos(clamp(viewZenithCos, -1.0, 1.0));
  float y;
  if (!hitGround) {
    float c = 1.0 - sqrt(max(0.0, 1.0 - viewZenith / zenithHorizonAngle));
    y = c * 0.5;
  } else {
    float c = sqrt(max(0.0, (viewZenith - zenithHorizonAngle) / beta));
    y = c * 0.5 + 0.5;
  }
  // 地平线正好落在两行 texel 之间：天空一侧和地面一侧各自夹在自己那行里，
  // 否则双线性插值会把地面的暗色混进地平线，出现一条细暗线
  float lastSkyRow = floor(0.5 * (SKY_VIEW_SIZE.y - 1.0)) / (SKY_VIEW_SIZE.y - 1.0);
  float firstGroundRow = ceil(0.5 * (SKY_VIEW_SIZE.y - 1.0)) / (SKY_VIEW_SIZE.y - 1.0);
  y = hitGround ? clamp(y, firstGroundRow, 1.0) : clamp(y, 0.0, lastSkyRow);
  float x = sqrt(clamp(0.5 - 0.5 * lightViewCos, 0.0, 1.0));
  return vec2(unitToUv(x, SKY_VIEW_SIZE.x), unitToUv(y, SKY_VIEW_SIZE.y));
}

// ---- 空气透视 LUT（相对太阳的方位角 × 天顶角 × 距离），以相机为中心，不随视线朝向变化 ----
vec3 aerialPerspectiveUvw(vec3 rd, vec3 sunDir, float dist) {
  vec2 h = rd.xz;
  vec2 s = sunDir.xz;
  float lh = length(h);
  float ls = length(s);
  float lightViewCos = (lh > 1e-5 && ls > 1e-5) ? dot(h, s) / (lh * ls) : 1.0;
  float x = sqrt(clamp(0.5 - 0.5 * lightViewCos, 0.0, 1.0));
  // 天顶角用 sqrt(|cos|) 映射：地平线附近分辨率最高，远处的云都在这一带
  float y = 0.5 - 0.5 * sign(rd.y) * sqrt(abs(rd.y));
  float z = sqrt(clamp(dist / AERIAL_MAX_DISTANCE, 0.0, 1.0));
  return vec3(unitToUv(x, AERIAL_SIZE.x), unitToUv(y, AERIAL_SIZE.y), unitToUv(z, AERIAL_SIZE.z));
}

// ---- 天空辐照度 LUT（水平面受到的天空漫射光，太阳天顶角余弦、高度） ----
vec2 irradianceUv(float r, float sunCosZenith) {
  return vec2(
    unitToUv(clamp(0.5 + 0.5 * sunCosZenith, 0.0, 1.0), IRRADIANCE_SIZE.x),
    unitToUv(clamp((r - BOTTOM) / (TOP - BOTTOM), 0.0, 1.0), IRRADIANCE_SIZE.y)
  );
}
`;

export const FULLSCREEN_VERT = /* glsl */ `
varying vec2 vUv;
void main() {
  vUv = uv;
  gl_Position = vec4(position.xy, 0.0, 1.0);
}
`;
