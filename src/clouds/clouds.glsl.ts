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
uniform vec4 uFlash;            // 闪电放电通道的一端（低端）：(本地 x, 高度 km, 本地 z, 强度)
uniform vec3 uFlashB;           // 放电通道的另一端：(本地 x, 高度 km, 本地 z)；云内闪电是几公里长的一段

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
// 形状用「有符号距离（km）+ 翻卷隆起」来描述，而不是「按高度改变半径」：
//  - 塔身：一根被高空风吹斜的圆柱，顶上是扁圆的穹顶（主塔的穹顶高出砧顶约 1 km，就是上冲云顶）；
//    表面叠两级圆鼓鼓的隆起（约 3 km 和 1 km），隆起的高度和它的尺寸相当，所以是菜花状而不是撕碎的纸片。
//  - 砧状云：单独的一块「透镜」，平面外形只随水平位置变（和高度无关），顶面平缓，底面向外缘抬升、越往外越薄，
//    下风方伸得更远；底下挂着半椭球形的乳状云口袋。
//  - 云底以下是倾斜的雨幡，截面不规则、带竖直的雨丝。
// 旧版把砧状云的半径交给随高度变化的 Worley 噪声去调，每个高度的外缘各不相同，看起来是一层层叠起来的盘子。
const float STORM_BASE = 1.2;
const float STORM_OVERSHOOT = 0.9;   // 上冲云顶高出 uStorms.w（砧顶）多少，km

// cloudDensity 的副产物（最近一次求值的点）：是否属于雷暴、雷暴的环境光遮蔽（隆起之间的凹处、砧底、雨幡里看到的天空少）
float gStormW = 0.0;
float gStormAO = 1.0;

vec2 stormHash22(vec2 p) {
  vec3 p3 = fract(vec3(p.xyx) * vec3(0.1031, 0.1030, 0.0973));
  p3 += dot(p3, p3.yzx + 33.33);
  return fract((p3.xx + p3.yz) * p3.zy);
}

// 乳状云口袋：平面上的 Worley 格子，返回 (到最近口袋中心的距离, 这个口袋的随机数)，单位是格
vec2 pouchCell(vec2 p) {
  vec2 id = floor(p);
  vec2 f = fract(p);
  float best = 9.0;
  float rnd = 0.0;
  for (int x = -1; x <= 1; x++)
  for (int y = -1; y <= 1; y++) {
    vec2 o = vec2(float(x), float(y));
    vec2 h = stormHash22(id + o);
    // 特征点不贴着格边：口袋大小比较均匀，挤在一起，像真实的乳状云
    vec2 fp = o + 0.2 + 0.6 * h - f;
    float dd = dot(fp, fp);
    if (dd < best) { best = dd; rnd = h.y; }
  }
  return vec2(sqrt(best), rnd);
}

float sminStorm(float a, float b, float k) {
  float h = clamp(0.5 + 0.5 * (b - a) / k, 0.0, 1.0);
  return mix(b, a, h) - k * h * (1.0 - h);
}

