import * as THREE from "three";
import { ATMOSPHERE_COMMON, FULLSCREEN_VERT } from "../atmosphere/common.glsl";
import type { Atmosphere } from "../atmosphere/luts";
import { CLOUD_COMMON } from "../clouds/clouds.glsl";
import { CABIN_COMMON, PANE_COMMON } from "./cabin.glsl";
import { CABIN_SHADING_COMMON } from "./cabin-shading.glsl";
import { LEATHER_COMMON } from "./cabin-leather.glsl";
import { SEATS_COMMON } from "./seats.glsl";
import { VIEW_COMMON } from "./view.glsl";
import { GROUND_LEVELS, type GroundClipmap } from "../ground/clipmap";
import { GROUND_COMMON } from "./ground.glsl";
import { GROUND_DETAIL_COMMON } from "./ground-detail.glsl";
import { INLAND_WATER_COMMON } from "./inland-water.glsl";
import { ISLANDS_COMMON } from "./islands.glsl";
import { LIGHTNING_COMMON } from "./lightning.glsl";
import { LIGHTS_COMMON } from "./lights.glsl";
import { OCEAN_COMMON } from "./ocean.glsl";
import { STARS_COMMON } from "./stars.glsl";
import { TERRAIN_SHADING_COMMON } from "./terrain-shading.glsl";
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
uniform float uMoodLight;       // 氛围洗墙灯开关 0..1（T20；颜色随时段与舱灯自动变）
uniform float uTime;            // 秒，给波浪和闪烁用
uniform float uWetness;         // 窗板外侧的湿度 0..1
uniform float uCameraFog;       // 飞机所在位置云的消光系数（1/km），机翼要隔着这层雾看
uniform float uHdrMax;          // HDR 目标能存的最大值（半精度时是 6e4）
// 调试可视化：0 关，1 内衬命中深度，2 亮度（伪彩），3 内衬受到的窗光，4 内衬法线，
// 5 海面本身，6 海面天空反射，7 海面的内散射，8 海面粗糙度 / 像素覆盖，9 海面直射照度，10 闪烁格子，
// 11 白浪覆盖率 / 本地粗糙度，12 海面可分辨的平均斜率（11、12 见 ocean.glsl.ts），
// 21 真实地面的地表分类（红 树林、绿 农田、蓝 城区），22 真实地面的像素足迹（21、22 只在低空细节变体里有），
// 23 真实地面的水体遮罩（红 水面、绿 海洋通道、蓝 夜光）
uniform int uDebug;
varying vec2 vUv;
${TRAFFIC_COMMON}

const float PANE_TRANSMITTANCE = 0.85;

// 输出的 alpha 只给机翼 pass 读（它再把窗外遮罩写回自己的输出给曝光用），所以这里把两样东西打包进 alpha 的 32 位里：
// 窗外遮罩 m（5 位）和「与窗外颜色无关的部分」A = 结果 − m·k·O（RGB 各 6 位 + 共享指数），
// O 是窗外加窗板效果之前的颜色，k 是窗板效果的乘性系数（油污、水珠暗边与透镜化、透气孔，机翼 pass 按同一公式重算）。
// 机翼 pass 合成：(1 − a)·场景 + a·(A + m·k·机翼)，a 是机翼覆盖率。划痕、水痕、舱内反射都在 A 里，照样叠在机翼上。
// 为什么存 A 而不是 O：量化误差按所存量的大小走。O 是明亮的天空，6 位量化的误差（约 1%）换到暗的机翼上就是满屏彩色噪点；
// A 在窗内只是窗板的附加亮度，很小，误差可以忽略。
// 为什么不用第二个渲染目标（MRT）：Windows 上 ANGLE 的 D3D 后端链接时只按单目标生成像素着色器，
// 画进两张目标时要在首帧同步重编整个场景着色器（实测首帧卡 50 秒、有时丢上下文）；也不能给场景加 sampler（已 16/16）。
// 位布局：0–4 m，5–10 R，11–16 G，17–22 B，23 恒为 1，24–28 指数 + 20，29–31 为 0——浮点指数域落在 1..63，
// 既不是 0（非规格数可能被冲成 0）也不是全 1（NaN / Inf 可能被规范化），原样存得下。半精度目标存不下，uHdrMax 小于 1e10 时不打包
float packWingRef(float m, vec3 o) {
  if (uHdrMax < 1e10) return m;
  float mx = max(max(o.r, o.g), max(o.b, 1e-30));
  int e = clamp(int(floor(log2(mx))) + 1, -20, 11);
  uvec3 q = uvec3(clamp(round(o / exp2(float(e)) * 63.0), 0.0, 63.0));
  uint bits = uint(round(clamp(m, 0.0, 1.0) * 31.0)) | (q.r << 5) | (q.g << 11) | (q.b << 17) | (1u << 23) | (uint(e + 20) << 24);
  return uintBitsToFloat(bits);
}      // 两层亚克力 + 内层防刮板
const vec3 PLASTIC_ALBEDO = vec3(0.78, 0.76, 0.72);

