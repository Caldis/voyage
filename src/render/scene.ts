import * as THREE from "three";
import { ATMOSPHERE_COMMON, FULLSCREEN_VERT } from "../atmosphere/common.glsl";
import type { Atmosphere } from "../atmosphere/luts";
import { CLOUD_COMMON } from "../clouds/clouds.glsl";
import { CABIN_COMMON, PANE_COMMON } from "./cabin.glsl";
import { VIEW_COMMON } from "./view.glsl";
import type { GroundClipmap } from "../ground/clipmap";
import { GROUND_COMMON } from "./ground.glsl";
import { ISLANDS_COMMON } from "./islands.glsl";
import { LIGHTS_COMMON } from "./lights.glsl";
import { STARS_COMMON } from "./stars.glsl";
import { TRAFFIC_COMMON } from "./traffic.glsl";
import { WING_COMMON } from "./wing.glsl";

/**
 * 场景着色器：从头部位置向屏幕每个像素发射线，先穿过按真实尺寸建模的舷窗，
 * 能穿出去的射线再算窗外的天空、太阳和海面。输出 HDR 亮度（单位 kcd/m²）。
 *
 * 座舱坐标（米）：原点在舱壁内饰面上的窗洞中心，x 沿舱壁（右侧座位时朝机头），y 向上，z 朝窗外。
 * 窗外坐标（km）：地心为原点，飞机正下方为 +y，x 朝东，z 朝南。
 */