// 一座对流塔的有符号距离（km，负值在云里）。apex：穹顶最高点；R：塔身半径。ao：隆起之间凹处的遮蔽（0..1）
float towerSdf(vec2 xz, float alt, vec2 axis, float R, float apex, float domeFrac, float lod, out float ao) {
  ao = 1.0;
  float H = apex - STORM_BASE;
  float h = (alt - STORM_BASE) / H;
  if (h < -0.08 || h > 1.12) return 1e3;
  // 轴线随高度缓慢摆动（一簇小塔错落上升），上半截被高空风吹斜。
  // 摆动必须是平滑的低频函数：旧版用 Worley 噪声，每隔几百米整个截面就横移一公里多，侧面成了一层层的锯齿
  float ph = dot(axis, vec2(0.37, 0.61));
  vec2 wob = vec2(sin(alt * 0.45 + ph), sin(alt * 0.33 + ph * 1.7 + 1.3)) * R * 0.12;
  vec2 shear = uUpperWind * R * 0.7 * h * h;
  float r = length(xz - axis - wob - shear);
  if (r > R * 2.2) return r - R * 1.4;  // 远离塔身：不必算噪声，给一个保守的距离
  // 平滑外形：底部稍窄、中上部最胖，顶上是扁圆穹顶（从 0.72 H 开始收）
  float Rd = R * (0.72 + 0.28 * sin(clamp(h / domeFrac, 0.0, 1.0) * 1.8));
  float domeStart = STORM_BASE + H * domeFrac;
  float Hd = apex - domeStart;
  vec2 q = vec2(r / Rd, max(alt - domeStart, 0.0) / Hd);
  float lq = length(q);
  float sdf = (lq - 1.0) * mix(Rd, Hd, q.y / max(lq, 1e-3));
  // 翻卷的隆起：约 3 km 的大团 + 约 1 km 的小塔。高度和尺寸相当（圆鼓鼓的）；塔底附近比较平整
  vec4 nA = textureLod(uShapeNoise, vec3(xz.x, alt * 0.8, xz.y) / 13.0, lod);
  vec4 nB = textureLod(uShapeNoise, vec3(xz.x, alt * 1.1, xz.y) / 4.2 + 0.31, lod);
  // 三级：约 3 km 的大团、约 1 km 的小塔（都来自 Worley）、约 0.5 km 的翻卷（Perlin-Worley）。
  // Worley 值是「1 − 到最近特征点的距离」，直接用是圆锥形的尖包；换成球冠 √(1 − d²)：
  // 每个格子鼓成一个圆顶，格子交界处是尖锐的折痕——这就是菜花状隆起的样子
  float dA = clamp((1.0 - nA.g) * 1.6, 0.0, 1.0);
  float dB = clamp((1.0 - nB.g) * 1.6, 0.0, 1.0);
  float bump = 2.2 * (sqrt(1.0 - dA * dA) - 0.55) + 0.9 * (sqrt(1.0 - dB * dB) - 0.55) + 0.4 * (nB.r - 0.55);
  bump *= mix(0.35, 1.0, smoothstep(0.03, 0.35, h));
  // 隆起的顶端看得到大半个天空，凹处只看得到一小块
  ao = smoothstep(-1.1, 0.7, bump);
  // 平的云底（略有起伏）
  float base = STORM_BASE + 0.12 * (nA.b - 0.5);
  return max(sdf - bump, base - alt);
}

// 砧状云（含乳状云）：返回密度（0..1），ao 是环境光遮蔽
float anvilDensity(vec2 xz, float alt, vec2 center, float R, float top, float lod, out float ao, out vec3 geo) {
  ao = 1.0;
  geo = vec3(0.0, 9.0, 0.0);
  float H = top - STORM_BASE;
  float thick0 = 0.22 * H;                 // 中心处约 2.7 km 厚
  if (alt < top - thick0 - 2.6 || alt > top + 0.4) return 0.0;  // 下限含乳状云和靠近塔身处下弯的砧底
  vec2 ac = center + uUpperWind * R * 1.5; // 被高空风吹向下风方
  vec2 da = xz - ac;
  float ra = length(da);
  float down = dot(da, uUpperWind) / max(ra, 1e-3);  // 1 = 正下风方，-1 = 上风方
  // 平面外形：只取噪声的一个水平切片，和高度无关
  vec4 np = textureLod(uShapeNoise, vec3(xz / (R * 6.0), 0.37), lod);
  float Ra = R * 2.6 * (1.0 + 0.7 * max(down, 0.0) - 0.25 * max(-down, 0.0)) * (0.8 + 0.45 * np.g);
  float rho = ra / Ra;
  if (rho > 1.35) return 0.0;
  // 外缘是被高空风拉开的冰晶纤维：沿风向拉长的噪声。
  // 必须随高度变（竖直尺度约 0.7 km）：只用水平切片时，侧看每一列都一样，被竖直拉成木板纹（飑线里最明显）
  vec2 wn = vec2(dot(xz, uUpperWind), dot(xz, vec2(-uUpperWind.y, uUpperWind.x)));
  vec4 nf = textureLod(uShapeNoise, vec3(wn.x / (R * 3.0), alt / 2.8, wn.y / (R * 0.35)) + 0.61, lod);
  float fib = nf.b;
  // 顶面：对流层顶附近几乎是平的，只有缓慢起伏，向外缘略微下沉
  // 顶面起伏：约 1.5 km 的圆鼓包（球冠化的 Worley），靠近塔顶翻腾得厉害，往外缘被吹平
  vec4 nu = textureLod(uShapeNoise, vec3(xz / 6.0, 0.53), lod);
  float du = clamp((1.0 - nu.g) * 1.6, 0.0, 1.0);
  float und = sqrt(1.0 - du * du) - 0.55;
  float aTop = top - 0.2 - 0.9 * rho * rho + 0.4 * (np.b - 0.5) + und * mix(0.7, 0.15, smoothstep(0.1, 0.8, rho));
  // 底面：中心厚、外缘薄成一片；有大尺度的起伏
  // 下风方是被吹出去的冰晶主体，外缘仍有一两公里厚；上风方很快变薄
  float thick = mix(thick0, 0.3 + 1.0 * max(down, 0.0), pow(min(rho, 1.0), 0.7));
  float aBot = aTop - thick + 0.6 * (np.a - 0.5) * smoothstep(0.2, 0.6, rho);
  // 和塔顶连续过渡：靠近塔身上端的地方砧底向下弯，像蘑菇伞从伞柄上长出来，而不是一块插在塔上的板
  float dTop = length(xz - center - uUpperWind * R * 0.7);
  aBot -= 2.0 * (1.0 - smoothstep(0.5 * R, 2.2 * R, dTop));
  float vert = smoothstep(aBot - 0.05, aBot + 0.25, alt) * (1.0 - smoothstep(aTop - 0.25, aTop + 0.05, alt));
  // 下风方的前缘变薄、变碎：纤维噪声在下风方权重更大
  float edge = 1.0 - smoothstep(0.6, 1.0, rho + (0.5 + 0.5 * max(down, 0.0)) * (fib - 0.5) + 0.3 * (nf.r - 0.5));
  // 冰晶云比水滴云稀：中心不透明，外缘半透明
  float dens = vert * edge * mix(0.8, 0.12, smoothstep(0.25, 1.0, rho));
  // 砧底和砧的下半部分看到的天空少
  ao = mix(0.45, 1.0, smoothstep(aBot, aTop, alt));
  // 砧底下的冰晶幡试过用竖直拉长的噪声做，远看成了一排梳齿状的竖条（squall 里尤其明显），先去掉
  geo = vec3(aBot, rho, down);   // 给乳状云用
  return dens;
}

