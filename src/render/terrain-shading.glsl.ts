/**
 * 真实地面的着色（GLSL）：陆地按影像反照率 + 地形法线 + 低空近景细节，湖泊河流用内陆水面，加城市夜光。
 * 海洋部分不在这里算：由 scene.ts 的 outsideRadiance 与开阔海面共用同一个 oceanRadiance 调用点（SC-3）。
 * 依赖 GROUND_COMMON（terrainHit / sampleGround / terrainNormal / terrainShadow）/ LIGHTS_COMMON /
 * GROUND_DETAIL_COMMON（groundDetail，低空近景细节）。
 *
 * 分三步，由 outsideRadiance 串起来：
 *   groundHit    求交、取影像与水体遮罩、空气透视（打不到地面或没有数据返回 false，交给开阔海面 / 天空）；
 *   groundLand   陆地的辐亮度（尚未乘空气透视的透射率）；
 *   groundFinish 水面（海洋或内陆水面，已由调用处算好）加闪光、岸边碎浪、天空反射，与陆地按水体遮罩合成。
 * 为什么拆开：海面着色（oceanRadiance，内含 cloudShadow 和 FFT 取样循环）很重，FXC 在每个调用点整份内联一次。
 * 原来这里和开阔海面各调一次，冷编译多出约 50 s（见 research/DX_SHADER_COMPILE.md）。
 * 同理，云影、水面处的主光源和天空光照度、闪光照度也都由调用处在命中点算一次，陆地和水面共用。
 */
import { GROUND_LEVELS } from "../ground/clipmap";

