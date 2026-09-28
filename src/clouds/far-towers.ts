import * as THREE from "three";
import { ATMOSPHERE_COMMON, FULLSCREEN_VERT } from "../atmosphere/common.glsl";
import type { Atmosphere } from "../atmosphere/luts";
import type { FullscreenPass } from "../render/pass";
import { LIGHTS_COMMON } from "../render/lights.glsl";
import { VIEW_COMMON } from "../render/view.glsl";

/**
 * 远景对流塔层（TW02，research/TOWERING.md §3、research/PERF_PREVIEW_wave8.md 的 TW02 预审）。
 *
 * 为什么要有它：13 km 的砧顶从巡航高度约 776 km 外都在地平线以上，而体积云只摆 280 km 内的 4 个雷暴单体、
 * 400 km 外一律不画——「地平线上一排远塔」正好落在被截掉的那一段。盛夏华南 / 南海午后 400 km 内平均约 5 个单体、
 * 最多二十几个（TW01 统计），名额却只有 4 个。
 *
 * 做法：天气场里**没有被体积雷暴占用**的深对流单体（WeatherDirector.farTowerCells），在一个独立的小程序里按解析几何画
 * （不走体积步进）：
 *   - 塔身：竖直的「圆柱」，半径随高度变（中上部最胖）、两侧轮廓各自按噪声起伏（花椰菜的鼓包），轴线随高度被高空风吹斜，
 *     顶上一个上冲穹顶（生长期没有砧时是大圆头的浓积云塔）；
 *   - 砧：塔顶附近向下风铺开的扁圆盘（半径是塔身的 2–4.6 倍，按真实比例远大于塔身），中间厚、边缘薄而破碎，
 *     视线穿过它的路程按「盘的水平弦长 × 这段视线落在砧的高度范围里的比例」解析求出；
 *   - 塔底：云底以下是淡淡的雨幡，再往下被地球挡住（地平线以外）或被霾吃掉（空气透视本来就强）；
 *   - 受光：太阳按**塔所在位置**的当地天顶算（400 km 外的当地天顶差 3.6°），keyLight 自带地影与透射变红 →
 *     日落时只有塔顶 / 砧被染成橙粉、下半截已进地影；背光时轮廓有一圈前向散射的亮边；
 *   - 空气透视：400 km 内查空气透视 LUT（与体积云同一张），更远的一段按透射率 LUT 求透射、内散射按「源函数不变」外推。
 * 数量、位置、大小、生消都来自天气场（系统的出生—成熟—消散：生长期先是没有砧的塔，成熟后砧铺开，消散期塔身塌掉、只剩砧）。
 *
 * 合成：远塔总在本帧所有体积云后面（体积云的雷暴只在 280 km 内摆放，远景层只画没被它们占用的系统），
 * 所以在云步进之后、resolve 之前直接叠进云步进的 raw 缓冲：raw.rgb += raw.a · 塔，raw.a *= 塔的透射率
 * （GL 混合 DST_ALPHA / ONE 与 ZERO / SRC_ALPHA，不读 raw、不新增任何程序的 sampler）。之后的时间累积、窗外合成、
 * 山前 / 山后判断（T38 深度）都把它当作 400 km 处的云，不用改。
 * 冷编译：独立小程序、第一次需要时后台编译，不在启动批次、不碰窗外 / 云步进的任何变体（默认程序逐字不变）；
 * 没有远塔时整个 pass 不画，画面逐位不变。只画地平线附近的一条带（CPU 把每座塔的包围盒投影到屏幕，取并集当 scissor）。
 */

/** 远景层最多画几座塔（uniform 数组长度）。按离相机的距离挑最近的；只挑相机朝向 ±FAR_VIEW_DEG 以内的 */
export const FAR_MAX = 32;
/** 远景层的距离范围（km）：外沿按天气场取样半径；内沿以内体积云负责（没被体积雷暴占用、又离得这么近的系统淡出） */
export const FAR_MIN_KM = 170;
export const FAR_MAX_KM = 760;
/** 相机水平朝向两侧多少度以内的塔才进列表（窗户左右各约 25°，转头、聚焦再留余量） */
const FAR_VIEW_DEG = 80;
/** 程序编好、或远景层从无到有时整体淡入的时长（真实秒） */
const FAR_FADE_IN_S = 6;

/** 天气场给的一个单体（WeatherDirector.farTowerCells）：取样时刻的位置 + 漂移，由本模块按模拟时间外推 */
export interface FarStormCell {
  id: string;
  lat: number;
  lon: number;
  /** 取样时刻（模拟毫秒）与漂移（km/h，向东 / 向北）：逐帧按 simTime 外推，位置连续 */
  t0: number;
  ve: number;
  vn: number;
  /** 天气场的塔身半径（km）、砧顶高度（km）、生命周期强度（0..1）与进度（0..1，出生 → 消散） */
  radius: number;
  top: number;
  strength: number;
  age01: number;
}

