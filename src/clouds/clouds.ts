import * as THREE from "three";
import { AERIAL_MAX_DISTANCE_KM, ATMOSPHERE_COMMON, FULLSCREEN_VERT } from "../atmosphere/common.glsl";
import type { Atmosphere } from "../atmosphere/luts";
import { EXPOSURE_WHITEOUT } from "../render/exposure";
import type { FullscreenPass } from "../render/pass";
import { LIGHTS_COMMON } from "../render/lights.glsl";
import { VIEW_COMMON } from "../render/view.glsl";
import { createWonderCloudUniforms, wonderCloudGlsl, wonderMarchGlsl } from "../wonders/wonder-cloud.glsl";
import { CLOUD_COMMON, CLOUD_SHADOW_EXT, CLOUD_SHADOW_RES, OCC_LAYERS, OCC_N, OCC_SPACING } from "./clouds.glsl";
import type { CloudNoise } from "./noise";

/**
 * 体积云：光线步进 + 时间累积（默认全分辨率，面板「画质」可降到 0.75 / 0.5）。
 * 输出纹理 RGB = 已经加上空气透视的云辐亮度（预乘），A = 云的透射率（背景还剩多少）。
 *
 * 步进程序只有一个颜色输出，云的深度写进 gl_FragDepth（深度纹理，按 AERIAL_MAX_DISTANCE 归一化）（PERF-1）。
 * 以前是 MRT（颜色 + 深度两个颜色输出）：ANGLE/D3D11 链接时只按第一个输出生成像素着色器，
 * 并行编译完成后第一次 draw 到双附件帧缓冲时，还要在 GPU 线程上同步把整个步进像素着色器重编一遍（冷启动冻结约 4.7 s）。
 */

