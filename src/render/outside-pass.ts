import * as THREE from "three";
import { ATMOSPHERE_COMMON, FULLSCREEN_VERT } from "../atmosphere/common.glsl";
import { CLOUD_COMMON } from "../clouds/clouds.glsl";
import { GROUND_COMMON } from "./ground.glsl";
import { GROUND_DETAIL_COMMON } from "./ground-detail.glsl";
import { INLAND_WATER_COMMON } from "./inland-water.glsl";
import { ISLANDS_COMMON } from "./islands.glsl";
import { LIGHTNING_COMMON } from "./lightning.glsl";
import { LIGHTS_COMMON } from "./lights.glsl";
import { NOISE_COMMON } from "./noise.glsl";
import { OCEAN_COMMON } from "./ocean.glsl";
import { STAR_MAP_COMMON, STARS_COMMON } from "./stars.glsl";
import { TERRAIN_SHADING_COMMON } from "./terrain-shading.glsl";
import { TRAFFIC_COMMON } from "./traffic.glsl";
import { VIEW_COMMON } from "./view.glsl";
import { HAZE_COMMON } from "./haze.glsl";
import { WONDER_SKY_COMMON } from "./wonder-sky.glsl";
import { OPTICS_COMMON } from "./optics.glsl";
import { RAIL_FAR_COMMON, RAIL_FAR_HIT } from "../rail/far-view.glsl";
import { railFarUniforms } from "../rail/far-view";
import { opticsWanted } from "./optics";

/**
 * 窗外 pass（SC-5）：只算「穿过本窗窗板看出去」的 HDR 辐亮度（天空、太阳月亮星星、云的合成、真实地面、海面、
 * 远处的飞机和航迹云、闪电），已乘窗板透射率，还没加窗板上的任何效果。写到一张全分辨率 HDR 目标，
 * 由舱内合成程序（scene.ts）在窗板以内读回，再做划痕、油污、水珠、舱内反射与舱壁 / 座椅 / 遮光板的合成。
 *
 * 为什么拆：FXC（Windows 上 ANGLE 的 D3D 后端）的编译时间随单个程序的规模超线性增长。离线实测窗外单独约 15 s、
 * 舱内单独约 5 s，合在一个程序里约 50–90 s。拆成两个程序后由 KHR_parallel_shader_compile 并行编译；
 * 只改舱内时只重编舱内那个小程序（浏览器的程序缓存按各程序的源码文本命中）。见 research/DX_SHADER_COMPILE.md。
 *
 * 只在需要的像素上算：本窗（wi = 0）的窗洞开口以内、窗板开口以内（和 scene.ts 里 inBezel、inPane 的判定同一公式，
 * 再放宽约半个像素防止两个程序的舍入差把边缘像素漏掉）。其余像素写 0 立刻返回，舱内程序在那里也不会读它。
 *
 * 输出：RGB = 窗外辐亮度 × 窗板透射率（kcd/m²）；A = 1 表示这个像素算过（调试用，舱内程序不读）。
 * 半精度目标（没有 EXT_color_buffer_float 时）存不下太阳（约 1.8e6），这时截到 uHdrMax，和改前场景输出截断的位置一致。
 *
 * 依赖：舱内程序只包含 NOISE_COMMON 这一小段公共代码（hash / 噪声），不包含 cabin*.glsl.ts、seats.glsl.ts，
 * 改那些文件不会让这个程序重编。反过来，这里包含的所有 *_COMMON 改了都会让它重编（约十几秒）。
 */