export const FAR_TOWER_FRAG = /* glsl */ `
${ATMOSPHERE_COMMON}
${VIEW_COMMON}
${LIGHTS_COMMON}
uniform sampler3D uAerialInscatter;
uniform sampler3D uAerialTransmittance;
uniform vec2 uCloudResolution;
uniform float uTime;
uniform int uFarCount;
// 每座塔三个 vec4（相对相机的本地坐标，km）：
//   A = (x, z, 塔身半径, 砧顶高度)
//   B = (砧的下风方向 x, z, 砧半径, 砧厚)
//   C = (塔身强度 0..1, 砧强度 0..1, 形态随机数, 整体淡入淡出)
uniform vec4 uFarA[${FAR_MAX}];
uniform vec4 uFarB[${FAR_MAX}];
uniform vec4 uFarC[${FAR_MAX}];
varying vec2 vUv;

// 厚积雨云的有效反照率（πL/E，受光面）：与体积云受光云顶 p90 ≈ 0.75 的标定同量级（C01）
const float FT_ALBEDO = 0.78;
// 砧（冰晶云）的消光（1/km）：几十公里的水平弦长上光学厚度十几，中部不透明、边缘弦长短处半透明
const float FT_ANVIL_SIGMA = 0.45;
const float FT_BASE = 1.3;   // 云底（km）

float ftHash(vec2 p) {
  p = fract(p * vec2(123.34, 456.21));
  p += dot(p, p + 45.32);
  return fract(p.x * p.y);
}
float ftNoise(vec2 p) {
  vec2 i = floor(p);
  vec2 f = fract(p);
  vec2 u = f * f * (3.0 - 2.0 * f);
  return mix(mix(ftHash(i), ftHash(i + vec2(1.0, 0.0)), u.x), mix(ftHash(i + vec2(0.0, 1.0)), ftHash(i + vec2(1.0, 1.0)), u.x), u.y);
}
// 2D 气泡场（花椰菜的鼓包）：平面按 1 格分块，每格一个随机圆（半径 0.45–0.8 格，圆心可贴近格边），
// 返回 (最高的球冠高度, 该球冠相对采样点的圆心偏移 / 半径)——后两项就是球冠法线在平面内的分量（取负）
vec3 ftBubbles(vec2 p, float seed) {
  vec2 id = floor(p);
  vec2 f = fract(p);
  vec3 best = vec3(0.0);
  for (int x = -1; x <= 1; x++)
  for (int y = -1; y <= 1; y++) {
    vec2 o = vec2(float(x), float(y));
    vec2 c = id + o + seed;
    vec2 d = o + 0.1 + 0.8 * vec2(ftHash(c), ftHash(c + 17.3)) - f;
    float rad = 0.35 + 0.5 * ftHash(c + 5.1);
    float s = rad * rad - dot(d, d);
    if (s > 0.0) {
      float hgt = sqrt(s) / rad;
      if (hgt > best.x) best = vec3(hgt, -d / rad);
    }
  }
  return best;
}
float ftHg(float c, float g) {
  float g2 = g * g;
  return (1.0 - g2) / (4.0 * M_PI * pow(max(1.0 + g2 - 2.0 * g * c, 1e-4), 1.5));
}

// 相机沿 rd 到距离 t 处的空气透视：apL = 内散射（已乘太阳照度，含夜天光的补项，与云步进同一口径），apT = 透射率。
// 400 km 内直接查空气透视 LUT（与体积云同一张）；更远的一段：透射率 = LUT 在 400 km 的值 × 透射率 LUT 的比值
// （两点沿同一方向到大气层顶的透射率之比；远塔在地平线以上，这段视线不会碰到地面），
// 内散射按「沿视线的源函数不变」外推：I(t) = I400 / (1 − T400) · (1 − T(t))
void ftAerial(vec3 ro, vec3 rd, float t, out vec3 apL, out vec3 apT) {
  vec3 uvw = aerialPerspectiveUvw(rd, uSunDir, min(t, AERIAL_MAX_DISTANCE));
  vec3 I = texture(uAerialInscatter, uvw).rgb;
  vec3 T = texture(uAerialTransmittance, uvw).rgb;
  if (t > AERIAL_MAX_DISTANCE) {
    vec3 p1 = ro + rd * AERIAL_MAX_DISTANCE;
    vec3 p2 = ro + rd * t;
    float r1 = length(p1), r2 = length(p2);
    vec3 T12 = transmittanceToTop(r1, dot(p1, rd) / r1) / max(transmittanceToTop(r2, dot(p2, rd) / r2), vec3(1e-6));
    vec3 Tn = T * min(T12, vec3(1.0));
    I = I / max(vec3(1.0) - T, vec3(1e-3)) * (vec3(1.0) - Tn);
    T = Tn;
  }
  apL = I * uSunIlluminance + nightglow(rd) * (0.6 * (1.0 - dot(T, vec3(0.2126, 0.7152, 0.0722))));
  apT = T;
}

void main() {
  gl_FragColor = vec4(0.0, 0.0, 0.0, 1.0);
  vec2 fc = gl_FragCoord.xy * (uResolution / uCloudResolution);
  vec3 rdC = cabinRay(fc);
  if (paneDistance(uHead, rdC) > 0.02) return;
  vec3 rd = uCabinToWorld * rdC;
  vec3 ro = vec3(0.0, uCamR, 0.0);
  float hl = length(rd.xz);
  // 远塔都在地平线附近：视线陡于 ±30° 的像素（scissor 带以外的余量）直接跳过
  if (hl < 0.866) return;
  vec2 rh = rd.xz / hl;              // 视线的水平方向
  vec2 side = vec2(-rh.y, rh.x);     // 水平面里垂直于视线的方向
  float tGround = raySphere(ro, rd, BOTTOM);
  // 一个云像素的角宽（弧度）：远塔轮廓按「距离 × 它」软化，约 1 个像素宽，不锯齿、不爬
  float pixAng = 2.0 * uTanHalfFov / uCloudResolution.y;
  float cosV = dot(rd, uKeyDir);

  vec3 Lacc = vec3(0.0);
  float Tacc = 1.0;
  // 上界是 uniform（不展开）；CPU 已按距离从近到远排好，前面的塔挡后面的
  for (int i = 0; i < uFarCount; i++) {
    vec4 A = uFarA[i];
    vec4 B = uFarB[i];
    vec4 C = uFarC[i];
    vec2 rel = A.xy;
    float R = A.z;
    float top = A.w;
    vec2 dirA = B.xy;
    float Ra = B.z;
    // 快速剔除：视线的水平投影离塔（含砧）太远，或塔在身后
    float sC = dot(rel, rh);
    float ext = max(R * 1.8, Ra * 1.55 + 1.0);
    float latC = dot(rel, side);
    if (sC <= 0.0 || abs(latC) > ext) continue;
    float seed = C.z;

    // ---------- 塔身 ----------
    float aC = 0.0;
    vec3 Lc = vec3(0.0);
    float tC = sC / hl;
    if (C.x > 0.0 && (tGround < 0.0 || tC < tGround)) {
      vec3 P = ro + rd * tC;
      float rP = length(P);
      float h = rP - BOTTOM;
      float fp = tC * pixAng + 0.04;
      // 生长期没有砧：大圆头的浓积云塔；有砧后顶上只剩一个上冲穹顶
      float domeH = mix(R * 0.9, 0.7, C.y);
      float domeR = mix(0.95, 0.4, C.y);
      if (h > 0.0 && h < top + domeH + 0.3) {
        float base = FT_BASE + 0.5 * seed;
        float hn = clamp((h - base) / max(top - base, 1.0), 0.0, 1.0);
        // 上半截被高空风吹斜（与砧同向）
        vec2 axis = rel + dirA * (R * 0.7 * hn * hn);
        float x = -dot(axis, side);           // 像素相对塔轴的横向坐标（km）
        float sgn = x >= 0.0 ? 1.0 : -1.0;
        // 大尺度：两侧轮廓各自缓慢起伏（约 2.5 km 一档），随时间缓慢上涌
        vec2 q = vec2(h * 0.42 - uTime * 0.004 + seed * 7.3, sgn * 3.7 + seed * 11.0);
        float n1 = ftNoise(q);
        // 花椰菜：塔面上两级圆鼓包（约 2.4 km 与 0.9 km，气泡场），随时间一起上涌
        vec2 pb = vec2(x, h - uTime * 0.005);
        vec3 b1 = ftBubbles(pb / 2.4, seed * 13.0);
        vec3 b2 = ftBubbles(pb / 0.9, seed * 29.0 + 3.0);
        // 下窄上宽（越往上越并进砧里），中段一个鼓肚
        float prof = 0.68 + 0.32 * hn + 0.1 * sin(3.1416 * min(hn * 1.3, 1.0));
        float rC = R * prof * (0.86 + 0.3 * n1);
        // 有砧时塔身上段向外张开、并进砧底（砧底在塔上方约 top − 砧厚 − 1 km）
        rC *= 1.0 + 0.45 * C.y * smoothstep(top - B.w - 3.0, top - 1.0, h);
        // 塔顶：靠近砧顶处收窄，上面是穹顶
        rC *= mix(1.0, domeR, smoothstep(top - 1.2, top, h));
        float dome = h > top ? sqrt(max(1.0 - (h - top) * (h - top) / (domeH * domeH), 0.0)) : 1.0;
        rC *= dome;
        // 轮廓上的鼓包：气泡高出一截的地方外凸（圆的花椰菜边）
        float bulge = 1.3 * b1.x + 0.5 * b2.x - 0.55;
        float e = rC - abs(x) + bulge * min(rC, 2.5) * 0.5;
        // 云底参差：底部一公里内渐隐（塔脚淹在霾与碎云里）
        float bottom = smoothstep(base - 0.25, base + 0.9 + 0.6 * b1.x, h);
        aC = smoothstep(-fp, fp, e) * bottom * C.x;
        // 云底以下：雨幡（淡的灰幕，随强度），往下到海面按高度再淡一点
        float rainR = R * 0.7 * (0.75 + 0.5 * ftNoise(vec2(x * 0.7 + seed * 5.0, seed)));
        float rain = smoothstep(-fp, fp, rainR - abs(x + dot(dirA, side) * (base - h) * 0.25))
                   * (1.0 - smoothstep(base - 0.3, base + 0.3, h)) * smoothstep(-0.2, 0.8, h)
                   * (0.55 + 0.45 * ftNoise(vec2(x * 2.2 + seed * 3.0, h * 0.15))) * 0.3 * C.x * C.x;
        float aTot = max(aC, rain);
        if (aTot > 1e-4) {
          vec3 upT = P / rP;
          // 法线：大形按圆柱（横向）、穹顶处朝上；再叠两级鼓包各自的球冠法线（受光的一侧亮、背光的一侧暗，鼓包之间的折痕暗）
          float nx = clamp(x / max(rC, 1e-3), -1.0, 1.0);
          vec2 nh = side * nx - rh * sqrt(1.0 - nx * nx);
          float ny = h > top ? clamp((h - top) / domeH, 0.0, 1.0) : 0.25 * smoothstep(top - 2.0, top, h);
          vec3 n0 = vec3(nh.x, 0.0, nh.y) * sqrt(1.0 - ny * ny) + upT * ny;
          vec3 sideW = vec3(side.x, 0.0, side.y);
          vec3 n = normalize(n0 + 0.9 * (sideW * b1.y + upT * b1.z) + 0.45 * (sideW * b2.y + upT * b2.z));
          float crease = mix(mix(0.85, 0.68, hn), 1.0, smoothstep(0.05, 0.45, b1.x)) * mix(0.88, 1.0, smoothstep(0.05, 0.4, b2.x));
          vec3 Ek = keyLight(rP, upT);
          float mu = dot(upT, uKeyDir);
          // 厚云的背光面仍有大量多次散射（约受光面的三到四成），按包裹光照：背面不低于 0.3
          float diff = mix(0.3, 1.0, clamp(0.5 + 0.5 * dot(n, uKeyDir), 0.0, 1.0)) * crease;
          // 砧底下的塔身在高太阳时被砧挡住一部分；越往下越暗（云底一侧只受天空与海面的漫射）
          float under = smoothstep(top - B.w - 4.0, top - B.w - 1.0, h) * (1.0 - smoothstep(top - 0.8, top, h)) * C.y * smoothstep(0.35, 0.8, mu);
          float vert = mix(0.65, 1.0, smoothstep(base, base + 0.5 * (top - base), h));
          vec3 Esky = skyIrradiance(rP, upT);
          // 环境：天空 + 下方被照亮的云海 / 海面的反光
          Lc = FT_ALBEDO / M_PI * (Ek * (diff * (1.0 - 0.45 * under) + 0.1 * max(mu, 0.0)) * vert + Esky * (0.45 + 0.3 * n.y) * vert);
          // 逆光时轮廓一圈前向散射的亮边（约 0.4 km 的薄边，只在接近正对太阳时）
          Lc += Ek * ftHg(cosV, 0.85) * 0.25 * smoothstep(0.5, 0.95, cosV) * exp(-max(e, 0.0) / 0.4) * vert;
          // 雨幡：灰，只受漫射与少量直射
          vec3 Lr = 0.5 / M_PI * (Esky * 0.6 + Ek * 0.2 * max(mu, 0.0));
          Lc = mix(Lr, Lc, aC / aTot);
          aC = aTot;
        }
      }
    }

    // ---------- 砧 ----------
    float aA = 0.0;
    vec3 La = vec3(0.0);
    float tA = tC;
    if (C.y > 0.0) {
      vec2 Ca = rel + dirA * (0.45 * Ra);
      float xa = -dot(Ca, side);
      float na = ftNoise(vec2(xa * 0.22 + seed * 5.0, seed * 2.0));
      float RaE = Ra * (0.88 + 0.24 * na);
      float half2 = RaE * RaE - xa * xa;
      if (half2 > 0.0) {
        float sA = dot(Ca, rh);
        float hw = sqrt(half2);
        float t0 = max(sA - hw, 0.0) / hl;
        float t1 = (sA + hw) / hl;
        if (tGround > 0.0) t1 = min(t1, tGround);
        if (t1 > t0) {
          tA = 0.5 * (t0 + t1);
          float rho = abs(xa) / RaE;
          float thick = B.w;
          // 楔形：按离塔的横向距离，靠塔处（上风一侧的钝边）厚，往下风越来越薄、砧顶略垂
          float xt = -dot(rel, side);
          float dT = clamp(abs(xt) / (1.5 * Ra), 0.0, 1.0);
          // 砧根：塔身正上方砧底往下垂、和塔身连成一体；砧底参差（乳状云 / 雨幡的起伏）
          float root = exp(-xt * xt / (R * R * 2.2));
          // 砧顶贴着对流层顶：几乎是一条直线（只在塔顶上方被上冲气流顶起一点、远端略垂），起伏只有一两百米
          float aTop = top - 0.3 - 0.35 * dT * dT + 0.15 * (ftNoise(vec2(xa * 0.5, seed * 3.0)) - 0.5) + 0.35 * root;
          float aBot = top - thick * (1.0 - 0.92 * smoothstep(0.0, 1.0, dT)) - 1.0 * root
                     + 0.7 * (ftNoise(vec2(xa * 0.9 + seed * 4.0, seed * 7.0)) - 0.5);
          float a0 = length(ro + rd * t0) - BOTTOM;
          float a1 = length(ro + rd * t1) - BOTTOM;
          float w = tA * pixAng + 0.03;
          float amn = min(a0, a1) - 0.5 * w;
          float amx = max(a0, a1) + 0.5 * w;
          float lo = max(aBot, amn), hi = min(aTop, amx);
          float frac = clamp((hi - lo) / (amx - amn), 0.0, 1.0);
          // 外缘破碎成纤维（边上按高一点的频率打散）
          float fib = mix(1.0, 0.35 + 1.1 * ftNoise(vec2(xa * 1.3 + seed * 9.0, seed)), smoothstep(0.55, 1.0, rho));
          float tau = FT_ANVIL_SIGMA * frac * (t1 - t0) * fib * C.y;
          aA = 1.0 - exp(-tau);
          if (aA > 1e-4) {
            float am = clamp(0.5 * (lo + hi), aBot, aTop);
            float v = clamp((am - aBot) / max(aTop - aBot, 0.1), 0.0, 1.0);
            vec3 PA = ro + rd * tA;
            float rA = length(PA);
            vec3 upA = PA / rA;
            float muA = dot(upA, uKeyDir);
            vec3 Ek = keyLight(BOTTOM + am, upA);
            // 从下往上看到的是砧底（高太阳时在砧自己的影子里，低太阳时被侧光照亮）；看到砧顶 / 侧面时是受光的亮白
            float underLit = mix(0.85, 0.5, smoothstep(0.1, 0.6, muA));
            // 侧面（朝相机的竖直边）整片受光，按太阳在它前后分受光 / 背光；只有视线贴着砧底进去的那一薄层才是暗的砧底——
            // 按高度连续渐变会把整张砧染成上亮下暗的「圆管」
            float face = mix(0.4, 1.0, clamp(0.5 - 0.5 * dot(vec3(rh.x, 0.0, rh.y), uKeyDir), 0.0, 1.0));
            float diffA = mix(underLit, face, smoothstep(0.0, 0.25, v)) * (0.88 + 0.24 * ftNoise(vec2(xa * 0.7 + seed * 2.0, am * 1.6)));
            vec3 Esky = skyIrradiance(BOTTOM + am, upA);
            La = FT_ALBEDO / M_PI * (Ek * diffA + Esky * (0.55 + 0.25 * v));
            // 薄的外缘背光时透亮
            La += Ek * ftHg(cosV, 0.85) * 0.4 * smoothstep(0.5, 0.95, cosV) * (1.0 - aA);
          }
        }
      }
    }

    float aT = 1.0 - (1.0 - aC) * (1.0 - aA);
    if (aT < 1e-4) continue;
    // 预乘；砧是围着塔的一整张盘，近侧挡在塔身前面（塔顶藏进砧里，只有上冲穹顶冒出砧顶）
    vec3 Lt = La * aA + Lc * aC * (1.0 - aA);
    float tAP = (tC * aC + tA * aA) / max(aC + aA, 1e-4);
    vec3 apL, apT;
    ftAerial(ro, rd, tAP, apL, apT);
    aT *= C.w;
    Lacc += Tacc * (Lt * C.w * apT + apL * aT);
    Tacc *= 1.0 - aT;
    if (Tacc < 0.002) break;
  }
  gl_FragColor = vec4(min(Lacc, vec3(60000.0)), Tacc);
}
`;