const MARCH_FRAG = /* glsl */ `
${ATMOSPHERE_COMMON}
${VIEW_COMMON}
#ifdef CLOUD_WEATHER
#define CLOUD_OCC 1
#endif
${CLOUD_COMMON}
${LIGHTS_COMMON}
#ifdef WONDER_LAYER
${wonderMarchGlsl()}
uniform sampler2D uWonderSurf;   // 奇观 pass 的结果（WONDER_SURF_FRAG）：rgb 预乘辐亮度，a = floor(tW·8) + 不透明度·0.998
#endif
uniform sampler3D uAerialInscatter;
uniform sampler3D uAerialTransmittance;
uniform float uFrame;
uniform vec2 uCloudResolution;
uniform float uWeatherCull;   // 1：够不着雷暴 / 台风的视线走普通云的快路径（T33）；0：对照
uniform float uCloudImmersion; // 飞机在云里的程度（0–1，平滑过的；和曝光的 uWhiteout 是同一个 uniform 对象，C01 返工）
varying vec2 vUv;

// 交错梯度噪声：每个像素的步进起点错开，时间累积后抹平成平滑结果
float ign(vec2 p) { return fract(52.9829189 * fract(dot(p, vec2(0.06711056, 0.00583715)))); }

// 软边的云（雷暴的砧和雨幡、台风的卷云盖和砧）的省步数（PERF-2）：不做表面细化，稀薄处（一步的光学厚度 < SOFT_THIN_OD）走 2 倍步长。
// 这两处在台风外围 / 雨带里占云步进的约三成：往上看时整片卷云盖都是稀薄的有云采样点，每个都要走 8 步受光步进。
// 对照开关：SOFT_SKIP 设 false 回到改动前的走法
const bool SOFT_SKIP = true;
const float SOFT_THIN_OD = 0.5;

#ifdef CLOUD_TYPHOON
// 眼里逆光看眼壁时额外压掉的空气透视内散射比例（美术取向，见 main 里的说明）
const float HUR_BACKLIT_AP_CUT = 0.5;

// 投影用的台风大形（只在云步进里用）：眼壁（含台阶平台、各扇区顶高、外卷）和卷云盖。
// 比 hurricaneShadowDensity 多了台阶与顶高起伏；眼壁内缘整体往外让 1.5 km，凹进去的表面点不会被自己的大形误判成在影子里
float hurricaneCasterDensity(vec2 xz, float alt) {
  if (alt > HUR_TOP + 1.8 || alt < 0.3) return 0.0;
  vec2 d2 = xz - uHurricane.xy;
  float r = length(d2);
  float Re = uHurricane.z;
  if (r > Re * 9.0) return 0.0;
  // 方位角的正余弦直接由方向向量得到，倍角公式展开 sin(nθ + φ)：这个函数每像素要求值几十次，省掉 atan 和一串 sin（帧时间）
  vec2 cs = d2 / max(r, 1e-3);                  // (cos θ, sin θ)
  vec2 cs2 = vec2(cs.x * cs.x - cs.y * cs.y, 2.0 * cs.x * cs.y);
  vec2 cs3 = vec2(cs2.x * cs.x - cs2.y * cs.y, cs2.x * cs.y + cs2.y * cs.x);
  vec2 cs4 = vec2(cs2.x * cs2.x - cs2.y * cs2.y, 2.0 * cs2.x * cs2.y);
  // sin(nθ + φ) = sin nθ cos φ + cos nθ sin φ
  #define HSIN(c, ph) ((c).y * cos(ph) + (c).x * sin(ph))
  float slopeK = 0.95 + 0.35 * HSIN(cs, 1.3) + 0.12 * HSIN(cs4, 0.5);
  float l1 = 4.5 + 1.3 * HSIN(cs2, 0.4);
  float l2 = 8.5 + 1.6 * HSIN(cs3, 1.9);
  float fl = smoothstep(HUR_FLARE_START, HUR_TOP, alt);
  float rIn = Re * (1.0 + 0.10 * HSIN(cs2, 0.6)) + slopeK * (0.55 * alt + 0.045 * alt * alt)
            + 1.6 * smoothstep(l1 - 0.35, l1 + 0.35, alt) * smoothstep(-0.3, 0.5, HSIN(cs3, 0.8))
            + 2.0 * smoothstep(l2 - 0.4, l2 + 0.4, alt) * smoothstep(-0.4, 0.4, HSIN(cs2, 2.6))
            + HUR_FLARE * fl * fl + 1.5;
  float top = HUR_TOP - 0.5 + 1.2 * HSIN(cs, 0.4) + 0.45 * HSIN(cs3, 1.7) + 0.5;   // = hurricaneRimTop(θ) + 0.5
  #undef HSIN
  float wall = smoothstep(rIn, rIn + 2.0, r) * (1.0 - smoothstep(top - 0.6, top, alt));
  // 卷云盖的遮挡按完整版的变薄走（T44）：眼壁附近（3.5 倍眼半径以内）是厚的中心密蔽云区，往外很快变成光学厚度几的冰云，
  // 挡不住多少光（总透射约 0.8）。旧版一直到 9 倍眼半径都按实心算、到那里再一刀切掉：台风外围（typhoon-outer / bands）
  // 视线上的空气全被当成在影子里，空气透视的蓝色内散射被砍到 12%，只剩透射率的偏黄——远处的雨带云被染成沙土色
  float canopy = smoothstep(Re * 2.5, Re * 3.0, r) * smoothstep(12.0, 12.8, alt) * (1.0 - smoothstep(HUR_TOP - 1.0, HUR_TOP, alt))
               * mix(1.0, 0.06, smoothstep(Re * 3.5, Re * 7.0, r));
  return max(wall, canopy);
}

// 台风里某点沿 dir 方向的阳光可见度（0..1）：用解析大形估计光学厚度（便宜，不采样纹理）。
// start：从离开该点多远处开始算（km）。云里的点只算远处的遮挡（对面的眼壁），近处 15 km 由受光步进负责，
// 而且解析大形没有隆起，凹进去的表面点会被误判在大形里面
float hurricaneSunVis(vec3 p, vec3 dir, float start) {
  float alt = length(p) - BOTTOM;
  float len = clamp((HUR_TOP + 1.8 - alt) / max(dir.y, 0.05), 0.0, 70.0) - start;
  if (len <= 0.0 || dir.y < 0.0) return 1.0;
  float dt = len / 5.0;
  float od = 0.0;
  // 上界依赖 uniform，FXC 不展开
  for (int i = 0; i < 5 + min(uStormCount, 0); i++) {
    vec3 q = p + dir * (start + (float(i) + 0.5) * dt);
    od += hurricaneCasterDensity(q.xz + uCloudOffset, length(q) - BOTTOM);
  }
  // 光学厚度按「穿过遮挡物的公里数」算、系数取得很小：解析大形和真实表面差几公里，影子边缘要留出几公里的半影，
  // 否则影子是一刀切的，落在眼壁上像一个个破洞
  return exp(-od * dt * 0.6);
}

// 带体积阴影的空气透视内散射（未乘太阳照度）。full：不考虑阴影时整段的值（LUT 直接查出来的）
vec3 hurricaneShadowedInscatter(vec3 ro, vec3 rd, float depth, vec3 full) {
  vec3 acc = vec3(0.0);
  vec3 prev = vec3(0.0);
  const float N = 6.0;
  for (int k = 1; k < 7 + min(uStormCount, 0); k++) {
    float fk = float(k);
    vec3 Lk = fk >= N ? full : textureLod(uAerialInscatter, aerialPerspectiveUvw(rd, uSunDir, depth * fk / N), 0.0).rgb;
    vec3 pk = ro + rd * (depth * (fk - 0.5) / N);
    float vis = hurricaneSunVis(pk, uSunDir, 0.0);
    // 影子里的空气仍被天空光照着（多次散射）；眼里低处四周是眼壁，看得到的天空只有头顶一块，取约 12%。
    // 眼外（T44）：卷云盖下面四周是开阔的天和被照亮的雨带、海面，影子里的空气仍有约一半的内散射。
    // 旧版处处 12%：远处的雨带云只剩透射率的偏黄、没了蓝色的空气透视，被染成沙土色
    float eyeK = smoothstep(uHurricane.z * 2.5, uHurricane.z * 4.0, length(pk.xz + uCloudOffset - uHurricane.xy));
    acc += max(Lk - prev, vec3(0.0)) * mix(mix(0.12, 0.5, eyeK), 1.0, vis);
    prev = Lk;
  }
  return acc;
}
#endif

#ifdef CLOUD_WEATHER
// 视线段 [t0, t1] 的水平投影离世界坐标 c（km）最近多远。视线从相机出发（ro.xz = 0），水平投影 = rd.xz · t，是一条直线
float cloudRayDist2D(vec3 rd, vec2 seg, vec2 c) {
  vec2 rel = c - uCloudOffset;
  float t = clamp(dot(rel, rd.xz) / max(dot(rd.xz, rd.xz), 1e-8), seg.x, seg.y);
  return length(rd.xz * t - rel);
}

// T33：这条视线够得着雷暴 / 台风吗（x：任一雷暴或台风，y：台风）。
// 包围半径和密度函数里的提前退出一致（雷暴 √56 ≈ 7.5 倍塔身半径，台风 18 倍眼半径），再加受光步进够得着的 15 km。
// 以前只要场上有雷暴 / 台风，所有像素都走「天气模式」（256 步、8 步不展开的受光步进、逐点查天气），
// 雷暴在几百公里外、甚至在身后也要多 1–1.2 ms/帧（T19b 报告），与距离无关
const float WEATHER_LIGHT_REACH = 15.0;
// 天气变体（PERF-10）只认自己带的那种天气：雷暴变体里的台风、台风变体里的雷暴当作不存在（编好对应变体之前的过渡，见 clouds.ts）
// （函数体里分 #ifdef，不写两份同名函数：check:glsl 的重名检查不展开条件编译）
bool cloudStormsOn() {
#ifdef CLOUD_STORM
  return uStormCount > 0;
#else
  return false;
#endif
}
bool cloudHurOn() {
#ifdef CLOUD_TYPHOON
  return uHurricane.w > 0.5;
#else
  return false;
#endif
}
bvec2 cloudRayNearWeather(vec3 rd, vec2 seg) {
  bool nearAny = false;
#ifdef CLOUD_STORM
  for (int i = 0; i < uStormCount; i++) {
    vec4 c = uStorms[i];
    if (cloudRayDist2D(rd, seg, c.xy) < c.z * 7.5 + WEATHER_LIGHT_REACH) nearAny = true;
  }
#endif
  bool nearHur = cloudHurOn() && cloudRayDist2D(rd, seg, uHurricane.xy) < uHurricane.z * 18.0 + WEATHER_LIGHT_REACH;
  return bvec2(nearAny || nearHur, nearHur);
}
// 同样的判断，对一个点（世界坐标 xz）：受光步进按采样点选路径。只按视线选的话，视线够得着的那片像素里
// 离雷暴很远的普通云也走雷暴的受光步进（8 步、15 km），和旁边够不着的像素差一点，包围圆柱的轮廓会在普通云上露出一条缝
bool cloudPointNearWeather(vec2 xz) {
  bool nearAny = cloudHurOn() && length(xz - uHurricane.xy) < uHurricane.z * 18.0 + WEATHER_LIGHT_REACH;
#ifdef CLOUD_STORM
  for (int i = 0; i < uStormCount; i++) {
    vec4 c = uStorms[i];
    if (length(xz - c.xy) < c.z * 7.5 + WEATHER_LIGHT_REACH) nearAny = true;
  }
#endif
  return nearAny;
}
#endif

float hg(float c, float g) {
  float g2 = g * g;
  return (1.0 - g2) / (4.0 * M_PI * pow(max(1.0 + g2 - 2.0 * g * c, 1e-4), 1.5));
}

// 多次散射近似的能量标定（C01）：少阶的八度近似把高阶散射的能量截掉了，受光厚云的有效反照率 πL / E（水平面照度）
// 只有约 0.2（noon-cumulus 读回，c01-albedo），真实厚云是 0.7–0.8。单次散射是精确的，缺的是多次散射那一份，
// 所以只给高阶乘一个与光学厚度无关的常数，标定到受光云顶的 p90 ≈ 0.75（见 handoff/C01-02.md）。
// 注意这是一个**不守恒的经验增益**：乘完以后高阶的绝对权重是 3.0 / 1.5，已不满足 a ≤ b；光学上很薄的地方（薄幕、卷云、碎云边，
// od → 0）多次散射的源项是单次散射的 3–4.5 倍（粉末 0.7–1），物理上那里几乎只有单次散射（已知问题，cirrus-noon 实测只亮 +4/255）
const float CLOUD_MS_ALBEDO = 6.0;
// 扩散尾巴的强度（C01 返工，见受光段）：x = 从外面看的积云（取小值，保住受光 / 背光的对比），y = 飞机在云里（按 uCloudImmersion 过渡；
// 取 2：云里窗外的 2×2 棋盘纹在 1 时仍略高于 master），z = 雷暴 / 台风的塔身（只在天气宏里用）
const vec3 CLOUD_MS_TAIL = vec3(0.2, 2.0, 1.0);

void main() {
  // 深度写进深度附件（单输出，见文件头）。写了 gl_FragDepth 的程序每条路径都要写，否则深度未定义
  gl_FragDepth = 1.0;
  gl_FragColor = vec4(0.0, 0.0, 0.0, 1.0);
  vec2 fc = gl_FragCoord.xy * (uResolution / uCloudResolution);
  vec3 rdC = cabinRay(fc);
  // 只算能穿出窗外的像素（留一点余量，避免上采样时窗边出现一圈空白）
  bool anyWeather = uCoverage > 0.0 || uStormCount > 0 || uHurricane.w > 0.5;
#ifdef WONDER_LAYER
  // 云间层奇观（W00）：这个变体只在有云间层奇观在场时画
  bool wonderOn = uWonderVol > 0.5;
  if ((!anyWeather && !wonderOn) || paneDistance(uHead, rdC) > 0.02) return;
#else
  if (!anyWeather || paneDistance(uHead, rdC) > 0.02) return;
#endif
  vec3 rd = uCabinToWorld * rdC;
  vec3 ro = vec3(0.0, uCamR, 0.0);
#ifdef WONDER_LAYER
  // 奇观层（表面 + 介质，奇观 pass 已经合成好的一层）：同分辨率、同一像素的一个 texel
  vec4 sw = texelFetch(uWonderSurf, ivec2(gl_FragCoord.xy), 0);
  bool hasW = wonderOn && sw.a > 0.0;
  vec4 surfW = vec4(0.0);
  float tW = 1e9;
  if (hasW) {
    surfW = vec4(sw.rgb, min(fract(sw.a) / 0.998, 1.0));
    tW = floor(sw.a) / 8.0;
  }
  const vec2 NO_SEG = vec2(1e9, -1e9);
  vec2 seg = cloudShellInterval(ro, rd);
  seg.y = min(seg.y, AERIAL_MAX_DISTANCE);
  // 没有云要走的视线，只要有奇观层也要输出（循环不走，最后插进去）
  bool cloudsHere = anyWeather && seg.y > seg.x;
  if (!cloudsHere) {
    if (!hasW) return;
    seg = NO_SEG;
  }
#ifdef CLOUD_WEATHER
  bvec2 nearW = !cloudsHere ? bvec2(false) : uWeatherCull > 0.5 ? cloudRayNearWeather(rd, seg) : bvec2(cloudStormsOn() || cloudHurOn(), cloudHurOn());
#else
  const bvec2 nearW = bvec2(false);
#endif
#else
  vec2 seg = cloudShellInterval(ro, rd);
  seg.y = min(seg.y, AERIAL_MAX_DISTANCE);
  if (seg.y <= seg.x) return;
#ifdef CLOUD_WEATHER
  // 这条视线够不着雷暴 / 台风：整条按普通云走（T33）。uWeatherCull = 0 时关掉（对照用）
  bvec2 nearW = uWeatherCull > 0.5 ? cloudRayNearWeather(rd, seg) : bvec2(cloudStormsOn() || cloudHurOn(), cloudHurOn());
#else
  // 默认程序（PERF-10）：没有雷暴 / 台风代码，所有视线都按普通云走
  const bvec2 nearW = bvec2(false);
#endif
#endif
#ifdef CLOUD_WEATHER
  gWeatherOn = nearW.x;
#endif
#ifdef CLOUD_TYPHOON
  bool nearHur = nearW.y;
#endif
  // 够不着时只走层状云自己的高度范围：有雷暴 / 台风时外壳被撑到 0–15 km（台风 0.5–20.5 km），巡航高度就在壳里，
  // 近水平的视线要空走几百公里（这是远处雷暴开销的大头）
#ifdef WONDER_LAYER
  if (!nearW.x && cloudsHere) {
    seg = uCoverage <= 0.0 ? NO_SEG : cloudShellIntervalH(ro, rd, uCloudBottom, uCloudTop);
    seg.y = min(seg.y, AERIAL_MAX_DISTANCE);
    if (seg.y <= seg.x) {
      if (!hasW) return;
      seg = NO_SEG;
    }
  }
  // 奇观层完全不透明：身后的云不用走
  if (surfW.a > 0.999) seg.y = min(seg.y, tW);
  bool wPending = hasW;
  // 奇观投影：这条视线上落在影子柱里的区间（循环里只做区间判断）
  vec3 shQ = vec3(0.0);
  vec2 shSeg = wonderCasterSegment(rd, shQ);
#else
  if (!nearW.x) {
    if (uCoverage <= 0.0) return;
    seg = cloudShellIntervalH(ro, rd, uCloudBottom, uCloudTop);
    seg.y = min(seg.y, AERIAL_MAX_DISTANCE);
    if (seg.y <= seg.x) return;
  }
#endif

  // 直射主光源：白天是太阳，夜里是月亮（月光照亮云海）
  float cosT = dot(rd, uKeyDir);
  // 相函数只和 cosT 有关，整条视线不变：在循环外算好（C09；原来每个有云的采样点要算 7 次 pow）
  // 前向峰按「路上被峰再散射了几次」展宽（C09，见受光段）：HG(0.9^(k+1))，k = 0, 1, 2 与 k ≥ 3 的余量
  vec4 phPeak = vec4(hg(cosT, 0.9), hg(cosT, 0.81), hg(cosT, 0.729), hg(cosT, 0.6561));
  float phBody = mix(hg(cosT, -0.25), hg(cosT, 0.8), 0.7);
  // 多次散射近似第 1、2 阶的相函数（g 按 c^k 变平：c = 0.5、0.25）
  float phMs1 = mix(hg(cosT, -0.125), hg(cosT, 0.4), 0.7);
  float phMs2 = mix(hg(cosT, -0.0625), hg(cosT, 0.2), 0.7);
  float jitter = fract(ign(gl_FragCoord.xy) + uFrame * 0.61803);
  vec3 L = vec3(0.0);
  float T = 1.0;
  float depthSum = 0.0;
  float wSum = 0.0;
  float t = seg.x;
  // 有雷暴时：从空白进入云的那一步改用 1/4 的小步重新走一遍，采样点才能落在云的表面附近。
  // 否则远处步长几百米、云的消光又高（60 /km），第一个采样点可能已经在云里几百米深处，
  // 被阳光照亮的那层表面被跳过，受光面发灰、菜花状的隆起也看不出来
  // 台风的眼壁同理（远处的眼壁表面同样会被大步长跳过）
  bool wasEmpty = true;
#ifdef CLOUD_WEATHER
  bool refineOn = nearW.x;
  int fine = 0;
  float fineDt = 0.03;
  bool wasThin = false;       // 上一个采样点是稀薄的软边冰晶云（下一步走 2 倍步长，见 SOFT_SKIP）
  float lastEmpty = seg.x;   // 最近一个空白采样点的位置：表面一定在它和第一个有云的采样点之间
  // 闪电放电通道（线段）：两端换到相机坐标
  vec3 fA = vec3(uFlash.x - uCloudOffset.x, BOTTOM + uFlash.y, uFlash.z - uCloudOffset.y);
  vec3 fAB = vec3(uFlashB.x - uCloudOffset.x, BOTTOM + uFlashB.y, uFlashB.z - uCloudOffset.y) - fA;
  float flashI = uFlash.w / (1.0 + 0.25 * length(fAB)); // 总能量摊到整条通道上
#endif
#ifdef CLOUD_TYPHOON
  float hurVis = 1.0;         // 台风长影的缓存（见下）
  float hurVisT = -1e9;
#endif
#ifdef CLOUD_WEATHER
  // 下方（海面 / 低云）反射上来的光的反照率：有低云时明显更亮
  // 台风眼里脚下是眼底的云，不是海面（晴天取 0.35），再按眼底受光的比例打折（见下）
  float albedoBelow = 0.06 + 0.5 * uCoverage;
#endif
#ifdef CLOUD_TYPHOON
  if (nearHur) {
    // 反射光来自眼底和对面的眼壁，随受光几何变：太阳低的时候眼底大半在向阳一侧眼壁的影子里（「井底」），
    // 反射光跟着变弱，背光的眼壁不再被统一提亮到天空的亮度（T26）。取眼底中心和沿太阳方位前后各一点的平均
    vec2 hc = uHurricane.xy - uCloudOffset;
    vec2 sh = normalize(uKeyDir.xz + vec2(1e-5)) * uHurricane.z * 0.6;
    float fv = 0.0;
    for (int k = -1; k < 2 + min(uStormCount, 0); k++) {
      vec2 f = hc + sh * float(k);
      fv += hurricaneSunVis(vec3(f.x, BOTTOM + 1.6, f.y), uKeyDir, 0.0);
    }
    albedoBelow = 0.35 * mix(0.25, 1.0, fv / 3.0);
  }
#endif
  // 次数上限：从相机空步走到 60 km 外本身就要约 190 步，细化还要额外的步数（每进一次云 9 步）。
  // 雷暴 / 台风时 448（原来 256）：台风外围在卷云盖下面近水平地看出去，稀薄的卷云盖采样点不走 2 倍步长、
  // 一路上的塔还要细化，走到约 100 km 就用完 256 步；在哪一步用完随每像素的抖动变，远处的塔成了一格一格的
  // 「纱窗点阵」半透明幽灵，步数用完处的边还连成直边的「透明方盒」（美术总监 wave5 第 2 处；和占据网格无关，
  // 关掉网格照旧）。只有用完预算的那些像素会多走，typhoon-outer 云步进 +0.2 ms（约 5%）
  for (int i = 0; i < 448; i++) {
    // 没有雷暴时仍是原来的 192 步（多出的步数只给雷暴的表面细化用，普通云不必多走）
#ifdef CLOUD_WEATHER
    if (t >= seg.y || T < 0.005 || (!refineOn && i >= 192)) break;
#else
    if (t >= seg.y || T < 0.005 || i >= 192) break;
#endif
    // 步长随距离变长：近处 60 m，远处 2 km
    float dtBase = clamp(t * 0.008, 0.06, 2.0);
    // 这一步代表的区间长度：空白处走 2 倍步长。抖动必须覆盖整个区间——旧版只抖动 dt、却走 2dt，
    // 每个区间的后一半永远采不到，远处的薄云被「同心球壳」切成一条条水平细纹（T13）
#ifdef CLOUD_WEATHER
    float dt = fine > 0 ? fineDt : dtBase;
    float stepLen = (fine > 0 || (!wasEmpty && !wasThin)) ? dt : 2.0 * dt;
#else
    float dt = dtBase;
    float stepLen = wasEmpty ? 2.0 * dt : dt;
#endif
    vec3 p = ro + rd * (t + stepLen * jitter);
    float lod = clamp(log2(dtBase / 0.055), 0.0, 5.0);
    // 细节噪声随机平铺给受光步进挑格点用（T32），每步、每帧都换。
    // 不能再由 jitter 派生（C03）：旧版 fract(jitter + i·φ) 和采样点在区间里的位置（t + stepLen·jitter）是同一个随机数，
    // 时间累积收敛到的是 E_j[受光(深度(j), 格点(j + i·φ))]，随「在第几步进云」这个整数 i 跳变；掠射看远处云带时 i 逐行变，
    // 受光面上就是一条条水平横纹（backlit-cu 的「梳齿」、clouds-variety 远处云带）。步长减到 1/4 横纹才消失、光照拉平或
    // 受光 od 置 0 横纹消失、mip / 步数上限无关，都指向这里。零开销（handoff/C03.md）。两样都要换：
    //  - 空间项用一张与 jitter 无关的 IGN（转置 + 平移）。不能用整数倍的 ign：fract(13·ign) 仍是 jitter 的函数，只换了图样，
    //    还把 IGN 的蓝噪声邻域性质放大没了，实时单帧里是一层菱形交叉细纹（审查返工）；
    //  - 每帧增量取 √2−1：与 jitter 的 0.618 在低阶联合谐波上漂移快（R2 的 0.7549 与 0.618 有 4·a + 6·b ≈ 7 的近有理关系，
    //    64 帧只走 0.09 圈），单独当一维序列时分层也与 φ 相当（0.7549 在 TAA 的约 8 帧窗口里只落在约 4 个值上，闪烁偏低频）
    gDetailRnd = fract(ign(gl_FragCoord.yx + vec2(19.0, 47.0)) + uFrame * 0.41421356 + float(i) * 0.6180339);
    float dens = cloudDensity(p, lod, t < 150.0);
#ifdef CLOUD_WEATHER
    float stormW = gStormW;
    float stormAO = gStormAO;
    bool soft = SOFT_SKIP && gStormSoft > 0.5;
    // 只在进入雷暴 / 台风时细化（层状云不必，保持原样）；这段会被小步重新采样，进云那一步的密度并没有丢
    if (dens > 0.002 && stormW > 0.5 && !soft && wasEmpty && fine == 0 && dtBase > 0.1 && t > seg.x) {
      // 表面夹在「上一个空白采样点」和「这个有云的采样点」之间：退回到上一个空白采样点，8 小步走完这段。
      // 旧版一：固定退回一个区间 [t − 2dt, t]，那里是空的，8 小步白走后又回到空白状态，下一步再次撞上同一处表面、
      //   再退回……反复直到用完步数上限，远处的云出现一圈圈等高线似的条纹。
      // 旧版二：不退回、从 t 开始细化——带抖动的粗采样可能落在表面之前而漏检，下一个区间才检出时 t 已经在云里，
      //   进云深度随「表面落在步进网格的哪个位置」周期变化，台风眼壁上一道道平行的明暗条纹（T04）
      float tHit = t + stepLen * jitter;
      t = max(lastEmpty, seg.x);
      fineDt = max((tHit - t) * 0.125, 0.02);
      fine = 8;
      wasEmpty = false;
      continue;
    }
    if (fine > 0) fine--;
#endif
#ifdef WONDER_LAYER
    // 奇观层在这一步的采样点之前：先插进去（它前面的云已经累积过，这一步和之后的云在它后面）
    if (wPending && t + stepLen * jitter >= tW) {
      L += T * surfW.rgb;
      depthSum += T * surfW.a * tW;
      wSum += T * surfW.a;
      T *= 1.0 - surfW.a;
      wPending = false;
      if (T < 0.005) break;
    }
#endif
    if (dens > 0.002) {
      wasEmpty = false;
#ifdef CLOUD_WEATHER
      wasThin = soft && dens * CLOUD_EXTINCTION * dt < SOFT_THIN_OD;
#endif
      float sigma = dens * CLOUD_EXTINCTION;
      float r = length(p);
      vec3 up = p / r;
      // 朝太阳方向做短距步进，估计阳光在云里走过的光学厚度。
      // 有雷暴、台风时走得更远（约 15 km），否则几公里厚的积雨云底部照样被照亮
      float od = 0.0;
      float lt = 0.0;
      // 受光步进的细节噪声只沿用上面那一点随机挑中的一个随机平铺格点（见 clouds.glsl.ts 的 gDetailLight，T32）
      gDetailLight = true;
#ifdef CLOUD_WEATHER
      float ls = 0.06;
      int lightSteps = nearW.x && cloudPointNearWeather(p.xz + uCloudOffset) ? 8 : 6;
      if (gStormSoft > 1.5) {
        // 台风卷云盖（T44）：外围变薄以后视线要在它里面走很长一段，每个采样点都走 8 步受光步进太贵（typhoon-bands 云步进 +2 ms）。
        // 它上面只有天，朝太阳的光学厚度 ≈ 本点消光 × 到卷云盖顶（约 15 km）的斜程的一半（密度往上变淡）
        od = dens * 0.5 * clamp(15.0 - (r - BOTTOM), 0.2, 3.0) / max(uKeyDir.y, 0.1);
      } else if (lightSteps == 6)
#endif
      {
        // 普通云（没有雷暴、台风）：只有层状云，常量上界，编译器展开后最快（和改动前一致）。
        // 这里只能调用层状云密度：展开的每一份都带上雷暴密度的话，冷编译会从 55 s 涨到 90 s
        // 步长 30 m 起、每步 ×2.2（6 步共 2.81 km；原来 60 m ×1.9、3.07 km）（C09）：第一个受光样本从 30 m 挪到 15 m，
        // 离本点更近、和本点的密度更相关（云外实时时间波动 −7~−13%；云里 8 姿态均值持平，但个别姿态 ×0.4~×2 的起伏
        // 全来自这一步，见 handoff/C09-review.md）；单独用时银边略弱（薄处 od 变小，芯也跟着亮）。
        // 雷暴 / 台风的受光步进（下面 else）不变
        float lsL = 0.03;
        for (int j = 0; j < 6; j++) {
          lt += lsL;
          od += layerDensity(p + uKeyDir * (lt - 0.5 * lsL), lod + 0.5, j < 3) * lsL;
          lsL *= 2.2;
        }
      }
#ifdef CLOUD_WEATHER
      else {
        // 雷暴 / 台风：上界依赖 uniform，FXC 不展开（展开成 8 份雷暴密度时冷编译很慢）
        for (int j = 0; j < lightSteps; j++) {
          lt += ls;
          // 一步代表的长度交给雨带塔的精简密度（gLightLen，见 HUR_BANDS_LIGHT）：后几步一步就是几公里，
          // 只按中点「在不在塔里」取 0 / 1 的话，塔身背光面在某个高度上亮度一跳（T38）
          gLightLen = ls;
          od += cloudDensityLite(p + uKeyDir * (lt - 0.5 * ls), lod + 0.5, j < 3, true) * ls;
          ls *= 2.0;
        }
      }
      gLightLen = 0.0;
#endif
      gDetailLight = false;
      od *= CLOUD_EXTINCTION;
      // 银边（T12）：水滴的散射里约一半是几度以内的衍射峰（g ≈ 0.9），顺着光走的光几乎不偏折，按 delta 缩放
      // （Joseph 1976）它只受约 1/4 的消光——所以朝太阳看时，云的薄边、顶上被照透的一层比「单次散射 × 全消光」亮得多。
      // 只在前向起作用（hg(0.9) 离开太阳 30° 就只剩百分之几），顺光 / 侧光的云几乎不变
      // 逆光银边（C09）：原来整份按 hg(0.9)·e^(−0.25·od) 算，等于假设光在路上被峰散射多少次都还挤在太阳几度以内，
      // od ≈ 10 的云芯照样在太阳周围发一大团光，薄边反而不突出（离边 0.5–1.5° 的芯还有边的一半亮，显示上整块饱和）。
      // 其实每被峰散射一次角分布就宽一圈：HG 与 HG 卷积仍是 HG，g 相乘（勒让德矩 g^l 相乘），散射 k 次后是 HG(0.9^(k+1))。
      // 峰的散射率取 f = 0.75（经验值，为与 e^(−0.25·od) 的 delta 缩放衔接；物理上约 0.5；推导用小角近似，
      // 三次以上散射全归到 g = 0.656，深处展宽偏保守），路上峰散射 k 次、别的散射 0 次的概率是
      // e^(−od)·(0.75·od)^k / k!，对 k 求和正好是原来的 e^(−0.25·od)——总能量不变，只把深处那份按次数摊到更宽的瓣上。
      // k = 0–2 显式写，k ≥ 3 的余量给 HG(0.9^4 ≈ 0.656)。效果：薄边照旧亮（k ≈ 0），云芯在太阳附近暗下去，银边从一团光晕收成一圈边
      // （backlit-close：HDR 边 ÷ 往里 0.5–1.5° 从 6.2 到 8.9（连同上面受光首步缩短），见 handoff/C09.md）；顺光 / 侧光的云变化 ≤ 2%。
      // 试过：f = 0.5（「约一半是衍射峰」）银边更强，但薄处的随机受光被放大，单帧亮点 +36%，没用；只加一个 g = 0.6 的宽瓣、
      // 受光步进首步缩短到 20–30 m 都几乎不改变「光晕太宽」（后者薄处 od 变小，芯也跟着亮，反而更糊）
      float pk = 0.75 * od;
      float pk0 = exp(-od);
      float pkSum = pk0 * (1.0 + pk + 0.5 * pk * pk);
      float sunScatter = 0.6 * (pk0 * dot(phPeak.xyz, vec3(1.0, pk, 0.5 * pk * pk)) + max(exp(-0.25 * od) - pkSum, 0.0) * phPeak.w)
      // 单次散射（下面多次散射近似的第 0 阶）：相函数双瓣，消光不打折
                       + phBody * pk0;
      // 多次散射近似（Wrenninge 2013 的八度法）：第 k 阶 = a^k · p(g·c^k) · exp(−b^k · od)，每一阶更弱、衰减更慢、相函数更平。
      // C01：**a ≤ b 才守恒**（散射权重衰减不能慢于消光衰减，Wrenninge 2013；Hillaire 2016 Frostbite 沿用，常取 a = b = c = 0.5；
      // UE Volumetric Cloud 的默认值同为 0.5，八度数最多加到 2）。原来是 a = 0.62 > b = 0.35、6 阶（T12 为补「顺光的云偏灰」加的）：
      // 第 3–5 阶的 b^k 趋近 0，几乎是一份不随 od 变的常数光，高阶合计从 od = 0 到 5 只降到一半，受光 / 背光抹平，
      // 云芯亮度起伏只有均值的 ±6%，菜花读不出来（research/CLOUD_SHARPNESS.md §1.6）。现在 a = b = c = 0.5、共 3 阶
      // （单次 + 2 个高阶），od 0 → 5 降到约 1/6.7：对比提高来自这条曲线变陡（审查更正：不是「od = 5 处高阶是单次的 100 倍」——改后仍是约 100 倍）。
      // 雷暴光学厚度几百、高阶占比更高，取 a = b = 0.6（同样守恒）
#ifdef CLOUD_WEATHER
      float msDecay = stormW > 0.5 ? 0.6 : 0.5;
      float tailK = stormW > 0.5 ? CLOUD_MS_TAIL.z : mix(CLOUD_MS_TAIL.x, CLOUD_MS_TAIL.y, uCloudImmersion);
#else
      const float msDecay = 0.5;
      float tailK = mix(CLOUD_MS_TAIL.x, CLOUD_MS_TAIL.y, uCloudImmersion);
#endif
      // 第 k 阶：a = b = msDecay^k、g 乘 0.5^k（相函数在循环外算好，C09）
      float msDecay2 = msDecay * msDecay;
      float msScatter = msDecay * phMs1 * exp(-msDecay * od) + msDecay2 * phMs2 * exp(-msDecay2 * od);
      // Beer-Powder（Schneider 2015，原文是经验性的）：按其物理含义的解读——刚进云的那一薄层里多次散射还没「攒」起来，
      // 所以只压多次散射（C01）；单次散射在受光表面本来就是满的。
      // 原来整项一起压，顺光时把受光的云边也压暗了，和真实云朵受光面的亮边相反。逆光时薄边正是最亮的地方，淡出（T12）
      float powder = 1.0 - exp(-2.0 * od - 0.5);
      sunScatter += CLOUD_MS_ALBEDO * msScatter * mix(1.0, powder, 0.5 * (1.0 - smoothstep(0.3, 0.9, cosT)));
      // 扩散尾巴（C01 返工）：上面三阶都按 e^(−b^k·od) 衰减，od ≳ 10 时全部归零——厚云深处（雷暴 / 台风的背光塔身、飞机在云里）
      // 只剩蓝色的天空光，塔身成了深蓝剪影；云里每个样本的受光全靠对受光 od 极敏感的那一项，受光步进的随机细节被放大成 2×2 棋盘纹。
      // 真实厚云深处是扩散区，漫射光按二流近似慢慢衰减：总透射 ≈ 1 / (1 + 0.75(1 − g)·od)（g = 0.85，和 keyVisibility 同一式），
      // 扣掉直射 e^−od 就是「已被散射、没被吸收」的那一份（上界 1、od = 0 时为 0，薄边自然还没攒起来），按各向同性相函数散出。
      // 强度 tailK：尾巴在 od 3–10 就有 0.3–0.6，会把从外面看的积云背光面抬平（K = 1 时 clouds-variety 云芯对比掉回改前的 −26%），
      // 所以晴天积云只取 0.2；飞机在云里（uCloudImmersion，看到的全是云体深处）取 2，雷暴 / 台风塔身（stormW，只在天气宏里）取 1
      sunScatter += (tailK / (4.0 * M_PI)) * (1.0 / (1.0 + 0.1125 * od) - exp(-od));
      vec3 sunLight = keyLight(r, up) * sunScatter;
#ifdef WONDER_LAYER
      // 奇观的投影椭球挡住直射光（岛在云海上的影子）
      float tp = t + stepLen * jitter;
      if (tp > shSeg.x && tp < shSeg.y) sunLight *= wonderCasterVis(tp, shQ);
#endif
      // 台风：对面眼壁投下的长影（几十公里，受光步进只走 15 km 够不着）。太阳不高时眼壁下半截和眼底都在影子里，
      // 上亮下暗，「体育场」的碗形靠这个读出来
      // 只在眼和眼壁附近算（外围雨带头顶的卷云盖由受光步进负责，这里再算一遍会重复压暗）
      // 长影在空间上变化很慢（半影几公里）：同一条视线上离上次求值不到 2 km 就沿用，省掉大部分求值（帧时间）
#ifdef CLOUD_TYPHOON
      if (uHurricane.w > 0.5 && stormW > 0.5 && length(p.xz + uCloudOffset - uHurricane.xy) < uHurricane.z * 3.5) {
        if (abs(t - hurVisT) > 2.0) { hurVis = hurricaneSunVis(p, uKeyDir, 3.0); hurVisT = t; }
        sunLight *= hurVis;
      }
#endif
      // 环境光：上半球的天空光，云顶亮、云底暗
      // 云顶亮、云底暗的归一化：雷暴 / 台风按整个外壳，普通云按它自己那一层（T33：以前场上一有雷暴，
      // 外壳被撑到 0–15 km，远处普通积云的 h01 只剩 0.1–0.2，整体被压暗）
#ifdef CLOUD_WEATHER
      float h01 = stormW > 0.5 ? clamp((r - BOTTOM - uShellBottom) / (uShellTop - uShellBottom), 0.0, 1.0)
                               : clamp((r - BOTTOM - uCloudBottom) / max(uCloudTop - uCloudBottom, 1e-3), 0.0, 1.0);
#else
      float h01 = clamp((r - BOTTOM - uCloudBottom) / max(uCloudTop - uCloudBottom, 1e-3), 0.0, 1.0);
#endif
      vec3 eSky = skyIrradiance(r, up);
      float ambFloor = 0.12;
#ifdef CLOUD_CIRRUS
      // 卷云（T12）：薄冰晶云光学厚度只有零点几到几，底下照样看得到大半个天，不按厚云的「云底只剩 12%」压暗
#ifdef CLOUD_WEATHER
      if (stormW < 0.5)
#endif
      ambFloor = mix(0.12, 0.6, 1.0 - smoothstep(0.0, 0.2, uCloudType));
#endif
#ifdef CLOUD_TYPHOON
      if (nearHur && stormW > 0.5) {
        // 台风眼外的雨带塔（T38，T44 遗留）：「按整个外壳高度（0–20 km）压暗、底部只剩 12%」是给眼壁下部（井底，只看得到头顶一块天）的。
        // 雨带上一座 3 km 高处的塔身，周围是开阔的天和被照亮的裙边云，却被压到约 35%，再乘隆起遮蔽，
        // 塔的下半截整片发暗（背光面只剩直射的百分之一），明暗只随高度变、不随形状变，读成一个深色的圆桶。
        // 眼外改按 0–10 km 归一化、底部下限 0.4（塔侧面约看得到半个天）
        float outK = smoothstep(uHurricane.z * 2.5, uHurricane.z * 4.0, length(p.xz + uCloudOffset - uHurricane.xy));
        h01 = mix(h01, clamp((r - BOTTOM) / 10.0, 0.0, 1.0), outK);
        ambFloor = mix(ambFloor, 0.4, outK);
      }
#endif
      vec3 ambient = eSky / (2.0 * M_PI) * mix(ambFloor, 1.0, pow(h01, 0.7));
      // 夜天光（T46）：skyIrradiance 只有太阳、月亮两路 LUT，没有气辉和星光；海面却经 skyRadiance 反射了它，
      // 无月夜云（≈ 0）成了比海还暗的纯黑剪影（美术总监 wave6 第 5 条：云 Y 9–12、海约 33）。
      // 量级：nightglow（lights.glsl.ts）按半球积分的水平照度 E = 2π·1.6e-7·0.743（van Rhijn 增亮）≈ 7.5e-7 klux，再加积分星光（约 30–50%）和黄道光（约 20–30%），合计约 1.7 倍 ≈ 1.3e-6；
      // 厚云顶当反照率 0.8 的朗伯面：L = 0.8·E/π ≈ 3.3e-7 kcd/m²，与远处掠射海面（菲涅尔 × 地平线气辉，2–4e-7）同一量级。
      // 不能照搬上一行的 E/(2π) 和云底 0.12：那是白天的经验取值（按厚云反照率算少了 1.6 倍，云底再压到 0.12），
      // T41 实验只补物理量级的 E、套用这套系数时云几乎不变（仍比海暗约 5 倍）。白天这一项比天空光小 7–8 个数量级，不影响
      ambient += vec3(0.8, 1.0, 0.85) * (1.3e-6 * 0.8 / M_PI) * mix(0.35, 1.0, pow(h01, 0.7));
#ifdef CLOUD_WEATHER
      if (stormW > 0.5) {
        // 雷暴：隆起之间的凹处、砧底、雨幡里看到的天空少（菜花状的明暗）；
        // 塔身下半截还被下方的海面 / 低云反射的光照着（中性的灰白，冲淡天空光的蓝）
        ambient *= mix(0.3, 1.0, stormAO);
        // 台风眼外（T44）：脚下是海面和雨带的裙边低云，不是眼底的云（albedoBelow 按眼底受光算，太阳低时会很小）。
        // 取 0.25（海面 0.06 + 雨带裙边约三成覆盖）。试过取 0.17：塔身下半截失去下方反射光，读成一个深色的拱洞
        float albB = albedoBelow;
#ifdef CLOUD_TYPHOON
        if (nearHur) albB = mix(albedoBelow, 0.25, smoothstep(uHurricane.z * 2.5, uHurricane.z * 4.0, length(p.xz + uCloudOffset - uHurricane.xy)));
#endif
        vec3 eBelow = albB * keyLight(BOTTOM + 1.0, up) * max(dot(up, uKeyDir), 0.0);
        // 台风眼里，背光的眼壁对面就是被太阳直射的眼壁和眼底：反射光在各个高度都很强，不只是下半截
        float hBelow = cloudHurOn() ? 1.0 - 0.4 * h01 : 1.0 - h01;
        ambient += eBelow / (2.0 * M_PI) * 0.5 * hBelow * stormAO;
#ifdef CLOUD_TYPHOON
        if (uHurricane.w > 0.5) {
          // 眼里的互相照亮：向阳一侧的眼壁（内表面背着太阳）对面就是被太阳直射的眼壁，占了它小半个视野，
          // 补光是中性的灰白。只按「内表面朝向」算：朝太阳的受光面对面是背光的暗壁，几乎没有补光。
          // 量级：对面受光壁辐亮度约 0.25 E，占视野约 1/3，反照率 0.8，取一半（对面下半截在影子里）≈ 0.035 E
          vec2 toC = (uHurricane.xy - uCloudOffset) - p.xz;
          float rc = length(toC);
          float away = -dot(toC / max(rc, 1e-3), normalize(uKeyDir.xz + vec2(1e-6)));
          float opp = smoothstep(-0.2, 0.6, away) * (1.0 - smoothstep(uHurricane.z * 2.2, uHurricane.z * 3.0, rc));
          ambient += keyLight(r, uKeyDir) * 0.035 * opp * mix(0.15, 1.0, stormAO) * smoothstep(0.02, 0.2, uKeyDir.y);
        }
#endif
      }
#endif
      vec3 S = sunLight + ambient;
#ifdef CLOUD_WEATHER
      // 闪电：云里一段几公里长的放电通道，光在云里多次散射后向外扩散（扩散长度约 2 km），
      // 整团云从内部亮起来，离通道越远越暗。凹处（ao 小）被周围的云挡住，也暗一些
      if (uFlash.w > 0.0) {
        vec3 pw = vec3(p.x, length(p), p.z);
        float u = clamp(dot(pw - fA, fAB) / max(dot(fAB, fAB), 1e-6), 0.0, 1.0);
        float fd = length(pw - fA - fAB * u);
        // 强度按观感标定：白天只在通道附近隐约可见，夜里通道周围几公里亮起来、十公里外的云只被照亮一点
        S += vec3(0.8, 0.85, 1.0) * flashI * 0.005 * exp(-fd / 1.5) / (1.0 + fd * fd) * mix(1.0, stormAO, 0.5);
      }
#endif
      float stepT = exp(-sigma * stepLen);
      // 云的反照率接近 1：散射系数 ≈ 消光系数，积分式里 σ 被约掉
      L += T * S * (1.0 - stepT);
      depthSum += T * (1.0 - stepT) * t;
      wSum += T * (1.0 - stepT);
      T *= stepT;
      t += stepLen;
    } else {
      // 空白区域大步走（细化时仍用小步）
      wasEmpty = true;
#ifdef CLOUD_WEATHER
      wasThin = false;
      lastEmpty = t + stepLen * jitter;
#endif
      t += stepLen;
    }
  }
#ifdef WONDER_LAYER
  // 奇观层在所有云之后（或云已经走完 / 步数用完）：最后插进去
  if (wPending) {
    L += T * surfW.rgb;
    depthSum += T * surfW.a * tW;
    wSum += T * surfW.a;
    T *= 1.0 - surfW.a;
  }
  if (wSum <= 0.0) {
    // 只有不消光的自发光（光束、辉光）：深度取奇观层的深度（给时间累积的重投影用）
    if (!hasW || max(L.r, max(L.g, L.b)) <= 0.0) return;
    depthSum = tW;
    wSum = 1.0;
  }
#else
  if (wSum <= 0.0) return;
#endif
  float depth = depthSum / wSum;
  // 相机到云之间的空气透视：远处的云被大气染蓝、变淡，融进地平线
  vec3 uvw = aerialPerspectiveUvw(rd, uSunDir, depth);
  vec3 apL = texture(uAerialInscatter, uvw).rgb;
  vec3 apT = texture(uAerialTransmittance, uvw).rgb;
  // 台风：视线上被眼壁 / 卷云盖挡住阳光的那几段空气不散射阳光（体积阴影）。
  // 下午逆光看远处眼壁时，40 km 的空气透视内散射是眼壁自身亮度的约 10 倍（T26 实测：0.9/1.9/4.5 对 0.2/0.2/0.24），
  // 背光的眼壁整面被刷成天空蓝；而真实的眼里，靠近向阳一侧眼壁的空气正处在它的影子里。
  // 分段累加：L(0, b) − L(0, a) ≈ 段 [a, b] 的内散射（已含到相机的透射），乘这一段中点的受光比例
#ifdef CLOUD_TYPHOON
  if (nearHur && uSunDir.y > 0.02) {
    apL = hurricaneShadowedInscatter(ro, rd, depth, apL);
    // 美术取向（有意偏离物理，T26 协调者 / 美术总监的要求）：物理上从 10.7 km 隔 40 km 看逆光的眼壁，空气透视
    // 和眼壁顶上方 8° 的天空几乎一样亮（两条视线穿过的空气柱相当），背光的眼壁整面融进天空；
    // 外卷的「看台」又让低太阳照进眼里，体积阴影只减掉约 5–20%。这里在眼里朝太阳方向看时再压掉一部分内散射，
    // 让背光面读成深灰蓝。只作用于台风眼附近、朝太阳、太阳不高的时候；要回到纯物理把 HUR_BACKLIT_AP_CUT 设 0
    vec2 hcC = uHurricane.xy - uCloudOffset;
    float inEye = 1.0 - smoothstep(uHurricane.z * 2.0, uHurricane.z * 3.0, length(hcC));
    float toward = max(dot(normalize(rd.xz + vec2(1e-6)), normalize(uSunDir.xz + vec2(1e-6))), 0.0);
    apL *= 1.0 - HUR_BACKLIT_AP_CUT * inEye * toward * toward * (1.0 - smoothstep(0.35, 0.8, uSunDir.y));
  }
#endif
  apL *= uSunIlluminance;
  // 夜天光的空气透视（T46）：LUT 只有太阳一路，夜里远处的云只剩「自身 × 透射率」（掠射几百公里、透射率偏红），
  // 读成比海面、地平线天空都暗的红褐色斑。远处的云应当和白天一样淡进地平线的天光：按同方向的夜天光补上 (1 − 透射率) 那部分。
  // 海面反射、天空用的都是同一个 nightglow（lights.glsl.ts），三者一致。白天比太阳那一路小 8 个数量级
  // 取透射率的亮度（不按通道）：按通道补是 (1 − 偏红的透射率) = 偏蓝，远处的云发蓝；系数 0.6：
  // 1.0 时远处的云约为同一行海面的 2 倍，0.6 约 1.3 倍（「略亮于海面」，night-sea-milkyway 读回窗外 HDR 实测）
  apL += nightglow(rd) * (0.6 * (1.0 - dot(apT, vec3(0.2126, 0.7152, 0.0722))));
  // 透射率 < 0.005 时步进提前停了（上面的 break），剩下的 T 只是「停在哪一步」的截断残差，不是真实透射率：
  // 真实的积雨云光学厚度几百，T ≈ e^−几百。窗外 pass 按背景 × T 合成，太阳圆盘比云亮 10^5 倍，
  // 残差 4e-5 也足以让日盘从积雨云里透出来（T45 实测日盘处 T = 4.2e-5）。按阈值连续地减掉这段残差（T = 1 不变）
  T = max(T - 0.005, 0.0) / 0.995;
  L = L * apT + apL * (1.0 - T);
  gl_FragColor = vec4(min(L, vec3(60000.0)), T);
  gl_FragDepth = clamp(depth / AERIAL_MAX_DISTANCE, 0.0, 1.0);
}
`;