// rail = true：火车远景变体（TR03）。火车的两段 GLSL 只拼进那个变体，飞机的默认程序源码里没有它们
const outsideFragment = (rail: boolean) => /* glsl */ `
${ATMOSPHERE_COMMON}
${VIEW_COMMON}
${CLOUD_COMMON}
${NOISE_COMMON}
${LIGHTS_COMMON}
${STAR_MAP_COMMON}
${STARS_COMMON}
${ISLANDS_COMMON}
${GROUND_COMMON}
uniform sampler2D uClouds;       // 云缓冲：两倍宽，左半 RGB 预乘辐亮度 + A 透射率，右半 RG =（深度×不透明度, 不透明度），相除得平均深度（用 cloudBufferColor / cloudBufferDepth 取，T38）
uniform float uWind;
uniform float uTime;            // 秒，给波浪和闪烁用
uniform float uHdrMax;          // 窗外目标能存的最大值（半精度时是 6e4）
// 调试可视化（编号含义见 scene.ts 的 uDebug 注释）：这里处理窗外的 5–13、21–23，舱内的 1–4 在 scene.ts
uniform int uDebug;
varying vec2 vUv;
${TRAFFIC_COMMON}

const float PANE_TRANSMITTANCE = 0.85; // 两层亚克力 + 内层防刮板（和 scene.ts 一致）
const float OUTSIDE_WINDOW_PITCH = 0.533; // 舷窗间距（和 cabin-shading.glsl.ts 的 WINDOW_PITCH 一致，这里只用来判定本窗）

${OCEAN_COMMON}
${LIGHTNING_COMMON}
${GROUND_DETAIL_COMMON}
${INLAND_WATER_COMMON}
${rail ? RAIL_FAR_COMMON : ""}${TERRAIN_SHADING_COMMON}${rail ? RAIL_FAR_HIT : ""}
${HAZE_COMMON}
// 天幕层奇观（W01 / W01b）与罕见光学（T17 的宝光 / 本机影子 / 幻日 / 22° 晕）只编进 OUTSIDE_WONDER / OUTSIDE_OPTICS 变体（PERF-13），
// 默认程序（启动批次、冷启动关键路径）预处理后不含它们；太阳圆盘 + 绿闪（opticsSunDisk）每个程序都有
#ifdef OUTSIDE_WONDER
${WONDER_SKY_COMMON}
#endif
${OPTICS_COMMON}

// 窗外辐亮度。重函数在这里各只有一个调用点（SC-3）：真实地面上的海洋和开阔海面共用同一个 oceanRadiance，
// 命中点的云影、水面照度、闪光照度也只算一次，陆地、湖河、海面共用。FXC 会把每个调用点整份内联，
// 原来地面水体和开阔海面各调一次 oceanRadiance，场景程序冷编译多出约 50 s。以后加分支时不要再在别处调这些函数，
// 把输入交给这里唯一的调用点
float gStarVis = 0.0; // 这个像素是天空（看得到点星）时由 outsideRadiance 置 1（T41，点星在舱内程序画）
vec3 outsideRadiance(vec3 rd, vec4 cloud) {
  vec3 ro = vec3(0.0, uCamR, 0.0);
  // 真实地面：先求交（打不到或还没有数据时退回原来的海平面球）
  GroundHit gh;
  bool onGround = uGroundOn > 0.5 && groundHit(ro, rd, gh);
  // 调试 23：水体遮罩（红 = 水面，绿 = 海洋通道，蓝 = 夜光）
  if (onGround && uDebug == 23) return gh.wat * 20.0 * cloud.a + cloud.rgb;
  float tGround;
  if (onGround) tGround = gh.t;
#ifdef RAIL
  else tGround = -1.0; // 火车远景（TR03）：内陆线路，没打到地形的视线是天空，不退回海平面球（那会画成海）
#else
  else tGround = raySphere(ro, rd, BOTTOM);
#endif
  bool hitGround = tGround > 0.0;
  // 天空视图 LUT 已经包含到地面为止的内散射（空气透视）；真实地面用空气透视 LUT，不需要它
  vec3 L = vec3(0.0);
  if (!onGround) L = skyRadiance(rd, hitGround);
  if (hitGround) {
    vec3 P;
    if (onGround) P = gh.P;
    else P = ro + rd * tGround;
    vec3 n = normalize(P);
    // 命中点的云影、水面处主光源（含云影）与天空光的照度、闪光照度：只算一次，陆地、湖河、海面共用
    float cs = cloudShadow(P, uKeyDir);
    vec3 eSunW = keyLight(BOTTOM, n) * cs;
    vec3 eSkyW = skyIrradiance(BOTTOM, n);
    vec3 eFlash = flashIlluminance(P);
    vec3 land = vec3(0.0);
    bool wet = true;          // 这个像素有水面（开阔海面恒为是）
    vec3 body = vec3(-1.0);   // 水色：开阔海面用大洋默认值，真实地面取卫星影像
    if (onGround) {
      if (gh.wat.r < 0.999) {
        vec4 lr = groundLand(gh, cs, eFlash);
        if (lr.w > 0.5) return lr.rgb * cloud.a + cloud.rgb; // 调试 21 / 22
        land = lr.rgb;
      }
      wet = gh.wat.r > 0.001;
      body = gh.alb.rgb * 0.7;
    }
    // 水面：海洋按设定风速（涌浪 + 风浪），湖泊、河流用只有细碎涟漪的内陆水面（海面的长波放在河上会出现摩尔纹）。
    // 每个像素只算其中一个（按遮罩的海洋通道 0.5 分界）。两个都算再按比例混合能消掉河口的接缝，
    // 但 FXC 要同时保留两份内联代码，冷编译多出十几秒（T02 实测），不值得
    float fView = 0.0;
    vec3 nView = n;
    vec3 water = vec3(0.0);
    vec3 skyCam = vec3(0.0);
    vec3 skyHz = vec3(0.0);
    if (wet) {
      if (!onGround || gh.wat.g > 0.5) water = oceanRadiance(P, rd, tGround, body, 1.0, eSunW, eSkyW, fView, nView);
      else water = inlandWaterRadiance(P, rd, gh.fpM, body, eSunW, eSkyW, fView, nView);
      // 天空反射：天空视图 LUT 是从相机算的，L相机(反射方向) ≈ 内散射(相机→水面) + 透射率 × L水面(反射方向)。
      // 所以反射的贡献是 F·(L相机 − 内散射)，不能再乘一次透射率，否则地平线处会被衰减两次，出现一条暗线
      vec3 rR = reflect(rd, nView);
      skyCam = skyRadiance(rR, false);
      // SEA-3：反射方位上几何地平线处的天空 skyHz（含义见下）。与 skyCam 同一方位，天空视图 LUT 里就是同一列、天空侧最后一行，
      // 直接按列坐标取这一行（太阳、月亮两路 + 气辉），不再调第二次 skyRadiance：
      // 两个 skyRadiance 调用点时离线 FXC outside-default 实测 +10–12%（窗外是冷启动关键路径）；放进循环共用一个调用点则 FXC 编不过
      // （分支里、循环里的隐式导数取样）
      vec2 hR = normalize(rR.xz + vec2(1e-7, 0.0));
      vec2 hS = normalize(uSunDir.xz + vec2(1e-7, 0.0));
      vec2 hM = normalize(uMoonDir.xz + vec2(1e-7, 0.0));
      float yHz = unitToUv(floor(0.5 * (SKY_VIEW_SIZE.y - 1.0)) / (SKY_VIEW_SIZE.y - 1.0), SKY_VIEW_SIZE.y);
      float xS = unitToUv(sqrt(clamp(0.5 - 0.5 * dot(hR, hS), 0.0, 1.0)), SKY_VIEW_SIZE.x);
      float xM = unitToUv(sqrt(clamp(0.5 - 0.5 * dot(hR, hM), 0.0, 1.0)), SKY_VIEW_SIZE.x);
      float sDip = sqrt(max(1.0 - (BOTTOM / uCamR) * (BOTTOM / uCamR), 0.0));
      skyHz = textureLod(uSkyViewLut, vec2(xS, yHz), 0.0).rgb * uSunIlluminance
            + textureLod(uSkyViewMoonLut, vec2(xM, yHz), 0.0).rgb * uMoonIlluminance
            + nightglow(vec3(hR.x, -sDip, hR.y));
    }
    // SEA-3（低空海天「暗墙」）：上面的近似默认「水面往反射方向看到的天空」≈「相机往同一方向看到的天空」。
    // 相机在霾顶之上、水面埋在霾里时不成立：掠射时水面反射的是一整段霾，相机往反射方向看到的却是霾顶以上的亮天空，
    // 地平线下一两个像素海面就比地平线上方的暗带亮十几级。按水面处往反射方向到大气顶的透射率 tUpR 混合：
    // tUpR → 1（反射视线很快出霾）沿用原公式；tUpR → 0 时反射的是贴着海面的那段霾本身。
    // 它的亮度取「相机看反射方位的几何地平线」处的天空 skyHz（天空视图 LUT 天空侧最后一行，太阳 + 月亮两路 + 气辉）：
    // 地平线处反射方向恰好退化到这里，与原公式连续；这条视线同样贴着霾层走，白天就是地平线上方那条暗带的亮度，夜里含月光与气辉。
    // 返工（SEA-3 审查 P0）：第一版用「视线段的饱和内散射」apT·apL/(1 − apT)（开阔海面用 tView·内散射/(1 − tView)）。
    // 这两个量只有太阳一路（空气透视 LUT、天空视图 LUT 地面侧都不含月光与气辉），夜里 ≈ 0，
    // 远海反射整片归零、地平线下一行从 Y≈65 掉到纯黑（night-sea-milkyway / night-sea-fullmoon）
    vec3 tUpR = transmittanceToTop(BOTTOM, max(dot(reflect(rd, nView), n), 0.0));
    if (onGround) {
      skyCam = gh.apL + mix(max(skyHz - gh.apL, vec3(0.0)), max(skyCam - gh.apL, vec3(0.0)), tUpR);
      // 清晨谷地辐射雾（T18，render/haze.glsl.ts）：贴着地形，要盖在陆地和湖河上、再一起乘空气透视，
      // 所以放在 groundFinish 之前，不放在下面的统一出口（那里 L 已经含空气透视）
      vec4 vf = hazeValleyFog(P, gh.g, gh.fpM, gh.wat.g, eSunW, eSkyW);
      land = mix(land, vf.rgb, vf.a);
      water = mix(water, vf.rgb, vf.a);
      fView *= 1.0 - vf.a;
      L = groundFinish(gh, land, water, fView, skyCam, eSunW, eSkyW, eFlash);
#ifdef RAIL
      L = mix(skyRadiance(rd, false), L, gh.cov); // 火车远景（TR03）：地形轮廓抗锯齿（擦着轮廓过去的视线只盖住一部分像素）
      // 层叠山脊之间的抗锯齿：擦过的近处山脊按「同一片地表、换成它那个距离的空气透视」估它的颜色，按覆盖比例混进来
      if (gh.occ > 0.0) {
        vec3 surf = (L - gh.apL) / max(gh.apT, vec3(1e-4));
        vec3 uvwO = aerialPerspectiveUvw(rd, uSunDir, gh.tOcc);
        vec3 nearL = texture(uAerialInscatterS, uvwO).rgb * uSunIlluminance + texture(uAerialTransmittanceS, uvwO).rgb * surf;
        L = mix(L, nearL, gh.occ);
      }
      // 调试 26（只在火车变体里，不乘曝光前的量级，用 ×0.3 让它在白天的曝光下落在可读范围）：红 = 轮廓覆盖率，绿 = 命中距离 / 50 km，蓝 = 擦过的近处山脊的覆盖率
      if (uDebug == 26) return vec3(gh.cov, gh.t / 50.0, gh.occ) * 0.3;
#endif
    } else {
      // 开阔海面：相机到海面的透射率 = T(海面→层顶) / T(相机→层顶)，两段都是朝上的射线
      vec3 tSurface = transmittanceToTop(BOTTOM, dot(n, -rd));
      vec3 tCamera = transmittanceToTop(uCamR, -rd.y);
      vec3 tView = min(tSurface / max(tCamera, vec3(1e-6)), vec3(1.0));
      vec3 inscatter = L;
      vec3 sea = tView * (water + vec3(0.02, 0.04, 0.05) / M_PI * eFlash);
      L += sea;
      vec3 refl = fView * mix(max(skyHz - inscatter, vec3(0.0)), max(skyCam - inscatter, vec3(0.0)), tUpR);
      L += refl;
      if (uDebug == 5 || uDebug >= 8) L = sea;
      if (uDebug == 6) L = refl;
      if (uDebug == 7) L = inscatter;
    }
  } else {
    // 月亮圆盘（白天也在，只是很淡）、星星和银河；都要穿过相机上方的大气。
    // 银河的可见度按它对这个方向天空底色（此时的 L：月光照亮的天空 + 夜天光）的对比度判断（T09，stars.glsl.ts）
    vec3 tUp = sunTransmittance(uCamR, rd.y);
    L += moonDisk(rd) * tUp + starRadiance(rd, tUp, L);
    gStarVis = 1.0; // 点星由舱内程序画（T41），这里只标出「这个像素是天空」
  }
  // 【大气合成接入点】到这里 L 是云层背后的背景辐亮度：地面 / 海面已含空气透视，天空含内散射。
  // T18 的边界层霾不在这里叠：它是大气里的一层气溶胶，已经进了透射率 / 天空视图 / 空气透视 LUT（atmosphere/haze.ts），
  // 上面三条路径取 LUT 时就带上了，不需要逐像素步进；谷地雾贴着地形，在上面 groundFinish 之前合成。
  // 所有路径（真实地面、开阔海面、天空）都会经过这一行，调试 21–23 的提前返回除外。
  // 天幕层奇观（W01 天梯 / 建木，render/wonder-sky.glsl.ts）：画在背景上、云之前合成，所以会被云挡住；
  // 线在地面 / 海面之前才可见（下半截沉到地平线以下时由 tGround 截掉）。奇观模式关时第一行就返回。
  // 只在 OUTSIDE_WONDER 变体里（PERF-13）：uWonderOn = 0 时两个程序逐像素相同，选哪个由 wantedOutsideKey 决定
#ifdef OUTSIDE_WONDER
  L = wonderSky(L, rd, hitGround ? tGround : 1e9);
#endif
  // 太阳圆盘（T17 起在 optics.glsl.ts）：地平线按亚像素解析裁切（含绿闪），所以天空、地面两条路径都要走这里
  L += opticsSunDisk(rd, hitGround);
  // 地形挡住它后面的云（T38，clouds.glsl.ts 的 cloudBeforeGround）：云步进不知道地形，只去掉地面之后那一段的云
#ifdef RAIL
  // 火车远景（TR03）：轮廓上只盖住一部分像素的地形，身后的云也只挡掉那一部分（否则云在山脊处被一刀切成台阶）
  // 擦过的近处山脊（gh.occ）同理：按覆盖比例在「切到远山」和「切到近处山脊」之间混
  if (onGround) {
    float cDepth = cloudBufferDepth(uClouds, gl_FragCoord.xy / uResolution);
    vec4 cFar = cloudBeforeGround(cloud, cDepth, tGround);
    if (gh.occ > 0.0) cFar = mix(cFar, cloudBeforeGround(cloud, cDepth, gh.tOcc), gh.occ);
    cloud = mix(cloud, cFar, gh.cov);
  }
#else
  if (onGround) cloud = cloudBeforeGround(cloud, cloudBufferDepth(uClouds, gl_FragCoord.xy / uResolution), tGround);
#endif
#ifdef OUTSIDE_WONDER
  // 天幕层奇观挡住比它远的云（WS01：天梯锚塔在 200–260 km 外，地平线一带更远的云要排到塔后面），按它盖住像素的比例混
  if (gWonderCov > 0.0) cloud = mix(cloud, cloudBeforeGround(cloud, cloudBufferDepth(uClouds, gl_FragCoord.xy / uResolution), gWonderT), gWonderCov);
#endif
  // 云挡在前面：背景剩下云的透射率那么多，再加上云自身的光（T17：云的光乘宝光 / 本机影子，再加卷云里的幻日和晕；
  // 这两项只在 OUTSIDE_OPTICS 变体里，默认程序的 opticsComposite 只剩前两项，见 optics.glsl.ts）
  return opticsComposite(L, cloud, rd);
}

void main() {
  vec3 rd = cabinRay(gl_FragCoord.xy);
  vec3 ro = uHead;
  // 本窗窗洞与窗板的覆盖判定：公式和 scene.ts 的 main() 一致（屏幕导数要在任何分支之前算）
  float rdz = max(rd.z, 1e-4);
  vec3 pWall = ro + rd * ((0.0 - ro.z) / rdz);
  vec3 pPane = ro + rd * ((PANE_DEPTH - ro.z) / rdz);
  float dBezel = sdRoundRect(pWall.xy, BEZEL_HALF, BEZEL_RADIUS);
  float dPane = sdRoundRect(pPane.xy, PANE_HALF, PANE_RADIUS);
  float wB = min(fwidth(dBezel), 0.005);
  float wP = min(fwidth(dPane), 0.005);
  bool isMain = floor(pWall.x / OUTSIDE_WINDOW_PITCH + 0.5) == 0.0;
  // 舱内程序在 inBezel > 0 且 inPane > 0 的像素上才用得到窗外（smoothstep(-w, w, d) < 1 即 d < w）。
  // 判定放宽到 1.5 倍宽度再加一点余量：两个程序各自编译，fwidth 和距离场的舍入可能差一两个 ulp，漏掉的像素会是一个黑点
  if (rd.z < 1e-4 || !isMain || dBezel > 1.5 * wB + 1e-5 || dPane > 1.5 * wP + 1e-5) {
    gl_FragColor = vec4(0.0);
    return;
  }
  vec3 rdW = uCabinToWorld * rd;
  vec4 cloud = cloudBufferColor(uClouds, gl_FragCoord.xy / uResolution);
  vec3 view = outsideRadiance(rdW, cloud);
  float starVis = gStarVis * cloud.a;
  // 远处的飞机和航迹云在云层之上，挡在海面和云前面
  vec4 tr = trafficRadiance(rdW);
  view = (view * tr.a + tr.rgb + boltRadiance(rdW)) * PANE_TRANSMITTANCE;
  // alpha：1 = 这个像素算过（舱内程序的水珠折射按 > 0.99 判断），再加上能看到多少点星（T41，舱内程序画点星时乘它）
  gl_FragColor = vec4(min(view, vec3(uHdrMax)), 1.0 + starVis * tr.a);
}
`;