/** 远景塔层的材质：叠进云步进的 raw（混合见文件头）。shared = 场景 uniforms（视角、日月、LUT、uTime） */
export function createFarTowerMaterial(shared: Record<string, THREE.IUniform>, atmosphere: Atmosphere | null): THREE.ShaderMaterial {
  const vec4s = () => Array.from({ length: FAR_MAX }, () => new THREE.Vector4());
  const mat = new THREE.ShaderMaterial({
    vertexShader: FULLSCREEN_VERT,
    fragmentShader: FAR_TOWER_FRAG,
    uniforms: {
      ...(atmosphere?.sharedUniforms ?? {}),
      ...shared,
      uAerialInscatter: { value: atmosphere?.aerialInscatter.texture ?? null },
      uAerialTransmittance: { value: atmosphere?.aerialTransmittance.texture ?? null },
      uCloudResolution: { value: new THREE.Vector2(1, 1) },
      uFarCount: { value: 0 },
      uFarA: { value: vec4s() },
      uFarB: { value: vec4s() },
      uFarC: { value: vec4s() },
    },
    depthTest: false,
    depthWrite: false,
    toneMapped: false,
    // raw.rgb += raw.a · src.rgb；raw.a *= src.a（src.a 是远塔的透射率）
    blending: THREE.CustomBlending,
    blendEquation: THREE.AddEquation,
    blendSrc: THREE.DstAlphaFactor,
    blendDst: THREE.OneFactor,
    blendEquationAlpha: THREE.AddEquation,
    blendSrcAlpha: THREE.ZeroFactor,
    blendDstAlpha: THREE.SrcAlphaFactor,
  });
  mat.name = "far-towers";
  return mat;
}