// 时间累积：把上一帧的结果按云的运动重投影过来，再和这一帧混合；用邻域夹取防止拖影
// 云间层奇观的「奇观 pass」（W00，research/WONDERS.md §3.3 方案 A 第 1 步）：在云分辨率上沿每条视线追踪奇观表面、步进奇观介质，
// 合成一层，给云步进的奇观变体在 tW 处插进去。只在有云间层奇观在场时画（和步进变体一起后台编译，平时不编也不画）。
// 奇观代码放进步进程序本身的话，就算视线穿不过包围盒（分支不走），整个云步进也慢一倍（W00 实测，见 README 坑点）。
// 输出 RGBA32F：rgb = 预乘的辐亮度（不含空气透视），a = floor(tW·8) + 不透明度·0.998（tW 精度 125 m；没有奇观 = 0）
const WONDER_SURF_FRAG = /* glsl */ `
${ATMOSPHERE_COMMON}
${VIEW_COMMON}
${CLOUD_COMMON}
${LIGHTS_COMMON}
${wonderCloudGlsl()}
uniform vec2 uCloudResolution;
uniform float uFrame;
varying vec2 vUv;
float wonderIgn(vec2 p) { return fract(52.9829189 * fract(dot(p, vec2(0.06711056, 0.00583715)))); }
void main() {
  gl_FragColor = vec4(0.0);
  vec3 rdC = cabinRay(gl_FragCoord.xy * (uResolution / uCloudResolution));
  if (uWonderVol < 0.5 || paneDistance(uHead, rdC) > 0.02) return;
  vec3 rd = uCabinToWorld * rdC;
  vec3 ro = vec3(0.0, uCamR, 0.0);
  vec2 wSeg = wonderInterval(ro, rd);
  wSeg.y = min(wSeg.y, AERIAL_MAX_DISTANCE);
  if (wSeg.y <= wSeg.x) return;
  // 介质步进的抖动：和云步进一样每帧换（黄金分割），时间累积抹平
  float jitter = fract(wonderIgn(gl_FragCoord.xy + 17.0) + uFrame * 0.61803);
  float tW;
  vec4 s = wonderLayer(ro, rd, wSeg, 2.0 * uTanHalfFov / uCloudResolution.y, jitter, tW);
  if (s.a <= 0.0 && max(s.r, max(s.g, s.b)) <= 0.0) return;
  gl_FragColor = vec4(min(s.rgb, vec3(60000.0)), max(floor(tW * 8.0), 1.0) + min(s.a, 1.0) * 0.998);
}
`;