/**
 * 窗外材质。uniforms 直接用舱内材质（场景材质）的同一个对象：主循环、机翼、低空细节变体都改的是这一份，
 * 之后再 Object.assign 进去的 uniform（海浪、机翼增升装置……）这里自动可见。
 * 这个程序不声明 uOutside，所以同一份 uniforms 里有它也不会形成「读自己正在写的纹理」的反馈环。
 * 火车远景（TR03）的 uniform 也并进这份 uniforms（只有火车变体声明它们，RailMode 每帧改 .value）。
 */
export function createOutsideMaterial(sharedUniforms: Record<string, THREE.IUniform>) {
  Object.assign(sharedUniforms, railFarUniforms);
  return new THREE.ShaderMaterial({
    vertexShader: FULLSCREEN_VERT,
    fragmentShader: outsideFragment(false),
    depthTest: false,
    depthWrite: false,
    toneMapped: false,
    uniforms: sharedUniforms,
  });
}

/** 火车远景变体（TR03）的片元源码：默认源码 + rail/far-view.glsl.ts 的两段（编译时再加 outsideVariantDefines("DROW") 的宏） */
export function outsideRailFragment() {
  return outsideFragment(true);
}

/**
 * 窗外程序的变体（PERF-13，照 PERF-10 云步进的写法）。键 = 特性字母：
 * D 低空细节（GROUND_DETAIL，T02）、R 火车远景（RAIL，TR03，源码另拼 rail/far-view.glsl.ts）、
 * O 罕见光学（OUTSIDE_OPTICS：宝光 / 本机影子 / 幻日 / 22° 晕，T17）、W 天幕层奇观（OUTSIDE_WONDER：天梯 / 建木，W01 / W01b）。
 *
 * 只有四个组合真的存在（组合矩阵的取舍见 handoff/PERF-13.md）：
 * - ""     默认：启动批次里编，冷启动的关键路径。不含 O / W，太阳圆盘 + 绿闪照旧
 * - "OW"   巡航（4 km 以上）时有罕见光学或天幕层奇观：首帧后后台预编（O、W 不再拆开——两者都常在巡航出现，拆开只会多一个程序）
 * - "DOW"  低空（4 km 以下）：和改动前的低空细节变体是同一个程序（O / W 总是带着，低空细节本来就是按需后台编的，不在关键路径上）
 * - "DROW" 火车：同上，和改动前的火车变体是同一个程序
 * 选哪个只由 wantedOutsideKey 决定；没编好时按 OUTSIDE_FALLBACK 退到已编好的（O / W 的效果暂时不画，不会画错）。
 */
