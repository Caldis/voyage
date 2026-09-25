import { GROUND_BASE_KM, GROUND_LEVELS } from "../ground/clipmap";

/**
 * 真实地面（GLSL）：clipmap 采样 + 高度场求交。依赖 ATMOSPHERE_COMMON / CLOUD_COMMON（uCloudOffset = 飞机的本地坐标）。
 * 本地坐标 g（km，x 东、z 南）= 相机相对坐标的水平分量 + uCloudOffset。
 * 级别选择是连续的：取「点离飞机的距离」和「像素覆盖范围」两者要求的级别里较粗的那个，在相邻两级之间线性混合，免得出现接缝。
 */
export const GROUND_COMMON = /* glsl */ `
uniform sampler2DArray uGroundAlbedo;
uniform sampler2DArray uGroundWater;
uniform sampler2DArray uGroundHeight;
uniform vec4 uGroundLevel[${GROUND_LEVELS}];   // (中心 x, 中心 z, 边长 km, 是否可用)
uniform float uGroundOn;
uniform float uTerrainMax;                     // 附近地形最高点（km）

const float GROUND_BASE = ${GROUND_BASE_KM.toFixed(1)};
const float GROUND_RES = 1024.0;

// 连续的级别：distKm = 离飞机的水平距离，footprintKm = 像素覆盖范围
float groundLod(float distKm, float footprintKm) {
  float byDist = log2(max(distKm * 2.0 / (0.85 * GROUND_BASE), 1.0));
  float byPixel = log2(max(footprintKm * GROUND_RES / (1.5 * GROUND_BASE), 1.0));
  return clamp(max(byDist, byPixel), 0.0, ${(GROUND_LEVELS - 1).toFixed(1)});
}

// 某一级在 g 处可不可用（在范围内且已加载）
bool levelCovers(int L, vec2 g) {
  vec4 lv = uGroundLevel[L];
  if (lv.w < 0.5) return false;
  vec2 d = abs(g - lv.xy);
  return max(d.x, d.y) < lv.z * 0.49;
}

vec3 levelUv(int L, vec2 g) {
  vec4 lv = uGroundLevel[L];
  vec2 uv = (g - lv.xy) / lv.z + 0.5;
  return vec3(uv, float(L));
}

// 找从 lod 开始往粗走第一个可用的级别；都不可用返回 −1
int usableLevel(int L, vec2 g) {
  for (int i = 0; i < ${GROUND_LEVELS}; i++) {
    if (i < L) continue;
    if (levelCovers(i, g)) return i;
  }
  return -1;
}

// 在 lod 附近两级之间混合采样。返回 w = 0 表示这里没有数据
vec4 sampleGround(sampler2DArray tex, vec2 g, float lod) {
  int L0 = usableLevel(int(floor(lod)), g);
  if (L0 < 0) return vec4(0.0);
  int L1 = usableLevel(L0 + 1, g);
  float f = L0 == int(floor(lod)) ? fract(lod) : 0.0;
  vec4 a = textureLod(tex, levelUv(L0, g), 0.0);
  if (L1 < 0 || f <= 0.0) return vec4(a.rgb, 1.0);
  vec4 b = textureLod(tex, levelUv(L1, g), 0.0);
  return vec4(mix(a.rgb, b.rgb, f), 1.0);
}

float groundHeightAt(vec2 g, float lod) {
  vec4 h = sampleGround(uGroundHeight, g, lod);
  return h.w > 0.0 ? h.r : 0.0;
}

// 视线与地形求交：在「地形最高点所在的球壳」与海平面之间步进，再二分细化。
// ro 是相机（地心坐标，km），返回距离；没打到返回 −1
float terrainHit(vec3 ro, vec3 rd) {
  float rTop = BOTTOM + uTerrainMax + 0.05;
  float r0 = length(ro);
  float tStart = 0.0;
  if (r0 > rTop) {
    tStart = raySphere(ro, rd, rTop);
    if (tStart < 0.0) return -1.0;
  }
  float tSea = raySphere(ro, rd, BOTTOM);
  float tEnd = tSea > 0.0 ? tSea : tStart + 400.0;
  float pixelAngle = 2.0 * uTanHalfFov / uResolution.y;
  float tPrev = tStart;
  const float N = 56.0;
  for (float i = 1.0; i <= N; i += 1.0) {
    // 步长前密后疏：近处的山要准，远处的只要大致对
    float s = i / N;
    float t = mix(tStart, tEnd, s * s);
    vec3 p = ro + rd * t;
    float alt = length(p) - BOTTOM;
    vec2 g = p.xz + uCloudOffset;
    float lod = groundLod(length(p.xz), t * pixelAngle);
    if (alt < groundHeightAt(g, lod)) {
      float a = tPrev, b = t;
      for (int k = 0; k < 6; k++) {
        float m = 0.5 * (a + b);
        vec3 pm = ro + rd * m;
        float lm = groundLod(length(pm.xz), m * pixelAngle);
        if (length(pm) - BOTTOM < groundHeightAt(pm.xz + uCloudOffset, lm)) b = m; else a = m;
      }
      return b;
    }
    tPrev = t;
  }
  return tSea;
}

// 地形阴影：从 P 朝主光源方向在高度场上步进，被山挡住返回 0（带一点软边）
float terrainShadow(vec3 P, vec3 l, float lod) {
  if (uTerrainMax < 0.05) return 1.0;
  float h0 = length(P) - BOTTOM;
  float shadow = 1.0;
  float t = 0.05;
  for (int i = 0; i < 16; i++) {
    vec3 q = P + l * t;
    float alt = length(q) - BOTTOM;
    if (alt > uTerrainMax) break;
    float hq = groundHeightAt(q.xz + uCloudOffset, lod + 1.0);
    // 软阴影：离山脊越近越暗（Quilez 的半影近似）
    shadow = min(shadow, clamp((alt - hq) / (0.02 * t) + 0.5, 0.0, 1.0));
    if (shadow <= 0.0) break;
    t *= 1.45;
  }
  return shadow;
}

// 地形法线（地心坐标）：用这一级的像素间距做差分
vec3 terrainNormal(vec2 g, vec3 up, float lod) {
  float texel = GROUND_BASE * exp2(floor(lod)) / 256.0; // 高度图是 256²
  float hx = groundHeightAt(g + vec2(texel, 0.0), lod) - groundHeightAt(g - vec2(texel, 0.0), lod);
  float hz = groundHeightAt(g + vec2(0.0, texel), lod) - groundHeightAt(g - vec2(0.0, texel), lod);
  return normalize(up - vec3(hx, 0.0, hz) / (2.0 * texel));
}
`;