const RESOLVE_FRAG = /* glsl */ `
${VIEW_COMMON}
const float CLOUD_DEPTH_SCALE = ${AERIAL_MAX_DISTANCE_KM.toFixed(1)};  // 深度纹理里存的是 depth / 这个值（与步进程序的 AERIAL_MAX_DISTANCE 一致）
uniform sampler2D uCurrent;
uniform sampler2D uCurrentDepth;   // 步进程序的深度附件（gl_FragDepth）
uniform sampler2D uHistory;
uniform mat3 uPrevCamBasis;
uniform mat3 uPrevCabinToWorld;
uniform vec3 uMotion;
uniform bool uReset;
uniform bool uResetDepth;   // 右半（深度）这一帧从停用变回启用：右半不取历史（PERF-11）
uniform vec2 uCloudResolution;
varying vec2 vUv;
// 输出是两倍宽（T38）：左半是云（RGB + 透射率），右半是云的深度——窗外程序要拿它判断云在山前还是山后
// （clouds.glsl.ts 的 cloudBeforeGround），放进同一张纹理，窗外 / 机翼程序不多占 sampler。两半各自时间累积、各自邻域夹取。
// 右半存 (深度 × 不透明度, 不透明度)，用时再相除：直接累积深度的话，没有云的帧深度是 400 km（gl_FragDepth = 1），
// 稀疏的小云、云边上逐帧抖动有云 / 没云，累积出来的「深度」是 150–360 km，海面上的云被当成在海面后面整片去掉（T38 踩过）
void main() {
  bool depthHalf = gl_FragCoord.x >= uCloudResolution.x;
  vec2 fc = gl_FragCoord.xy - vec2(depthHalf ? uCloudResolution.x : 0.0, 0.0);
  vec3 rdC = cabinRay(fc * (uResolution / uCloudResolution));
  // 窗板以外（PERF-11）：步进程序在 paneDistance > 0.02 处只写 (0, 0, 0, 1)、深度 1，右半折算出来也是 (0, 0, 0, 1)。
  // 离窗板再远一点（0.025，比一个云像素在窗板平面上的尺寸大一个数量级）的像素，3×3 邻域全是 (0, 0, 0, 1)，
  // 夹取后历史也被夹成它，结果恒为 (0, 0, 0, 1)——直接写出，不再读 9 + 9 次邻域（窗外只占画面的一部分）
  if (paneDistance(uHead, rdC) > 0.025) { gl_FragColor = vec4(0.0, 0.0, 0.0, 1.0); return; }
  // 本帧的 raw 与这一半同分辨率、取样点正好在纹素中心：直接 texelFetch（PERF-11）。
  // 旧版用 texture()，32 位浮点纹理的线性过滤在 NVIDIA 上是降速的，而取样点在纹素中心时过滤结果就是纹素本身；
  // 边缘按 ClampToEdge 的效果夹到 [0, 尺寸 − 1]，结果逐位不变
  ivec2 ip = ivec2(fc);
  ivec2 hi = ivec2(uCloudResolution) - 1;
  float dCur = texelFetch(uCurrentDepth, ip, 0).r * CLOUD_DEPTH_SCALE;
  vec4 cur = texelFetch(uCurrent, ip, 0);
  if (depthHalf) cur = vec4(dCur * (1.0 - cur.a), 1.0 - cur.a, 0.0, 1.0);
  if (uReset || (depthHalf && uResetDepth)) { gl_FragColor = cur; return; }

  vec4 mn = cur, mx = cur;
  for (int x = -1; x <= 1; x++)
  for (int y = -1; y <= 1; y++) {
    ivec2 q = clamp(ip + ivec2(x, y), ivec2(0), hi);
    vec4 s = texelFetch(uCurrent, q, 0);
    if (depthHalf) s = vec4(texelFetch(uCurrentDepth, q, 0).r * CLOUD_DEPTH_SCALE * (1.0 - s.a), 1.0 - s.a, 0.0, 1.0);
    mn = min(mn, s);
    mx = max(mx, s);
  }

  vec3 rd = uCabinToWorld * rdC;
  vec3 prevDir = normalize(rd * dCur + uMotion);
  vec3 v = transpose(uPrevCamBasis) * (transpose(uPrevCabinToWorld) * prevDir);
  float blend = 0.12;
  vec2 puv = vec2(-1.0);
  if (v.z < 0.0) {
    vec2 ndc = v.xy / (-v.z) / uTanHalfFov;
    ndc.x /= uResolution.x / uResolution.y;
    puv = ndc * 0.5 + 0.5;
  }
  if (any(lessThan(puv, vec2(0.0))) || any(greaterThan(puv, vec2(1.0)))) blend = 1.0;
  // 上一帧的缓冲也是两倍宽：取对应的半边，夹在半边以内半个纹素（线性过滤不串到另一半）
  float hx = clamp(puv.x * uCloudResolution.x, 0.5, uCloudResolution.x - 0.5) + (depthHalf ? uCloudResolution.x : 0.0);
  vec4 hist = clamp(texture(uHistory, vec2(hx / (2.0 * uCloudResolution.x), puv.y)), mn, mx);
  gl_FragColor = mix(hist, cur, blend);
}
`;

