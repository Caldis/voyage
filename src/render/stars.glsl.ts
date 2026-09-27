/**
 * 星星与月亮（GLSL）。依赖 LIGHTS_COMMON。
 * - 星星（T41 起）：耶鲁亮星表（BSC5）放进 J2000 赤道坐标的「每格最多一颗星」的格子（见 sky-assets.ts），
 *   这里查视线附近的 3×3 格，把每颗星投影到屏幕、按亚像素位置做能量守恒的点扩散积分（starPoints）。依赖 VIEW_COMMON、NOISE_COMMON（uLoopGuard）。
 * - 银河（T09）：同一张图的 A 通道，按物理量级定标，乘大气透射率；显示多少由眼睛的对比度阈值决定（月光、城市光、舱内光都会压它）。
 * - 月亮：Lommel-Seeliger 反射（月面没有临边昏暗、满月是均匀圆盘），相位由阳光方向自然产生；
 *   亮度按「整个圆盘积分 = 月光照度」归一；暗面有微弱的地照。
 */
export const STARS_COMMON = /* glsl */ `
uniform sampler2D uStarMap;
uniform mat3 uLocalToEquatorial;   // 当地（x 东、y 上、z 南）→ J2000 赤道直角坐标
uniform sampler2D uMoonTexture;    // 月面反照率（等距柱状，经度 0 在中央）
uniform vec3 uSunFromMoon;         // 从月亮看太阳的方向（≈ 从地球看）
uniform float uMoonAngularRadius;  // 弧度
uniform float uMoonPhaseFraction;  // 被照亮的面积比例 0..1

// ---- 银河（T09）----
// 星图 A 通道是银河的相对亮度（NASA SVS Deep Star Maps 2020「milkyway」图，只含比约 11.5 等更暗的 Gaia DR2 星，见 sky-assets.ts）。
// 绝对定标（估算）：人马座大星云（l = 2°, b = −4°，1° 圆内平均，图上 0.672）取 V ≈ 20.7 等/角秒²
// ——Roach & Gordon 的积分星光 S10 量级给出约 20.3，Masana 2021（GAMBONS）表 3 在 l = 45° 的值按图上比值外推给出约 21.1，取中间。
// 20.7 等/角秒² = 10.8e4 × 10^(−0.4 × 20.7) cd/m² ≈ 5.7e-4 cd/m² = 5.7e-7 kcd/m²；÷ 0.672 → 每单位 8.4e-7 kcd/m²。
// 对照：lights.glsl.ts 的夜天光天顶约 1.6e-7 kcd/m²（22 等/角秒²），所以最亮的银河约是无月夜空底色的 3.5 倍，银极附近远低于底色。
const float MILKY_WAY_UNIT = 8.4e-7;
// 亮区按亮度加权的平均色（build_milkyway.py 算出，按亮度归一）：K 型巨星为主，偏暖；暗视觉下浦肯野会把它压成灰蓝
const vec3 MILKY_WAY_TINT = vec3(1.219, 0.955, 0.801);
uniform float uSkyGlow;      // 城市光污染在飞机上方天空的亮度（kcd/m²，light-pollution.ts），只进银河的可见度阈值
uniform float uCabinLight;   // 舱内灯光照度，klux（scene.ts 声明同名 uniform，两个程序各自声明、共用一个值）
uniform float uMoodLight;    // 氛围洗墙灯 0..1

// 眼睛看不看得见银河：大面积、低对比的目标有对比度阈值，它随背景亮度升高而降低（暗视觉下阈值很高）。
// 近似拟合 Blackwell 1946 对 2° 级大目标的阈值数据（估算，只取量级）：Cth ≈ 0.04 · (B / 3.4e-3 cd/m²)^−0.44，
// 无月夜空（2e-4 cd/m²）约 0.14，满月夜空（约 5e-3）约 0.03。显示出的银河按「超出阈值的部分」计：× max(1 − Cth / C, 0)，
// 在阈值处连续地降到 0。背景 B = 这个方向的天空（含月光照亮的天空、夜天光）+ 城市人工天光 + 舱内光在眼里的光幕：
// 光幕按 Holladay 公式 L = 10 · E / θ²（E 眼睛处照度 lux，θ 光源偏离视线的角度，取 40°）；
// 舱灯开 200 lux → 1.25 cd/m²（银河完全看不见），氛围灯取 0.3 lux 估算 → 1.9e-3 cd/m²（约是无月夜空的 10 倍，只剩一点影子），
// 全关时阅读灯的零星光按贴窗时用手挡住计 0（暗适应后才看得见，这正是全关档的意义）。
// 城市天光和光幕**不画进天空**（画面上的天空底色没有它们），所以还要把银河按「画出来的底色 ÷ 真实底色」缩小，
// 让它相对画面底色的对比度等于真实对比度；否则阈值只砍掉一点点，靠近城市时几乎看不出变淡。
// 月光照亮的天空已经画在底色里，这一项对月光是 1（月光的压制完全来自真实的底色变亮）。
float milkyWayVisibility(float mwKcd, float backgroundKcd) {
  float eyeLux = 1000.0 * uCabinLight * smoothstep(0.005, 0.05, uCabinLight) + 0.3 * uMoodLight;
  float veilCd = 10.0 * eyeLux / (40.0 * 40.0);
  float drawnCd = max(backgroundKcd * 1000.0, 1e-6);
  float bCd = drawnCd + uSkyGlow * 1000.0 + veilCd;
  float cth = clamp(0.04 * pow(bCd / 3.4e-3, -0.44), 0.01, 4.0);
  float c = mwKcd * 1000.0 / bCd;
  return max(1.0 - cth / max(c, 1e-9), 0.0) * (drawnCd / bCd);
}

// ---- 点星（T41）----
// 星点在大气层外是点光源，眼睛里的像远小于一个屏幕像素（1600×1200 下一个像素约 2.7′）。原来把星溅射进 5.3′ 的等距柱状图、
// 再双线性放大，星是 2–4 像素的方块 / 菱形，高赤纬处 texel 在赤经方向变窄，读成短划线。
// 现在按屏幕像素解析地画：每颗星投影到屏幕上的亚像素位置，用高斯点扩散（σ = 0.6 像素，半高宽约 1.4 像素）在这个像素的
// 方格上精确积分（误差函数之差）。所有像素的份额加起来恰好是 1，所以一颗星的总能量只由星等决定、与它落在像素的哪里无关；
// 相机微动时星点平滑地在相邻像素间过渡，不跳、不闪。σ 不再缩小：再小时峰值随亚像素相位的起伏超过 2 倍，头一晃就闪。
const float STAR_PSF_SIGMA = 0.6;
const int STAR_ROWS = 2048;                 // 星表格子的行数（sky-assets.ts 的 STAR_MAP_H）
const int STAR_ROW_INFO_X = 4095;           // 每行最后一个 texel 存本行格数（G·64 + B）
const float STAR_CELL_ANG = M_PI / 2048.0;  // 一格的张角（弧度，约 5.3′）

// 误差函数（Winitzki 近似，绝对误差 < 1.3e-4）
float starErf(float x) {
  float x2 = x * x;
  float ax2 = 0.147 * x2;
  return sign(x) * sqrt(1.0 - exp(-x2 * (1.2732395 + ax2) / (1.0 + ax2)));
}

// B−V 色指数 → 线性 sRGB，按亮度归一到 1。色温按 Ballesteros 2012，色温 → 颜色按黑体近似的 Tanner Helland 拟合
// （原来在 sky-assets.ts 的 CPU 上算，T41 起每个像素对加权平均的色指数算一次）
vec3 starBvToRgb(float bv) {
  float k = 4600.0 * (1.0 / (0.92 * bv + 1.7) + 1.0 / (0.92 * bv + 0.62));
  float t = k / 100.0;
  vec3 c = vec3(
    t <= 66.0 ? 255.0 : 329.7 * pow(t - 60.0, -0.1332),
    t <= 66.0 ? 99.47 * log(t) - 161.12 : 288.12 * pow(t - 60.0, -0.0755),
    t >= 66.0 ? 255.0 : (t <= 19.0 ? 0.0 : 138.52 * log(t - 10.0) - 305.04));
  vec3 s = clamp(c, 0.0, 255.0) / 255.0;
  vec3 lin = mix(s / 12.92, pow((s + 0.055) / 1.055, vec3(2.4)), step(0.04045, s));
  return lin / max(dot(lin, vec3(0.2126, 0.7152, 0.0722)), 1e-4);
}

// 这个像素上所有点星的辐亮度（kcd/m²，大气层外）。uv：视线在星表格子里的位置（x = 赤经 / 2π，y = 0.5 + 赤纬 / π）。
// 查视线所在格的 3×3 邻格（格子每行格数随赤纬减少，保证每格在两个方向上都不小于 5.3′，核的 4σ ≈ 2.4 像素 ≈ 1.1 格以内都找得到）
vec3 starPoints(vec2 uv) {
  float pixAng = 2.0 * uTanHalfFov / uResolution.y;
  // 视场放大（像素张角变大）时把核的角宽度夹在一格的 1/3.2 以内，免得超出 3×3 邻格被截断
  float sigma = min(STAR_PSF_SIGMA, STAR_CELL_ANG / 3.2 / pixAng);
  float kk = 0.70710678 / sigma;
  float reach = 4.0 * sigma + 0.5;
  // 赤道坐标 → 相机系（列：右、上、后）；星投影到屏幕的公式和 view.glsl.ts 的 cabinRay 互逆
  mat3 eqToCam = transpose(uLocalToEquatorial * uCabinToWorld * uCamBasis);
  vec2 toPix = vec2(uResolution.y / uResolution.x, 1.0) / uTanHalfFov;
  int j0 = int(floor(uv.y * float(STAR_ROWS)));
  float eSum = 0.0;
  float bvSum = 0.0;
  for (int dj = -1; dj <= 1 + uLoopGuard; dj++) {
    int j = j0 + dj;
    if (j < 0 || j >= STAR_ROWS) continue;
    vec4 info = texelFetch(uStarMap, ivec2(STAR_ROW_INFO_X, j), 0);
    int n = int(info.g + 0.5) * 64 + int(info.b + 0.5);
    int ic = int(floor(uv.x * float(n)));
    for (int di = -1; di <= 1 + uLoopGuard; di++) {
      if (di + 1 >= n) continue; // 极点附近一行只有一两格时，别把同一格数两遍
      int i = ic + di;
      i = i < 0 ? i + n : (i >= n ? i - n : i);
      vec4 s = texelFetch(uStarMap, ivec2(i, j), 0);
      if (s.r <= 0.0) continue;
      float qy = floor((s.g + 0.5) / 32.0);
      float qx = s.g - qy * 32.0;
      float sra = (float(i) + (qx + 0.5) / 32.0) / float(n) * 2.0 * M_PI;
      float sdec = ((float(j) + (qy + 0.5) / 32.0) / float(STAR_ROWS) - 0.5) * M_PI;
      vec3 v = normalize(eqToCam * vec3(cos(sdec) * cos(sra), cos(sdec) * sin(sra), sin(sdec)));
      if (v.z > -0.01) continue;
      vec2 d = ((v.xy / -v.z) * toPix * 0.5 + 0.5) * uResolution - gl_FragCoord.xy;
      if (max(abs(d.x), abs(d.y)) > reach) continue;
      // 高斯在这个像素方格 [d − 0.5, d + 0.5]² 上的积分
      vec4 e4 = vec4(d + 0.5, d - 0.5) * kk;
      float cov = 0.25 * (starErf(e4.x) - starErf(e4.z)) * (starErf(e4.y) - starErf(e4.w));
      // 离轴像素的立体角是 pixAng² · cos³θ
      float w = s.r * cov / (-v.z * v.z * v.z);
      eSum += w;
      bvSum += w * s.b;
    }
  }
  if (eSum <= 0.0) return vec3(0.0);
  // R 存的是 klux × 1e12；除以像素立体角得辐亮度
  return eSum * 1e-12 / (pixAng * pixAng) * starBvToRgb(bvSum / eSum);
}

// 星星 + 银河，已乘相机上方大气的透射率 tUp（消光）。background：这个方向的天空辐亮度（kcd/m²，不含星星和月亮圆盘）
vec3 starRadiance(vec3 rd, vec3 tUp, vec3 background) {
  vec3 eq = uLocalToEquatorial * rd;
  float ra = atan(eq.y, eq.x);
  float dec = asin(clamp(eq.z, -1.0, 1.0));
  vec2 uv = vec2(fract(ra / (2.0 * M_PI)), 0.5 + dec / M_PI);
  // 银河在 A 通道，照旧双线性过滤（5.3′ 的漫射光比暗视觉的分辨率还细）；RGB 是星表格子，由 starPoints 用 texelFetch 读
  float mwA = textureLod(uStarMap, uv, 0.0).a;
  vec3 mw = mwA * MILKY_WAY_UNIT * MILKY_WAY_TINT * tUp;
  float mwLum = dot(mw, vec3(0.2126, 0.7152, 0.0722));
  float bgLum = dot(background, vec3(0.2126, 0.7152, 0.0722));
  return starPoints(uv) * tUp + mw * milkyWayVisibility(mwLum, bgLum);
}

vec3 moonDisk(vec3 rd) {
  vec3 w = uMoonDir;
  float c = dot(rd, w);
  if (c <= 0.0) return vec3(0.0);
  float sinR = sin(uMoonAngularRadius);
  float ang = asin(min(length(cross(rd, w)), 1.0));
  if (ang > uMoonAngularRadius * 1.3) return vec3(0.0);
  // 月面朝向：月球北极大致指向天球北极
  vec3 north = transpose(uLocalToEquatorial) * vec3(0.0, 0.0, 1.0);
  vec3 right = normalize(cross(w, north));
  vec3 up = cross(right, w);
  vec2 q = vec2(dot(rd, right), dot(rd, up)) / sinR;
  float r2 = min(dot(q, q), 0.9999);
  float cosE = sqrt(1.0 - r2);
  vec3 nrm = -w * cosE + right * q.x + up * q.y; // 月面法线（朝向观察者一侧）
  float cosI = dot(nrm, uSunFromMoon);
  float ls = cosI > 0.0 ? cosI / (cosI + cosE) : 0.0;
  // 月面坐标：圆盘中心是经度 0（近地面正中）
  float lon = atan(dot(nrm, right), cosE);
  float lat = asin(clamp(dot(nrm, up), -1.0, 1.0));
  vec3 albedo = texture(uMoonTexture, vec2(0.5 + lon / (2.0 * M_PI), 0.5 + lat / M_PI)).rgb;
  albedo /= 0.45; // 贴图平均值约 0.45（线性），归一到 1
  float omega = M_PI * uMoonAngularRadius * uMoonAngularRadius;
  // 满月时 2·LS = 1 且照亮比例 = 1，圆盘均匀，积分正好等于月光照度
  vec3 lit = uMoonIlluminance / (omega * max(uMoonPhaseFraction, 0.02)) * 2.0 * ls * albedo;
  vec3 earthshine = uMoonIlluminance / omega * 2e-4 * albedo * (1.0 - uMoonPhaseFraction);
  float pixelAngle = 2.0 * uTanHalfFov / uResolution.y;
  float coverage = clamp((uMoonAngularRadius - ang) / pixelAngle + 0.5, 0.0, 1.0);
  return (lit + earthshine) * coverage;
}
`;