${OCEAN_COMMON}
${LIGHTNING_COMMON}
${GROUND_DETAIL_COMMON}
${INLAND_WATER_COMMON}
${TERRAIN_SHADING_COMMON}

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

${CABIN_SHADING_COMMON}
${LEATHER_COMMON}
${SEATS_COMMON}

void main() {
  vec3 viewPre = vec3(0.0);   // 窗外加窗板效果之前的颜色，打包给机翼 pass
  float paneK = 1.0;          // 窗板效果的乘性系数（和 wing-pass.ts 的公式一致）
  vec3 rd = cabinRay(gl_FragCoord.xy);
  vec3 ro = uHead;

  // ---- 所有屏幕导数都在任何循环和分支之前算好（分支里的导数没有定义） ----
  float rdz = max(rd.z, 1e-4);
  vec3 pWall = ro + rd * ((0.0 - ro.z) / rdz);
  vec3 pShade = ro + rd * ((SHADE_DEPTH - ro.z) / rdz);
  vec3 pPane = ro + rd * ((PANE_DEPTH - ro.z) / rdz);
  // 最近的那扇窗（0 = 本窗，±1 = 前后相邻的窗，遮光板放下）；两窗正中间两边的距离相等，所以距离场是连续的。
  // 窗洞、遮光板都在这扇窗的局部坐标里算（只差一个 x 平移）
  float wi = floor(pWall.x / WINDOW_PITCH + 0.5);
  float isMain = wi == 0.0 ? 1.0 : 0.0;
  vec2 wOff = vec2(wi * WINDOW_PITCH, 0.0);
  vec2 wq = pWall.xy - wOff;
  float dBezel = sdRoundRect(wq, BEZEL_HALF, BEZEL_RADIUS);
  float dPane = sdRoundRect(pPane.xy - wOff, PANE_HALF, PANE_RADIUS);
  // 抗锯齿宽度设上限：视线几乎贴着舱壁时交点飞到很远，导数会大到把几层颜色混在一起
  float wB = min(fwidth(dBezel), 0.005);
  float wP = min(fwidth(dPane), 0.005);
  float wS = min(fwidth(pShade.y), 0.005);
  float pixPane = max(length(fwidth(pPane.xy)), 1e-5);
  float pixShade = max(length(fwidth(pShade.xy)), 1e-5);
  float pixAng = 2.0 * uTanHalfFov / uResolution.y; // 一个像素的张角（分支里用它算解析的像素足迹）

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
  // 窗板反射舱内时仍用这一版（窗外画面与改前一致）；舱内表面的环境光里满舱窗户的回弹再多算一些（经验值）
  vec3 eCabinRefl = eCabin;
  eCabin += 0.03 * M_PI * lWin;
  CabinLights cl;
  cl.sunC = sunC;
  cl.eSunNormal = eSunNormal;
  cl.lWin = lWin;
  cl.eCabin = eCabin;
  // 遮光板放下的邻窗：外面的光透过半透的白塑料（和本窗遮光板的透光系数一致）
  cl.lGlow = PLASTIC_ALBEDO / M_PI * 0.08 * (M_PI * lWin + eSunNormal * max(sunC.z, 0.0));
  cl.readOn = 1.0 - smoothstep(0.005, 0.05, uCabinLight);
  // 灯光场景（T20）：主灯色温随时段变（白天中性、夜里暖琥珀），行李架下的氛围洗墙灯（关灯时是淡紫蓝的睡眠光）。
  // 只改舱内表面用的 cl.eCabin；窗板反射舱内用的 eCabinRefl 不动，窗外画面与测光不变
  vec3 mainTint, moodI;
  cabinMoodScene(uCabinLight, uSunDir.y, uMoodLight, mainTint, moodI);
  cl.eCabin += uCabinLight * (mainTint - CABIN_LIGHT_COLOR) + moodI * 0.05; // 洗墙光在上墙、行李架之间的回弹
  cl.moodI = moodI;

  // ---- 座椅：挡在侧壁和窗前面（见 seats.glsl.ts） ----
  float tWall = rd.z > 1e-4 ? traceWall(ro, rd) : 1e3;
  SeatHit seat = traceSeats(ro, rd, tWall, pixAng);
  vec3 seatCol = seat.cov > 0.0 ? shadeSeat(ro, rd, seat, pixAng, cl, uShadeBottom) : vec3(0.0);

  // ---- 舱壁（带弧度的内饰板、窗罩翻边、接缝、脏污；见 cabin-shading.glsl.ts） ----
  vec3 pW = ro + rd * tWall;
  // 座椅顶在窗中心以下约 5 cm，再往上 12 cm 以外不可能有接触阴影，省掉距离场
  float wallSeatAO = pW.y < 0.08 ? mix(0.55, 1.0, smoothstep(0.0, 0.12, sdSeats(pW))) : 1.0;
  float seed = wi * 3.7 + 1.0;
  vec3 wall = shadeWall(pW, rd, tWall, pixAng, wq, dBezel, seed, wallSeatAO, cl);
  // 窗板反射舱内用的平滑版本（和改前的舱壁一致，不带细节）
  vec3 wallRefl = PLASTIC_ALBEDO / M_PI * eCabinRefl * (1.0 + 0.35 * clamp(pWall.y / 0.4, -1.0, 1.0));
  if (rd.z < 1e-4) {
    gl_FragColor = vec4(mix(wall, seatCol, seat.cov), 0.0);
    return;
  }

  // ---- 窗洞内衬（漏斗曲面） ----
  vec3 hit;
  vec3 reveal = wall;
  float hitZ = 1.0; // 打到内衬的深度，没打到就是 1（比窗板还深）
  vec3 roL = ro - vec3(wOff, 0.0);
  float shadeBottom = mix(NB_SHADE, uShadeBottom, isMain);
  if (dBezel < 0.01 && marchFunnel(roL, rd, hit)) {
    hitZ = hit.z;
    vec3 n = funnelNormal(hit);
    reveal = shadeReveal(hit, n, rd, length(hit - roL), pixAng, cl, mix(cl.lGlow, lWin, isMain), isMain, shadeBottom, seed);
    if (uDebug == 3) reveal = windowIrradiance(hit, n, lWin);
    if (uDebug == 4) reveal = n * 0.5 + 0.5;
  }

  // ---- 遮光板：半透的白色塑料，下沿有把手（见 cabin-shading.glsl.ts） ----
  vec3 shade = shadeShade(pShade - vec3(wOff, 0.0), rd, pixShade, cl, shadeBottom, seed);

  // ---- 合成 ----
  float inBezel = 1.0 - smoothstep(-wB, wB, dBezel);
  float inPane = 1.0 - smoothstep(-wP, wP, dPane);
  // 视线在遮光板所在深度之前就打到内衬的话，遮光板被内衬挡住
  float shaded = smoothstep(-wS, wS, pShade.y - shadeBottom) * step(SHADE_DEPTH, hitZ);

  vec4 cloud = texture(uClouds, gl_FragCoord.xy / uResolution);
  // 邻窗遮光板下沿以下（窗洞最深处）：只有一点暗光
  vec3 view = reveal * 0.3;
  if (inBezel > 0.0 && isMain > 0.5) {
  // 机翼和翼尖灯不在这里画：由单独的机翼 pass（wing-pass.ts）读这张结果、按 alpha（窗外遮罩）合成上去
  vec3 rdW = uCabinToWorld * rd;
  view = outsideRadiance(rdW, cloud);
  // 远处的飞机和航迹云在云层之上，挡在海面和云前面
  vec4 tr = trafficRadiance(rdW);
  view = (view * tr.a + tr.rgb + boltRadiance(rdW)) * PANE_TRANSMITTANCE;
  viewPre = view;

  // ---- 窗板上的细节 ----
  vec2 q = pPane.xy;
  float sunLit = step(0.0, sunC.z); // 阳光照得到窗板
  vec2 sc = scratches(q, rd, sunC, pixPane);
  float sm = smudges(q);
  // 油污的前向散射：视线离太阳越近越亮，散射角大约 10–20°
  float fwdLobe = exp(-(1.0 - dot(rd, sunC)) / 0.03);
  view *= 1.0 - 0.1 * sm;
  // 划痕和擦痕的附加亮度按窗外亮度做相对上限：夜里窗外很暗、曝光拉高时，舱内光照亮的细纹不能反客为主。
  // 直射光点亮的那一路（逆光、太阳在视野附近）上限放宽
  vec3 viewRef = view;
  view += min(sunLit * eSunNormal * (0.015 * sc.x + 0.004 * sm * fwdLobe), viewRef * 0.6);
  // 划痕 / 擦痕平时也能隐约看到：被舱内光和天空漫射照到，只有背景的百分之几
  float wm = wipeMarks(q, pixPane);
  view += min(M_PI * lWin * (0.015 * sc.y + 0.006 * sm + 0.02 * wm) + eCabinRefl / M_PI * 0.1 * (sc.y + wm), viewRef * 0.03);
  view += min(sunLit * eSunNormal * 0.006 * wm * fwdLobe, viewRef * 0.3);
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
  view += fr * wallRefl * 1.5;
  paneK = (1.0 - 0.1 * sm) * (1.0 - 0.3 * edge) * (1.0 - 0.12 * wc)
    * (1.0 - 0.6 * smoothstep(0.0011, 0.0014, dHole) * (1.0 - smoothstep(0.0016, 0.0021, dHole)));
  }
  vec3 col = mix(wall, mix(mix(reveal, view, inPane), shade, shaded), inBezel);
  col = mix(col, seatCol, seat.cov);
  if (uDebug == 3 || uDebug == 4) col = mix(vec3(0.0), reveal, inBezel * (1.0 - inPane));
  if (uDebug == 1) col = vec3(hitZ / PANE_DEPTH, inBezel, shaded) * 10.0;
  if (uDebug == 2) col = vec3(log2(max(dot(col, vec3(0.2126, 0.7152, 0.0722)), 1e-6)) * 0.1 + 1.0) * 10.0;
  // HDR 目标是 32 位浮点时可以原样存下太阳的辐亮度（约 1.8e6 kcd/m²），眩光的能量才对。
  // alpha 存「这个像素有多少是窗外」，曝光时窗外和舱内分开适应
  float outsideMask = isMain * inBezel * inPane * (1.0 - shaded) * (1.0 - seat.cov);
  col = min(col, vec3(uHdrMax));
  gl_FragColor = vec4(col, packWingRef(outsideMask, max(col - outsideMask * paneK * viewPre, vec3(0.0))));
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
      uMoodLight: { value: 1 },
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
      uTerrainSteps: { value: 96 },
      uGroundLevelCount: { value: GROUND_LEVELS },
      uDetailLoop: { value: 1 },
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
      uLoopGuard: { value: 0 },
    },
  });
}