export type OutsideKey = "" | "OW" | "DOW" | "DROW";
export const OUTSIDE_KEYS: readonly OutsideKey[] = ["", "OW", "DOW", "DROW"];
const OUTSIDE_FEATURE_DEFINES: Record<string, string> = { D: "GROUND_DETAIL", R: "RAIL", O: "OUTSIDE_OPTICS", W: "OUTSIDE_WONDER" };

/** 变体键 → three 的 defines（lint-shaders.mjs / shader-budget.mjs 离线枚举也用这一份，不要另写） */
export function outsideVariantDefines(key: OutsideKey): Record<string, number> {
  const d: Record<string, number> = {};
  for (const c of key) d[OUTSIDE_FEATURE_DEFINES[c]] = 1;
  return d;
}

/** 变体键 → 片元源码（不含 defines；带 R 的拼火车远景的两段） */
export function outsideVariantFragment(key: OutsideKey): string {
  return outsideFragment(key.includes("R"));
}

/** wantedOutsideKey 的输入：都是这一帧的状态，main.ts 不需要另外算 */
export interface OutsideWant {
  /** 低空细节开着（离地高度 < 4 km 打开、> 4.5 km 关闭的滞回，由 GroundDetailVariant 维护） */
  detail: boolean;
  /** 火车模式 */
  rail: boolean;
  /** 共用的 uniforms：从里面读罕见光学（opticsWanted）与天幕层奇观（uWonderOn）的当前值 */
  uniforms: Record<string, THREE.IUniform>;
}