type State = "idle" | "compiling" | "ready" | "failed";

/** 字符串 → [0, 1) 的稳定哈希（FNV-1a） */
function hash01(s: string, salt = 0) {
  let h = 2166136261 ^ salt;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  h ^= h >>> 13;
  h = Math.imul(h, 0x5bd1e995);
  h ^= h >>> 15;
  return (h >>> 0) / 4294967296;
}

const smooth = (a: number, b: number, x: number) => {
  const t = Math.min(Math.max((x - a) / (b - a), 0), 1);
  return t * t * (3 - 2 * t);
};

/** 一座远塔这一帧的几何（本地坐标、相对相机，km；调试 / 截图读 `__voyage.farTowers.towers`） */
export interface FarTower {
  id: string;
  x: number;
  z: number;
  dist: number;
  R: number;
  top: number;
  dirX: number;
  dirZ: number;
  Ra: number;
  thick: number;
  col: number;
  anvil: number;
  seed: number;
  fade: number;
}

export class FarTowers {
  readonly mat: THREE.ShaderMaterial;
  /** 总开关（调试 / A-B：`__voyage.farTowers.enabled = false`；URL `?fartowers=0`） */
  enabled = typeof location === "undefined" || new URLSearchParams(location.search).get("fartowers") !== "0";
  state: State = "idle";
  /** 这一帧的塔（按距离从近到远，最多 FAR_MAX 座） */
  towers: FarTower[] = [];
  /** 调试 / 截图：不为 null 时用它代替天气场的单体（本地坐标、相对相机；字段同 FarTower，fade 可省） */
  override: Partial<FarTower>[] | null = null;
  /** 这一帧画了没有、scissor 矩形（raw 像素）——调试与测量用 */
  active = false;
  readonly scissor = new THREE.Vector4();
  /** 整体淡入进度（程序编好 / 从没有塔到有塔时从 0 升到 1，按挂钟） */
  private fadeIn = 0;
  private lastMs = 0;
  private floatBlendOk: boolean | null = null;
  private readonly tmp = new THREE.Vector3();
  private readonly c2wT = new THREE.Matrix3();
  private readonly camT = new THREE.Matrix3();