// 乳状云：砧底下风方的一圈，挂着一个个半椭球形的口袋（口袋底面 = 砧底 − 深度 × √(1 − (d/半径)²)）。geo = (砧底, rho, down)
float mammatusDensity(vec2 xz, float alt, vec3 geo) {
  float aBot = geo.x;
  float zone = smoothstep(0.3, 0.45, geo.y) * (1.0 - smoothstep(0.65, 0.8, geo.y)) * smoothstep(-0.2, 0.4, geo.z);
  if (zone <= 0.0 || alt > aBot + 0.3 || alt < aBot - 0.9) return 0.0;
  vec2 pc = pouchCell(xz / 1.3);
  float s = 1.0 - pc.x * pc.x / 0.3;        // 口袋半径约 0.55 格
  if (s <= 0.0 || pc.y <= 0.2) return 0.0;
  float depth = 0.7 * (0.3 + 1.2 * pc.y * pc.y) * zone;
  float pb = aBot + 0.1 - depth * sqrt(s);
  return smoothstep(pb, pb + 0.12, alt) * (1.0 - smoothstep(aBot + 0.1, aBot + 0.3, alt)) * 0.45;
}

// 雨幡：云底以下、主塔下方偏下风一点；被低层风吹斜；截面不规则，边缘是一道道竖直的雨丝
float rainDensity(vec2 xz, float alt, vec2 center, float R, float lod) {
  const vec2 LOW_WIND_R = vec2(0.94, 0.34);
  vec2 dr = xz - center - uUpperWind * R * 0.25 - LOW_WIND_R * (STORM_BASE - alt) * 0.35;
  float n = textureLod(uShapeNoise, vec3(xz / (R * 2.0), 0.83), lod).g;
  float rr = length(dr) / (R * (0.4 + 0.35 * n));
  if (rr > 1.4) return 0.0;
  // 雨丝：水平约 150 m，竖直方向拉得很长
  float streak = textureLod(uShapeNoise, vec3(xz.x / 1.2, alt * 0.02, xz.y / 1.2) + 0.13, max(lod - 1.0, 0.0)).b;
  float core = 1.0 - smoothstep(0.1, 1.2, rr + 0.5 * (streak - 0.5));
  // 强降水的消光约 1–2 /km（能见度 1–3 km）；贴近云底更密，近地面略有蒸发
  float sigma = 1.8 * core * (0.5 + 0.9 * streak) * mix(0.75, 1.0, alt / STORM_BASE) * smoothstep(0.0, 0.1, alt);
  return sigma / CLOUD_EXTINCTION;
}