const SCENE_FRAG = /* glsl */ `
${ATMOSPHERE_COMMON}
${VIEW_COMMON}
${CLOUD_COMMON}
${CABIN_COMMON}
${PANE_COMMON}
${WING_COMMON}
${LIGHTS_COMMON}
${STARS_COMMON}
${ISLANDS_COMMON}
${GROUND_COMMON}
uniform sampler2D uClouds;       // 半分辨率云层：RGB 预乘辐亮度，A 透射率
uniform float uShadeBottom;
uniform float uWind;
uniform float uCabinLight;      // 舱内灯光照度，klux
uniform float uTime;            // 秒，给波浪和闪烁用
uniform float uWetness;         // 窗板外侧的湿度 0..1
uniform float uCameraFog;       // 飞机所在位置云的消光系数（1/km），机翼要隔着这层雾看
uniform float uHdrMax;          // HDR 目标能存的最大值（半精度时是 6e4）
// 调试可视化：0 关，1 内衬命中深度，2 亮度（伪彩），3 内衬受到的窗光，4 内衬法线，
// 5 海面本身，6 海面天空反射，7 海面的内散射，8 海面粗糙度 / 像素覆盖，9 海面直射照度，10 闪烁格子
uniform int uDebug;
varying vec2 vUv;
${TRAFFIC_COMMON}

const float PANE_TRANSMITTANCE = 0.85;      // 两层亚克力 + 内层防刮板
const vec3 PLASTIC_ALBEDO = vec3(0.78, 0.76, 0.72);

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

// 闪电从云底向下照亮地面 / 海面的照度（klux）：按平方反比衰减，经验标定到「夜里 5 km 外约 10 lux」
vec3 flashIlluminance(vec3 P) {
  if (uFlash.w <= 0.0) return vec3(0.0);
  vec3 fp = vec3(uFlash.x - uCloudOffset.x, BOTTOM + min(uFlash.y, 1.3), uFlash.z - uCloudOffset.y);
  vec3 pw = vec3(P.x, length(P), P.z);
  float d2 = dot(pw - fp, pw - fp);
  return vec3(0.8, 0.85, 1.0) * uFlash.w * 4e-5 / (0.04 + d2 / 25.0);
}

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

vec3 outsideRadiance(vec3 rd, vec4 cloud) {
  vec3 ro = vec3(0.0, uCamR, 0.0);
  if (uGroundOn > 0.5) {
    vec4 gr = groundRadiance(ro, rd);
    if (gr.w > 0.0) return gr.rgb * cloud.a + cloud.rgb;
  }
  float tGround = raySphere(ro, rd, BOTTOM);
  bool hitGround = tGround > 0.0;
  // 天空视图 LUT 已经包含到地面为止的内散射（空气透视）
  vec3 L = skyRadiance(rd, hitGround);
  if (hitGround) {
    vec3 P = ro + rd * tGround;
    // 相机到海面的透射率 = T(海面→层顶) / T(相机→层顶)，两段都是朝上的射线
    vec3 tSurface = transmittanceToTop(BOTTOM, dot(normalize(P), -rd));
    vec3 tCamera = transmittanceToTop(uCamR, -rd.y);
    vec3 tView = min(tSurface / max(tCamera, vec3(1e-6)), vec3(1.0));
    float fView;
    vec3 nView;
    vec3 inscatter = L;
    vec3 sea = tView * (oceanRadiance(P, rd, tGround, vec3(-1.0), 1.0, fView, nView) + vec3(0.02, 0.04, 0.05) / M_PI * flashIlluminance(P));
    L += sea;
    // 天空反射：天空视图 LUT 是从相机算的，L相机(反射方向) ≈ 内散射(相机→海面) + 透射率 × L海面(反射方向)。
    // 所以反射的贡献是 F·(L相机 − 内散射)，不能再乘一次透射率，否则地平线处会被衰减两次，出现一条暗线
    vec3 skyCam = skyRadiance(reflect(rd, nView), false);
    vec3 refl = fView * max(skyCam - inscatter, vec3(0.0));
    L += refl;
    if (uDebug == 5 || uDebug >= 8) L = sea;
    if (uDebug == 6) L = refl;
    if (uDebug == 7) L = inscatter;
  } else {
    // 太阳圆盘：辐亮度 = 照度 / 立体角，带临边昏暗
    float c = dot(rd, uSunDir);
    if (c > 0.0) {
      float ang = asin(min(length(cross(rd, uSunDir)), 1.0));
      float x = ang / SUN_ANGULAR_RADIUS;
      if (x < 1.2) {
        float pixelAngle = 2.0 * uTanHalfFov / uResolution.y;
        float coverage = clamp((SUN_ANGULAR_RADIUS - ang) / pixelAngle + 0.5, 0.0, 1.0);
        float mu = sqrt(max(0.0, 1.0 - x * x));
        float limb = (1.0 - 0.6 * (1.0 - mu)) / (1.0 - 0.6 / 3.0);
        vec3 disk = uSunIlluminance / (M_PI * SUN_ANGULAR_RADIUS * SUN_ANGULAR_RADIUS) * limb;
        L += disk * coverage * sunTransmittance(uCamR, rd.y);
      }
    }
    // 月亮圆盘（白天也在，只是很淡）和星星；都要穿过相机上方的大气
    vec3 tUp = sunTransmittance(uCamR, rd.y);
    L += (moonDisk(rd) + starRadiance(rd)) * tUp;
  }
  // 云挡在前面：背景剩下云的透射率那么多，再加上云自身的光
  return L * cloud.a + cloud.rgb;
}

// 机翼着色（座舱系）。eSky / eDown / belowAlbedo 是窗外的天空光、下方反射光
vec3 shadeWing(vec3 pc, vec3 rd, vec3 sunC, vec3 eSky, vec3 eDown, float belowAlbedo) {
  vec3 P = cabinToAircraft(pc);
  vec3 nA = wingNormal(P);
  vec3 n = vec3(uSeatSign * nA.x, nA.y, nA.z);          // 机体系 → 座舱系
  vec3 v = -rd;
  if (dot(n, v) < 0.0) n = -n;
  vec3 nW = uCabinToWorld * n;
  float pix = length(pc - uHead) * 2.0 * uTanHalfFov / uResolution.y; // 命中点处一个像素对应的米数
  WingSurface m = wingSurface(P, pix);
  vec3 lA = vec3(uSeatSign * sunC.x, sunC.y, sunC.z);
  float nl = dot(n, sunC);
  float shadow = fuselageShadow(P, lA) * step(0.0, nl);
  vec3 eSun = keyLight(uCamR, vec3(0.0, 1.0, 0.0)) * shadow;
  float nv = max(dot(n, v), 1e-3);
  nl = max(nl, 0.0);

  // 漫反射：阳光 + 上方天空 + 下方海面 / 云海反射上来的光
  vec3 diffuse = m.albedo * (1.0 - m.metal) / M_PI
    * (eSun * nl + eSky * (0.5 + 0.5 * nW.y) + belowAlbedo * eDown * (0.5 - 0.5 * nW.y));

  // 镜面：基础层（漆或裸铝）+ 清漆层（很光滑，太阳在上面是一个刺眼的亮点）
  vec3 h = normalize(sunC + v);
  float nh = max(dot(n, h), 0.0);
  float vh = max(dot(v, h), 0.0);
  vec3 f0 = mix(vec3(0.04), m.albedo, m.metal);
  vec3 fBase = f0 + (1.0 - f0) * pow(1.0 - vh, 5.0);
  float aBase = m.rough * m.rough;
  vec3 spec = fBase * ggxD(nh, aBase) * smithG(nv, max(nl, 1e-3), aBase) / (4.0 * nv * max(nl, 1e-3)) * eSun * nl;
  float coat = (1.0 - m.metal) * 0.9;
  float fCoat = 0.04 + 0.96 * pow(1.0 - vh, 5.0);
  const float A_COAT = 0.004; // 清漆粗糙度 0.06 的平方
  spec += coat * fCoat * ggxD(nh, A_COAT) * smithG(nv, max(nl, 1e-3), A_COAT) / (4.0 * nv * max(nl, 1e-3)) * eSun * nl;

  // 环境反射：天空（反射到地平线以下时是海面，用天空视图 LUT 的地面部分近似）
  vec3 r = uCabinToWorld * reflect(rd, n);
  float tG = raySphere(vec3(0.0, uCamR, 0.0), r, BOTTOM);
  vec3 env = skyRadiance(r, tG > 0.0);
  vec3 fEnv = f0 + (max(vec3(1.0 - m.rough), f0) - f0) * pow(1.0 - nv, 5.0);
  float fEnvCoat = 0.04 + 0.96 * pow(1.0 - nv, 5.0);
  vec3 envSpec = env * (fEnv * (m.metal > 0.5 ? 1.0 : 0.3) + coat * fEnvCoat);
  return diffuse + spec + envSpec + m.emit;
}

// 翼尖的航行灯（右绿左红）和白色频闪灯：小光源 + 周围的光晕（光晕靠后面的眩光处理放大）
vec3 wingLights(vec3 ro, vec3 rd) {
  float tipY = ROOT_Y + (TIP_Z - ROOT_Z) * tan(DIHEDRAL) + uWingFlex;
  float tipLE = -(TIP_Z - ROOT_Z) * tan(SWEEP);
  vec3 navA = vec3(tipLE - 0.15, tipY + 0.05, TIP_Z + 0.12);
  vec3 strobeA = navA + vec3(-0.35, 0.0, 0.0);
  vec3 L = vec3(0.0);
  for (int i = 0; i < 2; i++) {
    vec3 a = i == 0 ? navA : strobeA;
    vec3 c = vec3(uSeatSign * (a.x + uWingRootLE), a.y - WINDOW_HEIGHT, a.z - CABIN_WALL_RADIUS);
    vec3 d = c - ro;
    float t = dot(d, rd);
    if (t < 0.0) continue;
    float dist = length(d - rd * t);
    // 发光强度（cd）：航行灯约 40 cd，频闪闪亮时约 1500 cd。换算成一个 3 cm 光球的亮度，再加上宽一点的衰减
    vec3 intensity = i == 0 ? (uSeatSign > 0.0 ? vec3(0.1, 1.0, 0.35) : vec3(1.0, 0.08, 0.05)) * 40.0
                            : vec3(1.0) * 1500.0 * uStrobe;
    float core = 1.0 - smoothstep(0.02, 0.03, dist);
    L += intensity / (M_PI * 0.03 * 0.03) * 1e-3 * core; // cd/m² → kcd/m²
  }
  return L;
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

void main() {
  vec3 rd = cabinRay(gl_FragCoord.xy);
  vec3 ro = uHead;

  // ---- 所有屏幕导数都在任何循环和分支之前算好（分支里的导数没有定义） ----
  float rdz = max(rd.z, 1e-4);
  vec3 pWall = ro + rd * ((0.0 - ro.z) / rdz);
  vec3 pShade = ro + rd * ((SHADE_DEPTH - ro.z) / rdz);
  vec3 pPane = ro + rd * ((PANE_DEPTH - ro.z) / rdz);
  float dBezel = sdRoundRect(pWall.xy, BEZEL_HALF, BEZEL_RADIUS);
  float dPane = sdRoundRect(pPane.xy, PANE_HALF, PANE_RADIUS);
  // 抗锯齿宽度设上限：视线几乎贴着舱壁时交点飞到很远，导数会大到把几层颜色混在一起
  float wB = min(fwidth(dBezel), 0.005);
  float wP = min(fwidth(dPane), 0.005);
  float wS = min(fwidth(pShade.y), 0.005);
  float px = length(fwidth(pWall.xy));
  float pixPane = max(length(fwidth(pPane.xy)), 1e-5);

  // ---- 窗外来的光（舱内所有表面共用） ----
  // 「sun」系列变量指直射主光源：白天是太阳，夜里是月亮
  vec3 sunC = transpose(uCabinToWorld) * uKeyDir;   // 座舱系里的主光源方向
  vec3 upW = vec3(0.0, 1.0, 0.0);
  vec3 eSunNormal = keyLight(uCamR, upW) * PANE_TRANSMITTANCE;
  vec3 eSkyH = skyIrradiance(uCamR, upW);
  // 下半球：海面或云海把天空光和阳光反射上来。云海的反照率远高于海面
  vec3 eDown = eSkyH + keyLight(uCamR, upW) * max(uKeyDir.y, 0.0);
  float belowAlbedo = mix(0.06, 0.7, clamp(uCoverage * 0.9, 0.0, 1.0));
  // 窗板当作面光源时的平均辐亮度：一半看天，一半看下面
  vec3 lWin = 0.5 * (eSkyH / M_PI + belowAlbedo * eDown / M_PI) * PANE_TRANSMITTANCE;
  // 舱内环境光：灯光 + 满舱窗户进来的光被来回反射后的均匀部分（经验系数，待换成辐射度近似）
  vec3 eCabin = uCabinLight * CABIN_LIGHT_COLOR + 0.06 * M_PI * lWin + 0.004 * eSunNormal * max(sunC.z, 0.0);

  // ---- 舱壁 ----
  // 塑料面板：毫米级的橘皮纹理 + 厘米级的轻微斑驳。远处纹理细于像素时淡出，免得闪烁
  float grain = vnoise(pWall.xy * 900.0) - 0.5;
  float mottle = vnoise(pWall.xy * 30.0) - 0.5;
  float grainFade = 1.0 - smoothstep(0.0004, 0.0012, px);
  vec3 wallAlbedo = PLASTIC_ALBEDO * (1.0 + 0.06 * grain * grainFade + 0.04 * mottle);
  // 上亮下暗：顶灯和行李架下的灯带从上方照下来
  float wallGrad = 1.0 + 0.35 * clamp(pWall.y / 0.4, -1.0, 1.0);
  vec3 wall = wallAlbedo / M_PI * eCabin * wallGrad;
  if (rd.z < 1e-4) {
    gl_FragColor = vec4(wall, 0.0);
    return;
  }

  // ---- 窗洞内衬（漏斗曲面） ----
  vec3 hit;
  vec3 reveal = wall;
  float hitZ = 1.0; // 打到内衬的深度，没打到就是 1（比窗板还深）
  if (dBezel < 0.01 && marchFunnel(ro, rd, hit)) {
    hitZ = hit.z;
    vec3 n = funnelNormal(hit);
    float depth01 = clamp(hit.z / PANE_DEPTH, 0.0, 1.0);
    float ao = mix(1.0, 0.45, sqrt(depth01)); // 越深，看到的舱内越少
    vec3 e = eCabin * ao + windowIrradiance(hit, n, lWin)
           + eSunNormal * max(dot(n, sunC), 0.0) * sunThroughWindow(hit, sunC, uShadeBottom);
    float g = vnoise(hit.xy * 900.0 + hit.z * 500.0) - 0.5;
    // 窗板四周一圈深灰色的橡胶密封条
    float gasket = (1.0 - smoothstep(0.004, 0.006, sdRoundRect(hit.xy, PANE_HALF, PANE_RADIUS))) * step(PANE_DEPTH - 0.012, hit.z);
    vec3 albedo = mix(PLASTIC_ALBEDO * (1.0 + 0.05 * g * grainFade), vec3(0.06), gasket);
    reveal = albedo / M_PI * e;
    if (uDebug == 3) reveal = windowIrradiance(hit, n, lWin);
    if (uDebug == 4) reveal = n * 0.5 + 0.5;
  }

  // ---- 遮光板：半透的白色塑料，舱内一侧能看到透过来的光 ----
  vec3 eShadeOuter = M_PI * lWin + eSunNormal * max(sunC.z, 0.0);
  vec3 shade = PLASTIC_ALBEDO / M_PI * (0.8 * eCabin + 0.08 * eShadeOuter);
  // 遮光板下沿有一道凸起的把手，被顶上来的光照亮
  float lip = smoothstep(0.012, 0.0, pShade.y - uShadeBottom);
  shade *= 1.0 + 0.25 * lip;

  // ---- 合成 ----
  float inBezel = 1.0 - smoothstep(-wB, wB, dBezel);
  float inPane = 1.0 - smoothstep(-wP, wP, dPane);
  // 视线在遮光板所在深度之前就打到内衬的话，遮光板被内衬挡住
  float shaded = smoothstep(-wS, wS, pShade.y - uShadeBottom) * step(SHADE_DEPTH, hitZ);

  vec4 cloud = texture(uClouds, gl_FragCoord.xy / uResolution);
  vec3 view;
  float tWing = inBezel > 0.0 ? wingHit(ro, rd, (PANE_DEPTH - ro.z) / rd.z) : -1.0;
  if (tWing > 0.0) {
    view = shadeWing(ro + rd * tWing, rd, sunC, eSkyH, eDown, belowAlbedo);
    // 在云里：机翼隔着几米到十几米的雾。消光系数取探针测到的云密度，雾色取这条视线上云的亮度
    if (uCameraFog > 0.0) {
      float tFog = exp(-uCameraFog * tWing * 0.001);
      vec3 fogColor = cloud.rgb / max(1.0 - cloud.a, 0.05);
      view = mix(fogColor, view, tFog);
    }
    view *= PANE_TRANSMITTANCE;
  } else {
    vec3 rdW = uCabinToWorld * rd;
    view = outsideRadiance(rdW, cloud);
    // 远处的飞机和航迹云在云层之上，挡在海面和云前面
    vec4 tr = trafficRadiance(rdW);
    view = (view * tr.a + tr.rgb + boltRadiance(rdW)) * PANE_TRANSMITTANCE;
  }
  view += wingLights(ro, rd) * PANE_TRANSMITTANCE;

  // ---- 窗板上的细节 ----
  vec2 q = pPane.xy;
  float sunLit = step(0.0, sunC.z); // 阳光照得到窗板
  vec2 sc = scratches(q, rd, sunC, pixPane);
  float sm = smudges(q);
  // 油污的前向散射：视线离太阳越近越亮，散射角大约 10–20°
  float fwdLobe = exp(-(1.0 - dot(rd, sunC)) / 0.03);
  view *= 1.0 - 0.1 * sm;
  view += sunLit * eSunNormal * (0.015 * sc.x + 0.004 * sm * fwdLobe);
  view += M_PI * lWin * (0.01 * sc.y + 0.006 * sm);
  // 窗板外侧的水：水线和水珠像小透镜，把周围一大片的光折射进来——亮度被「平均」成窗外的平均亮度，
  // 边缘因为全反射偏暗；迎着阳光时会闪亮
  vec2 wetCov = waterOnPane(q, pixPane, -uSeatSign, uTime, uWetness);
  float wc = clamp(wetCov.x + wetCov.y, 0.0, 1.0);
  // 均匀的雾里水珠几乎看不见，主要靠边缘的全反射暗边；外面有明暗对比时才折射出亮光
  vec3 lensed = M_PI * lWin * 0.9 + eSunNormal * 0.004 * sunLit * fwdLobe;
  float edge = clamp(4.0 * wc * (1.0 - wc) + 0.6 * wetCov.x, 0.0, 1.0);
  view *= 1.0 - 0.3 * edge;
  view += wc * 0.12 * max(lensed - view, vec3(0.0));
  // 内层窗板底部的透气孔（直径约 3 mm），孔边一圈暗环
  float dHole = length(q - vec2(0.0, -0.145));
  view *= 1.0 - 0.6 * smoothstep(0.0011, 0.0014, dHole) * (1.0 - smoothstep(0.0016, 0.0021, dHole));
  // 窗板反射舱内：正对时约 4%，斜看时更多（菲涅尔）
  float fr = 0.04 + 0.96 * pow(1.0 - clamp(rd.z, 0.0, 1.0), 5.0);
  view += fr * wall * 1.5;
  vec3 col = mix(wall, mix(mix(reveal, view, inPane), shade, shaded), inBezel);
  if (uDebug == 3 || uDebug == 4) col = mix(vec3(0.0), reveal, inBezel * (1.0 - inPane));
  if (uDebug == 1) col = vec3(hitZ / PANE_DEPTH, inBezel, shaded) * 10.0;
  if (uDebug == 2) col = vec3(log2(max(dot(col, vec3(0.2126, 0.7152, 0.0722)), 1e-6)) * 0.1 + 1.0) * 10.0;
  // HDR 目标是 32 位浮点时可以原样存下太阳的辐亮度（约 1.8e6 kcd/m²），眩光的能量才对。
  // alpha 存「这个像素有多少是窗外」，曝光时窗外和舱内分开适应
  float outsideMask = inBezel * inPane * (1.0 - shaded);
  gl_FragColor = vec4(min(col, vec3(uHdrMax)), outsideMask);
}
`;

