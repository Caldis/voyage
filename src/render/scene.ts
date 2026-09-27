import * as THREE from "three";
import { ATMOSPHERE_COMMON, FULLSCREEN_VERT } from "../atmosphere/common.glsl";
import type { Atmosphere } from "../atmosphere/luts";
import { CABIN_COMMON, PANE_COMMON } from "./cabin.glsl";
import { CABIN_SHADING_COMMON } from "./cabin-shading.glsl";
import { LEATHER_COMMON } from "./cabin-leather.glsl";
import { FABRIC_COMMON } from "./fabric.glsl";
import { SEATS_COMMON } from "./seats.glsl";
import { CABIN_REFLECT_COMMON } from "./cabin-reflect.glsl";
import { EXPOSURE_MODEL, EXPOSURE_MODEL_UNIFORMS, EXPOSURE_STATE } from "./exposure";
import { VIEW_COMMON } from "./view.glsl";
import { GROUND_LEVELS, type GroundClipmap } from "../ground/clipmap";
import { LIGHTS_COMMON } from "./lights.glsl";
import { WING_COMMON } from "./wing.glsl";
import { STAR_MAP_COMMON, STAR_POINTS_COMMON } from "./stars.glsl";
import type { CabinClass } from "../state";

/**
 * 场景（舱内合成）着色器：从头部位置向屏幕每个像素发射线，穿过按真实尺寸建模的舷窗、舱壁、座椅、遮光板。
 * 窗外的辐亮度不在这里算（SC-5）：由窗外 pass（outside-pass.ts）先画到一张全分辨率 HDR 目标 uOutside，
 * 这里在本窗的窗板以内按像素读回，再加窗板效果（划痕、油污、水珠、透气孔、舱内反射）并与舱内合成。输出 HDR 亮度（单位 kcd/m²）。
 * 两个程序分开编译（FXC 的编译时间随程序规模超线性增长），改舱内只重编这个程序。
 *
 * 座舱坐标（米）：原点在舱壁内饰面上的窗洞中心，x 沿舱壁（右侧座位时朝机头），y 向上，z 朝窗外。
 * 窗外坐标（km）：地心为原点，飞机正下方为 +y，x 朝东，z 朝南。
 *
 * 不要把 CLOUD_COMMON、海面、地面这些窗外模块拼进来：这个程序的源码一变就要重编，拼进来的模块越少，
 * 别人改云、改地面时这里越不受牵连（浏览器按程序的源码文本命中缓存）。舱内只用到 uCoverage，单独声明。
 *
 * 舱等（T25）：同一份源码两个变体——默认（商务舱：皮革、胡桃木、香槟金属、氛围灯）和 #define CABIN_CLASS_ECONOMY
 * （经济舱：织物座椅、浅灰塑料、冷白灯）。差别全在预处理层（cabin-shading / seats / cabin-leather / fabric / cabin-reflect
 * 里的 #ifdef），每个变体只编自己那一套；经济舱由 CabinClassVariant 在用户选中时才后台编译。
 */