/**
 * 低空近景细节的着色器变体（带 GROUND_DETAIL 宏）。细节层让 Windows 上的冷编译几乎翻倍，而且只有离地几公里以内才看得出来，
 * 所以默认的场景着色器不含它：需要时（离地高度 < ENABLE_BELOW_KM）才用 renderer.compileAsync 在后台编译
 * （KHR_parallel_shader_compile，不阻塞渲染），编好之后才切过去。变体和默认材质共用同一份 uniforms，切换不需要同步任何状态。
 */
export class GroundDetailVariant {
  static readonly ENABLE_BELOW_KM = 4;
  /** 高于这个高度切回默认材质（带一点滞回，免得在门限附近来回切） */
  static readonly DISABLE_ABOVE_KM = 4.5;
  private material: THREE.ShaderMaterial | null = null;
  private state: "idle" | "compiling" | "ready" | "failed" = "idle";
  private active = false;

  constructor(private readonly base: THREE.ShaderMaterial) {}

  /** 每帧调用：给出离地高度（km），返回这一帧该用的材质 */
  pick(renderer: THREE.WebGLRenderer, aglKm: number): THREE.ShaderMaterial {
    if (aglKm < GroundDetailVariant.ENABLE_BELOW_KM) this.prepare(renderer);
    if (this.state !== "ready" || !this.material) return this.base;
    if (aglKm < GroundDetailVariant.ENABLE_BELOW_KM) this.active = true;
    else if (aglKm > GroundDetailVariant.DISABLE_ABOVE_KM) this.active = false;
    return this.active ? this.material : this.base;
  }

