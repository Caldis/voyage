import { GROUND_LEVELS } from "../ground/clipmap";

/**
 * 火车远景（TR03）：窗外程序的 RAIL 变体（`render/outside-pass.ts` 的 `outsideRailFragment`，#define GROUND_DETAIL + RAIL）。
 * 这两段 GLSL 只拼进火车变体的片元源码，飞机的默认程序 / 低空细节变体里没有它们；共用模块（terrain-shading / ground-detail /
 * outside-pass）里只留几处 `#ifdef RAIL` 钩子，预处理后飞机的程序与原来逐字相同（`src/rail/shader-parity.mjs` 验证）。
 *
 * 贴地相机（眼高约 2.5 m）和飞机的差别，以及这里的对策：
 * 1. **相机高度的精度**：uCamR = 6360 + 海拔，float32 在 6360 附近的间隔约 0.49 m，贴地时坡道上相机按半米台阶跳，地面也跟着跳。
 *    这里的求交、阴影全部用「相对相机」的写法：海拔 = 相机海拔（uRailCamAltKm，小数，精确到亚毫米）+ 沿视线的增量，
 *    增量用 q / (√(rc² + q) + rc) 这种不在 6360 附近相减的形式（railAltAlong）。
 * 2. **近处的地面**：clipmap 最细一级 7.8 m 一个影像像素、31 m 一个高度像素，放在几十米外就是一大片模糊色块，
 *    而 AWS 地形比国土地理院的轨面还高的地方（弯道处实测抬了 7–30 m）视线从地形里面出发，整片退回海平面球（画成海）。
 *    近处（水平距离 < RAIL_NEAR_END）改成国土地理院标高的平面（uRailNearGroundKm），到 RAIL_BLEND_END 渐变到 clipmap 地形，
 *    clipmap 地形再按 uRailTerrOffsetKm 平移到国土地理院的基准（1–4 km 渐隐）。近处平面带只画「地面近似色」：
 *    影像取粗级（RAIL_NEAR_ALB_LOD，约 40 m 一个像素的平均色）+ 低空细节（田块、斑驳）按像素足迹的长轴淡出——不露放大的影像。
 *    真正的近景 / 中景留给 TR04 / TR05 的走廊层，画在它上面。
 * 3. **掠射的步进**：眼高 2.5 m 时，地平线附近的视线在平原上方几米处走十几公里，飞机版「按离地高度缩步」的规则会在
 *    96 步内用完、退回海平面球（山脚下那条发白的「海」）。这里：地形在朝视线逼近（比视线升得快）时用小步，
 *    否则步长按距离的 4%（3 km 内）到 10%（20 km 外）放大；步数用完时按「打在最后一步的地面」处理，不退回海。
 * 4. **斜看的影像走样**：像素在地面上的足迹沿视线方向是横向的 1/cosθ 倍（1 km 外几百倍）。只按横向足迹取一个点，
 *    平原上的影像沿视线方向严重欠采样，列车一动就闪。这里沿足迹长轴取最多 4 个点平均，级别选到每个点只负责约一个纹素（railGroundSample）；
 *    岸线按长轴足迹收紧（抗锯齿），不在斜看时出台阶。
 */