export const TERRAIN_SHADING_COMMON = /* glsl */ `
// 地面命中点的公共量（groundHit 填好，后两步共用）
struct GroundHit {
  vec3 P;       // 命中点（地心坐标，km）
  vec3 up;      // 当地天顶 = normalize(P)
  vec2 g;       // 地面纹理坐标（随飞机平移）
  float t;      // 相机到命中点的距离（km）
  float lod;
  float fpM;    // 像素足迹（米，斜看拉长后取几何平均）
  float texelM; // 这一级影像像素的尺寸（米）
  vec4 alb;     // 影像反照率
  vec3 wat;     // 水体遮罩：r 水面、g 海洋通道、b 夜光
  vec3 apL;     // 相机到地面的空气透视：内散射
  vec3 apT;     //                        透射率
#ifdef RAIL
  vec3 nT;      // 火车远景（TR03）：地形法线（求交时已算好，groundLand 直接用）
  float fpLong; //                   像素足迹沿视线方向的长轴（米），细节按它淡出
  float alt;    //                   命中点海拔（km，相对相机算的精确值，阴影用）
  float cov;    //                   这个像素被地形盖住的比例（轮廓抗锯齿：擦着山脊 / 远处地平线过去的视线 < 1）
#endif
};
#ifdef RAIL
// 火车远景（TR03）的求交与取样，定义在 rail/far-view.glsl.ts（只拼进火车变体）
bool railGroundHit(vec3 ro, vec3 rd, out GroundHit gh);
#endif

// 第一步：地形求交、取影像和水体遮罩。返回 false 表示这条视线没打到地面（或还没有地面数据），交给原来的海面 / 天空处理
bool groundHit(vec3 ro, vec3 rd, out GroundHit gh) {
#ifdef RAIL
  return railGroundHit(ro, rd, gh);
#else
  float tT = terrainHit(ro, rd);
  if (tT <= 0.0) return false;
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
  vec4 alb = sampleGroundAlbedo(g + albedoJitterKm(g, fpM, texelM), lod);
#else
  vec4 alb = sampleGroundAlbedo(g, lod);
#endif
  if (alb.w <= 0.0) return false;
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
  // 相机到地面的空气透视：用空气透视 LUT（地形不在海平面，天空视图 LUT 的地面部分不适用）
  vec3 uvw = aerialPerspectiveUvw(rd, uSunDir, tT);
  gh.P = P;
  gh.up = up;
  gh.g = g;
  gh.t = tT;
  gh.lod = lod;
  gh.fpM = fpM;
  gh.texelM = texelM;
  gh.alb = alb;
  gh.wat = wat;
  gh.apL = texture(uAerialInscatterS, uvw).rgb * uSunIlluminance;
  gh.apT = texture(uAerialTransmittanceS, uvw).rgb;
  return true;
#endif
}

// 第二步：陆地（水体遮罩 < 1 的部分）的辐亮度，还没乘空气透视的透射率、没乘 (1 − 水面比例)。
// cs：命中点的云影；eFlash：命中点的闪光照度（都由调用处算一次，陆地和水面共用）。
// 返回 w > 0.5 表示这是调试输出，rgb 直接当最终结果
vec4 groundLand(GroundHit gh, float cs, vec3 eFlash) {
  vec3 P = gh.P, up = gh.up;
  vec2 g = gh.g;
  float lod = gh.lod;
  vec4 alb = gh.alb;
  float h = length(P) - BOTTOM;
#ifdef RAIL
  vec3 n = gh.nT;
#else
  vec3 n = terrainNormal(g, up, lod);
#endif
  float ndl = dot(n, uKeyDir);
  vec3 eKey = keyLight(BOTTOM + h, up) * cs;
#ifdef RAIL
  if (ndl > 0.0) eKey *= railTerrainShadow(P, gh.alt, uKeyDir, lod);
#else
  if (ndl > 0.0) eKey *= terrainShadow(P, uKeyDir, lod);
#endif
  vec3 eSky = skyIrradiance(BOTTOM + h, up);
  vec3 albMul = vec3(1.0);
  vec3 nD = n;
  float shadowD = 1.0, aoD = 1.0;
#ifdef GROUND_DETAIL
#ifdef RAIL
  float fpM = gh.fpLong, texelM = gh.texelM; // 火车：贴地掠射，细节按足迹长轴淡出，不在斜看时闪
#else
  float fpM = gh.fpM, texelM = gh.texelM;
#endif
  // 低空近景细节：田块、树冠、街区与楼影（远处自动淡出，返回「无细节」）
  // 夜里（月光）细节几乎看不见，省掉；城市灯光另算，不受影响
  bool dayDetail = uSunDir.y > -0.05 && fpM < 24.0;
  GroundDetail gd = groundDetail(g, alb.rgb, dayDetail ? fpM : 1e3, uKeyDir, lod);
  // 林缘的影子：朝太阳方向约「树高 / tan(太阳高度角)」处是树林、这里不是，这里就落在树影里
  float forestHere = landClasses(alb.rgb).x;
  if (dayDetail && fpM < 20.0 && uKeyDir.y > 0.02 && forestHere < 0.9) {
    float sunH = max(length(uKeyDir.xz), 1e-3);
    float len = min(14.0 * sunH / uKeyDir.y, 60.0);
    vec3 albSun = sampleGroundAlbedo(g + uKeyDir.xz / sunH * len * 0.001, lod).rgb;
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
  float night = gh.wat.b;
  if (night > 0.004) {
    float lumA = dot(alb.rgb, vec3(0.2126, 0.7152, 0.0722));
    float sat = (max(max(alb.r, alb.g), alb.b) - min(min(alb.r, alb.g), alb.b)) / max(lumA, 1e-3);
    float urban = smoothstep(0.04, 0.14, lumA) * (1.0 - smoothstep(0.25, 0.7, sat));
    urban *= urban;
    // 一盏盏灯：每个 30 m 格子里在随机位置放一个圆点（半径约 3 m），亮度随机；
    // 点比像素小时按覆盖比例保持能量——近处是清晰的小圆点，远处自然平均成均匀亮度，不会显出方块
    float pixelAngle = 2.0 * uTanHalfFov / uResolution.y;
    float fpL = max(gh.t * pixelAngle * 1000.0, 0.5);
    vec2 gm = g * 1000.0 / 30.0;
    vec2 cell = floor(gm);
    vec2 jit = hash22(cell * 1.7 + 3.1);
    float dM = length(gm - cell - (0.15 + 0.7 * jit)) * 30.0;           // 到这盏灯的距离（米）
    float rEff = max(3.0, fpL * 0.7);
    float dot1 = exp(-dM * dM / (rEff * rEff)) * (3.0 / rEff) * (3.0 / rEff) * 100.0; // 期望值约 1（30² / (π·3²) ≈ 32，再乘分布的平均）
    float bright = pow(jit.y, 3.0) * 4.0;
    float blocks = dot1 * bright * (0.6 + 0.8 * hash12(floor(g * 1000.0 / 180.0)));
    float emit = pow(night, 2.0) * smoothstep(0.15, 0.5, urban) * 2.5 * blocks;
    land += vec3(1.0, 0.72, 0.42) * 3e-3 * emit;
  }
  return vec4(land, 0.0);
}

// 道路灯带（T08）：夜里的主干道与高速公路。只在 groundFinish 里调用一次（它内含取样循环，FXC 会在每个调用点整份内联）。
// 线来自 OSM 道路的有向距离栅格（clipmap.ts 的 RoadRaster，照亮宽度已按聚落地毯 / 互通 / 断续段决定亮不亮，T43），像素覆盖率由 groundRoadCoverage
// 解析算出（含沿视线方向的各向异性过滤）。这里只做：近处一盏盏路灯的光斑、沿线的明暗起伏与钠灯 / LED 的色温混合、黄昏时各片区先后亮灯。
// 返回地面处的辐亮度（kcd/m²），调用处乘空气透视的透射率
const float ROAD_LUMINANCE = 3.2e-3;           // 满覆盖、强度 1 的路面亮度（cd/m² × 1e-3）。T08 取 1.6（道路照明标准里高速路面 1.5–2 cd/m²）；
                                               // T43 起强度按聚落地毯的亮度线性给（road-raster.ts 的 cityLit，市中心才到 1），市中心的路要跟得上灯点，所以这里 ×2。
                                               // 再亮线会在夜间曝光下过曝成一片平色，抗锯齿的灰阶被截掉、成了台阶（经验值）
const vec3 ROAD_SODIUM = vec3(1.0, 0.45, 0.12); // 高压钠灯：橙
const vec3 ROAD_LED = vec3(1.0, 0.80, 0.62);    // 约 4500 K 的 LED：偏白
vec3 groundRoadLights(GroundHit gh) {
  // 太阳高于约 3.4° 时路灯都没开（按片区在 0°–3° 之间先后开灯，见下面 on）
  if (uSunDir.y > 0.06) return vec3(0.0);
  vec3 ro = vec3(0.0, uCamR, 0.0);
  vec3 rd = (gh.P - ro) / gh.t;
  float pixelAngle = 2.0 * uTanHalfFov / uResolution.y;
  float shortM = max(gh.t * pixelAngle * 1000.0, 0.05);
  float cosI = max(abs(dot(rd, gh.up)), 0.02);
  float longM = shortM / cosI;
  vec2 dirH = rd.xz / max(length(rd.xz), 1e-6);
  float cov = groundRoadCoverage(gh.g, shortM, longM, dirH);
  if (cov <= 1e-4) return vec3(0.0);
  vec2 gm = gh.g * 1000.0; // 米
  // 沿线的明暗起伏：一两百米尺度（一段段街道的灯多灯少、有没有店面）× 几百米（换了灯型 / 灯距、车流）×
  // 几公里（不同路段、不同管理单位）。足迹比起伏的尺度还大时淡出到均值，免得噪声本身在远处闪
  float v0 = mix(vnoise(gm / 170.0 + 5.9), 0.5, smoothstep(60.0, 170.0, longM));
  float v1 = mix(vnoise(gm / 650.0), 0.5, smoothstep(200.0, 700.0, longM));
  float v2 = vnoise(gm / 2900.0 + 7.3);
  float vary = (0.3 + 1.4 * v0) * (0.45 + 1.1 * v1) * (0.65 + 0.7 * v2);
  // 色温：按片区混合钠灯和 LED（很多城市正在把钠灯换成 LED，所以是成片的，不是逐盏随机）
  float sodium = smoothstep(0.35, 0.65, vnoise(gm / 4300.0 + 19.1));
  vec3 col = mix(ROAD_LED / dot(ROAD_LED, vec3(0.2126, 0.7152, 0.0722)),
                 ROAD_SODIUM / dot(ROAD_SODIUM, vec3(0.2126, 0.7152, 0.0722)), sodium);
  // 近处能分出一盏盏路灯：每 32 m 格子里一个光斑（半径约 9 m），按能量归一（平均值 1），足迹变大时淡出成连续的线。
  // 光斑按像素足迹的椭圆展宽（沿视线方向用长轴、横向用短轴）：只按短轴展宽时，斜看的长轴方向上光斑比像素还密，
  // 成了一串闪动的单像素亮点。展宽超过约半个格子后只算本格一盏灯会丢能量，所以在那之前（sA 12→20 m）淡出
  float beads = 1.0;
  float sA = max(9.0, longM * 0.7), sB = max(9.0, shortM * 0.7);
  if (sA < 15.0) {
    vec2 cm = gm / 32.0;
    vec2 cell = floor(cm);
    vec2 jit = hash22(cell * 1.3 + 5.7);
    vec2 off = (cm - cell - (0.2 + 0.6 * jit)) * 32.0;
    float qa = dot(off, dirH) / sA, qb = dot(off, vec2(-dirH.y, dirH.x)) / sB;
    float pool = exp(-(qa * qa + qb * qb)) * (32.0 * 32.0) / (M_PI * sA * sB);
    beads = mix(pool * (0.7 + 0.6 * jit.y), 1.0, smoothstep(10.0, 15.0, sA));
  }
  // 黄昏按片区先后开灯（太阳高度约 0°–3°），片区边界是平滑的噪声，不是方块
  float th = 0.05 * vnoise(gm / 5000.0 + 3.1);
  float on = 1.0 - smoothstep(th - 0.012, th, uSunDir.y);
  return col * (ROAD_LUMINANCE * cov * vary * beads * on);
}

// 第三步：合成。land 是 groundLand 的结果（没有陆地时为 0）；water / fView 是水面着色的结果
// （海洋走调用处唯一的 oceanRadiance，湖泊河流走 inlandWaterRadiance）；skyCam 是反射方向上从相机看到的天空。
// eSunW / eSkyW：水面处主光源（含云影）与天空光的照度，碎浪用
vec3 groundFinish(GroundHit gh, vec3 land, vec3 water, float fView, vec3 skyCam, vec3 eSunW, vec3 eSkyW, vec3 eFlash) {
  // 道路灯带（T08）不乘水体遮罩：跨河、跨海湾的桥上也亮（隧道在 CPU 侧已剔除）
  vec3 road = groundRoadLights(gh);
  if (uDebug == 24) return road; // 调试 24：只画道路灯带（地面处的辐亮度，不含空气透视、城市灯点和地表）
  if (uDebug == 25) road = vec3(0.0); // 调试 25（T43）：正常画面去掉道路灯带，和正常画面相减就是道路的贡献（含空气透视）
  vec3 L = (1.0 - gh.wat.r) * land + road;
  if (gh.wat.r <= 0.001) return L * gh.apT + gh.apL;
  vec3 alb = gh.alb.rgb;
  water += alb * 0.7 / M_PI * eFlash;
#ifdef GROUND_DETAIL
  // 海岸的碎浪（只在低空细节变体里：巡航时它只是一条细淡的线，却让默认着色器冷编译多出好几秒）。
  // 只在海洋（不是湖、河）的岸边。离岸距离用粗三级（近处约 60 m 像素）的水体遮罩估计，
  // 浪线平行于岸、朝岸推进，沿岸的强弱用噪声打散。浪线比像素细时按均值画
  // 足迹 20–40 m 之间平滑淡出（远处浪线细于像素，而且粗级遮罩给出的「离岸距离」已经不准）
  float fpM = gh.fpM;
  vec2 g = gh.g;
  float foamFade = 1.0 - smoothstep(20.0, 40.0, fpM);
  if (gh.wat.g > 0.5 && foamFade > 0.0) {
    // 直接取一级（不走 sampleGround 的逐级查找）：sampleGround 每调用一处 FXC 就内联一份循环，冷编译变慢
    int cl = min(int(floor(gh.lod)) + 3, ${GROUND_LEVELS - 1});
    float cw = levelCovers(cl, g) ? textureLod(uGroundWater, levelUv(cl, g), 0.0).r : 1.0;
    float near = (1.0 - smoothstep(0.55, 0.85, cw)) * foamFade;
    if (near > 0.0) {
      float along = vnoise(g * 1000.0 / 90.0);
      float ph = cw * 20.0 - uTime * 0.7 + along * 5.0;
      float lines = mix(0.35, smoothstep(0.5, 0.95, sin(ph)), 1.0 - smoothstep(4.0, 12.0, fpM));
      float foam = near * lines * mix(0.3, 1.0, along) * clamp(uWind / 7.0, 0.3, 1.5);
      foam = clamp(foam, 0.0, 1.0) * 0.6;
      vec3 eFoam = eSunW * max(dot(gh.up, uKeyDir), 0.0) + eSkyW;
      water = mix(water, 0.6 / M_PI * eFoam, foam);
      fView *= 1.0 - foam;
    }
  }
#endif
  L = L * gh.apT + gh.wat.r * (water * gh.apT + fView * max(skyCam - gh.apL, vec3(0.0)));
  return L + gh.apL;
}
`;