  constructor(
    private readonly renderer: THREE.WebGLRenderer,
    private readonly pass: FullscreenPass,
    atmosphere: Atmosphere,
    private readonly shared: Record<string, THREE.IUniform>,
  ) {
    this.mat = createFarTowerMaterial(shared, atmosphere);
  }

  /**
   * 每帧（云步进之前）：天气场的单体 → 这一帧的塔列表。cells = null（连续航程关着 / 天气场不驱动）时清空。
   * toLocal：经纬度 → 本地坐标（km）；offset：相机的本地坐标（uCloudOffset）；simTime：模拟毫秒（外推漂移）；
   * camBasis / cabinToWorld：这一帧的相机（按朝向剔除、算 scissor）
   */
  update(cells: FarStormCell[] | null, toLocal: (lat: number, lon: number) => [number, number], offset: THREE.Vector2, simTime: number, camBasis: THREE.Matrix3, cabinToWorld: THREE.Matrix3) {
    this.c2wT.copy(cabinToWorld).transpose();
    this.camT.copy(camBasis).transpose();
    // 相机的水平朝向（窗外坐标）
    const f = this.tmp.set(0, 0, -1).applyMatrix3(camBasis).applyMatrix3(cabinToWorld);
    const fl = Math.hypot(f.x, f.z) || 1;
    const fx = f.x / fl, fz = f.z / fl;
    const cosView = Math.cos((FAR_VIEW_DEG * Math.PI) / 180);
    const out: FarTower[] = [];
    if (this.override) {
      for (const o of this.override) {
        const x = o.x ?? 0, z = o.z ?? 0;
        out.push({ id: o.id ?? "debug", x, z, dist: Math.hypot(x, z), R: o.R ?? 5, top: o.top ?? 14, dirX: o.dirX ?? 0.8, dirZ: o.dirZ ?? 0.6, Ra: o.Ra ?? 22, thick: o.thick ?? 2.4, col: o.col ?? 1, anvil: o.anvil ?? 1, seed: o.seed ?? 0.37, fade: o.fade ?? 1 });
      }
    } else if (cells) {
      for (const c of cells) {
        // 按模拟时间外推漂移（km/h），位置逐帧连续
        const dh = (simTime - c.t0) / 3.6e6;
        const lat = c.lat + (c.vn * dh) / 110.57;
        const lon = c.lon + (c.ve * dh) / (111.32 * Math.cos((lat * Math.PI) / 180));
        const [lx, lz] = toLocal(lat, lon);
        const x = lx - offset.x, z = lz - offset.y;
        const dist = Math.hypot(x, z);
        if (dist < FAR_MIN_KM || dist > FAR_MAX_KM) continue;
        if ((x * fx + z * fz) / dist < cosView) continue;
        out.push(towerFromCell(c, x, z, dist));
      }
    }
    out.sort((a, b) => a.dist - b.dist);
    if (out.length > FAR_MAX) out.length = FAR_MAX;
    this.towers = out;
  }