// 第一段：放在 TERRAIN_SHADING_COMMON 之前（依赖 GROUND_COMMON、ATMOSPHERE_COMMON、VIEW_COMMON、CLOUD_COMMON、NOISE_COMMON）
export const RAIL_FAR_COMMON = /* glsl */ `
uniform float uRailCamAltKm;      // 相机海拔（km），精确（见文件头 1）
uniform float uRailNearGroundKm;  // 近处地面标高（km，国土地理院）
uniform float uRailTerrOffsetKm;  // 国土地理院 − clipmap 地形（km）
uniform int uRailSteps;           // 地形求交最多步数

const float RAIL_NEAR_END = 0.25;     // 近处平面带的外沿（水平距离 km）
const float RAIL_BLEND_END = 0.6;     // 渐变到 clipmap 地形的外沿
const float RAIL_OFFSET_FADE0 = 1.0;  // 基准平移从这里开始渐隐……
const float RAIL_OFFSET_FADE1 = 4.0;  // ……到这里消失
const float RAIL_NEAR_ALB_LOD = 2.3;  // 近处平面带取影像的最细级别（2^2.3 × 7.8 m ≈ 38 m 一个像素：只要大致的地面颜色）
const int RAIL_ALB_TAPS = 4;          // 沿足迹长轴最多取几个点

// 从海拔 h0（km）的点出发，沿与该点天顶夹角余弦为 mu 的方向走 t（km）后的海拔。
// |p|² − rc² = t(2·rc·mu + t) 精确可算，海拔增量 = 它 / (|p| + rc)，全程不在 6360 附近相减（float32 在那里只有约 0.5 m）
float railAltAlong(float h0, float mu, float t) {
  float rc = BOTTOM + h0;
  float q = t * (2.0 * rc * mu + t);
  return h0 + q / (sqrt(max(rc * rc + q, 0.0)) + rc);
}

// 火车远景的地形高度（km）。xz：相对相机的水平位置（km）。近处是国土地理院标高的平面，往外渐变到 clipmap 地形（近处平移到国土地理院的基准）
float railTerrainHeight(vec2 xz, float lod) {
  float r = length(xz);
  float w = smoothstep(RAIL_NEAR_END, RAIL_BLEND_END, r);
  if (w <= 0.0) return uRailNearGroundKm;
  float hT = groundHeightAt(xz + uCloudOffset, lod) + uRailTerrOffsetKm * (1.0 - smoothstep(RAIL_OFFSET_FADE0, RAIL_OFFSET_FADE1, r));
  return mix(uRailNearGroundKm, hT, w);
}

// 视线与火车远景地形求交，返回距离（km），打不到返回 −1（天空）。
// cov：像素被地形盖住的比例。打到了是 1；没打到、但途中离地形最近处不到一个像素（按那里的像素竖直足迹算）时，
// 返回那一处的距离、cov = 1 − 最近距离 / 足迹（单侧的轮廓抗锯齿：贴地掠射时远处低矮的山脊几乎和地平线平行，
// 不抗锯齿就是一段段 1 像素的水平台阶，列车一动就沿轮廓爬）
float railTerrainHit(vec3 rd, out float cov) {
  cov = 1.0;
  float pixelAngle = 2.0 * uTanHalfFov / uResolution.y;
  float lh = max(length(rd.xz), 1e-4);
  // 近处平面：250 m 内地球曲率只差几厘米，按平面解析求交
  if (rd.y < 0.0) {
    float tp = (uRailCamAltKm - uRailNearGroundKm) / -rd.y;
    if (tp * lh < RAIL_NEAR_END) return tp;
  }
  vec3 ro = vec3(0.0, BOTTOM + uRailCamAltKm, 0.0);
  float tSea = raySphere(ro, rd, BOTTOM);
  float tTop = raySphere(ro, rd, BOTTOM + uTerrainMax + 0.05);
  float tEnd = tSea > 0.0 ? tSea : tTop;
  if (tEnd <= 0.0) return -1.0;
  tEnd = min(tEnd, 400.0);
  float t = RAIL_NEAR_END / lh;
  if (t >= tEnd) return -1.0;
  float mu = rd.y;
  float altPrev = railAltAlong(uRailCamAltKm, mu, t);
  float hPrev = uRailNearGroundKm;
  float tPrev = t;
  float cPrev = altPrev - hPrev;
  float c = cPrev;
  bool hit = false;
  float dMin = 1e9, tMin = t; // 途中离地形最近（以像素计）的一处
  // 上限用 uniform（uRailSteps）：常量上限会被 FXC 整个展开
  for (int i = 0; i < uRailSteps; i++) {
    float alt = railAltAlong(uRailCamAltKm, mu, t);
    float hg = railTerrainHeight(rd.xz * t, groundLod(t * lh, t * pixelAngle));
    c = alt - hg;
    if (c < 0.0) { hit = true; break; }
    float dPx = c * lh / (t * pixelAngle); // 离地形的竖直距离，换算成像素（近水平的视线，竖直足迹 ≈ t·像素张角 / 水平分量）
    if (dPx < dMin) { dMin = dPx; tMin = t; }
    if (t >= tEnd) break;
    // 步长下限按距离放大（3 km 内 4%，20 km 外 10%）：平原上掠射的视线离地只有几米，按离地高度缩步会在几十步内用完。
    // 地形朝视线逼近（这一步里地形比视线升得多）时，按逼近的速度预估还有多远会碰上，只走其中一半，免得跨过山脊；
    // 不能一逼近就退回飞机版的小步（0.004t + 10 m）：平原上高度有起伏，一半的步都在「逼近」，步数照样用完（第一版就是这样，远处地平线成了一段段台阶）
    float k = mix(0.04, 0.1, smoothstep(3.0, 20.0, t));
    float closeRate = ((hg - hPrev) - (alt - altPrev)) / max(t - tPrev, 1e-4);
    float floorStep = max(k * t, 0.01);
    if (closeRate > 0.0) floorStep = min(floorStep, max(0.5 * c / closeRate, 0.004 * t + 0.01));
    tPrev = t;
    altPrev = alt;
    hPrev = hg;
    cPrev = c;
    t = min(t + max(1.5 * c, floorStep), tEnd);
  }
  // 没打到：步数用完而视线还在往下走，当作打在最后一步处的地面（内陆线路，不退回海平面球）；否则是天空
  if (!hit) {
    if (t < tEnd && railAltAlong(uRailCamAltKm, mu, t) < uRailCamAltKm) return t;
    cov = 1.0 - dMin;
    return cov > 0.0 ? tMin : -1.0;
  }
  // 在上一步与这一步之间二分，最后按两端的离地高度线性插值。上限「5 + uLoopGuard」防展开
  float a = tPrev, b = t, ca = cPrev, cb = c;
  for (int k = 0; k < 5 + uLoopGuard; k++) {
    float m = 0.5 * (a + b);
    float cm = railAltAlong(uRailCamAltKm, mu, m) - railTerrainHeight(rd.xz * m, groundLod(m * lh, m * pixelAngle));
    if (cm < 0.0) { b = m; cb = cm; } else { a = m; ca = cm; }
  }
  return a + (b - a) * ca / max(ca - cb, 1e-9);
}

// 火车远景地形的法线（和 terrainNormal 同一差分，高度取 railTerrainHeight：近处平面带是平的）
vec3 railTerrainNormal(vec2 xz, vec3 up, float lod) {
  float texel = GROUND_BASE * exp2(floor(lod)) / 256.0;
  float hx = railTerrainHeight(xz + vec2(texel, 0.0), lod) - railTerrainHeight(xz - vec2(texel, 0.0), lod);
  float hz = railTerrainHeight(xz + vec2(0.0, texel), lod) - railTerrainHeight(xz - vec2(0.0, texel), lod);
  return normalize(up - vec3(hx, 0.0, hz) / (2.0 * texel));
}

// 地形阴影（和 terrainShadow 同一做法），高度都用相对量：P 是地心坐标的命中点（P.xz 就是相对相机的水平位置），hP 是它的海拔（km，精确）
float railTerrainShadow(vec3 P, float hP, vec3 l, float lod) {
  if (uTerrainMax < 0.05) return 1.0;
  float mu = dot(normalize(P), l);
  float shadow = 1.0;
  float t = 0.05;
  for (int i = 0; i < 16 + uLoopGuard; i++) {
    float alt = railAltAlong(hP, mu, t);
    if (alt > uTerrainMax) break;
    float hq = railTerrainHeight(P.xz + l.xz * t, lod + 1.0);
    shadow = min(shadow, clamp((alt - hq) / (0.02 * t) + 0.5, 0.0, 1.0));
    if (shadow <= 0.0) break;
    t *= 1.45;
  }
  return shadow;
}

// 沿足迹长轴（视线的水平方向 dirH，长 longM 米）取最多 RAIL_ALB_TAPS 个点平均影像与水体遮罩。
// lodA：影像级别；lodW：水体级别（近处平面带的影像取粗级，水体不跟着粗，河还在）。alb.w = 各点里最小的「有影像」比例
void railGroundSample(vec2 g, vec2 dirH, float longM, float lodA, float lodW, out vec4 alb, out vec3 wat) {
  float texelW = GROUND_BASE * exp2(floor(lodW)) * 1000.0 / GROUND_RES;
  int n = int(clamp(ceil(longM / texelW), 1.0, float(RAIL_ALB_TAPS)));
  vec2 stepKm = dirH * (longM / float(n) * 0.001);
  alb = vec4(0.0, 0.0, 0.0, 1.0);
  wat = vec3(0.0);
  for (int i = 0; i < RAIL_ALB_TAPS + uLoopGuard; i++) {
    if (i >= n) break;
    vec2 q = g + stepKm * (float(i) + 0.5 - 0.5 * float(n));
    vec4 a = sampleGroundAlbedo(q, lodA);
    alb.rgb += a.rgb;
    alb.w = min(alb.w, a.w);
    wat += sampleGround(uGroundWater, q, lodW).rgb;
  }
  alb.rgb /= float(n);
  wat /= float(n);
}
`;