float stormDensity(vec4 c, vec2 xz, float alt, float lod, bool detail, out float ao) {
  ao = 1.0;
  float top = c.w;
  float R = c.z;
  if (alt > top + STORM_OVERSHOOT + 0.7) return 0.0;
  float rain = 0.0;
  if (alt < STORM_BASE + 0.1) {
    rain = rainDensity(xz, alt, c.xy, R, lod);
    ao = 0.3; // 头顶是几公里厚的云
    if (alt < STORM_BASE - 0.1) return rain;
  }
  // 主塔（穹顶就是上冲云顶）+ 伴生的浓积云小塔（顶只有主塔的 35–60%，和主塔平滑地连成一体）
  float aoT;
  float sdf = towerSdf(xz, alt, c.xy, R, top + STORM_OVERSHOOT, 0.72, lod, aoT);
  // 伴生塔数量写成「3 + 一个恒为 0 的 uniform 表达式」，FXC 就不会把塔身 SDF 展开 3 份
  int nSat = 3 + min(uStormCount, 0);
  for (int k = 0; k < nSat; k++) {
    float ang = float(k) * 2.1 + c.x * 0.37;
    vec2 ax = c.xy + vec2(cos(ang), sin(ang)) * R * (1.5 + 0.3 * float(k));
    float tk = STORM_BASE + (top - STORM_BASE) * (0.35 + 0.12 * float(k));
    if (alt > tk + 0.5) continue;
    float a2;
    float s2 = towerSdf(xz, alt, ax, R * 0.45, tk, 0.4, lod, a2);
    if (s2 < sdf) aoT = a2;
    // 低处融合得更宽：小塔和主塔从同一片云底长出来（飑线侧翼那样连成一体），高处才各自分开
    sdf = sminStorm(sdf, s2, mix(2.2, 0.6, smoothstep(STORM_BASE + 0.5, STORM_BASE + 3.5, alt)));
  }
  // 从表面往里约 250 m 内密度升到饱和：边界干脆，但步进能看到它的厚度
  float tower = smoothstep(0.0, 0.25, -sdf);
  float aoA;
  vec3 geo;
  float anvil = anvilDensity(xz, alt, c.xy, R, top, lod, aoA, geo);
  float mam = mammatusDensity(xz, alt, geo);
  if (mam > anvil) { anvil = mam; aoA = 0.5; }
  if (tower <= 0.0 && anvil <= 0.0) return rain;
  if (detail) {
    vec3 dn = textureLod(uDetailNoise, vec3(xz.x, alt, xz.y) / DETAIL_TILE, lod).rgb;
    float dfbm = dn.r * 0.625 + dn.g * 0.25 + dn.b * 0.125;
    // 塔身：表面附近侵蚀成小的圆团（反相 Worley）；砧：按比例变稀疏，保留半透明的外缘
    tower = remapc(tower, (1.0 - dfbm) * 0.45, 1.0, 0.0, 1.0);
    anvil *= clamp(0.35 + 1.3 * (dfbm - 0.3), 0.25, 1.1);
  }
  if (tower >= anvil) {
    ao = aoT;
    return max(tower, rain);
  }
  ao = aoA;
  return max(anvil, rain);
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

// 精简版雷暴密度：只有塔身（含伴生塔）和砧的大形，没有乳状云、雨幡、细节侵蚀。
// 给光线步进（朝太阳）、云影、探针用：这些地方只要光学厚度的大概，而完整版被内联进 4 个地方，冷编译慢了约 50%
float stormDensityLite(vec4 c, vec2 xz, float alt, float lod) {
  float top = c.w;
  float R = c.z;
  if (alt < STORM_BASE - 0.1 || alt > top + STORM_OVERSHOOT + 0.7) return 0.0;
  float ao;
  float sdf = towerSdf(xz, alt, c.xy, R, top + STORM_OVERSHOOT, 0.72, lod, ao);
  // 伴生塔数量写成「3 + 一个恒为 0 的 uniform 表达式」，FXC 就不会把塔身 SDF 展开 3 份
  int nSat = 3 + min(uStormCount, 0);
  for (int k = 0; k < nSat; k++) {
    float ang = float(k) * 2.1 + c.x * 0.37;
    vec2 ax = c.xy + vec2(cos(ang), sin(ang)) * R * (1.5 + 0.3 * float(k));
    float tk = STORM_BASE + (top - STORM_BASE) * (0.35 + 0.12 * float(k));
    if (alt > tk + 0.5) continue;
    sdf = sminStorm(sdf, towerSdf(xz, alt, ax, R * 0.45, tk, 0.4, lod, ao), mix(2.2, 0.6, smoothstep(STORM_BASE + 0.5, STORM_BASE + 3.5, alt)));
  }
  vec3 geo;
  return max(smoothstep(0.0, 0.25, -sdf), anvilDensity(xz, alt, c.xy, R, top, lod, ao, geo));
}

// 所有云的密度（精简版雷暴）：光线步进、云影、探针用；层状云和台风与完整版相同
float cloudDensityLite(vec3 p, float lod, bool detail) {
  float alt = length(p) - BOTTOM;
  if (alt < uShellBottom || alt > uShellTop) return 0.0;
  float d = layerDensity(p, lod, detail);
  if (uStormCount > 0 || uHurricane.w > 0.5) {
    vec2 xz = p.xz + uCloudOffset;
    // 循环上界用 uniform（最多 4 个）：常量上界会被 FXC 展开成 4 份完整的雷暴密度，冷编译大幅变慢
    for (int i = 0; i < uStormCount; i++) {
      vec4 c = uStorms[i];
      vec2 dd = xz - c.xy;
      if (dot(dd, dd) > c.z * c.z * 56.0) continue;
      d = max(d, stormDensityLite(c, xz, alt, lod) * uCloudDensity);
    }
    if (uHurricane.w > 0.5) d = max(d, hurricaneDensity(xz, alt, lod) * uCloudDensity);
  }
  return d;
}

// 所有云的密度：层状云、雷暴、台风取最大
float cloudDensity(vec3 p, float lod, bool detail) {
  float alt = length(p) - BOTTOM;
  if (alt < uShellBottom || alt > uShellTop) return 0.0;
  float d = layerDensity(p, lod, detail);
  gStormW = 0.0;
  gStormAO = 1.0;
  if (uStormCount > 0 || uHurricane.w > 0.5) {
    vec2 xz = p.xz + uCloudOffset;
    // 循环上界用 uniform（最多 4 个）：常量上界会被 FXC 展开成 4 份完整的雷暴密度，冷编译大幅变慢
    for (int i = 0; i < uStormCount; i++) {
      vec4 c = uStorms[i];
      vec2 dd = xz - c.xy;
      if (dot(dd, dd) > c.z * c.z * 56.0) continue; // 砧状云加上下风偏移最远约 7 倍塔身半径（1.5R + 2.6R × 1.7 × 1.25）
      float ao;
      float sd = stormDensity(c, xz, alt, lod, detail, ao) * uCloudDensity;
      if (sd > d) { d = sd; gStormW = 1.0; gStormAO = ao; }
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
  // 有雷暴时砧状云在 10–14 km：斜着穿过去要 20–40 km，点也要多一些，否则砧的影子被截掉、边缘一格一格的
  bool storms = uStormCount > 0;
  seg.y = min(seg.y, seg.x + (storms ? 40.0 : 20.0));
  float N = storms ? 12.0 : 5.0;
  float od = 0.0;
  float dt = (seg.y - seg.x) / N;
  if (!storms) {
    // 普通云：和改动前一样的常量 5 点（展开后最快）
    for (float i = 0.0; i < 5.0; i += 1.0) od += cloudDensityLite(p + sunDir * (seg.x + (i + 0.5) * dt), 2.0, false);
  } else {
    // 雷暴：点数依赖 uniform，不让 FXC 展开 12 份
    for (int i = 0; i < 12 + min(uStormCount - 1, 0); i++) {
      od += cloudDensityLite(p + sunDir * (seg.x + (float(i) + 0.5) * dt), 2.0, false);
    }
  }
  return exp(-od * dt * CLOUD_EXTINCTION);
}
`;