const SCENE_FRAG = /* glsl */ `
${ATMOSPHERE_COMMON}
${VIEW_COMMON}
${CABIN_COMMON}
${PANE_COMMON}
${WING_COMMON}
${LIGHTS_COMMON}
uniform sampler2D uOutside;      // 窗外 pass 的结果：本窗窗板以内的窗外辐亮度 × 窗板透射率（见 outside-pass.ts）
uniform float uCoverage;         // 云量 0..1（CLOUD_COMMON 里也有，同一个 uniform；这里只为「下半球反照率」用）
uniform float uShadeBottom;
uniform float uCabinLight;      // 舱内灯光照度，klux
uniform float uMoodLight;       // 氛围洗墙灯开关 0..1（T20；颜色随时段与舱灯自动变）
uniform float uTime;            // 秒，窗板上水珠的颤动用
uniform float uWetness;         // 窗板外侧的湿度 0..1
uniform float uCameraFog;       // 飞机所在位置云的消光系数（1/km），机翼要隔着这层雾看
uniform vec3 uKeyCloud;         // 飞机周围云对光照的影响（clouds.keyVisibility，T31）：x 直射透射率，y 云散射出的漫射光（占主光源水平照度），z 天空光乘子
uniform float uHdrMax;          // HDR 目标能存的最大值（半精度时是 6e4）
uniform sampler2D uExposureState; // 上一帧的曝光适应结果（exposure.ts 的 EXPOSURE_STATE）：左像素 w = 倒影的显示增益（log2，T30）
// 调试可视化：0 关，1 内衬命中深度，2 亮度（伪彩），3 内衬受到的窗光，4 内衬法线（1–4 在这里），
// 以下在窗外程序（outside-pass.ts）里：
// 5 海面本身，6 海面天空反射，7 海面的内散射，8 海面粗糙度 / 像素覆盖，9 海面直射照度，10 闪烁格子，
// 11 白浪覆盖率 / 本地粗糙度，12 海面可分辨的平均斜率（11、12 见 ocean.glsl.ts），
// 21 真实地面的地表分类（红 树林、绿 农田、蓝 城区），22 真实地面的像素足迹（21、22 只在低空细节变体里有），
// 23 真实地面的水体遮罩（红 水面、绿 海洋通道、蓝 夜光）；
// 31 窗内只留舱内倒影（窗外置黑）、32 关掉倒影、33 只留面状倒影（不含光点）（T34，这三个在这里）
uniform int uDebug;
varying vec2 vUv;

const float PANE_TRANSMITTANCE = 0.85; // 两层亚克力 + 内层防刮板（窗外 pass 已经乘过，这里给舱内的窗光用）

// 输出的 alpha 只给机翼 pass 读（它再把窗外遮罩写回自己的输出给曝光用），所以这里把两样东西打包进 alpha 的 32 位里：
// 窗外遮罩 m（5 位）和「与窗外颜色无关的部分」A = 结果 − m·k·O（RGB 各 6 位 + 共享指数），
// O 是窗外加窗板效果之前的颜色，k 是窗板效果的乘性系数（油污、水珠暗边与透镜化、透气孔，机翼 pass 按同一公式重算）。
// 机翼 pass 合成：(1 − a)·场景 + a·(A + m·k·机翼)，a 是机翼覆盖率。划痕、水痕、舱内反射都在 A 里，照样叠在机翼上。
// 为什么存 A 而不是 O：量化误差按所存量的大小走。O 是明亮的天空，6 位量化的误差（约 1%）换到暗的机翼上就是满屏彩色噪点；
// A 在窗内只是窗板的附加亮度，很小，误差可以忽略。
// 为什么不用第二个渲染目标（MRT）：Windows 上 ANGLE 的 D3D 后端链接时只按单目标生成像素着色器，
// 画进两张目标时要在首帧同步重编整个场景着色器（实测首帧卡 50 秒、有时丢上下文）。
// 位布局：0–4 m，5–10 R，11–16 G，17–22 B，23 恒为 1，24–28 指数 + 20，29–31 为 0——浮点指数域落在 1..63，
// 既不是 0（非规格数可能被冲成 0）也不是全 1（NaN / Inf 可能被规范化），原样存得下。半精度目标存不下，uHdrMax 小于 1e10 时不打包
float packWingRef(float m, vec3 o) {
  if (uHdrMax < 1e10) return m;
  float mx = max(max(o.r, o.g), max(o.b, 1e-30));
  int e = clamp(int(floor(log2(mx))) + 1, -20, 11);
  uvec3 q = uvec3(clamp(round(o / exp2(float(e)) * 63.0), 0.0, 63.0));
  uint bits = uint(round(clamp(m, 0.0, 1.0) * 31.0)) | (q.r << 5) | (q.g << 11) | (q.b << 17) | (1u << 23) | (uint(e + 20) << 24);
  return uintBitsToFloat(bits);
}
const vec3 PLASTIC_ALBEDO = vec3(0.78, 0.76, 0.72);

${CABIN_SHADING_COMMON}
${LEATHER_COMMON}
${FABRIC_COMMON}
${SEATS_COMMON}
${CABIN_REFLECT_COMMON}
${EXPOSURE_MODEL}
${STAR_MAP_COMMON}
${STAR_POINTS_COMMON}

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
  // 头顶处的主光源照度只算一次（原来 eSunNormal 和 eDown 各调一次 keyLight，SC-3b）
  // 乘上飞机到主光源之间云的透射率（T31）：穿云时舱壁上不再有硬边光斑；被云挡掉的直射光变成白色的漫射光
  vec3 eKey0 = keyLight(uCamR, upW);
  vec3 eKeyUp = eKey0 * uKeyCloud.x;
  vec3 eSunNormal = eKeyUp * PANE_TRANSMITTANCE;
  vec3 eSkyH = skyIrradiance(uCamR, upW) * uKeyCloud.z + eKey0 * max(uKeyDir.y, 0.0) * uKeyCloud.y;
  // 下半球：海面或云海把天空光和阳光反射上来。云海的反照率远高于海面
  vec3 eDown = eSkyH + eKeyUp * max(uKeyDir.y, 0.0);
  float belowAlbedo = mix(0.06, 0.7, clamp(uCoverage * 0.9, 0.0, 1.0));
  // 窗板当作面光源时的平均辐亮度：一半看天，一半看下面
  vec3 lWin = 0.5 * (eSkyH / M_PI + belowAlbedo * eDown / M_PI) * PANE_TRANSMITTANCE;
  // 舱内环境光：灯光 + 满舱窗户进来的光被来回反射后的均匀部分（经验系数，待换成辐射度近似）
  vec3 eCabin = uCabinLight * CABIN_LIGHT_COLOR + 0.06 * M_PI * lWin + 0.004 * eSunNormal * max(sunC.z, 0.0);
  // 划痕 / 擦痕被舱内光照亮时仍用这一版；舱内表面的环境光里满舱窗户的回弹再多算一些（经验值）
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
  // 窗板里的舱内倒影用的灯光（T24，见 cabin-reflect.glsl.ts）
  ReflLights rl;
  // 面板「关灯」时 uCabinLight 留着 0.001 的底数（别处要用），倒影里当成全关，否则曝光拉高后这 1 lux 也会显出一层灯带
  rl.eMain = uCabinLight * mainTint * smoothstep(0.005, 0.05, uCabinLight);
  rl.eAmb = 0.06 * M_PI * lWin + 0.004 * eSunNormal * max(sunC.z, 0.0);
  rl.moodI = moodI;
  rl.wash = moodI + rl.eMain * 1.2; // 主灯里行李架下沿的洗墙灯带（和氛围灯同一条灯槽）
  rl.lOppWin = mix(cl.lGlow, lWin, 0.5);
  rl.readOn = cl.readOn;
  rl.pupil = mix(0.0065, 0.0045, smoothstep(0.005, 0.05, uCabinLight)); // 夜里暗适应时瞳孔更大，倒影更虚
  rl.lit = smoothstep(0.005, 0.05, uCabinLight);
  rl.pixAng = pixAng;

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
    // 调试 3（内衬受到的窗光）在 shadeReveal 里面返回，免得这里再内联一份 windowIrradiance（SC-3b）
    if (uDebug == 4) reveal = n * 0.5 + 0.5;
  }

  // ---- 遮光板：半透的白色塑料，下沿有把手（见 cabin-shading.glsl.ts） ----
  vec3 shade = shadeShade(pShade - vec3(wOff, 0.0), rd, pixShade, cl, shadeBottom, seed);

  // ---- 合成 ----
  float inBezel = 1.0 - smoothstep(-wB, wB, dBezel);
  float inPane = 1.0 - smoothstep(-wP, wP, dPane);
  // 视线在遮光板所在深度之前就打到内衬的话，遮光板被内衬挡住
  float shaded = smoothstep(-wS, wS, pShade.y - shadeBottom) * step(SHADE_DEPTH, hitZ);

  // 邻窗遮光板下沿以下（窗洞最深处）：只有一点暗光
  vec3 view = reveal * 0.3;
  if (inBezel > 0.0 && isMain > 0.5) {
  // 机翼和翼尖灯不在这里画：由单独的机翼 pass（wing-pass.ts）读这张结果、按 alpha（窗外遮罩）合成上去。
  // 窗外（天空、云、地面、海面、交通、闪电，已乘窗板透射率）由窗外 pass 算好（outside-pass.ts），这里按像素读回。
  // 窗外 pass 只在本窗窗洞与窗板开口以内算，判定和这个分支、inPane 同一公式（略放宽），这里读到的都是算过的值
  vec4 outside = texelFetch(uOutside, ivec2(gl_FragCoord.xy), 0);
  view = outside.rgb;
  // 点星（T41，stars.glsl.ts）：窗外程序在 alpha 里写 1 + 这个像素能看到多少星（天空 × 云 × 交通的透射率），
  // 这里补上相机上方大气的消光和窗板透射率。点星放在舱内程序是为了冷编译（放进窗外程序 d3d11 冷编译 17 → 52 s，见 handoff/T41.md）。
  // 算进 viewPre（窗外的颜色），机翼 pass 按窗外遮罩合成时机翼会挡住它
  if (outside.a > 1.0) {
    vec3 rdW = uCabinToWorld * rd;
    view += starPoints(rdW) * sunTransmittance(uCamR, rdW.y) * (PANE_TRANSMITTANCE * (outside.a - 1.0));
  }
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
  // 窗板外侧的水（T29）：水珠、水线是小透镜——视线穿过倾斜的水面偏折 (n−1)·坡度，
  // 直接读偏折后方向上的窗外像素（uOutside 是全分辨率的窗外结果），所以水里看到的是偏移、放大或倒转的窗外；
  // 陡的边缘全反射、映出暗的舱内，压暗一点。均匀的雾里折射前后一样，只剩很淡的暗边；
  // 背后是太阳或明暗交界时，水里会自然出现亮点和倒像
  vec4 wat = waterOnPane(q, pixPane, -uSeatSign, uTime, uWetness);
  if (wat.z > 0.002) {
    vec2 defl = WATER_DEFLECT * wat.xy / wat.z;
    // 视线方向对像素坐标的雅可比（解析求，不用屏幕导数：这里在分支里）
    vec2 jx = cabinRay(gl_FragCoord.xy + vec2(1.0, 0.0)).xy - rd.xy;
    vec2 jy = cabinRay(gl_FragCoord.xy + vec2(0.0, 1.0)).xy - rd.xy;
    float det = jx.x * jy.y - jx.y * jy.x;
    vec2 dpx = abs(det) > 1e-12 ? vec2(jy.y * defl.x - jy.x * defl.y, -jx.y * defl.x + jx.x * defl.y) / det : vec2(0.0);
    // 保险：截到 64 像素（WATER_DEFLECT 已经把偏折缩小，正常只有几到几十像素）
    dpx *= min(1.0, 64.0 / max(length(dpx), 1e-6));
    // 两个抽头（偏折的 100% 与 80%）取平均：缩小的倒像不至于逐像素跳
    ivec2 rmax = ivec2(uResolution) - 1;
    vec4 refr = 0.5 * (texelFetch(uOutside, clamp(ivec2(gl_FragCoord.xy + dpx), ivec2(0), rmax), 0)
                     + texelFetch(uOutside, clamp(ivec2(gl_FragCoord.xy + 0.8 * dpx), ivec2(0), rmax), 0));
    // 窗外 pass 只在窗板开口以内写 alpha = 1，开口以外读到的是 0：退回不偏折
    vec3 bent = refr.a > 0.99 ? refr.rgb : viewPre;
    view += wat.z * (bent - viewPre);
    viewPre = mix(viewPre, bent, wat.z);
    view *= 1.0 - WATER_RIM * wat.w;
  }
  // 内层窗板底部的透气孔（直径约 3 mm），孔边一圈暗环
  float dHole = length(q - vec2(0.0, -0.145));
  view *= 1.0 - 0.6 * smoothstep(0.0011, 0.0014, dHole) * (1.0 - smoothstep(0.0016, 0.0021, dHole));
  // 窗板反射舱内：正对时约 4%，斜看时更多（菲涅尔）；×1.5 是多层窗板各个面的反射之和。
  // 反射的是按方向变化的舱内倒影（T24）：自己的头肩是暗区，窗外的灯光从那里透出来
  float fr = 0.04 + 0.96 * pow(1.0 - clamp(rd.z, 0.0, 1.0), 5.0);
  // 白天窗外亮上千倍，倒影不到窗外的千分之三（色调映射后不到半个灰阶），整段跳过省掉开销；
  // 上界按最亮的天花板灯槽 + 对面窗户估计，阅读灯亮着时（只在夜里全关灯时）不跳
  vec3 rr = vec3(rd.xy, -rd.z);
  // T30：倒影跟舱内同一个适应框架（见 exposure.ts ⑦）——夜里窗外暗、窗内曝光比舱内高很多档时，
  // 倒影不能跟着被拉亮到比它的来源（舱壁、灯带）还亮，超出「舱内曝光 + 余量」的部分在这里扣掉
  vec4 expState = texelFetch(uExposureState, ivec2(0, 0), 0);
  float reflGain = fr * 1.5 * exp2(expState.w);
  // 倒影的色适应：舱内按 T28 部分适应了舱灯的暖色（D ≈ 0.7，舱壁看上去接近中性），倒影是同一批表面、同一个框架，
  // 也按同样程度抵掉主灯的色温；曝光 pass 分不开倒影和窗外（窗外不做舱内色适应），所以在这里预先乘上。
  // 睡眠档的淡紫氛围灯不抵（T28 本来就只适应它一小部分）
  vec3 reflWB = mix(vec3(1.0), vec3(dot(mainTint, vec3(0.2126, 0.7152, 0.0722))) / mainTint, 0.7 * smoothstep(0.005, 0.05, uCabinLight));
  float reflMax = reflGain * dot(0.3 * (rl.eAmb + 2.5 * rl.eMain + rl.moodI) + rl.lOppWin, vec3(0.2126, 0.7152, 0.0722));
  vec3 reflAdd = vec3(0.0);
  if (rl.readOn > 0.0 || reflMax > 0.003 * dot(view, vec3(0.2126, 0.7152, 0.0722))) {
    vec3 pts;
    vec3 surf = reflGain * reflWB * cabinReflection(pPane, rr, length(pPane - ro), rl, pts);
    // T34 面状倒影的硬上限（exposure.ts ⑧）：显示亮度不超过同屏舱内均值的 k 倍（睡眠 / 全关 k 使显示 Y ≤ 舱壁一半）。
    // 软限幅（4 次范数），低于上限的部分几乎不变，所以倒影内部的明暗结构（灯带的亮线、行李架的边）还在；
    // 光点是灯本身，开灯档不进上限（睡眠档见下，T41）
    ExpModel em = exposureModel(expState);
    float capL = exp2(em.reflCapLog);
    // 窗外亮的时候（黄昏开着灯，窗外显示亮度 Y 过 100 左右），倒影不超过背后窗外的 15%：
    // 这时窗外才是主角，倒影只该是一层淡淡的「玻璃感」（美术总监第三次检查的建议）
    float lOut = dot(viewPre, vec3(0.2126, 0.7152, 0.0722));
    // 在对数域里过渡（线性混合时 min 那一项要到权重接近 1 才起作用）；0.05–0.15 是色调映射前的显示亮度，约 Y 70–110
    capL *= exp2(smoothstep(0.05, 0.15, lOut * exp2(em.eO)) * min(0.0, log2(max(0.15 * lOut, 1e-12) / capL)));
    float sl = dot(surf, vec3(0.2126, 0.7152, 0.0722)) / capL;
    surf *= inversesqrt(sqrt(1.0 + sl * sl * sl * sl));
    // T41：睡眠档的阅读灯光点也按同一上限软限幅（显示亮度 ≤ 面状倒影的上限，极弱）——不限时它们是夜景窗里最亮的一对点，
    // 读成天上的「双亮星」。开灯档（lit = 1）照旧不进上限：那时舱内亮、倒影本来就认得出是灯
    vec3 ptsR = reflGain * reflWB * pts;
    float pl = dot(ptsR, vec3(0.2126, 0.7152, 0.0722)) / capL;
    ptsR *= mix(inversesqrt(sqrt(1.0 + pl * pl * pl * pl)), 1.0, rl.lit);
    reflAdd = surf + (uDebug == 33 ? vec3(0.0) : ptsR);
  }
  // 调试 31：窗内只留倒影（窗外置黑，量倒影本身的显示亮度）；32：关掉倒影（T34）
  if (uDebug == 31 || uDebug == 33) view = reflAdd;
  else if (uDebug != 32) view += reflAdd;
  paneK = (1.0 - 0.1 * sm) * (1.0 - WATER_RIM * wat.w)
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
      uOutside: { value: null },
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
      uKeyCloud: { value: new THREE.Vector3(1, 0, 1) },
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
      uExposureState: EXPOSURE_STATE,
      ...EXPOSURE_MODEL_UNIFORMS, // T34：倒影的亮度上限要在舱内合成里按同一个曝光模型算（与曝光 pass 共用同一批 uniform 对象）
      uDebug: { value: 0 },
      uLoopGuard: { value: 0 },
    },
  });
}

/**
 * 舱等变体（T25）：舱内合成程序按舱等切换（默认商务舱 = 传进来的 base 材质；经济舱 = 同一份源码加 #define CABIN_CLASS_ECONOMY）。
 * 只编当前要用的那一套：首帧只有商务舱（main.ts 的后台编译批次里就是 base），用户在面板选经济舱时才用
 * renderer.compileAsync 在后台编译（KHR_parallel_shader_compile，不阻塞渲染），编好之前继续画当前的舱等，编好了才切——
 * 切换时没有黑屏、不卡帧。编过的变体留着，来回切不再编。变体之间共用同一份 uniforms，切换不需要同步任何状态。
 * 做法与坑同 GroundDetailVariant（outside-pass.ts）：
 * - 编译时绑定真正要画进去的目标（hdr，单输出）：ANGLE 的 D3D 后端按链接时绑定的帧缓冲生成输出布局，绑错会在首次使用时同步重编；
 * - compileAsync 编译失败也会 resolve：取出程序、检查 diagnostics.runnable，失败就留在当前舱等（面板显示「编译失败」）。
 */
export class CabinClassVariant {
  private readonly mats: Partial<Record<CabinClass, THREE.ShaderMaterial>> = {};
  private readonly states: Partial<Record<CabinClass, "compiling" | "ready" | "failed">> = { business: "ready" };
  /** 这一帧实际画的舱等（变体编好之前可能和面板选的不一样） */
  shown: CabinClass = "business";
  /** 最近一次变体编译的耗时（毫秒），调试 / 测量用 */
  lastCompileMs = 0;

  /** base：默认（商务舱）材质；target：舱内合成真正画进去的目标 */
  constructor(
    base: THREE.ShaderMaterial,
    private readonly target: THREE.WebGLRenderTarget,
  ) {
    this.mats.business = base;
  }

  /** 每帧调用：want 是面板选的舱等，返回这一帧该用的材质 */
  pick(renderer: THREE.WebGLRenderer, want: CabinClass): THREE.ShaderMaterial {
    if (want !== this.shown) {
      if (!this.states[want]) this.prepare(renderer, want);
      if (this.states[want] === "ready") this.shown = want;
    }
    return this.mats[this.shown]!;
  }

  /** 某个舱等的状态：ready 可以直接切；compiling 后台编译中；failed 编译失败；undefined 还没开始 */
  status(c: CabinClass) {
    return this.states[c];
  }

  private prepare(renderer: THREE.WebGLRenderer, c: CabinClass) {
    this.states[c] = "compiling";
    const b = this.mats.business!;
    const m = new THREE.ShaderMaterial({
      vertexShader: b.vertexShader,
      fragmentShader: b.fragmentShader,
      uniforms: b.uniforms, // 共用同一份 uniforms
      defines: { ...b.defines, CABIN_CLASS_ECONOMY: 1 },
      depthTest: false,
      depthWrite: false,
      toneMapped: false,
    });
    const scene = new THREE.Scene();
    // 几何体与相机和 FullscreenPass 一致（只有 position + uv 的全屏三角形），程序缓存的键才相同
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute("position", new THREE.Float32BufferAttribute([-1, -1, 0, 3, -1, 0, -1, 3, 0], 3));
    geometry.setAttribute("uv", new THREE.Float32BufferAttribute([0, 0, 2, 0, 0, 2], 2));
    const mesh = new THREE.Mesh(geometry, m);
    mesh.frustumCulled = false;
    scene.add(mesh);
    const t0 = performance.now();
    const prevTarget = renderer.getRenderTarget();
    renderer.setRenderTarget(this.target);
    const job = renderer.compileAsync(scene, new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1));
    renderer.setRenderTarget(prevTarget);
    job
      .then(() => {
        // compileAsync 只等「编译完成」，不管编译是否成功。取出程序、触发一次诊断，失败就不切换
        const program = (renderer.properties.get(m) as { currentProgram?: { getUniforms(): unknown; diagnostics?: { runnable: boolean } } }).currentProgram;
        program?.getUniforms();
        if (!program || program.diagnostics?.runnable === false) {
          this.states[c] = "failed";
          return;
        }
        this.lastCompileMs = performance.now() - t0;
        this.mats[c] = m;
        this.states[c] = "ready";
      })
      .catch(() => {
        this.states[c] = "failed";
      })
      .finally(() => geometry.dispose());
  }
}