  /** 编译（首次需要时，后台）；target 绑真正要画进去的 raw（ANGLE 按链接时的帧缓冲生成输出布局） */
  private prepare(target: THREE.WebGLRenderTarget) {
    if (this.state !== "idle") return;
    this.state = "compiling";
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute("position", new THREE.Float32BufferAttribute([-1, -1, 0, 3, -1, 0, -1, 3, 0], 3));
    geometry.setAttribute("uv", new THREE.Float32BufferAttribute([0, 0, 2, 0, 0, 2], 2));
    const scene = new THREE.Scene();
    const mesh = new THREE.Mesh(geometry, this.mat);
    mesh.frustumCulled = false;
    scene.add(mesh);
    const prev = this.renderer.getRenderTarget();
    this.renderer.setRenderTarget(target);
    const job = this.renderer.compileAsync(scene, new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1));
    this.renderer.setRenderTarget(prev);
    job
      .then(() => {
        const program = (this.renderer.properties.get(this.mat) as { currentProgram?: { getUniforms(): unknown; diagnostics?: { runnable: boolean } } }).currentProgram;
        program?.getUniforms();
        this.state = program && program.diagnostics?.runnable !== false ? "ready" : "failed";
      })
      .catch(() => (this.state = "failed"))
      .then(() => {
        if (this.state === "failed") console.warn("[far-towers] 远景对流塔层程序编译失败，不画远塔");
      })
      .finally(() => geometry.dispose());
  }

  /**
   * 云步进之后、resolve 之前调用（clouds.afterMarch）：把远塔叠进 raw。没有塔 / 没编好 / 关着时什么都不画（raw 逐位不变）
   */
  render(raw: THREE.WebGLRenderTarget) {
    this.active = false;
    const now = performance.now();
    const dtS = Math.max(0, now - this.lastMs) / 1000;
    this.lastMs = now;
    if (!this.enabled || !this.towers.length) {
      this.fadeIn = 0;
      return;
    }
    if (this.floatBlendOk === null) {
      // 32 位浮点目标的混合要 EXT_float_blend（桌面 GPU 都有）；没有就不画，不退回别的写法
      this.floatBlendOk = raw.texture.type !== THREE.FloatType || this.renderer.extensions.has("EXT_float_blend");
      if (!this.floatBlendOk) console.warn("[far-towers] 没有 EXT_float_blend，远景对流塔层关闭");
    }
    if (!this.floatBlendOk) return;
    this.prepare(raw);
    if (this.state !== "ready") return;
    this.fadeIn = Math.min(1, this.fadeIn + dtS / FAR_FADE_IN_S);
    const u = this.mat.uniforms;
    const w = raw.width, h = raw.height;
    (u.uCloudResolution.value as THREE.Vector2).set(w, h);
    const A = u.uFarA.value as THREE.Vector4[];
    const B = u.uFarB.value as THREE.Vector4[];
    const C = u.uFarC.value as THREE.Vector4[];
    this.towers.forEach((t, i) => {
      A[i].set(t.x, t.z, t.R, t.top);
      B[i].set(t.dirX, t.dirZ, t.Ra, t.thick);
      C[i].set(t.col, t.anvil, t.seed, t.fade * this.fadeIn);
    });
    u.uFarCount.value = this.towers.length;
    if (!this.computeScissor(w, h)) return;
    raw.scissorTest = true;
    raw.scissor.copy(this.scissor);
    this.pass.render(this.mat, raw);
    raw.scissorTest = false;
    this.active = true;
  }

  /**
   * 每座塔的包围盒（塔心 ± 横向 / 纵深范围 × 海面到穹顶）投影到 raw 像素，取并集（+ 4 像素余量）写进 this.scissor。
   * 投影与 cabinRay 互逆（resolve 里重投影历史用的是同一套）。有角点在相机后面时退回整屏。全部在窗外视野以外时返回 false
   */
  private computeScissor(w: number, h: number): boolean {
    const s = this.shared;
    const tan = s.uTanHalfFov.value as number;
    const res = s.uResolution.value as THREE.Vector2;
    const aspect = res.x / Math.max(res.y, 1);
    const camR = s.uCamR.value as number;
    const BOTTOM = 6360;
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    const v = this.tmp;
    for (const t of this.towers) {
      const ext = Math.max(t.R * 1.8, t.Ra * 1.55 + 1);
      const ux = t.x / t.dist, uz = t.z / t.dist; // 相机 → 塔的水平方向
      for (const along of [-ext, ext])
        for (const across of [-ext, ext])
          for (const alt of [0, t.top + 1.6]) {
            const px = t.x + ux * along - uz * across;
            const pz = t.z + uz * along + ux * across;
            const rr = (BOTTOM + alt) ** 2 - px * px - pz * pz;
            const py = Math.sqrt(Math.max(rr, 0)) - camR;
            v.set(px, py, pz).normalize().applyMatrix3(this.c2wT).applyMatrix3(this.camT);
            if (v.z > -1e-3) {
              this.scissor.set(0, 0, w, h);
              return true;
            }
            const nx = v.x / -v.z / tan / aspect;
            const ny = v.y / -v.z / tan;
            const sx = (nx * 0.5 + 0.5) * w, sy = (ny * 0.5 + 0.5) * h;
            x0 = Math.min(x0, sx);
            x1 = Math.max(x1, sx);
            y0 = Math.min(y0, sy);
            y1 = Math.max(y1, sy);
          }
    }
    const ix0 = Math.max(0, Math.floor(x0) - 4), iy0 = Math.max(0, Math.floor(y0) - 4);
    const ix1 = Math.min(w, Math.ceil(x1) + 4), iy1 = Math.min(h, Math.ceil(y1) + 4);
    if (ix1 <= ix0 || iy1 <= iy0) return false;
    this.scissor.set(ix0, iy0, ix1 - ix0, iy1 - iy0);
    return true;
  }

  /**
   * 调试 / 测量：GPU 计时（EXT_disjoint_timer_query_webgl2）连画 n 次远景层（画进一张同尺寸的临时目标，不碰真正的 raw），
   * 返回每次的毫秒数；没有塔 / 没编好 / 不支持时返回 NaN。`await __voyage.farTowers.bench(40)`
   */
  async bench(n = 40, raw?: THREE.WebGLRenderTarget): Promise<number> {
    const gl = this.renderer.getContext() as WebGL2RenderingContext;
    const ext = gl.getExtension("EXT_disjoint_timer_query_webgl2") as { TIME_ELAPSED_EXT: number; GPU_DISJOINT_EXT: number } | null;
    if (!ext || this.state !== "ready" || !this.towers.length) return NaN;
    const res = this.mat.uniforms.uCloudResolution.value as THREE.Vector2;
    const rt = raw ?? new THREE.WebGLRenderTarget(res.x, res.y, { type: THREE.FloatType, depthBuffer: false });
    const once = () => {
      rt.scissorTest = true;
      rt.scissor.copy(this.scissor);
      this.pass.render(this.mat, rt);
      rt.scissorTest = false;
    };
    once();
    const q = gl.createQuery()!;
    gl.beginQuery(ext.TIME_ELAPSED_EXT, q);
    for (let i = 0; i < n; i++) once();
    gl.endQuery(ext.TIME_ELAPSED_EXT);
    for (let i = 0; i < 200; i++) {
      await new Promise((r) => setTimeout(r, 10));
      if (gl.getQueryParameter(q, gl.QUERY_RESULT_AVAILABLE)) break;
    }
    const ok = gl.getQueryParameter(q, gl.QUERY_RESULT_AVAILABLE) && !gl.getParameter(ext.GPU_DISJOINT_EXT);
    const ns = ok ? (gl.getQueryParameter(q, gl.QUERY_RESULT) as number) : NaN;
    gl.deleteQuery(q);
    if (!raw) rt.dispose();
    return ns / 1e6 / n;
  }
}