/**
 * 这一帧想画哪个窗外变体，以及它没编好时依次退到哪些（只退到已编好的，退的时候不触发编译）——
 * **选变体只由这一个函数决定**（PERF-10 教训：预编、预告、每帧选择各写一份判断会互相打架）。
 * 低空 / 火车的变体总带 O、W；巡航时罕见光学有看得出的贡献（opticsWanted）或天幕层奇观在场（uWonderOn）才要 OW。
 * 退路：火车 → 低空细节（沿用 TR03 的过渡）→ 带 O / W 的（只在确实要它们时）→ 默认。退到默认时 O / W 的效果暂时不画。
 */
export function wantedOutsideKey(w: OutsideWant): { key: OutsideKey; fallback: OutsideKey[] } {
  const wonder = ((w.uniforms.uWonderOn?.value as number | undefined) ?? 0) > 0.5;
  const extras = wonder || opticsWanted(w.uniforms);
  const tail: OutsideKey[] = extras ? ["OW", ""] : [""];
  if (w.rail) return { key: "DROW", fallback: ["DOW", ...tail] };
  if (w.detail) return { key: "DOW", fallback: tail };
  return extras ? { key: "OW", fallback: [""] } : { key: "", fallback: [] };
}

/**
 * 窗外 HDR 目标：32 位浮点能原样存下太阳；只用 texelFetch 读，不需要线性过滤（所以不要求 OES_texture_float_linear，
 * 只要能渲染到浮点纹理，即 EXT_color_buffer_float）。
 */