  get status() {
    return this.state;
  }

  private prepare(renderer: THREE.WebGLRenderer) {
    if (this.state !== "idle") return;
    this.state = "compiling";
    const b = this.base;
    const m = new THREE.ShaderMaterial({
      vertexShader: b.vertexShader,
      fragmentShader: b.fragmentShader,
      uniforms: b.uniforms, // 共用同一份 uniforms
      defines: { ...b.defines, GROUND_DETAIL: 1 },
      depthTest: false,
      depthWrite: false,
      toneMapped: false,
    });
    const scene = new THREE.Scene();
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute("position", new THREE.Float32BufferAttribute([-1, -1, 0, 3, -1, 0, -1, 3, 0], 3));
    geometry.setAttribute("uv", new THREE.Float32BufferAttribute([0, 0, 2, 0, 0, 2], 2));
    const mesh = new THREE.Mesh(geometry, m);
    mesh.frustumCulled = false;
    scene.add(mesh);
    renderer
      .compileAsync(scene, new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1))
      .then(() => {
        // compileAsync 只等「编译完成」，不管编译是否成功（例如函数重名）。取出程序、触发一次诊断，失败就不切换
        const program = (renderer.properties.get(m) as { currentProgram?: { getUniforms(): unknown; diagnostics?: { runnable: boolean } } }).currentProgram;
        program?.getUniforms();
        if (!program || program.diagnostics?.runnable === false) {
          this.state = "failed";
          return;
        }
        this.material = m;
        this.state = "ready";
      })
      .catch(() => {
        this.state = "failed";
      })
      .finally(() => geometry.dispose());
  }
}