export function createSceneMaterial(atmosphere: Atmosphere, cloudUniforms: Record<string, THREE.IUniform>, ground: GroundClipmap) {
  return new THREE.ShaderMaterial({
    vertexShader: FULLSCREEN_VERT,
    fragmentShader: SCENE_FRAG,
    depthTest: false,
    depthWrite: false,
    toneMapped: false,
    uniforms: {
      ...atmosphere.sharedUniforms,
      ...cloudUniforms,
      uClouds: { value: null },
      uSkyViewLut: { value: atmosphere.skyView.texture },
      uSkyViewMoonLut: { value: atmosphere.skyViewMoon.texture },
      uIrradianceLut: { value: atmosphere.irradiance.texture },
      uSunDir: { value: new THREE.Vector3(0, 1, 0) },
      uSunIlluminance: { value: new THREE.Vector3(120, 120, 120) },
      uMoonDir: { value: new THREE.Vector3(0, -1, 0) },
      uMoonIlluminance: { value: new THREE.Vector3() },
      uKeyDir: { value: new THREE.Vector3(0, 1, 0) },
      uKeyIlluminance: { value: new THREE.Vector3(120, 120, 120) },
      uSunFromMoon: { value: new THREE.Vector3(0, 1, 0) },
      uMoonAngularRadius: { value: 0.0045 },
      uMoonPhaseFraction: { value: 1 },
      uMoonTexture: { value: null },
      uStarMap: { value: null },
      uLocalToEquatorial: { value: new THREE.Matrix3() },
      uCamR: { value: 6370 },
      uResolution: { value: new THREE.Vector2(1, 1) },
      uHead: { value: new THREE.Vector3(0, 0, -0.45) },
      uCamBasis: { value: new THREE.Matrix3() },
      uTanHalfFov: { value: Math.tan((25 * Math.PI) / 180) },
      uCabinToWorld: { value: new THREE.Matrix3() },
      uShadeBottom: { value: 1 },
      uWind: { value: 7 },
      uCabinLight: { value: 0.2 },
      uTime: { value: 0 },
      uWetness: { value: 0 },
      uCameraFog: { value: 0 },
      uSeatSign: { value: 1 },
      uWingRootLE: { value: 8 },
      uWingFlex: { value: 0.5 },
      uStrobe: { value: 0 },
      uIslandDensity: { value: 0.15 },
      uGroundAlbedo: { value: ground.albedo },
      uGroundWater: { value: ground.water },
      uGroundHeight: { value: ground.height },
      uGroundLevel: { value: ground.levelUniform },
      uGroundOn: { value: 1 },
      uTerrainMax: { value: 0 },
      uBolt: { value: Array.from({ length: 16 }, () => new THREE.Vector3()) },
      uBoltIntensity: { value: 0 },
      uTrafficPos: { value: [new THREE.Vector3(), new THREE.Vector3()] },
      uTrafficDir: { value: [new THREE.Vector3(1, 0, 0), new THREE.Vector3(1, 0, 0)] },
      uTrafficSpeed: { value: [0.23, 0.23] },
      uTrafficActive: { value: [0, 0] },
      uAerialInscatterS: { value: atmosphere.aerialInscatter.texture },
      uAerialTransmittanceS: { value: atmosphere.aerialTransmittance.texture },
      uHdrMax: { value: 6e4 },
      uDebug: { value: 0 },
    },
  });
}