export function createOutsideTarget(renderer: THREE.WebGLRenderer) {
  const float = renderer.extensions.has("EXT_color_buffer_float");
  return new THREE.WebGLRenderTarget(1, 1, {
    type: float ? THREE.FloatType : THREE.HalfFloatType,
    minFilter: THREE.NearestFilter,
    magFilter: THREE.NearestFilter,
    depthBuffer: false,
  });
}

type VariantState = "idle" | "compiling" | "ready" | "failed";

/** 一个按需后台编译的窗外变体（和默认材质共用同一份 uniforms，切换不需要同步任何状态） */
class LazyVariant {
  material: THREE.ShaderMaterial | null = null;
  state: VariantState = "idle";
  /** 从开始后台编译到编好（或失败）的毫秒数（性能核对用；页面里的真实编译，含 KHR_parallel_shader_compile 的轮询粒度） */
  compileMs = 0;

  constructor(
    private readonly base: THREE.ShaderMaterial,
    private readonly target: THREE.WebGLRenderTarget | null,
    private readonly defines: Record<string, number>,
    private readonly fragmentShader: string,
    /** 材质名（passes.mjs 按 material.name 归类；空 = 不设，按 #define 兜底归类） */
    private readonly name = "",
  ) {}

  prepare(renderer: THREE.WebGLRenderer) {
    if (this.state !== "idle") return;
    this.state = "compiling";
    const t0 = performance.now();
    const b = this.base;
    const m = new THREE.ShaderMaterial({
      vertexShader: b.vertexShader,
      fragmentShader: this.fragmentShader,
      uniforms: b.uniforms, // 共用同一份 uniforms
      defines: { ...b.defines, ...this.defines },
      depthTest: false,
      depthWrite: false,
      toneMapped: false,
    });
    if (this.name) m.name = this.name;
    const scene = new THREE.Scene();
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute("position", new THREE.Float32BufferAttribute([-1, -1, 0, 3, -1, 0, -1, 3, 0], 3));
    geometry.setAttribute("uv", new THREE.Float32BufferAttribute([0, 0, 2, 0, 0, 2], 2));
    const mesh = new THREE.Mesh(geometry, m);
    mesh.frustumCulled = false;
    scene.add(mesh);
    const prevTarget = renderer.getRenderTarget();
    if (this.target) renderer.setRenderTarget(this.target);
    const job = renderer.compileAsync(scene, new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1));
    renderer.setRenderTarget(prevTarget);
    job
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
      .then(() => {
        if (this.state === "failed") console.warn(`窗外变体 ${JSON.stringify(this.defines)} 编译失败，保持已有的变体`);
      })
      .finally(() => {
        this.compileMs = performance.now() - t0;
        geometry.dispose();
      });
  }
}

