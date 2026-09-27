import { GROUND_BASE_KM, GROUND_LEVELS, GROUND_RES } from "../ground/clipmap";

/**
 * 真实地面（GLSL）：clipmap 采样 + 高度场求交。依赖 ATMOSPHERE_COMMON / CLOUD_COMMON（uCloudOffset = 飞机的本地坐标）/
 * NOISE_COMMON（uLoopGuard：循环上限写成「常数 + uLoopGuard」防止 FXC 展开）。
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
uniform int uGroundLevelCount;                 // = GROUND_LEVELS（uniform 是为了不让 FXC 展开循环）
uniform int uTerrainSteps;                     // 地形求交的最多步数（uniform 而不是常量，免得 FXC 展开循环）

const float GROUND_BASE = ${GROUND_BASE_KM.toFixed(1)};
const float GROUND_RES = ${GROUND_RES.toFixed(1)};   // 影像 / 水体纹理边长（G06 起 2048）

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

// 找从 lod 开始往粗走第一个可用的级别；都不可用返回 −1。
// 上限用 uniform（uGroundLevelCount = ${GROUND_LEVELS}）：sampleGround 在着色器里被调用几十处，常量上限会让 FXC 在每一处都展开，
// 冷编译明显变慢（T02 实测）
int usableLevel(int L, vec2 g) {
  for (int i = max(L, 0); i < uGroundLevelCount; i++) {
    if (levelCovers(i, g)) return i;
  }
  return -1;
}

// 在 lod 附近两级之间混合采样。返回 w = 0 表示这里没有数据。
// holes：影像瓦片没取到的地方用粗一级补上——只对影像有意义。影像纹理的 A 通道（T08 起）：< 0.5 时是「有影像的比例 / 2」，
// ≥ 0.5 表示有影像、其余位存道路照亮宽度（clipmap.ts 的 roadAlbedoAlpha），所以有影像的比例 = min(A·2, 1)。
// 水体纹理的 A 通道存的是道路有向距离，不能当成「缺数据」，所以分成 sampleGround / sampleGroundAlbedo 两个入口
vec4 groundSampleImpl(sampler2DArray tex, vec2 g, float lod, bool holes) {
  int L0 = usableLevel(int(floor(lod)), g);
  if (L0 < 0) return vec4(0.0);
  int L1 = usableLevel(L0 + 1, g);
  float f = L0 == int(floor(lod)) ? fract(lod) : 0.0;
  vec4 a = textureLod(tex, levelUv(L0, g), 0.0);
  if (L1 < 0) return vec4(a.rgb, 1.0);
  vec4 b = textureLod(tex, levelUv(L1, g), 0.0);
  if (holes) a.rgb = mix(b.rgb, a.rgb, min(a.a * 2.0, 1.0));
  return vec4(mix(a.rgb, b.rgb, f), 1.0);
}
// 按像素足迹取样（G06）：ax / ay 是一个屏幕像素在地面上的足迹的两条轴（km，g 坐标；groundHit 用光线微分算），
// textureGrad 让硬件按足迹选 mip、沿长轴做各向异性过滤（纹理带 mipmap，最多 16×）。
// 为什么要：G06 把纹素调细到约屏幕像素的 1.5 倍，斜看时足迹沿视线方向是横向的 5–50 倍，只取一个双线性样本（textureLod 0）
// 飞机一动就闪；硬件各向异性超过 16× 以后按 mip 变糊（远处本来就在雾里，宁可糊不要闪）。
// A 通道：mip 是平均出来的。只用它判缺影像（min(A·2, 1)，平均后正好是「有影像的比例」，有路的纹素 A > 0.5 会让边上略偏大，只影响瓦片没取到时的过渡）；
// 道路照亮宽度必须按第 0 级读（groundRoadTap 用 textureLod），不能用这里的 A
vec4 groundSampleAniso(sampler2DArray tex, vec2 g, float lod, vec2 ax, vec2 ay, bool holes) {
  int L0 = usableLevel(int(floor(lod)), g);
  if (L0 < 0) return vec4(0.0);
  int L1 = usableLevel(L0 + 1, g);
  float f = L0 == int(floor(lod)) ? fract(lod) : 0.0;
  float k0 = 1.0 / uGroundLevel[L0].z;
  vec4 a = textureGrad(tex, levelUv(L0, g), ax * k0, ay * k0);
  if (L1 < 0) return vec4(a.rgb, 1.0);
  float k1 = 1.0 / uGroundLevel[L1].z;
  vec4 b = textureGrad(tex, levelUv(L1, g), ax * k1, ay * k1);
  if (holes) a.rgb = mix(b.rgb, a.rgb, min(a.a * 2.0, 1.0));
  return vec4(mix(a.rgb, b.rgb, f), 1.0);
}
// 水体、高度纹理
vec4 sampleGround(sampler2DArray tex, vec2 g, float lod) {
  return groundSampleImpl(tex, g, lod, false);
}
// 影像（缺瓦片处回退到粗一级）
vec4 sampleGroundAlbedo(vec2 g, float lod) {
  return groundSampleImpl(uGroundAlbedo, g, lod, true);
}

// ---- 道路灯带（T08）----
// 水体纹理 A = 0.5 + 有向距离 / (2·ROAD_SD_RANGE)（到最近道路中心线，单位纹素）；影像纹理 A 的高半段 = 照亮宽度 / ROAD_W_MAX。
// 两个常数和 clipmap.ts 一致。为什么是有向距离、怎么挡假线，见 clipmap.ts 的 RoadRaster
const float ROAD_SD_RANGE = 4.0;
const float ROAD_W_MAX = 40.0;

// 帐篷核（半宽 F，面积 1）的累积分布
float groundRoadTentCdf(float x, float F) {
  float u = clamp(x / F, -1.0, 1.0);
  return u < 0.0 ? 0.5 * (1.0 + u) * (1.0 + u) : 1.0 - 0.5 * (1.0 - u) * (1.0 - u);
}
// 一个取样点：这个子足迹（横跨道路方向宽 F 米）里被照亮路面占的比例。
// 线按真实宽度 W 的带子、和半宽 F 的帐篷核卷积（解析抗锯齿，T43）：能量和真实宽度一致（逐列求和 = W/F），
// 细线按离像素中心的距离线性地分到相邻两个像素上。T08 用的是宽 F 的盒子：路比像素窄时剖面是「像素中心在 F/2 以内就满亮、否则全暗」，
// 细线成了 1 像素的阶梯，飞机前进时阶梯沿线爬
float groundRoadTap(int L, vec2 q, float texM, float F) {
  vec3 uv = levelUv(L, q);
  float dc = abs(textureLod(uGroundWater, uv, 0.0).a - 0.5) * (2.0 * ROAD_SD_RANGE) * texM;
  if (dc > F + 0.5 * ROAD_W_MAX) return 0.0;
  // 编码是 128 + 宽度 × 127 / ROAD_W_MAX（road-raster.ts）。T08 按 A·2 − 1 解码，「不亮」的 128 被解成 1/255 × 40 m ≈ 0.16 m，
  // 所有没亮的路（包括田里的每一条乡道）都剩一根等亮的灰线（T43 发现），这里按原编码精确还原，0 就是 0
  float W = clamp((textureLod(uGroundAlbedo, uv, 0.0).a * 255.0 - 128.0) / 127.0, 0.0, 1.0) * ROAD_W_MAX;
  return groundRoadTentCdf(dc + 0.5 * W, F) - groundRoadTentCdf(dc - 0.5 * W, F);
}

// 这个像素里被照亮路面占的比例（已含每条路的照明强度与「亮不亮」）。
// shortM / longM：像素在地面上的足迹（米，横向 / 沿视线方向），dirH：视线的水平方向。
// 级别只按横向足迹选（纹素 ≈ 横向足迹，有向距离能在纹素以内还原线位，不必像影像那样按距离再粗一级），往粗走到第一个覆盖得到的级别，
// 在这一级的边缘附近渐变到粗一级，免得线的锐度在级别边界上突变。
// 斜看时足迹沿视线方向拉得很长（贴近地平线时是横向的几十倍）：沿长轴等距取 n 个点，每个点只负责长轴的 1/n（各向异性过滤），
// 否则和视线垂直的路（屏幕上横着的路）会漏采、飞机一动就闪。
float groundRoadCoverage(vec2 g, float shortM, float longM, vec2 dirH) {
  float base = GROUND_BASE * 1000.0 / GROUND_RES;
  float lodR = clamp(log2(max(shortM / base, 1.0)), 0.0, ${(GROUND_LEVELS - 1).toFixed(1)});
  int Lf = int(floor(lodR));
  int L0 = usableLevel(Lf, g);
  if (L0 < 0) return 0.0;
  int L1 = usableLevel(L0 + 1, g);
  vec4 lv = uGroundLevel[L0];
  vec2 e = abs(g - lv.xy) / lv.z;
  float f = max(L0 == Lf ? fract(lodR) : 0.0, smoothstep(0.42, 0.48, max(e.x, e.y)));
  if (L1 < 0) { L1 = L0; f = 0.0; }
  float tex0 = base * exp2(float(L0));
  float tex1 = base * exp2(float(L1));
  // 路的法线：中心处有向距离的梯度（真线上 |梯度| ≈ 1 纹素 / 纹素）。
  // 两条路之间、或路的负侧与「无路」之间，有向距离会跳变，插值出一个假零点（假线），那里 |梯度| 明显大于 1，据此挡掉
  float hK = 0.5 * tex0 * 0.001;
  float s0 = textureLod(uGroundWater, levelUv(L0, g), 0.0).a;
  float sx = textureLod(uGroundWater, levelUv(L0, g + vec2(hK, 0.0)), 0.0).a;
  float sz = textureLod(uGroundWater, levelUv(L0, g + vec2(0.0, hK)), 0.0).a;
  vec2 grad = vec2(sx - s0, sz - s0) * (4.0 * ROAD_SD_RANGE);
  float gl = length(grad);
  float real = 1.0 - smoothstep(1.35, 1.9, gl);
  vec2 perpH = vec2(-dirH.y, dirH.x);
  vec2 nrm = gl > 1e-3 ? grad / gl : perpH;
  int n = int(clamp(ceil(longM / (1.5 * tex0)), 1.0, 6.0));
  float spacing = longM / float(n);
  // 子足迹在路的法线方向上的宽度（足迹是 spacing × shortM 的矩形，投影到法线上）
  float F = abs(dot(nrm, dirH)) * spacing + abs(dot(nrm, perpH)) * shortM;
  float F0 = max(F, 0.25 * tex0);
  float F1 = max(F, 0.25 * tex1);
  float c0 = 0.0, c1 = 0.0;
  vec2 stepKm = dirH * (spacing * 0.001);
  // 上限写成「6 + uLoopGuard」：常量上限会被 FXC 展开
  for (int i = 0; i < 6 + uLoopGuard; i++) {
    if (i >= n) break;
    vec2 q = g + stepKm * (float(i) + 0.5 - 0.5 * float(n));
    c0 += groundRoadTap(L0, q, tex0, F0);
    if (f > 0.0) c1 += groundRoadTap(L1, q, tex1, F1);
  }
  return mix(c0, c1, f) / float(n) * real;
}

float groundHeightAt(vec2 g, float lod) {
  vec4 h = sampleGround(uGroundHeight, g, lod);  // 高度纹理 RedFormat，alpha 恒为 1
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
  float range = max(tEnd - tStart, 1e-3);
  float t = tStart;
  // 步长前密后疏（基准分布 t = tStart + range·s²，近处的山要准，远处的只要大致对）；
  // 离地面近时再按「离地高度」缩小步长：固定步长会跨过比步长还窄的山脊，山脊的剪影在远处变成锯齿。
  // 循环上限用 uniform（uTerrainSteps）：常量上限会被 Windows 上的 FXC 整个展开，冷编译慢到浏览器判定 GPU 卡死、丢失上下文
  bool hit = false;
  for (int i = 0; i < uTerrainSteps; i++) {
    float s = sqrt((t - tStart) / range);
    float dq = range * (2.0 * s + 1.0 / N) / N;
    vec3 p = ro + rd * t;
    float alt = length(p) - BOTTOM;
    float lod = groundLod(length(p.xz), t * pixelAngle);
    float hg = groundHeightAt(p.xz + uCloudOffset, lod);
    if (alt < hg) { hit = true; break; }
    tPrev = t;
    if (t >= tEnd) break;
    t = min(t + min(dq, max((alt - hg) * 1.5, 0.004 * t + 0.01)), tEnd);
  }
  // 没打到：包括步数用完（uTerrainSteps）还没走到 tEnd 的情况——这时退化成「打在海平面球上」，
  // 远处极贴地平线的视线可能把山后的陆地画在海平面高度；96 步下实测场景里没有出现
  if (!hit) return tSea;
  // 打到了：在上一步与这一步之间二分。上限写成「6 + uLoopGuard」（恒为 6）：常量上限会被 FXC 展开成 6 份
  // groundHeightAt → sampleGround（里面还有逐级查找循环），SC-3b
  float a = tPrev, b = t;
  for (int k = 0; k < 6 + uLoopGuard; k++) {
    float m = 0.5 * (a + b);
    vec3 pm = ro + rd * m;
    float lm = groundLod(length(pm.xz), m * pixelAngle);
    if (length(pm) - BOTTOM < groundHeightAt(pm.xz + uCloudOffset, lm)) b = m; else a = m;
  }
  return b;
}

// 地形阴影：从 P 朝主光源方向在高度场上步进，被山挡住返回 0（带一点软边）
float terrainShadow(vec3 P, vec3 l, float lod) {
  if (uTerrainMax < 0.05) return 1.0;
  float h0 = length(P) - BOTTOM;
  float shadow = 1.0;
  float t = 0.05;
  // 上限「16 + uLoopGuard」（恒为 16）：常量上限会被 FXC 展开成 16 份 sampleGround（SC-3b）
  for (int i = 0; i < 16 + uLoopGuard; i++) {
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