// 探针：异步读回给 CPU。
//  R：飞机位置和前方几百米的云密度（判断是否在云里：窗上起水痕、颠簸）
//  G：从飞机朝直射主光源方向的云透射率（T31）：舱内的直射光斑、窗板上的直射项、机翼受光都要乘它；B：同一段的光学厚度。
//     以前只乘了大气透射率，穿云时舱壁上照样有一块硬边的阳光斑。
//     沿主光源方向取 PROBE_SUN_STEPS 个点，步长从 30 m 起每步 ×1.2（约 25 km，够穿过雷暴的砧），层状云带细节侵蚀
//     （和画出来的云一样瘦；只是一个像素，不在乎开销）。两段样本放进同一个循环：cloudDensityLite 只内联一处
const PROBE_FRAG = /* glsl */ `
${ATMOSPHERE_COMMON}
#define CLOUD_CIRRUS 1
${CLOUD_COMMON}
uniform float uCamR;
uniform vec3 uProbeDir;   // 航向（窗外坐标）
uniform vec3 uKeyDir;     // 直射主光源方向
varying vec2 vUv;
const int PROBE_FWD = 4;
const int PROBE_SUN_STEPS = 28;
void main() {
  vec3 p0 = vec3(0.0, uCamR, 0.0);
  float d = 0.0;
  float od = 0.0;
  float ls = 0.03, lt = 0.0;
  for (int k = 0; k < PROBE_FWD + PROBE_SUN_STEPS + min(uStormCount, 0); k++) {
    bool fwd = k < PROBE_FWD;
    vec3 q;
    if (fwd) q = p0 + uProbeDir * (float(k) * 0.12);
    else { q = p0 + uKeyDir * (lt + 0.5 * ls); lt += ls; }
    float dk = cloudDensityLite(q, 1.0, !fwd, false);
    if (fwd) d += dk;
    else { od += dk * ls; ls *= 1.2; }
  }
  gl_FragColor = vec4(d * 0.25, exp(-od * CLOUD_EXTINCTION), od * CLOUD_EXTINCTION, 1.0);
}
`;

// 占据网格（PERF-2）：每个格点求一次雷暴 / 台风密度，有云写 1。只要大形，不做细节侵蚀（侵蚀只会让密度变小）。
// 云步进远处用粗 mip 的噪声（lod 最大约 5）、近处用细的，两者的表面能差出一两公里：这里 lod 0 和 3.5 各求一次取并集，
// 再靠查询时的 mip 膨胀兜住其余差异（见 clouds.glsl.ts 的 OCC_*）
const OCC_FRAG = /* glsl */ `
${ATMOSPHERE_COMMON}
${CLOUD_COMMON}
uniform vec2 uOccOrigin;
uniform vec2 uOccAlt;
uniform float uOccLayer;
varying vec2 vUv;
void main() {
  vec2 xz = uOccOrigin + floor(gl_FragCoord.xy) * ${OCC_SPACING.toFixed(3)};
  float alt = uOccAlt.x + uOccLayer * uOccAlt.y;
  float d = 0.0;
  float ao;
  // 两个 lod 放进同一个循环（上界依赖 uniform，FXC 不展开）：雷暴 / 台风密度各只内联一份
  for (int k = 0; k < 2 + min(uStormCount, 0); k++) {
    float lod = float(k) * 3.5;
    for (int i = 0; i < uStormCount; i++) {
      vec4 c = uStorms[i];
      vec2 dd = xz - c.xy;
      if (dot(dd, dd) > c.z * c.z * 56.0) continue;
      d = max(d, stormDensity(c, xz, alt, lod, false, ao));
    }
    if (uHurricane.w > 0.5) d = max(d, hurricaneDensity(xz, alt, lod, false, ao));
  }
  gl_FragColor = vec4(d > 0.0 ? 1.0 : 0.0, 0.0, 0.0, 1.0);
}
`;

// 云影图（T27）：每个格点是海平面上的一点，沿主光源方向穿过云壳取 48 个点（上界依赖 uniform，FXC 不展开），
// 分别累计 0 / 1 / 2 / 3 km 以上那一段的光学厚度，存透射率（存透射率而不是光学厚度：插值后边缘是渐变；
// 插值光学厚度再取 exp，边缘又会变回一刀切）。用完整的云密度（含雷暴、台风的真实形状，带细节侵蚀）。
// 旧版逐像素只取 5 个点、台风只用解析大形（完整密度进窗外程序太慢），现在这些都在这个单独的小程序里，窗外程序只查图
const SHADOW_FRAG = /* glsl */ `
${ATMOSPHERE_COMMON}
// 卷云的丝缕（T12）也投影；这个程序每帧只算一小片，卷云代码的开销无所谓
#define CLOUD_CIRRUS 1
${CLOUD_COMMON}
uniform vec2 uBuildCenter;   // 这张图的中心（世界坐标 km）
uniform vec3 uBuildSun;      // 这张图的主光源方向
varying vec2 vUv;
void main() {
  float k = floor(gl_FragCoord.x / ${CLOUD_SHADOW_RES.toFixed(1)});
  float ext = k < 0.5 ? ${CLOUD_SHADOW_EXT[0].toFixed(1)} : k < 1.5 ? ${CLOUD_SHADOW_EXT[1].toFixed(1)} : ${CLOUD_SHADOW_EXT[2].toFixed(1)};
  vec2 uv = vec2(gl_FragCoord.x - k * ${CLOUD_SHADOW_RES.toFixed(1)}, gl_FragCoord.y) / ${CLOUD_SHADOW_RES.toFixed(1)};
  // 格点的世界坐标 → 相机相对坐标，落到海平面球面上（抬高 10 m：正好在球面上时求交在 0 附近抖动，见 README 坑点）
  vec2 lxz = uBuildCenter + (uv * 2.0 - 1.0) * ext - uCloudOffset;
  vec3 p = vec3(lxz.x, sqrt(max(BOTTOM * BOTTOM - dot(lxz, lxz), 0.0)), lxz.y);
  p += normalize(p) * 0.01;
  vec3 sunDir = uBuildSun;
  vec4 T = vec4(1.0);
  vec2 seg = cloudShellInterval(p, sunDir);
  if (sunDir.y > -0.2 && seg.y > seg.x) {
    // 有雷暴、台风时砧和卷云盖在 10–17 km，斜着穿过去要走得更远
    seg.y = min(seg.y, seg.x + ((uStormCount > 0 || uHurricane.w > 0.5) ? 60.0 : 30.0));
    float dt = (seg.y - seg.x) / 48.0;
    vec4 od = vec4(0.0);
    for (int i = 0; i < 48 + min(uStormCount, 0); i++) {
      vec3 q = p + sunDir * (seg.x + (float(i) + 0.5) * dt);
      // 带细节侵蚀：和画出来的云一样瘦。不侵蚀的大形偏胖，太阳低时几乎每条光线都会撞上，整片海都在影子里、耀斑没了
      float d = cloudDensity(q, 1.5, true);
      float a = length(q) - BOTTOM;
      od += d * step(vec4(0.0, 1.0, 2.0, 3.0), vec4(a));
    }
    T = exp(-od * dt * CLOUD_EXTINCTION);
  }
  gl_FragColor = T;
}
`;

export interface CloudPreset {
  id: string;
  name: string;
  bottom: number;
  top: number;
  coverage: number;
  type: number;
  density: number;
}

/** 云层的连续参数（CloudPreset 去掉 id / name），导演插值用（T19b） */
export type CloudParams = Pick<CloudPreset, "bottom" | "top" | "coverage" | "type" | "density">;

export const CLOUD_PRESETS: CloudPreset[] = [
  { id: "cumulus", name: "晴天积云", bottom: 1.2, top: 3.4, coverage: 0.42, type: 1, density: 1 },
  { id: "stratocumulus", name: "层积云云海", bottom: 1.0, top: 2.2, coverage: 0.78, type: 0.2, density: 0.8 },
  { id: "towering", name: "浓积云（午后对流）", bottom: 1.4, top: 6.5, coverage: 0.35, type: 1, density: 1.2 },
  { id: "altocumulus", name: "高积云（中层，4.5–6 km）", bottom: 4.5, top: 6.0, coverage: 0.6, type: 0.45, density: 0.7 },
  { id: "deck-below", name: "云海贴着航路（云顶 9.8 km）", bottom: 8.0, top: 9.8, coverage: 0.85, type: 0.25, density: 0.8 },
  { id: "cirrus", name: "卷云（航路上方 11.5–12.5 km）", bottom: 11.5, top: 12.5, coverage: 0.5, type: 0.0, density: 0.12 },
  { id: "clear", name: "无云", bottom: 1.2, top: 3.4, coverage: 0, type: 1, density: 1 },
];

/** 云场参数。场景着色器（海面云影）和云着色器共用同一组 uniform 对象 */
export function createCloudUniforms(noise: CloudNoise) {
  return {
    uShapeNoise: { value: noise.shape },
    uDetailNoise: { value: noise.detail },
    uWeather: { value: noise.weather },
    uCloudOffset: { value: new THREE.Vector2() },
    uCloudBottom: { value: 1.2 },
    uCloudTop: { value: 3.4 },
    uCoverage: { value: 0.42 },
    uCloudType: { value: 1 },
    uCloudDensity: { value: 1 },
    uShellBottom: { value: 1.2 },
    uShellTop: { value: 3.4 },
    uStormCount: { value: 0 },
    uStorms: { value: [0, 1, 2, 3].map(() => new THREE.Vector4()) },
    uUpperWind: { value: new THREE.Vector2(0.8, 0.6) },
    uHurricane: { value: new THREE.Vector4(0, 0, 20, 0) },
    uFlash: { value: new THREE.Vector4() },
    uFlashB: { value: new THREE.Vector3() },
    // 云影图（T27）：Clouds 建好后填上
    uCloudShadowMap: { value: null as THREE.Texture | null },
    uCloudShadowSun: { value: new THREE.Vector3(0, 1, 0) },
    uCloudShadowCenter: { value: new THREE.Vector3(0, 0, 0) },
    // 云缓冲右半（深度）这一帧写了没有（PERF-11）：Clouds.render 每帧设，窗外程序的 cloudBufferDepth 读
    uCloudDepthOn: { value: 0 },
  };
}
export type CloudUniforms = ReturnType<typeof createCloudUniforms>;

function target(w: number, h: number, type: THREE.TextureDataType = THREE.HalfFloatType) {
  return new THREE.WebGLRenderTarget(w, h, {
    type,
    format: THREE.RGBAFormat,
    minFilter: THREE.LinearFilter,
    magFilter: THREE.LinearFilter,
    depthBuffer: false,
  });
}

/** 步进的输出：颜色（RGB 辐亮度 + A 透射率）+ 深度附件（云的深度，gl_FragDepth） */
function rawTarget(w: number, h: number, type: THREE.TextureDataType = THREE.HalfFloatType) {
  const depthTexture = new THREE.DepthTexture(w, h, THREE.FloatType);
  depthTexture.format = THREE.DepthFormat;
  return new THREE.WebGLRenderTarget(w, h, {
    type,
    format: THREE.RGBAFormat,
    minFilter: THREE.LinearFilter,
    magFilter: THREE.LinearFilter,
    depthBuffer: true,
    depthTexture,
  });
}

/** 占据网格：水平 OCC_N × OCC_N、竖直 OCC_LAYERS 层的 R8 3D 纹理，带 mipmap（查询时用 mip 做膨胀） */
function occTarget() {
  const t = new THREE.WebGL3DRenderTarget(OCC_N, OCC_N, OCC_LAYERS, {
    type: THREE.UnsignedByteType,
    format: THREE.RedFormat,
    minFilter: THREE.LinearMipmapLinearFilter,
    magFilter: THREE.LinearFilter,
    depthBuffer: false,
  });
  t.texture.wrapS = t.texture.wrapT = t.texture.wrapR = THREE.ClampToEdgeWrapping;
  // 只在画最后一层时生成 mipmap（three 每画一层都会按这个开关重新生成一遍，84 层就是 84 遍）
  t.texture.generateMipmaps = false;
  return t;
}

/** 云影图：三级并排（3·RES × RES），RGBA 半精度 = 四个起点高度的透射率 */
function shadowTarget() {
  const t = new THREE.WebGLRenderTarget(CLOUD_SHADOW_RES * 3, CLOUD_SHADOW_RES, {
    type: THREE.HalfFloatType,
    format: THREE.RGBAFormat,
    minFilter: THREE.LinearFilter,
    magFilter: THREE.LinearFilter,
    depthBuffer: false,
  });
  t.texture.generateMipmaps = false;
  return t;
}
/**
 * 整张云影图在 RTX 5090 上要 3 ms（普通云）到 8 ms（雷暴 / 台风）。太阳一直在动，要经常重建，
 * 所以在后台缓冲里分 SHADOW_SLICES 帧（按行）建完再换上来，每帧约 0.2–0.5 ms；只有云 / 天气变了（用户操作）才一帧建完
 */
const SHADOW_SLICES = 16;
/** 飞机离云影图中心超过这么远就重建（最内一级 ±16 km，飞机附近至少留 12 km） */
const SHADOW_RECENTER_KM = 4;
/**
 * 主光源方向变化超过约 0.01° 就重建：太阳低（高度 5°）时 2 km 高的云，太阳每动 0.25° 影子就挪约 1 km，
 * 阈值大了影子会一跳一跳的；0.01° 对应几十米。正常时间流速下约每 2–3 秒重建一次，快进时每帧重建
 */
const SHADOW_SUN_COS = Math.cos(THREE.MathUtils.degToRad(0.01));
/** 云影图中心对齐到最粗一级的格距：重建前后三级的格点位置都不变，影子不会因为重新取样而跳一下 */
const SHADOW_SNAP_KM = (CLOUD_SHADOW_EXT[2] * 2) / CLOUD_SHADOW_RES;

/** 直射光云透射率的平滑时间常数（秒）：真实穿云时阳光也是在零点几秒到一两秒里暗下去 / 亮起来 */
const KEY_VIS_TAU = 0.35;

/** 飞机离网格中心超过这么远就重建（网格覆盖 ±128 km，步进最远约 170 km，网格外照旧逐点求值） */
const OCC_RECENTER_KM = 24;
/**
 * 每帧画几层网格。整张网格（84 层）一次画完在 RTX 5090 上要 5–9 ms，弱一些的 GPU（Mac）可能到几十毫秒，
 * 一帧里画完就是一次明显的卡顿；分到 7 帧，每帧约 1 ms。画在后台缓冲里，画完再换上来
 */
const OCC_LAYERS_PER_FRAME = 12;

type VariantState = "idle" | "compiling" | "ready" | "failed";

