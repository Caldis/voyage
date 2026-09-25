/**
 * 云的密度场与光照（GLSL），思路来自 Schneider《The Real-time Volumetric Cloudscapes of Horizon: Zero Dawn》(2015)
 * 和 Hillaire《Physically Based Sky, Atmosphere and Cloud Rendering in Frostbite》(2016)。
 * 坐标与大气一致：km，地心为原点，相机在 (0, uCamR, 0)，y 向上。
 * 云场随飞机前进整体向后平移：采样坐标 = 相机相对坐标 + uCloudOffset（飞机累计走过的水平位移）。
 */
export const CLOUD_COMMON = /* glsl */ `
uniform sampler3D uShapeNoise;
uniform sampler3D uDetailNoise;
uniform sampler2D uWeather;
uniform vec2 uCloudOffset;      // km
uniform float uCloudBottom;     // 云底高度，km
uniform float uCloudTop;        // 云顶高度，km
uniform float uCoverage;        // 0..1
uniform float uCloudType;       // 0 = 层积云（扁平），1 = 积云（圆顶高耸）
uniform float uCloudDensity;    // 消光系数的倍率
// ---- 天气系统 ----
uniform float uShellBottom;     // 所有云（层状云、雷暴、台风）合起来的高度范围，km
uniform float uShellTop;
uniform int uStormCount;
uniform vec4 uStorms[4];        // 雷暴单体：(本地 x, 本地 z, 塔身半径 km, 云顶高度 km)
uniform vec2 uUpperWind;        // 高空风方向（砧状云被吹向下风方）
uniform vec4 uHurricane;        // 台风：(本地 x, 本地 z, 风眼半径 km, 是否启用)
uniform vec4 uFlash;            // 闪电：(本地 x, 高度 km, 本地 z, 强度)

const float SHAPE_TILE = 7.0;     // 形状噪声一个周期覆盖的水平距离，km
const float DETAIL_TILE = 0.9;
const float WEATHER_TILE = 90.0;
// 积云的消光系数量级是 50–100 /km；密度场是 0..1，乘上这个值
const float CLOUD_EXTINCTION = 60.0;

float remapc(float v, float a, float b, float c, float d) {
  return clamp(c + (v - a) / (b - a) * (d - c), min(c, d), max(c, d));
}

// 高度剖面：层积云扁而平，积云底平、顶圆
float heightProfile(float h, float type) {
  float stratus = smoothstep(0.0, 0.08, h) * (1.0 - smoothstep(0.35, 0.7, h));
  float cumulus = smoothstep(0.0, 0.12, h) * (1.0 - smoothstep(0.45, 1.0, h));
  return mix(stratus, cumulus, type);
}

// ---- 天气场：决定每个区域长什么样的云，而不只是「有没有云」----
struct Weather {
  float coverage;  // 0..1
  float top;       // 这一带的云顶占整层厚度的比例：云顶高低起伏，不是一刀切平
  float scaleMix;  // 0 = 小碎积云，1 = 大云团
  vec2 warp;       // 采样坐标的扭曲（km），打散噪声纹理的网格感
};

Weather sampleWeather(vec2 xz) {
  // 显式用 mip 0：天气图一个像素约 176 m，远比像素覆盖范围粗；隐式导数在循环里没有定义（D3D X3595）
  vec4 w1 = textureLod(uWeather, xz / WEATHER_TILE, 0.0);
  vec4 w2 = textureLod(uWeather, xz / (WEATHER_TILE * 0.31) + 0.37, 0.0);
  vec4 w3 = textureLod(uWeather, xz / (WEATHER_TILE * 3.1) + 0.71, 0.0);
  Weather w;
  float field = w1.r * 0.55 + w2.r * 0.25 + w3.r * 0.2;
  float c = clamp(uCoverage + (field - 0.5) * 1.2, 0.0, 1.0);
  // 中尺度组织（主要对积云）：
  //  - 对流单体：闭合单体（云在单体中心）和开放单体（云在单体边缘、中心晴空）两种形态按区域切换
  float cells = w1.g;
  float openCells = smoothstep(0.4, 0.6, w3.b);
  float cellular = mix(cells, 1.0 - cells, openCells);
  //  - 云街：沿低层风向排成一条条，间距约 4 km，只在部分区域出现
  const vec2 LOW_WIND = vec2(0.94, 0.34);
  float across = dot(xz, vec2(-LOW_WIND.y, LOW_WIND.x));
  float streets = 0.5 + 0.5 * sin(across * 1.57 + (w2.b - 0.5) * 6.0);
  float streetZone = smoothstep(0.55, 0.75, w3.g);
  float org = mix(0.45 + 0.9 * cellular, 0.35 + 0.9 * streets, streetZone);
  c *= mix(1.0, org, uCloudType * 0.8);
  // 小单体：让云团之间的间隙有大有小
  c *= mix(1.0, 0.75 + 0.5 * w2.a, uCloudType * 0.5);
  w.coverage = clamp(c, 0.0, 1.0);
  w.top = mix(0.45, 1.0, smoothstep(0.2, 0.8, w1.b * 0.6 + w2.b * 0.4));
  w.scaleMix = smoothstep(0.35, 0.65, w3.b * 0.5 + w2.r * 0.5);
  w.warp = (vec2(w2.b, w1.a) - 0.5) * 3.0;
  return w;
}

vec2 rot2(vec2 p, float a) {
  float c = cos(a), s = sin(a);
  return vec2(c * p.x - s * p.y, s * p.x + c * p.y);
}

// 层状云（普通云层）的密度：lod 是噪声采样的 mip 级别，远处用粗的；detail = false 时跳过细节侵蚀（阴影、远景用）
float layerDensity(vec3 p, float lod, bool detail) {
  float r = length(p);
  float alt = r - BOTTOM;
  float thick = uCloudTop - uCloudBottom;
  float hLayer = (alt - uCloudBottom) / thick;
  if (hLayer <= 0.0 || hLayer >= 1.0) return 0.0;
  vec2 xz = p.xz + uCloudOffset;
  Weather wx = sampleWeather(xz);
  if (wx.coverage < 0.01) return 0.0;
  // 这一带的云顶：高度剖面按局部云顶重新归一
  float h = hLayer / wx.top;
  if (h >= 1.0) return 0.0;
  // 卷云（云型接近 0）：冰晶被高空风拉成纤维状，噪声沿风向拉长 5 倍
  float stretch = mix(5.0, 1.0, smoothstep(0.0, 0.2, uCloudType));
  const vec2 HIGH_WIND = vec2(0.8, 0.6);
  vec2 xw = xz + wx.warp;
  vec2 xzn = vec2(dot(xw, HIGH_WIND) / stretch, dot(xw, vec2(-HIGH_WIND.y, HIGH_WIND.x)));
  // 两个尺度的形状噪声，相互旋转 37°，按区域混合：有的地方是小碎云，有的地方是大云团
  vec4 nA = textureLod(uShapeNoise, vec3(xzn.x, alt * 1.3, xzn.y) / SHAPE_TILE, lod);
  vec2 xzB = rot2(xzn, 0.65);
  vec4 nB = textureLod(uShapeNoise, vec3(xzB.x, alt * 0.9, xzB.y) / (SHAPE_TILE * 2.3) + 0.37, max(lod - 1.0, 0.0));
  float fbmA = nA.g * 0.625 + nA.b * 0.25 + nA.a * 0.125;
  float fbmB = nB.g * 0.625 + nB.b * 0.25 + nB.a * 0.125;
  float baseA = remapc(nA.r, fbmA - 1.0, 1.0, 0.0, 1.0);
  float baseB = remapc(nB.r, fbmB - 1.0, 1.0, 0.0, 1.0);
  float base = mix(baseA, baseB, wx.scaleMix);
  base *= heightProfile(h, uCloudType);
  float coverage = wx.coverage;
  float d = remapc(base, 1.0 - coverage, 1.0, 0.0, 1.0) * coverage;
  if (detail && d > 0.0) {
    vec3 dn = textureLod(uDetailNoise, vec3(xzn.x, alt, xzn.y) / DETAIL_TILE, lod).rgb;
    float dfbm = dn.r * 0.625 + dn.g * 0.25 + dn.b * 0.125;
    // 云底是被抽丝的絮状，云顶是翻卷的菜花状
    float dmod = mix(dfbm, 1.0 - dfbm, clamp(h * 5.0, 0.0, 1.0));
    d = remapc(d, dmod * 0.55, 1.0, 0.0, 1.0);
  }
  // 真实积云的边界在几十米内消光就从 0 升到 ~50/km：让密度在边缘快速饱和，轮廓才干脆
  return min(d * 3.5, 1.0) * uCloudDensity;
}

// ---- 雷暴（积雨云）----
// 塔身从云底长到云顶，随高度被高空风吹斜；到对流层顶铺开成砧状云（半径约 3 倍，偏向下风方）；
// 塔顶中心有穿出砧顶的上冲云顶；砧状云底挂着乳状云；云底以下是灰色的雨幡。
const float STORM_BASE = 1.2;

// 一座对流塔的形状：R 是塔身半径，top 是塔顶；axis 是塔底中心。噪声直接扰动半径和轴线，形成团块和小塔
float towerShape(vec2 xz, float alt, vec2 axis, float R, float top, bool anvilOn, float lod, out float anvilW) {
  float h = (alt - STORM_BASE) / (top - STORM_BASE);
  anvilW = 0.0;
  if (h < 0.0 || h > 1.12) return 0.0;
  // 轴线随高度摆动（一簇小塔错落上升），并被高空风吹斜
  vec2 wob = (textureLod(uShapeNoise, vec3(axis * 0.13, alt * 0.09) + 0.5, 0.0).gb - 0.5) * R * 0.7;
  vec2 shear = uUpperWind * R * 1.0 * smoothstep(0.3, 1.0, h);
  // 砧状云：到对流层顶铺开，偏向下风方；底面起伏，顶面平
  float anvilBase = 0.74 + 0.05 * (textureLod(uShapeNoise, vec3(xz / (R * 2.5), 0.3), lod).r - 0.5);
  if (anvilOn) anvilW = smoothstep(anvilBase, anvilBase + 0.1, h) * (1.0 - smoothstep(0.985, 1.0, h));
  vec2 anvilShift = uUpperWind * R * 2.2 * anvilW;
  vec2 d2 = xz - axis - wob - shear - anvilShift;
  float r = length(d2);
  // 形状噪声：大团块（约塔身直径）+ 小塔（约 1/3 塔身）
  vec4 nL = textureLod(uShapeNoise, vec3(xz.x, alt * 0.7, xz.y) / (R * 2.4), lod);
  vec4 nS = textureLod(uShapeNoise, vec3(xz.x, alt * 1.2, xz.y) / (R * 0.8) + 0.31, lod);
  // 菜花状的小团块（约 1.5 km），让塔身侧面不再光滑
  vec4 nT = textureLod(uShapeNoise, vec3(xz.x, alt * 1.5, xz.y) / 1.6 + 0.57, lod);
  float lobes = nL.r * 0.7 + nL.g * 0.3;
  float turrets = nS.r;
  float cauli = nT.r - 0.5;
  float towerR = R * (0.55 + 0.25 * sin(min(h, 1.0) * 3.1416)) * (0.6 + 0.55 * lobes + 0.3 * turrets + 0.35 * cauli);
  // 塔顶收成圆顶：越靠近顶部越窄
  towerR *= sqrt(max(1.0 - pow(max(h - 0.75, 0.0) / 0.37, 2.0), 0.0));
  // 砧状云边缘：撕扯开的纤维状，下风方更长更薄
  float anvilR = R * 3.4 * (0.65 + 0.6 * nL.g) * (1.0 + 0.4 * max(dot(normalize(d2 + 1e-4), uUpperWind), 0.0));
  float radius = mix(towerR, anvilR, anvilW);
  float sdf = 1.0 - r / max(radius, 1e-3);
  float body = smoothstep(0.0, 0.1, sdf);
  // 砧状云本身更稀薄（冰晶），外缘更淡
  body *= mix(1.0, 0.55 + 0.45 * smoothstep(0.0, 0.5, sdf), anvilW);
  return body;
}

float stormDensity(vec4 c, vec2 xz, float alt, float lod, bool detail) {
  float top = c.w;
  if (alt > top + 1.3) return 0.0;
  float R = c.z;
  vec2 d2 = xz - c.xy;
  // 雨幡：云底以下，塔身正下方偏下风一点，低密度的灰色帘幕
  if (alt < STORM_BASE) {
    vec2 dr = d2 - uUpperWind * R * 0.3;
    float rr = length(dr) / (R * 0.75);
    if (rr > 1.2) return 0.0;
    float streaks = textureLod(uShapeNoise, vec3(xz.x * 0.6, alt * 0.15, xz.y * 0.6) / SHAPE_TILE, lod + 1.0).g;
    return 0.012 * (1.0 - smoothstep(0.5, 1.2, rr)) * (0.5 + streaks) * smoothstep(0.0, 0.4, alt);
  }
  float anvilW;
  float body = towerShape(xz, alt, c.xy, R, top, true, lod, anvilW);
  // 上冲云顶：砧顶中心拱起的穹顶
  float dh = (alt - top) / 1.3;
  vec2 dc = d2 - uUpperWind * R * 1.0;
  if (dh > -0.2) body = max(body, 1.0 - smoothstep(0.0, 1.0, length(vec2(length(dc) / (R * 0.5), max(dh, 0.0)))));
  // 伴生的浓积云小塔：在主塔周围，顶只有主塔的 35–60%
  for (int k = 0; k < 3; k++) {
    float ang = float(k) * 2.1 + c.x * 0.37;
    vec2 ax = c.xy + vec2(cos(ang), sin(ang)) * R * (1.7 + 0.3 * float(k));
    float tk = STORM_BASE + (top - STORM_BASE) * (0.35 + 0.12 * float(k));
    float aw;
    body = max(body, towerShape(xz, alt, ax, R * 0.45, tk, false, lod, aw));
  }
  // 砧状云底的乳状云：底面往下鼓出一个个圆口袋——用 Worley 噪声改变底面的高度（口袋中心最低），
  // 而不是按水平位置直接给密度（那样会成一根根竖直的「冰柱」）
  float h = (alt - STORM_BASE) / (top - STORM_BASE);
  if (h > 0.6 && h < 0.8) {
    float rr = length(d2 - uUpperWind * R * 2.0) / (R * 3.0);
    float wc = textureLod(uShapeNoise, vec3(xz.x, 0.0, xz.y) / 2.2, lod).g; // 1 = 口袋中心
    // 口袋深度取平方根：中心附近变化平缓，鼓出来是圆的，不是尖的
    float pouchBottom = 0.76 - 0.07 * sqrt(smoothstep(0.35, 1.0, wc));
    float zone = (1.0 - smoothstep(0.55, 1.0, rr)) * smoothstep(0.3, 0.45, rr);
    body = max(body, smoothstep(pouchBottom, pouchBottom + 0.015, h) * (1.0 - smoothstep(0.76, 0.8, h)) * zone);
  }
  if (body <= 0.0) return 0.0;
  float d = body;
  if (detail) {
    vec3 dn = textureLod(uDetailNoise, vec3(xz.x, alt, xz.y) / DETAIL_TILE, lod).rgb;
    float dfbm = dn.r * 0.625 + dn.g * 0.25 + dn.b * 0.125;
    d = remapc(d, (1.0 - dfbm) * 0.5, 1.0, 0.0, 1.0);
  }
  return min(d * 2.5, 1.0);
}

// ---- 台风 ----
// 极坐标结构：晴空的风眼、高耸的眼墙、对数螺旋雨带、覆盖几百公里的卷云盖；风眼里有低空层积云。
float hurricaneDensity(vec2 xz, float alt, float lod) {
  vec2 d2 = xz - uHurricane.xy;
  float r = length(d2);
  float Re = uHurricane.z;
  if (r > Re * 18.0) return 0.0;
  float theta = atan(d2.y, d2.x);
  vec4 n = textureLod(uShapeNoise, vec3(xz.x, alt * 0.8, xz.y) / (SHAPE_TILE * 1.6), lod);
  float fbm = n.g * 0.625 + n.b * 0.25 + n.a * 0.125;
  float d = 0.0;
  // 眼墙：风眼外一圈，内壁向外倾斜（像体育场的看台），顶到 15 km。
  // 内壁半径沿方位角和高度起伏（一团团对流云错落堆叠），不是一堵平整的墙
  vec4 nW = textureLod(uShapeNoise, vec3(xz.x, alt * 0.6, xz.y) / 9.0 + 0.23, lod);
  vec4 nWs = textureLod(uShapeNoise, vec3(xz.x, alt * 1.3, xz.y) / 2.5 + 0.61, lod);
  // 墙面是实心的，噪声只改变墙面的起伏（大团块 ±15%，中等起伏约 ±0.8 km），否则会像一块多孔海绵
  float slope = pow(smoothstep(1.0, 15.0, alt), 1.4);
  // 中等起伏混两个频率的噪声，避免一排排规则的皱褶
  float bumps = (nWs.r - 0.5) * 1.2 + (nW.g - 0.5) * 2.0;
  float wallIn = Re * (1.0 + 0.8 * slope) * (0.87 + 0.26 * nW.r) + bumps;
  float wall = smoothstep(wallIn - 0.3, wallIn + 0.6, r) * (1.0 - smoothstep(Re * 2.6, Re * 3.4, r));
  wall *= 1.0 - smoothstep(14.0, 15.5, alt);
  d = max(d, wall * step(1.0, alt));
  // 螺旋雨带：沿对数螺旋排列的对流带，带间有晴空
  float spiral = sin(2.0 * theta - 2.4 * log(max(r, 1.0)) + fbm * 2.0);
  float band = smoothstep(0.35, 0.9, spiral) * smoothstep(Re * 2.5, Re * 4.0, r) * (1.0 - smoothstep(Re * 12.0, Re * 17.0, r));
  float bandTop = mix(12.0, 7.0, smoothstep(Re * 3.0, Re * 15.0, r));
  band *= step(1.0, alt) * (1.0 - smoothstep(bandTop - 1.5, bandTop, alt));
  d = max(d, band);
  // 卷云盖：眼墙外 13–15 km 的一层冰云，越往外越薄；风眼上方是空的
  float canopy = smoothstep(Re * 1.6, Re * 2.4, r) * (1.0 - smoothstep(Re * 8.0, Re * 16.0, r));
  canopy *= smoothstep(12.5, 13.2, alt) * (1.0 - smoothstep(14.6, 15.2, alt)) * 0.35;
  d = max(d, canopy);
  // 风眼里的低云
  float eyeLow = (1.0 - smoothstep(Re * 0.8, Re, r)) * smoothstep(0.8, 1.0, alt) * (1.0 - smoothstep(1.6, 2.2, alt)) * 0.6;
  d = max(d, eyeLow);
  if (d <= 0.0) return 0.0;
  // 眼墙保持实心；雨带和卷云盖再用噪声调出疏密
  float dn = max(remapc(d * (0.6 + 0.4 * n.r), 1.0 - fbm, 1.0, 0.0, 1.0) * 2.5, wall);
  return min(dn, 1.0);
}

// 所有云的密度：层状云、雷暴、台风取最大
float cloudDensity(vec3 p, float lod, bool detail) {
  float alt = length(p) - BOTTOM;
  if (alt < uShellBottom || alt > uShellTop) return 0.0;
  float d = layerDensity(p, lod, detail);
  if (uStormCount > 0 || uHurricane.w > 0.5) {
    vec2 xz = p.xz + uCloudOffset;
    for (int i = 0; i < 4; i++) {
      if (i >= uStormCount) break;
      vec4 c = uStorms[i];
      vec2 dd = xz - c.xy;
      if (dot(dd, dd) > c.z * c.z * 100.0) continue; // 砧状云加上下风偏移能伸到约 9 倍塔身半径
      d = max(d, stormDensity(c, xz, alt, lod, detail) * uCloudDensity);
    }
    if (uHurricane.w > 0.5) d = max(d, hurricaneDensity(xz, alt, lod) * uCloudDensity);
  }
  return d;
}

// 视线穿过云壳的区间 [t0, t1]；穿不过返回 t1 < t0
vec2 raySphere2(vec3 ro, vec3 rd, float R) {
  float r = length(ro);
  float mu = dot(ro, rd) / r;
  float rs = r * sqrt(max(0.0, 1.0 - mu * mu));
  float disc = (R - rs) * (R + rs);
  if (disc < 0.0) return vec2(-1.0);
  float s = sqrt(disc);
  return vec2(-r * mu - s, -r * mu + s);
}

vec2 cloudShellInterval(vec3 ro, vec3 rd) {
  float rb = BOTTOM + uShellBottom;
  float rt = BOTTOM + uShellTop;
  float r = length(ro);
  vec2 outer = raySphere2(ro, rd, rt);
  vec2 inner = raySphere2(ro, rd, rb);
  vec2 ground = raySphere2(ro, rd, BOTTOM);
  if (r > rt) {
    if (outer.y < 0.0 || outer.x < 0.0) return vec2(1.0, 0.0);
    float t1 = inner.x > 0.0 ? inner.x : outer.y;
    return vec2(outer.x, t1);
  }
  if (r < rb) {
    if (ground.x > 0.0) return vec2(1.0, 0.0); // 在云下往下看，只会看到海
    return vec2(inner.y, outer.y);
  }
  float t1 = inner.x > 0.0 ? inner.x : outer.y;
  return vec2(0.0, t1);
}

// 海面等处的云影：沿太阳方向穿过云壳，取几个点粗略估计光学厚度
float cloudShadow(vec3 p, vec3 sunDir) {
  if (sunDir.y < -0.2 || (uCoverage <= 0.0 && uStormCount == 0 && uHurricane.w < 0.5)) return 1.0;
  // 起点抬高 10 m：正好落在海面球面上时，地面求交会在 0 附近正负抖动，云影随机丢失
  p += normalize(p) * 0.01;
  vec2 seg = cloudShellInterval(p, sunDir);
  if (seg.y <= seg.x) return 1.0;
  seg.y = min(seg.y, seg.x + 20.0);
  float od = 0.0;
  const float N = 5.0;
  float dt = (seg.y - seg.x) / N;
  for (float i = 0.0; i < N; i += 1.0) {
    od += cloudDensity(p + sunDir * (seg.x + (i + 0.5) * dt), 2.0, false);
  }
  return exp(-od * dt * CLOUD_EXTINCTION);
}
`;