// 第二段：放在 TERRAIN_SHADING_COMMON 之后（要用 GroundHit；terrain-shading 里 groundHit 在 RAIL 下转到这里，前面有原型声明）
export const RAIL_FAR_HIT = /* glsl */ `
// 近处平面带的地表（反照率乘子，均值约 1）：粗级影像只给「这一片大致是什么颜色」，这里按地表类别叠几米到几十米的斑块，
// 免得近处是一整块平涂（城区尤其：低空细节里的楼顶 / 街道从 2.5 m 眼高看只是条纹，已在 RAIL 下关掉）。
// 城区：沥青、混凝土、暗色屋顶 / 墙根、零星绿地；农田 / 草地：草色深浅、土色、倒伏的亮带。斑块边按足迹（长轴）软化，均值按比例归一，
// 远处（nearW → 0）退回影像本身。这是按实拍经验调的外观模型，不是真实的地块数据；TR04 / TR05 的走廊层会画在它上面
float railFade(float fp, float s) { return 1.0 - smoothstep(0.25 * s, 0.6 * s, fp); }
vec3 railNearCover(vec2 g, vec3 alb, float fp) {
  vec2 gm = g * 1000.0;
  vec3 cls = landClasses(alb);
  float n1 = (vnoise(gm / 23.0 + 3.1) - 0.5) * railFade(fp, 23.0);
  float n2 = (vnoise(gm / 7.3 + 5.7) - 0.5) * railFade(fp, 7.3);
  float n3 = (vnoise(gm / 2.1 + 11.3) - 0.5) * railFade(fp, 2.1);
  // 农田、草地、树林底下：草色深浅（明度 ±25%）与色相（偏黄 / 偏蓝绿）
  float m = n1 * 0.9 + n2 * 0.6 + n3 * 0.35;
  vec3 veg = vec3(1.0 + 0.5 * m) * mix(vec3(1.08, 1.0, 0.8), vec3(0.92, 1.02, 1.1), clamp(0.5 + 1.4 * n1, 0.0, 1.0));
  // 城区：按 6 m 尺度的噪声分成几种地面，边界宽度 = 足迹 / 斑块尺度（远处自动变成平均色）
  float u = vnoise(gm / 6.0 + 7.9) + 0.25 * n1 + 0.3 * n3;
  float soft = clamp(fp / 6.0, 0.04, 1.0) * 0.5;
  float wA = 1.0 - smoothstep(0.38 - soft, 0.38 + soft, u);   // 沥青（暗）
  float wG = smoothstep(0.66 - soft, 0.66 + soft, u);           // 绿地
  float wC = 1.0 - wA - wG;                                     // 混凝土 / 砂石（亮）
  vec3 urb = wA * vec3(0.45, 0.46, 0.5) + wC * vec3(1.35, 1.3, 1.2) + wG * vec3(0.7, 1.05, 0.55);
  urb *= 1.0 + 0.3 * n3;
  urb /= 0.38 * 0.45 + 0.34 * 1.3 + 0.28 * 0.9; // 三种地面的大致面积比加权后的平均明度，保持和影像同一个均值
  vec3 mul = mix(veg, urb, cls.z);
  return mul;
}

bool railGroundHit(vec3 ro, vec3 rd, out GroundHit gh) {
  float cov;
  float tT = railTerrainHit(rd, cov);
  if (tT <= 0.0) return false;
  vec3 P = ro + rd * tT;   // 地心坐标：只拿去求方向、查云影 / 光照；高度一律用下面的相对量
  vec3 up = normalize(P);
  vec2 g = P.xz + uCloudOffset;
  float pixelAngle = 2.0 * uTanHalfFov / uResolution.y;
  float r = length(P.xz);
  float lod = groundLod(r, tT * pixelAngle);
  float nearW = 1.0 - smoothstep(RAIL_NEAR_END, RAIL_BLEND_END, r);
  vec3 nT = railTerrainNormal(P.xz, up, lod);
  // 像素足迹：横向 shortM，沿视线方向（投影到地面上）longM = shortM / cosθ（θ 是视线与地面法线的夹角）
  float shortM = max(tT * pixelAngle * 1000.0, 0.01);
  float longM = min(shortM / max(dot(-rd, nT), 0.002), 5000.0);
  float base = GROUND_BASE * 1000.0 / GROUND_RES;
  float lodW = clamp(max(lod, log2(max(longM / (float(RAIL_ALB_TAPS) * base), 1.0))), 0.0, ${(GROUND_LEVELS - 1).toFixed(1)});
  float lodA = max(lodW, RAIL_NEAR_ALB_LOD * nearW);
  vec4 alb;
  vec3 wat;
  railGroundSample(g, rd.xz / max(length(rd.xz), 1e-6), longM, lodA, lodW, alb, wat);
  // 影像还没到：中性的田野色（火车模式里没有海，不能露出深海底色）
  if (alb.w <= 0.0) alb = vec4(0.055, 0.075, 0.04, 1.0);
  if (nearW > 0.0) alb.rgb *= mix(vec3(1.0), railNearCover(g, alb.rgb, longM), nearW);
  float texelW = GROUND_BASE * exp2(floor(lodW)) * 1000.0 / GROUND_RES;
  // 岸线：按足迹长轴收紧水体遮罩（长轴方向已经取样平均过），掠射时不出台阶、不闪；远处（长轴 ≥ 半个纹素）保持平均值
  if (wat.r > 0.0 && wat.r < 1.0) {
    float w = 1.0 - smoothstep(0.2, 0.5, longM / texelW);
    if (w > 0.0) {
      float k = clamp(0.5 * longM / texelW, 0.04, 0.25);
      float e = (vnoise(g * 1000.0 / 6.0) - 0.5) * (0.25 - k) * 0.8;
      wat.r = mix(wat.r, smoothstep(0.3 - k, 0.3 + k, wat.r + e), w);
    }
  }
  vec3 uvw = aerialPerspectiveUvw(rd, uSunDir, tT);
  gh.P = P;
  gh.up = up;
  gh.g = g;
  gh.t = tT;
  gh.lod = lodA;
  gh.fpM = sqrt(shortM * longM);
  gh.texelM = texelW;
  gh.alb = alb;
  gh.wat = wat;
  gh.apL = texture(uAerialInscatterS, uvw).rgb * uSunIlluminance;
  gh.apT = texture(uAerialTransmittanceS, uvw).rgb;
  gh.nT = nT;
  gh.fpLong = longM;
  gh.alt = railAltAlong(uRailCamAltKm, rd.y, tT);
  gh.cov = cov;
  return true;
}
`;