/**
 * 云步进变体的特性（PERF-10），按这个顺序拼成变体键。weight：编好之前挑「已编好的子集」时的优先级
 * （缺了台风 / 雷暴是整个天气系统没了，缺了卷云只是卷云画成普通层状云），W 奇观层必须带 C（W00 起奇观变体就带卷云）
 */
const MARCH_FEATURES = [
  { id: "W", define: "WONDER_LAYER", weight: 2 },
  { id: "C", define: "CLOUD_CIRRUS", weight: 1 },
  { id: "S", define: "CLOUD_STORM", weight: 4 },
  { id: "T", define: "CLOUD_TYPHOON", weight: 8 },
] as const;

/** 变体键 → three 的 defines；有 S 或 T 时另加 CLOUD_WEATHER（两者共用的代码，见 clouds.glsl.ts） */
function marchDefines(key: string): Record<string, number> {
  const d: Record<string, number> = {};
  for (const f of MARCH_FEATURES) if (key.includes(f.id)) d[f.define] = 1;
  if (key.includes("S") || key.includes("T")) d.CLOUD_WEATHER = 1;
  return d;
}

/** 雷暴 + 台风都带的小程序（占据网格、云影图、探针的天气版）的 defines */
const WEATHER_DEFINES = { CLOUD_STORM: 1, CLOUD_TYPHOON: 1, CLOUD_WEATHER: 1 };

/** 启动后第几次 probe（每 4 帧一次）开始后台预编雷暴 / 台风变体：约 1–4 s，首帧早已画完 */
const WEATHER_PREWARM_PROBES = 60;

/** 云缓冲右半（深度，T38）只在附近有高于这个值（km）的真实地形时写（PERF-11）：海面、平原上云不可能在「地面后面」 */
const DEPTH_TERRAIN_MIN_KM = 0.05;
/** 相机低于这个高度（km）时右半深度常开（火车、起降）：贴地的视线上矮丘也能挡住远处的云 */
const DEPTH_LOW_CAMERA_KM = 1.0;

export class Clouds {
  private raw = rawTarget(1, 1);
  /** 云间层奇观的表面（W00，WONDER_SURF_FRAG 的输出，和 raw 同尺寸） */
  private wonderSurf = new THREE.WebGLRenderTarget(1, 1, {
    type: THREE.FloatType,
    format: THREE.RGBAFormat,
    minFilter: THREE.NearestFilter,
    magFilter: THREE.NearestFilter,
    depthBuffer: false,
  });
  private history = [target(1, 1), target(1, 1)];
  private frame = 0;
  /** 云的渲染分辨率相对全屏的比例 */
  resolutionScale = 1;
  private reset = true;
  private readonly prevCamBasis = new THREE.Matrix3();
  private readonly prevCabinToWorld = new THREE.Matrix3();

  private readonly marchMat: THREE.ShaderMaterial;
  /**
   * 云间层奇观（W00）的步进变体：同一份着色器加 #define WONDER_LAYER，和 marchMat 共用同一批 uniform 对象。
   * 只在有云间层奇观在场（uWonderVol > 0）时用它画；平时画的 marchMat 预处理后与改动前逐字相同——
   * 奇观代码就算分支不走也会让步进变慢（寄存器，W00 实测 noon-cumulus 云步进 0.35 → 0.44–0.73 ms），冷编译也不加。
   * 第一次需要时在后台编译（d3d11 约 10–15 s，有磁盘缓存后不到 1 s），编好之前奇观不画（云照常）
   */
  // 下面两个字段 = marchVariants 里的 "WC" / "C"，留着给离线检查（lint-shaders）和按 pass 计时（passes.mjs）按名字取
  readonly marchWonderMat: THREE.ShaderMaterial;
  /**
   * 卷云变体（T12）：加 #define CLOUD_CIRRUS，只在云型 < 0.2（卷云）时用它画。卷云的丝缕代码就算按 uniform 分支、平时不走，
   * 也让积云场景的云步进慢一档（noon-cumulus +25%、typhoon-bands +20%），所以和奇观一样做成变体。
   * 启动后第一次 probe 就在后台编译（不在启动的编译批次里，不拖冷启动），编好之前卷云按普通层状云画
   */
  readonly marchCirrusMat: THREE.ShaderMaterial;
  /**
   * 云步进的全部变体（PERF-10），键是特性字母按固定顺序拼起来（见 MARCH_FEATURES）：W 奇观层、C 卷云、S 雷暴、T 台风；W 总带着 C。
   * "" 是默认程序（晴天 / 普通云，不含任何雷暴 / 台风代码，启动批次里编），"C" / "WC" 就是上面两个字段。
   * 雷暴 / 台风变体（"S"、"T"）在启动后不久后台预编（prewarmWeather）；其他组合（"ST"、"CS"、"WCS"……）只在真的需要时才编，
   * 编好之前画「已编好的、特性最多的那个子集」（pickMarch），不会画空、不会同步编译卡住
   */
  private readonly marchVariants = new Map<string, { mat: THREE.ShaderMaterial; state: VariantState }>();
  /** 这一帧想画的 / 实际画的步进变体键（调试、回归脚本等它编好：cloudVariantPending） */
  private marchWanted = "";
  private marchShown = "";
  /** 云影图、探针的天气版（CLOUD_STORM + CLOUD_TYPHOON 都带，都是小程序），和占据网格一起在后台编（weatherAuxState） */
  private readonly shadowWeatherMat: THREE.ShaderMaterial;
  private readonly probeWeatherMat: THREE.ShaderMaterial;
  private weatherAuxState: VariantState = "idle";
  /** 启动后第几次 probe 开始预编雷暴 / 台风变体（首帧之后，不和首帧的同步编译抢线程） */
  private prewarmCount = 0;
  private readonly wonderSurfMat: THREE.ShaderMaterial;
  private wonderState: VariantState = "idle";
  /** 预热：设成 true 后，下一次 probe() 就在后台编译奇观变体（奇观模式打开时由 main.ts 设，召唤时不用再等） */
  wonderPrewarm = false;
  private readonly probeMat: THREE.ShaderMaterial;
  private readonly probeTarget = new THREE.WebGLRenderTarget(1, 1, { type: THREE.FloatType, depthBuffer: false });
  private readonly probePixel = new Float32Array(4);
  private probeBusy = false;
  /** 飞机所在位置的云密度（0..1，几帧前的值） */
  cameraDensity = 0;
  /** 飞机在云里的程度（0–1，平滑过的），曝光的雪景补偿用（C02，EXPOSURE_WHITEOUT） */
  private whiteout = 0;
  /** 从飞机朝直射主光源的云透射率、光学厚度（几帧前的值，没平滑；T31） */
  keyTransmittanceRaw = 1;
  keyOpticalDepthRaw = 0;
  /** 平滑后的舱内光照乘子（keyVisibility 每帧推进，见那里） */
  private readonly keyVis = new THREE.Vector3(1, 0, 1);
  private readonly resolveMat: THREE.ShaderMaterial;
  // ---- 雷暴 / 台风的占据网格（PERF-2）----
  private readonly occMat: THREE.ShaderMaterial;
  /** 前台（步进正在查的）和后台（正在分帧重建的）两张网格 */
  private occ = [occTarget(), occTarget()];
  /** 前台网格对应的天气签名（雷暴、台风、高空风、云壳高度）；天气一变前台立刻作废 */
  private occKey = "";
  private readonly occCenter = new THREE.Vector2(1e9, 1e9);
  /** 后台正在建的网格：签名、中心，下一层是第几层（-1 = 没在建） */
  private occBuildKey = "";
  private readonly occBuildCenter = new THREE.Vector2();
  private occBuildLayer = -1;
  /** 调试 / 对照：false 时步进不查占据网格（逐点求完整密度，等于改动前的行为） */
  occEnabled = true;
  // ---- 云影图（T27）----
  private readonly shadowMat: THREE.ShaderMaterial;
  /** 前台（窗外程序正在查的）和后台（正在分帧重建的）两张云影图 */
  private shadow = [shadowTarget(), shadowTarget()];
  private shadowKey = "";
  /** setParams(gradual) 之后：参数变了也不整张一帧重建云影图，而是按后台分片的节奏跟上（T19b） */
  private shadowGradual = false;
  /** 后台正在建到第几片（-1 = 没在建） */
  private shadowSlice = -1;
  private shadowState: "idle" | "compiling" | "ready" = "idle";
  /** 上一次建云影图用的程序（默认版 / 天气版，PERF-10） */
  private shadowProg: THREE.ShaderMaterial | null = null;
  /** 主光源方向（场景 uniform uKeyDir 的值对象） */
  private readonly keyDir: THREE.Vector3;
  /** 场景 uniform（读 uGroundOn / uTerrainMax 决定云缓冲右半要不要写，PERF-11） */
  private readonly view: Record<string, THREE.IUniform>;
  /** 云缓冲右半（深度，T38）这一帧写了没有；上一帧的值（从停用变回启用时右半不取历史） */
  private depthOn = false;

  constructor(
    private readonly pass: FullscreenPass,
    atmosphere: Atmosphere,
    readonly uniforms: CloudUniforms,
    /** 场景着色器的 uniform（视角、太阳等），直接共享同一批对象 */
    viewUniforms: Record<string, THREE.IUniform>,
  ) {
    // 云的步进结果和时间累积用 32 位浮点（T46）：半精度最小的次正规数是 6e-8，无月夜的云只有 1e-7 量级（kcd/m²），
    // 存进半精度只剩 0 / 1 / 2 个最低位——云成了纯黑、边缘是量化出来的马赛克（T41 把云的环境光放大 100 倍才「修好」就是这个原因）。
    // 和 T36 大气 LUT 的半精度下溢同一类坑。窗外 pass 按双线性读它，要浮点线性过滤；没有时退回半精度
    // （离线 GLSL 检查 lint-shaders.mjs 传进来的 pass 是桩，没有 renderer）
    const ext = pass.renderer?.extensions;
    if (ext?.has("OES_texture_float_linear") && ext.has("EXT_color_buffer_float")) {
      this.raw.dispose();
      for (const t of this.history) t.dispose();
      this.raw = rawTarget(1, 1, THREE.FloatType);
      this.history = [target(1, 1, THREE.FloatType), target(1, 1, THREE.FloatType)];
    }
    const common = { depthTest: false, depthWrite: false, toneMapped: false, vertexShader: FULLSCREEN_VERT };
    this.marchMat = new THREE.ShaderMaterial({
      ...common,
      // 深度测试恒通过、写深度：云深度经 gl_FragDepth 写进 raw 的深度纹理（关掉深度测试时 GL 不写深度）
      depthTest: true,
      depthWrite: true,
      depthFunc: THREE.AlwaysDepth,
      fragmentShader: MARCH_FRAG,
      uniforms: {
        // 云间层奇观（W00）：先铺默认值（奇观关）；main.ts 已把 WonderSystem 的同名 uniform 合进场景 uniforms，由下一行覆盖成共用的对象
        ...createWonderCloudUniforms(),
        ...atmosphere.sharedUniforms,
        ...viewUniforms,
        ...this.uniforms,
        uAerialInscatter: { value: atmosphere.aerialInscatter.texture },
        uAerialTransmittance: { value: atmosphere.aerialTransmittance.texture },
        uFrame: { value: 0 },
        uCloudResolution: { value: new THREE.Vector2(1, 1) },
        uWeatherCull: { value: 1 },
        uOcc: { value: this.occ[0].texture },
        uOccOrigin: { value: new THREE.Vector2() },
        uOccAlt: { value: new THREE.Vector2(0, 1) },
        uOccValid: { value: 0 },
      },
    });
    this.marchMat.name = "cloud-march";
    this.view = viewUniforms;
    // 默认程序在启动批次里编（main.ts 的 compileTargets），一开始就当作可用：真没编好时 three 会在首帧同步编，和改动前一样
    this.marchVariants.set("", { mat: this.marchMat, state: "ready" });
    // 奇观变体本来就慢一档，卷云代码一起带上（不再多一个「奇观 × 卷云」的组合）
    this.marchWonderMat = this.marchVariant("WC").mat;
    this.marchCirrusMat = this.marchVariant("C").mat;
    this.marchMat.uniforms.uWonderSurf = { value: this.wonderSurf.texture };
    // 扩散尾巴的强度（C01 返工）：直接共用曝光的「在云里」uniform 对象，keyVisibility 每帧写一次
    this.marchMat.uniforms.uCloudImmersion = EXPOSURE_WHITEOUT;
    this.wonderSurfMat = new THREE.ShaderMaterial({
      ...common,
      fragmentShader: WONDER_SURF_FRAG,
      uniforms: this.marchMat.uniforms,
    });
    this.occMat = new THREE.ShaderMaterial({
      ...common,
      fragmentShader: OCC_FRAG,
      // 占据网格只在有雷暴 / 台风时有意义，只有天气版（PERF-10：不进启动批次，和天气变体一起后台预编）
      defines: WEATHER_DEFINES,
      uniforms: {
        ...atmosphere.sharedUniforms,
        ...this.uniforms,
        // 后台网格的原点、层高（分帧重建期间步进还在用前台网格，两边各用各的）
        uOccOrigin: { value: new THREE.Vector2() },
        uOccAlt: { value: new THREE.Vector2(0, 1) },
        uOccLayer: { value: 0 },
      },
    });
    this.shadowMat = new THREE.ShaderMaterial({
      ...common,
      fragmentShader: SHADOW_FRAG,
      uniforms: {
        ...atmosphere.sharedUniforms,
        ...this.uniforms,
        uBuildCenter: { value: new THREE.Vector2() },
        uBuildSun: { value: new THREE.Vector3(0, 1, 0) },
      },
    });
    // 天气版（PERF-10）：同一份源码加雷暴 + 台风，共用同一批 uniform；有雷暴 / 台风且编好时代替默认版
    this.shadowWeatherMat = new THREE.ShaderMaterial({ ...common, fragmentShader: SHADOW_FRAG, defines: WEATHER_DEFINES, uniforms: this.shadowMat.uniforms });
    this.keyDir = viewUniforms.uKeyDir?.value as THREE.Vector3;
    // 窗外程序通过同一个 uniform 对象读云影图（lint 的 mock 里没有这些 uniform）
    if (this.uniforms.uCloudShadowMap) this.uniforms.uCloudShadowMap.value = this.shadow[0].texture;
    this.probeMat = new THREE.ShaderMaterial({
      ...common,
      fragmentShader: PROBE_FRAG,
      uniforms: { ...viewUniforms, ...this.uniforms, uProbeDir: { value: new THREE.Vector3(1, 0, 0) } },
    });
    this.probeWeatherMat = new THREE.ShaderMaterial({ ...common, fragmentShader: PROBE_FRAG, defines: WEATHER_DEFINES, uniforms: this.probeMat.uniforms });
    // 名字给按 pass 计时用（passes.mjs 先按 material.name 归类）
    this.occMat.name = "cloud-occupancy";
    this.probeMat.name = "cloud-probe";
    this.probeWeatherMat.name = "cloud-probe-weather";
    this.resolveMat = new THREE.ShaderMaterial({
      ...common,
      fragmentShader: RESOLVE_FRAG,
      uniforms: {
        ...viewUniforms,
        uCurrent: { value: this.raw.texture },
        uCurrentDepth: { value: this.raw.depthTexture },
        uHistory: { value: null },
        uPrevCamBasis: { value: this.prevCamBasis },
        uPrevCabinToWorld: { value: this.prevCabinToWorld },
        uMotion: { value: new THREE.Vector3() },
        uReset: { value: true },
        uResetDepth: { value: false },
        uCloudResolution: this.marchMat.uniforms.uCloudResolution,
      },
    });
  }