/**
 * 低空近景细节的着色器变体（带 GROUND_DETAIL 宏），落在窗外程序上（SC-5 之前落在整个场景程序上）。
 * 细节层让 Windows 上的冷编译明显变长，而且只有离地几公里以内才看得出来，所以默认的窗外着色器不含它：
 * 需要时（离地高度 < ENABLE_BELOW_KM）才用 renderer.compileAsync 在后台编译（KHR_parallel_shader_compile，不阻塞渲染），
 * 编好之后才切过去。变体和默认材质共用同一份 uniforms，切换不需要同步任何状态。
 *
 * 火车远景（TR03）：火车模式下改用另一个变体（GROUND_DETAIL + RAIL，源码多拼了 rail/far-view.glsl.ts），
 * 第一次进入火车模式时才在后台编译；编好之前沿用低空细节变体 / 默认材质（火车模式下飞机的窗外程序会把近处画成海，只是过渡几秒）。
 *
 * PERF-13 起它管全部四个窗外变体（键见 OutsideKey，选择见 wantedOutsideKey）：base 就是默认程序（""），
 * 罕见光学 + 天幕层奇观的 "OW" 在首帧后 PREWARM_AFTER_FRAMES 帧开始后台预编（冷缓存下约 10 s 编好，
 * 之前宝光 / 影子 / 幻日 / 晕与天幕层奇观暂时不画）；想要它时没开始编的也立即开始。类名沿用（main.ts / 调试句柄 __voyage.groundDetail）。
 */