/**
 * 天气场的一个单体 → 远塔的形态（按生命周期）：
 *   - 生长期（进度 < 0.5）：塔从浓积云长到对流层顶，进度约 0.12 起砧开始铺开；
 *   - 成熟：砧半径是塔身的 2–4.6 倍（孤立单体的砧几十公里，TOWERING §2.3）、偏向下风；
 *   - 消散期（进度 > 0.6）：塔身塌掉、砧继续摊开变薄，最后只剩一片孤砧（真实积雨云消散时的样子）。
 * 大小与体积雷暴的摆放（weather-director.ts requestStormPlacement）同一套强度缩放，交接时尺寸对得上
 */
function towerFromCell(c: FarStormCell, x: number, z: number, dist: number): FarTower {
  const str = c.strength;
  const age = c.age01;
  // 远处看到的是整团对流（主塔 + 伴生塔，体积雷暴里伴生塔在 0.45R 外），塔身按 1.3 倍主塔半径
  const R = 1.3 * c.radius * (0.75 + 0.25 * str);
  const topFull = c.top - 1.2 * (1 - str);
  // 生长期前段塔还没到顶
  const top = topFull * (0.55 + 0.45 * smooth(0.02, 0.22, age));
  const h1 = hash01(c.id, 1), h2 = hash01(c.id, 2), h3 = hash01(c.id, 3);
  const anvil = smooth(0.1, 0.32, age) * (1 - smooth(0.88, 1.0, age));
  const col = 1 - smooth(0.6, 0.95, age);
  const Ra = R * (2.0 + 2.6 * h1) * (0.45 + 0.55 * smooth(0.1, 0.55, age)) * (1 + 0.45 * smooth(0.5, 1.0, age));
  // 砧朝下风（系统的引导气流方向，本地 x 东、z 南），每个单体再偏 ±25°
  const vl = Math.hypot(c.ve, c.vn);
  let ang = vl > 1 ? Math.atan2(-c.vn, c.ve) : h2 * Math.PI * 2;
  ang += (h3 - 0.5) * 0.87;
  const fade = smooth(0.25, 0.4, str) * smooth(FAR_MAX_KM, FAR_MAX_KM - 60, dist) * smooth(FAR_MIN_KM, FAR_MIN_KM + 40, dist);
  return { id: c.id, x, z, dist, R, top, dirX: Math.cos(ang), dirZ: Math.sin(ang), Ra, thick: 2.0 + 1.6 * h2, col, anvil, seed: h1 * 0.999, fade };
}