  /**
   * 需要和其他着色器一起后台并行编译的材质与它们真正画进去的目标（启动时 main.ts 的 compileAsync 批次用）。
   * 前两项固定是默认步进、resolve（main.ts 按位置取来数程序数）。
   * 雷暴 / 台风的程序（步进天气变体、占据网格、云影图 / 探针的天气版）不在这批里（PERF-10：它们曾是启动的唯一关键路径），
   * 启动后不久在后台预编；只有一打开就有雷暴 / 台风时（以后若有这种入口）才把用得上的一起放进来，免得首屏缺天气
   */
  compileTargets(): Array<readonly [THREE.ShaderMaterial, THREE.WebGLRenderTarget]> {
    const list: Array<readonly [THREE.ShaderMaterial, THREE.WebGLRenderTarget]> = [
      [this.marchMat, this.raw],
      [this.resolveMat, this.history[0]],
      [this.shadowMat, this.shadow[1]],
    ];
    const key = this.weatherKey();
    if (key) {
      list.push([this.marchVariant(key).mat, this.raw], [this.occMat, this.occ[1]], [this.shadowWeatherMat, this.shadow[1]]);
    }
    return list;
  }

  /**
   * 云影图（默认版）的后台编译（KHR_parallel_shader_compile），不阻塞主线程。
   * main.ts 已经把它放进启动时的编译批次（compileTargets），这里几乎立刻就好
   */
  private ensureAuxCompiled(renderer: THREE.WebGLRenderer) {
    if (this.shadowState !== "idle") return;
    this.shadowState = "compiling";
    this.compileInBackground(renderer, this.shadowMat, this.shadow[1], () => (this.shadowState = "ready"));
  }

  /** 程序编好且可用（compileAsync 失败也会 resolve，要检查 diagnostics） */
  private runnable(renderer: THREE.WebGLRenderer, mat: THREE.ShaderMaterial) {
    const program = (renderer.properties.get(mat) as { currentProgram?: { getUniforms(): unknown; diagnostics?: { runnable: boolean } } }).currentProgram;
    program?.getUniforms();
    return !!program && program.diagnostics?.runnable !== false;
  }

  /** 取（没有就建）一个云步进变体的材质，和 marchMat 共用同一批 uniform 对象（PERF-10） */
  private marchVariant(key: string) {
    let v = this.marchVariants.get(key);
    if (!v) {
      const mat = new THREE.ShaderMaterial({
        depthTest: true,
        depthWrite: true,
        depthFunc: THREE.AlwaysDepth,
        toneMapped: false,
        vertexShader: FULLSCREEN_VERT,
        fragmentShader: MARCH_FRAG,
        defines: marchDefines(key),
        uniforms: this.marchMat.uniforms,
      });
      mat.name = `cloud-march-${key}`;
      v = { mat, state: "idle" };
      this.marchVariants.set(key, v);
    }
    return v;
  }

  /** 后台编译一个云步进变体（已经在编 / 编好了就什么都不做），返回它此刻的状态 */
  private requestMarch(key: string): VariantState {
    const v = this.marchVariant(key);
    const renderer = this.pass.renderer;
    if (v.state === "idle" && renderer) {
      v.state = "compiling";
      this.compileInBackground(renderer, v.mat, this.raw, () => {
        v.state = this.runnable(renderer, v.mat) ? "ready" : "failed";
        // 静默失效最难查（审查建议）：天气变体编不过时，导演会一直推迟摆放这种天气
        if (v.state === "failed") console.warn(`[clouds] 云步进变体 "${key}" 编译失败：含这些特性的组合改画已编好的子集${/[ST]/.test(key) ? "，导演不再摆放对应的雷暴 / 台风" : ""}`);
      });
    }
    return v.state;
  }

  /**
   * 这一帧想画的步进变体键（PERF-10）：**选变体的唯一规则**，步进（pickMarch）、导演预告（prepareWeather）都从这里算，
   * 免得各算各的对不上（审查返工：预告只看 S / T，卷云 / 奇观在场时摆了雷暴，步进要的 CS / WCS 没编好，整层卷云 / 奇观当场跳变）。
   * extra：预告时额外要加的天气（"S" / "T"）
   */
  private wantedKey(extra = "") {
    const u = this.uniforms;
    const wonder = this.wonderState === "ready" && this.marchMat.uniforms.uWonderVol.value > 0.5;
    const cirrus = u.uCloudType.value < 0.2;
    const w = this.weatherKey() + extra;
    return (wonder ? "WC" : cirrus ? "C" : "") + (w.includes("S") ? "S" : "") + (w.includes("T") ? "T" : "");
  }

  /** 天气小程序（占据网格、云影图 / 探针天气版）这一帧用不用：只在步进实际画的变体带雷暴 / 台风时用，三者始终一致 */
  private weatherAuxOn() {
    return this.weatherAuxState === "ready" && /[ST]/.test(this.marchShown);
  }

  /** 此刻场上的天气要哪种天气变体："" 没有雷暴 / 台风，"S" / "T" / "ST" */
  private weatherKey() {
    const u = this.uniforms;
    return (u.uStormCount?.value > 0 ? "S" : "") + (u.uHurricane?.value.w > 0.5 ? "T" : "");
  }

  /**
   * 天气版的小程序（占据网格、云影图 / 探针的天气版）和雷暴、台风两个步进变体的后台预编（PERF-10）。
   * 启动后约 WEATHER_PREWARM_PROBES 次 probe 自动开始（首帧早已画完；天气导演随时可能摆出雷暴 / 台风，而且它们本来就摆在视野外，
   * 有时间等编译）；场上一出现雷暴 / 台风、或导演预告（prepareWeather）时立刻开始
   */
  private prewarmWeather(renderer: THREE.WebGLRenderer, now = false) {
    if (!now && ++this.prewarmCount < WEATHER_PREWARM_PROBES) return;
    if (this.weatherAuxState === "idle") {
      this.weatherAuxState = "compiling";
      let left = 3;
      let ok = true;
      const done = (mat: THREE.ShaderMaterial) => () => {
        if (!this.runnable(renderer, mat)) ok = false;
        if (--left === 0) {
          this.weatherAuxState = ok ? "ready" : "failed";
          if (!ok) console.warn("[clouds] 占据网格 / 云影图 / 探针的天气版编译失败：雷暴 / 台风没有云影、探针看不到它们（步进照画）");
        }
      };
      this.compileInBackground(renderer, this.occMat, this.occ[1], done(this.occMat));
      this.compileInBackground(renderer, this.shadowWeatherMat, this.shadow[1], done(this.shadowWeatherMat));
      this.compileInBackground(renderer, this.probeWeatherMat, this.probeTarget, done(this.probeWeatherMat));
    }
    this.requestMarch("S");
    this.requestMarch("T");
    // 卷云层 / 云间层奇观正在画时，顺带预编它们和雷暴 / 台风的组合（导演一摆天气就要用；wantedKey("S") = "CS" / "WCS"）
    const base = this.wantedKey().replace(/[ST]/g, "");
    if (base) {
      this.requestMarch(base + "S");
      this.requestMarch(base + "T");
    }
  }

  /**
   * 导演的「预告」钩子（PERF-10）：马上要摆雷暴（storm）/ 台风（typhoon）时调用，立刻后台编需要的变体（连同场上已有的另一种天气），
   * 返回现在能不能画出来。导演据此推迟摆放，直到变体编好（摆放本来就等遮挡 / 视野外，推迟几秒看不出来）
   */
  prepareWeather(storm: boolean, typhoon: boolean): boolean {
    const renderer = this.pass.renderer;
    if (renderer) this.prewarmWeather(renderer, true);
    // 按步进的同一规则拼完整的键（含场上的卷云 / 奇观，以及已有的另一种天气）：摆放之后步进要画的就是它
    const key = this.wantedKey((storm ? "S" : "") + (typhoon ? "T" : ""));
    if (!/[ST]/.test(key)) return true;
    // 天气小程序也要编好（失败了就不等：步进照画，只是没有云影）
    const auxDone = this.weatherAuxState === "ready" || this.weatherAuxState === "failed";
    return this.requestMarch(key) === "ready" && auxDone;
  }

