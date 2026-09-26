/**
 * 真实地面的着色（GLSL）：陆地按影像反照率 + 地形法线 + 低空近景细节，海洋复用海面反射模型、湖泊河流用内陆水面，加城市夜光。
 * 依赖 GROUND_COMMON（terrainHit / sampleGround / terrainNormal / terrainShadow）/ LIGHTS_COMMON /
 * OCEAN_COMMON（oceanRadiance）/ LIGHTNING_COMMON（flashIlluminance）/ GROUND_DETAIL_COMMON（groundDetail，低空近景细节）/
 * INLAND_WATER_COMMON（inlandWaterRadiance，湖泊河流）。
 */
import { GROUND_LEVELS } from "../ground/clipmap";

export const TERRAIN_SHADING_COMMON = /* glsl */ `
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
  // 像素在地面上的足迹（米）：斜看时像素沿视线方向拉长 1/cos 倍。取短边与长边的几何平均，
  // 细节按它淡出（只用短边会让横向的线闪烁，只用长边又淡出得太早）
  float cosI = max(abs(dot(rd, up)), 0.12);
  float fpM = max(tT * pixelAngle * 1000.0 * inversesqrt(cosI), 0.05);
  float texelM = GROUND_BASE * exp2(floor(lod)) * 1000.0 / GROUND_RES;
#ifdef GROUND_DETAIL
  vec4 alb = sampleGround(uGroundAlbedo, g + albedoJitterKm(g, fpM, texelM), lod);
#else
  vec4 alb = sampleGround(uGroundAlbedo, g, lod);
#endif
  if (alb.w <= 0.0) return vec4(0.0, 0.0, 0.0, -1.0);
  vec3 wat = sampleGround(uGroundWater, g, lod).rgb;
  // 水陆边界：水体遮罩是一个影像像素（近处约 8 m）宽的双线性渐变，低空时是一条模糊的带子。
  // 按足迹把它收紧成清晰的岸线，再用几米尺度的噪声让岸线不那么光滑；远处（足迹 ≥ 影像像素）保持原样
  // 阈值取 0.3 而不是 0.5：比影像像素还窄的小河、水渠在遮罩里只有 0.3–0.7 的峰值，阈值 0.5 会把它们整条抹掉
  if (wat.r > 0.0 && wat.r < 1.0) {
    float w = 1.0 - smoothstep(0.2, 0.5, fpM / texelM);
    if (w > 0.0) {
      float k = clamp(0.5 * fpM / texelM, 0.04, 0.25);
      float e = (vnoise(g * 1000.0 / 6.0) - 0.5) * (0.25 - k) * 0.8;
      wat.r = mix(wat.r, smoothstep(0.3 - k, 0.3 + k, wat.r + e), w);
    }
  }
  // 调试 23：水体遮罩（红 = 水面，绿 = 海洋通道，蓝 = 夜光）
  if (uDebug == 23) return vec4(wat * 20.0, 1.0);
  // 相机到地面的空气透视：用空气透视 LUT（地形不在海平面，天空视图 LUT 的地面部分不适用）
  vec3 uvw = aerialPerspectiveUvw(rd, uSunDir, tT);
  vec3 apL = texture(uAerialInscatterS, uvw).rgb * uSunIlluminance;
  vec3 apT = texture(uAerialTransmittanceS, uvw).rgb;
  float h = length(P) - BOTTOM;
  vec3 L = vec3(0.0);
  // 陆地
  vec3 eFlash = flashIlluminance(P);
  // 云影只算一次，陆地和内陆水面共用：cloudShadow 里有展开的固定次数循环，FXC 每个调用点内联一份，冷编译很贵
  float csG = cloudShadow(P, uKeyDir);
  if (wat.r < 0.999) {
    vec3 n = terrainNormal(g, up, lod);
    float ndl = dot(n, uKeyDir);
    vec3 eKey = keyLight(BOTTOM + h, up) * csG;
    if (ndl > 0.0) eKey *= terrainShadow(P, uKeyDir, lod);
    vec3 eSky = skyIrradiance(BOTTOM + h, up);
    vec3 albMul = vec3(1.0);
    vec3 nD = n;
    float shadowD = 1.0, aoD = 1.0;
#ifdef GROUND_DETAIL
    // 低空近景细节：田块、树冠、街区与楼影（远处自动淡出，返回「无细节」）
    // 夜里（月光）细节几乎看不见，省掉；城市灯光另算，不受影响
    bool dayDetail = uSunDir.y > -0.05 && fpM < 24.0;
    GroundDetail gd = groundDetail(g, alb.rgb, dayDetail ? fpM : 1e3, uKeyDir, lod);
    // 林缘的影子：朝太阳方向约「树高 / tan(太阳高度角)」处是树林、这里不是，这里就落在树影里
    float forestHere = landClasses(alb.rgb).x;
    if (dayDetail && fpM < 20.0 && uKeyDir.y > 0.02 && forestHere < 0.9) {
      float sunH = max(length(uKeyDir.xz), 1e-3);
      float len = min(14.0 * sunH / uKeyDir.y, 60.0);
      vec3 albSun = sampleGround(uGroundAlbedo, g + uKeyDir.xz / sunH * len * 0.001, lod).rgb;
      float edge = landClasses(albSun).x * (1.0 - forestHere);
      gd.shadow *= 1.0 - 0.8 * edge * (1.0 - smoothstep(10.0, 20.0, fpM));
    }
    // 调试（只在细节变体里有）：21 地表分类（红 树林、绿 农田、蓝 城区），22 像素足迹（红 = fp / 20 m，绿 = 影像像素 / 20 m）
    if (uDebug == 21) return vec4(landClasses(alb.rgb) * 20.0, 1.0);
    if (uDebug == 22) return vec4(vec3(fpM / 20.0, texelM / 20.0, 0.0) * 20.0, 1.0);
    albMul = gd.albedoMul;
    nD = normalize(n - vec3(gd.slope.x, 0.0, gd.slope.y));
    shadowD = gd.shadow;
    aoD = gd.ao;
#endif
    float ndlD = dot(nD, uKeyDir);
    vec3 land = alb.rgb * albMul / M_PI * (eKey * shadowD * max(ndlD, 0.0) * step(0.0, ndl)
                + eSky * (0.5 + 0.5 * dot(nD, up)) * aoD + eFlash);
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
    // 海洋用海面模型（涌浪 + 风浪）；湖泊、河流用只有细碎涟漪的内陆水面（海面的长波放在河上会出现摩尔纹）
    // 每个像素只算其中一个（按遮罩的海洋通道 0.5 分界）。两个都算再按比例混合能消掉河口的接缝，
    // 但 FXC 要同时保留两份内联代码，冷编译多出十几秒（T02 实测），不值得
    vec3 water;
    // 主光源（含云影）与天空光的照度：内陆水面、碎浪共用，只算一次
    vec3 eSunW = keyLight(BOTTOM, up) * csG;
    vec3 eSkyW = skyIrradiance(BOTTOM, up);
    if (wat.g > 0.5) water = oceanRadiance(P, rd, tT, alb.rgb * 0.7, 1.0, fView, nView);
    else water = inlandWaterRadiance(P, rd, fpM, alb.rgb * 0.7, eSunW, eSkyW, fView, nView);
    water += alb.rgb * 0.7 / M_PI * eFlash;
#ifdef GROUND_DETAIL
    // 海岸的碎浪（只在低空细节变体里：巡航时它只是一条细淡的线，却让默认着色器冷编译多出好几秒）。
    // 只在海洋（不是湖、河）的岸边。离岸距离用粗三级（近处约 60 m 像素）的水体遮罩估计，
    // 浪线平行于岸、朝岸推进，沿岸的强弱用噪声打散。浪线比像素细时按均值画
    // 足迹 20–40 m 之间平滑淡出（远处浪线细于像素，而且粗级遮罩给出的「离岸距离」已经不准）
    float foamFade = 1.0 - smoothstep(20.0, 40.0, fpM);
    if (wat.g > 0.5 && foamFade > 0.0) {
      // 直接取一级（不走 sampleGround 的逐级查找）：sampleGround 每调用一处 FXC 就内联一份循环，冷编译变慢
      int cl = min(int(floor(lod)) + 3, ${GROUND_LEVELS - 1});
      float cw = levelCovers(cl, g) ? textureLod(uGroundWater, levelUv(cl, g), 0.0).r : 1.0;
      float near = (1.0 - smoothstep(0.55, 0.85, cw)) * foamFade;
      if (near > 0.0) {
        float along = vnoise(g * 1000.0 / 90.0);
        float ph = cw * 20.0 - uTime * 0.7 + along * 5.0;
        float lines = mix(0.35, smoothstep(0.5, 0.95, sin(ph)), 1.0 - smoothstep(4.0, 12.0, fpM));
        float foam = near * lines * mix(0.3, 1.0, along) * clamp(uWind / 7.0, 0.3, 1.5);
        foam = clamp(foam, 0.0, 1.0) * 0.6;
        vec3 eFoam = eSunW * max(dot(up, uKeyDir), 0.0) + eSkyW;
        water = mix(water, 0.6 / M_PI * eFoam, foam);
        fView *= 1.0 - foam;
      }
    }
#endif
    vec3 skyCam = skyRadiance(reflect(rd, nView), false);
    L = L * apT + wat.r * (water * apT + fView * max(skyCam - apL, vec3(0.0)));
    return vec4(L + apL, 1.0);
  }
  return vec4(L * apT + apL, 1.0);
}
`;