export class GroundDetailVariant {
  static readonly ENABLE_BELOW_KM = 4;
  /** 高于这个高度切回默认材质（带一点滞回，免得在门限附近来回切） */
  static readonly DISABLE_ABOVE_KM = 4.5;
  /** 首帧后多少帧开始后台预编 OW（让启动批次和云的天气变体预编先走；约 1–2 s） */
  static readonly PREWARM_AFTER_FRAMES = 90;
  private readonly variants = new Map<OutsideKey, LazyVariant>();
  private active = false;
  private frames = 0;
  /** 这一帧想要的变体 / 实际画的变体（调试、回归等待用） */
  wanted: OutsideKey = "";
  shown: OutsideKey = "";

  /** target：变体真正要画进去的目标。ANGLE 的 D3D 后端按链接时绑定的帧缓冲生成输出布局，绑错会在首次使用时同步重编 */
  constructor(
    private readonly base: THREE.ShaderMaterial,
    target: THREE.WebGLRenderTarget | null = null,
  ) {
    for (const key of OUTSIDE_KEYS) {
      if (key === "") continue;
      // OW 取名「窗外」：和改动前的默认程序是同一份代码，passes.mjs 归进同一个桶才可比；D 系列按 GROUND_DETAIL 宏归类（和改动前一样）
      this.variants.set(key, new LazyVariant(base, target, outsideVariantDefines(key), outsideVariantFragment(key), key === "OW" ? "窗外" : ""));
    }
  }

  private materialOf(key: OutsideKey): THREE.ShaderMaterial | null {
    if (key === "") return this.base;
    const v = this.variants.get(key)!;
    return v.state === "ready" ? v.material : null;
  }

  /**
   * 每帧调用：给出离地高度（km，关掉真实地理数据时传 Infinity）、是不是火车模式，返回这一帧该用的材质。
   * 罕见光学 / 天幕层奇观要不要从共用 uniforms 里读（调用前这一帧的 optics.update / wonders.update 已经写好）
   */
  pick(renderer: THREE.WebGLRenderer, aglKm: number, rail = false): THREE.ShaderMaterial {
    if (aglKm < GroundDetailVariant.ENABLE_BELOW_KM) this.active = true;
    else if (aglKm > GroundDetailVariant.DISABLE_ABOVE_KM) this.active = false;
    const { key, fallback } = wantedOutsideKey({ detail: this.active, rail, uniforms: this.base.uniforms });
    this.wanted = key;
    if (key !== "") this.variants.get(key)!.prepare(renderer);
    if (++this.frames > GroundDetailVariant.PREWARM_AFTER_FRAMES) this.variants.get("OW")!.prepare(renderer);
    for (const k of [key, ...fallback]) {
      const m = this.materialOf(k);
      if (m) {
        this.shown = k;
        return m;
      }
    }
    this.shown = "";
    return this.base;
  }

  /** 想要的变体还在编（回归截图等它：编好之前 O / W 的效果不画）。编译失败不算等待 */
  get pending() {
    return this.wanted !== this.shown && this.variants.get(this.wanted as Exclude<OutsideKey, "">)?.state !== "failed";
  }

  /** 各变体的编译状态与耗时（调试看：__voyage.groundDetail.variantStatus） */
  get variantStatus() {
    const out: Record<string, { state: VariantState; compileMs: number }> = { "": { state: "ready", compileMs: 0 } };
    for (const [k, v] of this.variants) out[k] = { state: v.state, compileMs: Math.round(v.compileMs) };
    return { wanted: this.wanted, shown: this.shown, variants: out };
  }

  /** 低空细节变体的编译状态 */
  get status() {
    return this.variants.get("DOW")!.state;
  }

  /** 火车远景变体的编译状态（回归场景等它编好再截图） */
  get railStatus() {
    return this.variants.get("DROW")!.state;
  }

  /** 火车远景变体的后台编译耗时（毫秒） */
  get railCompileMs() {
    return this.variants.get("DROW")!.compileMs;
  }

  /** 火车远景变体的材质（编好之前是 null；性能对照、探针用） */
  get railMaterial() {
    return this.variants.get("DROW")!.material;
  }

  /** 罕见光学 + 天幕层奇观变体的材质（编好之前是 null；性能对照、探针用） */
  get extrasMaterial() {
    return this.variants.get("OW")!.material;
  }
}