  private compileInBackground(renderer: THREE.WebGLRenderer, mat: THREE.ShaderMaterial, target: THREE.WebGLRenderTarget, done: () => void) {
    const geo = new THREE.BufferGeometry();
    geo.setAttribute("position", new THREE.Float32BufferAttribute([-1, -1, 0, 3, -1, 0, -1, 3, 0], 3));
    geo.setAttribute("uv", new THREE.Float32BufferAttribute([0, 0, 2, 0, 0, 2], 2));
    const scene = new THREE.Scene();
    const mesh = new THREE.Mesh(geo, mat);
    mesh.frustumCulled = false;
    scene.add(mesh);
    const prev = renderer.getRenderTarget();
    renderer.setRenderTarget(target);
    const job = renderer.compileAsync(scene, new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1));
    renderer.setRenderTarget(prev);
    job.then(done, done).finally(() => geo.dispose());
  }

  /** 云间层奇观变体的后台编译（W00）：有奇观在场或预热时开始；compileAsync 失败也会 resolve，要检查程序是否可用 */
  private ensureWonderCompiled(renderer: THREE.WebGLRenderer) {
    if (this.wonderState !== "idle") return;
    if (!this.wonderPrewarm && !(this.marchMat.uniforms.uWonderVol.value > 0.5)) return;
    this.wonderState = "compiling";
    // 两个程序（步进变体、表面 pass）并行编译，都好了才用
    let left = 2;
    let ok = true;
    const done = (mat: THREE.ShaderMaterial) => () => {
      if (!this.runnable(renderer, mat)) ok = false;
      if (--left === 0) this.wonderState = ok ? "ready" : "failed";
    };
    const wc = this.marchVariant("WC");
    wc.state = "compiling";
    this.compileInBackground(renderer, wc.mat, this.raw, () => {
      wc.state = this.runnable(renderer, wc.mat) ? "ready" : "failed";
      done(wc.mat)();
    });
    this.compileInBackground(renderer, this.wonderSurfMat, this.wonderSurf, done(this.wonderSurfMat));
  }

  /**
   * 卷云变体的后台编译（T12）：要画卷云时立刻开始；否则启动后约 300 次 probe（十几秒，启动的编译批次早已结束）再预热，
   * 以后导演换到卷云时不用等。编好之前卷云按普通层状云画
   */
  private cirrusProbeCount = 0;
  private ensureCirrusCompiled() {
    if (this.marchVariant("C").state !== "idle") return;
    if (this.uniforms.uCloudType.value >= 0.2 && ++this.cirrusProbeCount < 300) return;
    this.requestMarch("C");
  }

  /** 卷云变体的状态（调试 / 回归场景等它编好用）：idle / compiling / ready / failed */
  get cirrusLayerState() {
    return this.marchVariant("C").state;
  }

  /**
   * 想画的步进变体还没编好、正在用替代的变体画（PERF-10：雷暴 / 台风 / 组合变体第一次需要时后台编译）。
   * 回归脚本（scripts/scenarios.mjs 的 applyScene）等它变成 false 再截图；编译失败的变体不算（不会再等到它）
   */
  get cloudVariantPending() {
    // 有雷暴 / 台风时，云影图 / 探针的天气版也要等（它们编好后云影图还要按分片节奏重建一次，约 16 帧）
    if (this.weatherKey() && (this.weatherAuxState === "idle" || this.weatherAuxState === "compiling")) return true;
    if (this.marchShown === this.marchWanted) return false;
    return this.marchVariant(this.marchWanted).state !== "failed";
  }

  /** 调试：各个步进变体的编译状态（键见 MARCH_FEATURES）、这一帧想画 / 实际画的变体、天气小程序的状态 */
  get variantStatus() {
    const march: Record<string, VariantState> = {};
    for (const [k, v] of this.marchVariants) march[k || "default"] = v.state;
    return { march, wanted: this.marchWanted, shown: this.marchShown, weatherAux: this.weatherAuxState, depthOn: this.depthOn };
  }

  /**
   * 这一帧用哪个步进变体画（PERF-10）：想要的特性（奇观层、卷云、雷暴、台风）里，挑已经编好的、权重最大的子集；
   * 想要的组合没编好就顺手开始后台编。默认程序（空集）总是可用，所以最坏是「天气系统暂时不画，普通云照常」，不会画空或同步卡住
   */
  private pickMarch(): string {
    const want = this.wantedKey();
    this.marchWanted = want;
    if (want) {
      // 卷云单独要（"C"）时照旧按 T12 的节奏（ensureCirrusCompiled，probe 里），这里只管其余组合
      if (want !== "C") this.requestMarch(want);
    }
    let best = "";
    let bestW = -1;
    const feats = MARCH_FEATURES.filter((f) => want.includes(f.id));
    for (let mask = 0; mask < 1 << feats.length; mask++) {
      const sub = feats.filter((_, i) => mask & (1 << i));
      const key = sub.map((f) => f.id).join("");
      if (key.includes("W") && !key.includes("C")) continue;
      if (this.marchVariants.get(key)?.state !== "ready") continue;
      const w = sub.reduce((s, f) => s + f.weight, 0);
      if (w > bestW) {
        bestW = w;
        best = key;
      }
    }
    return best;
  }

  /** 云间层奇观变体的状态（调试 / 面板用）：idle 没编过、compiling 后台编译中、ready 可用、failed 编译失败 */
  get wonderLayerState() {
    return this.wonderState;
  }

  /**
   * 云影图（T27）：云本身在世界坐标里不动，只在主光源方向变了（> 0.01°）或飞机走远了（> 4 km）时重建，
   * 在后台缓冲里分 SHADOW_SLICES 帧建完再换到前台；云 / 天气变了（用户操作）时一帧建完，免得看到旧云的影子
   */
  private updateShadow() {
    const u = this.uniforms;
    if (this.shadowState !== "ready" || !this.keyDir) return;
    // 有雷暴 / 台风时用天气版（PERF-10）；天气版还没编好时先用默认版（天气系统暂时没有影子），编好后按分片节奏重建一次
    // 和步进实际画的变体一致（weatherAuxOn）：步进还没画出雷暴 / 台风时，云影也不带它们
    const mat = this.weatherAuxOn() ? this.shadowWeatherMat : this.shadowMat;
    if (mat !== this.shadowProg) {
      this.shadowProg = mat;
      // 换程序等于有无整个天气系统：正在分片建的那张作废，从第 0 片按分片节奏重建（审查建议：否则半张有影子、半张没有）
      this.shadowGradual = true;
      this.shadowSlice = -1;
    }
    const key = [
      u.uCloudBottom.value, u.uCloudTop.value, u.uCoverage.value, u.uCloudType.value, u.uCloudDensity.value,
      u.uShellBottom.value, u.uShellTop.value,
      u.uStorms.value.slice(0, u.uStormCount.value).map((v) => v.toArray().join(",")).join(";"),
      u.uHurricane.value.toArray().join(","), u.uUpperWind.value.toArray().join(","),
      mat === this.shadowWeatherMat ? "w" : "d",
    ].join("|");
    const bu = this.shadowMat.uniforms;
    const c = u.uCloudShadowCenter.value;
    const off = u.uCloudOffset.value;
    // 天气参数渐变（T19b，setParams 的 gradual）：变化很小，按分片节奏重建即可，免得每次推进都整张一帧重建（3–8 ms）
    let restart = false;
    if (key !== this.shadowKey && this.shadowGradual && c.z > 0.5) {
      this.shadowKey = key;
      restart = this.shadowSlice < 0;
    }
    this.shadowGradual = false;
    const now = key !== this.shadowKey || c.z < 0.5;
    if (!now && !restart && this.shadowSlice < 0) {
      const drift = Math.hypot(off.x - c.x, off.y - c.y);
      if (drift < SHADOW_RECENTER_KM && this.keyDir.dot(u.uCloudShadowSun.value) > SHADOW_SUN_COS) return;
    }
    if (now || this.shadowSlice < 0) {
      // 开始建一张新的：中心对齐到格点上，光源方向取现在的
      this.shadowKey = key;
      bu.uBuildCenter.value.set(Math.round(off.x / SHADOW_SNAP_KM) * SHADOW_SNAP_KM, Math.round(off.y / SHADOW_SNAP_KM) * SHADOW_SNAP_KM);
      bu.uBuildSun.value.copy(this.keyDir);
      this.shadowSlice = 0;
    }
    const back = this.shadow[1];
    const rows = CLOUD_SHADOW_RES / SHADOW_SLICES;
    const end = now ? SHADOW_SLICES : this.shadowSlice + 1;
    back.scissorTest = !now;
    back.scissor.set(0, this.shadowSlice * rows, CLOUD_SHADOW_RES * 3, (end - this.shadowSlice) * rows);
    this.pass.render(mat, back);
    back.scissorTest = false;
    this.shadowSlice = end;
    if (end < SHADOW_SLICES) return;
    // 建完：换到前台
    this.shadowSlice = -1;
    this.shadow = [back, this.shadow[0]];
    u.uCloudShadowMap.value = back.texture;
    u.uCloudShadowSun.value.copy(bu.uBuildSun.value);
    c.set(bu.uBuildCenter.value.x, bu.uBuildCenter.value.y, 1);
  }

  /**
   * 雷暴 / 台风的占据网格：天气变了、或飞机离网格中心太远时，在后台缓冲里分帧重建（每帧 OCC_LAYERS_PER_FRAME 层），
   * 建完换到前台。天气变了时前台立刻作废（这几帧步进照旧逐点求值）；只是飞远了时前台继续用，网格覆盖 ±128 km 足够。
   * 没有雷暴 / 台风时什么都不做（步进里也不查网格）。all = true：一次建完（调试 / 计时用）
   */
  private updateOccupancy(all = false) {
    const u = this.uniforms;
    const mu = this.marchMat.uniforms;
    const hasWeather = u.uStormCount.value > 0 || u.uHurricane.value.w > 0.5;
    if (!hasWeather || this.weatherAuxState !== "ready" || !this.occEnabled) {
      mu.uOccValid.value = 0;
      return;
    }
    const storms = u.uStorms.value.slice(0, u.uStormCount.value).map((v) => v.toArray().join(","));
    const key = [storms.join(";"), u.uHurricane.value.toArray().join(","), u.uUpperWind.value.toArray().join(","), u.uShellBottom.value, u.uShellTop.value].join("|");
    const off = u.uCloudOffset.value;
    if (key !== this.occKey) this.occKey = ""; // 天气变了：前台作废
    mu.uOccValid.value = this.occKey ? 1 : 0;
    const building = this.occBuildLayer >= 0 && this.occBuildKey === key;
    if (!building && (!this.occKey || off.distanceTo(this.occCenter) >= OCC_RECENTER_KM)) {
      // 开始（或因天气又变了而重新开始）建后台网格。中心对齐到格点上，前后两次重建的格点位置一致
      this.occBuildKey = key;
      this.occBuildCenter.set(Math.round(off.x / OCC_SPACING) * OCC_SPACING, Math.round(off.y / OCC_SPACING) * OCC_SPACING);
      const half = ((OCC_N - 1) / 2) * OCC_SPACING;
      const ou = this.occMat.uniforms;
      ou.uOccOrigin.value.set(this.occBuildCenter.x - half, this.occBuildCenter.y - half);
      const bottom = u.uShellBottom.value;
      ou.uOccAlt.value.set(bottom, (u.uShellTop.value - bottom) / (OCC_LAYERS - 1));
      this.occBuildLayer = 0;
    }
    if (this.occBuildLayer < 0) return;
    const back = this.occ[1];
    const tex = back.texture;
    const end = all ? OCC_LAYERS : Math.min(OCC_LAYERS, this.occBuildLayer + OCC_LAYERS_PER_FRAME);
    for (let k = this.occBuildLayer; k < end; k++) {
      this.occMat.uniforms.uOccLayer.value = k;
      // 只在画最后一层时生成 mipmap（three 每画一层都会按这个开关重新生成一遍）
      tex.generateMipmaps = k === OCC_LAYERS - 1;
      this.pass.render(this.occMat, back, k);
    }
    tex.generateMipmaps = false;
    this.occBuildLayer = end;
    if (end < OCC_LAYERS) return;
    // 建完：换到前台
    this.occBuildLayer = -1;
    this.occ = [back, this.occ[0]];
    mu.uOcc.value = back.texture;
    mu.uOccOrigin.value.copy(this.occMat.uniforms.uOccOrigin.value);
    mu.uOccAlt.value.copy(this.occMat.uniforms.uOccAlt.value);
    this.occKey = this.occBuildKey;
    this.occCenter.copy(this.occBuildCenter);
    mu.uOccValid.value = 1;
  }

  /** 每几帧调用一次：在 GPU 上算飞机位置的云密度，异步读回（不阻塞渲染） */
  probe(renderer: THREE.WebGLRenderer, heading: THREE.Vector3) {
    this.ensureAuxCompiled(renderer);
    this.ensureWonderCompiled(renderer);
    this.ensureCirrusCompiled();
    // 雷暴 / 台风变体：启动后不久预编；场上已经有雷暴 / 台风（面板手选）就立刻开始
    const weather = this.weatherKey() !== "";
    this.prewarmWeather(renderer, weather);
    if (this.probeBusy) return;
    this.probeMat.uniforms.uProbeDir.value.copy(heading);
    // 有雷暴 / 台风时用天气版探针（穿进雷暴时的颠簸、窗上的水、舱内光照）；没编好之前用默认版（只看得到层状云）
    this.pass.render(this.weatherAuxOn() ? this.probeWeatherMat : this.probeMat, this.probeTarget);
    this.probeBusy = true;
    renderer
      .readRenderTargetPixelsAsync(this.probeTarget, 0, 0, 1, 1, this.probePixel)
      .then(() => {
        this.cameraDensity = this.probePixel[0];
        this.keyTransmittanceRaw = this.probePixel[1];
        this.keyOpticalDepthRaw = this.probePixel[2];
      })
      .finally(() => (this.probeBusy = false));
  }

  /**
   * 舱内 / 机翼光照的云乘子（场景 uniform uKeyCloud，T31），每帧调用一次，写进 out：
   *  x：直射主光源的云透射率 e^−τ（τ 是飞机朝主光源的云光学厚度）；
   *  y：被云散射成漫射光的那部分，占「主光源在水平面上的照度」的比例；
   *  z：天空光的乘子。
   * 在云里（探针密度 > 0）才算漫射：云几乎不吸收，挡掉的直射光变成四面八方的白光，舱内被窗外的白雾照亮，
   * 而不是只剩天空的蓝光（只乘直射透射率时舱内整个发蓝、发暗）。漫射量用守恒散射的二流近似：
   * 总透射 ≈ 1 / (1 + 0.75(1 − g)τ)，g = 0.85，扣掉直射那部分；天空光同样按总透射衰减。
   * 在云下（被云影挡住但人不在云里）：漫射照样加（头顶的云底 / 卷云盖被照亮，是白灰色的光源），
   * 天空光不衰减（四周仍是蓝天）。只去掉直射时，台风卷云盖下面的舱内整个发蓝、发暗。
   * 探针每 4 帧一个值、单条光线，穿过碎云边缘时会抖：按时间常数 KEY_VIS_TAU 秒指数平滑
   */
  keyVisibility(dt: number, out: THREE.Vector3) {
    const tau = Math.max(this.keyOpticalDepthRaw, 0);
    const tDir = this.keyTransmittanceRaw;
    const tTot = 1 / (1 + 0.1125 * tau);
    const immersed = THREE.MathUtils.smoothstep(this.cameraDensity, 0.01, 0.08);
    const k = 1 - Math.exp(-dt / KEY_VIS_TAU);
    this.keyVis.x += (tDir - this.keyVis.x) * k;
    this.keyVis.y += (Math.max(tTot - tDir, 0) - this.keyVis.y) * k;
    this.keyVis.z += (1 + (tTot - 1) * immersed - this.keyVis.z) * k;
    // C02：飞机在云里 = 窗外一片白茫茫，交给曝光的雪景补偿（⑤）。原来靠「窗外线性均值 ≈ 对数均值」判断，
    // C01 以后云里的雾不再被高阶散射抹得那么匀（机翼比雾亮），判据落在边缘；这里直接给曝光一个「在云里」的量，按 0.5 s 平滑（眼睛的亮适应量级）
    this.whiteout += (immersed - this.whiteout) * (1 - Math.exp(-dt / 0.5));
    EXPOSURE_WHITEOUT.value = this.whiteout;
    return out.copy(this.keyVis);
  }

  get texture() {
    return this.history[0].texture;
  }

  /** 此刻的云层参数（T19b：导演从这里起步做插值） */
  params(): CloudParams {
    const u = this.uniforms;
    return { bottom: u.uCloudBottom.value, top: u.uCloudTop.value, coverage: u.uCoverage.value, type: u.uCloudType.value, density: u.uCloudDensity.value };
  }

  /**
   * 天气参数的插值接口（T19b，连续航程的导演用）。gradual：连续推进的一小步——不清时间累积（history），
   * 云影图按后台分片的节奏跟上，不整张一帧重建；false：借遮挡的硬切，和 applyPreset 一样立刻清掉累积。
   * 改了高度范围后调用方还要调 weather.updateShell()
   */
  setParams(p: Partial<CloudParams>, gradual: boolean) {
    const u = this.uniforms;
    if (p.bottom !== undefined) u.uCloudBottom.value = p.bottom;
    if (p.top !== undefined) u.uCloudTop.value = p.top;
    if (p.coverage !== undefined) u.uCoverage.value = p.coverage;
    if (p.type !== undefined) u.uCloudType.value = p.type;
    if (p.density !== undefined) u.uCloudDensity.value = p.density;
    if (gradual) this.shadowGradual = true;
    else this.snap();
  }

  applyPreset(p: CloudPreset) {
    const u = this.uniforms;
    u.uCloudBottom.value = p.bottom;
    u.uCloudTop.value = p.top;
    u.uCoverage.value = p.coverage;
    u.uCloudType.value = p.type;
    u.uCloudDensity.value = p.density;
    this.snap();
  }

  snap() {
    this.reset = true;
  }

  setSize(fullWidth: number, fullHeight: number) {
    // 降分辨率步进，时间累积补回细节
    const w = Math.max(1, Math.round(fullWidth * this.resolutionScale));
    const h = Math.max(1, Math.round(fullHeight * this.resolutionScale));
    this.raw.setSize(w, h);
    this.wonderSurf.setSize(w, h);
    // 云缓冲两倍宽：右半是云的平均深度（T38，见 RESOLVE_FRAG）
    for (const t of this.history) t.setSize(2 * w, h);
    this.marchMat.uniforms.uCloudResolution.value.set(w, h);
    this.reset = true;
  }

  /**
   * motion：上一帧到这一帧，云相对相机的位移反过来（km，窗外坐标）。飞机向前飞，云向后退，
   * 所以同一朵云上一帧在「现在的位置 + 飞机位移」。
   */
  render(motion: THREE.Vector3, camBasis: THREE.Matrix3, cabinToWorld: THREE.Matrix3) {
    this.updateOccupancy();
    this.updateShadow();
    this.marchMat.uniforms.uFrame.value = this.frame++ % 64;
    // 步进变体（PERF-10，pickMarch）：奇观层（W00，奇观 pass 编好且奇观在场）、卷云（T12，云型 < 0.2）、雷暴、台风，
    // 想要的组合没编好之前画已编好的子集（编好之前奇观不画 / 卷云按普通层状云画 / 天气系统暂时不画，普通云照常）
    const key = this.pickMarch();
    this.marchShown = key;
    if (key.includes("W")) this.pass.render(this.wonderSurfMat, this.wonderSurf);
    this.pass.render(this.marchVariant(key).mat, this.raw);

    const [prev, next] = this.history;
    const r = this.resolveMat.uniforms;
    r.uCurrent.value = this.raw.texture;
    r.uCurrentDepth.value = this.raw.depthTexture;
    r.uHistory.value = prev.texture;
    r.uMotion.value.copy(motion);
    r.uReset.value = this.reset;
    // 云缓冲右半（云的平均深度，T38）只在附近有高出海面的真实地形时写（PERF-11）：它只用来判断「云在山前还是山后」，
    // 海面 / 没开真实地理时用不上，却让 resolve 多一倍像素。停用期间右半不更新（窗外按 uCloudDepthOn = 0 不读），
    // 重新启用的那一帧右半不取历史（旧内容早已过时）
    const v = this.view;
    // 相机离地很低（火车 TR03、低空）时常开：平原上几十米的小丘也挡得住贴地平线的远云（审查建议）
    const camAlt = (v.uCamR?.value ?? 1e9) - 6360;
    const depthOn = (v.uGroundOn?.value ?? 0) > 0.5 && ((v.uTerrainMax?.value ?? 0) > DEPTH_TERRAIN_MIN_KM || camAlt < DEPTH_LOW_CAMERA_KM);
    r.uResetDepth.value = depthOn && !this.depthOn;
    this.depthOn = depthOn;
    if (this.uniforms.uCloudDepthOn) this.uniforms.uCloudDepthOn.value = depthOn ? 1 : 0;
    const w = this.marchMat.uniforms.uCloudResolution.value;
    next.scissorTest = !depthOn;
    next.scissor.set(0, 0, w.x, w.y);
    this.pass.render(this.resolveMat, next);
    next.scissorTest = false;
    this.history = [next, prev];
    this.reset = false;
    this.prevCamBasis.copy(camBasis);
    this.prevCabinToWorld.copy(cabinToWorld);
  }
}
