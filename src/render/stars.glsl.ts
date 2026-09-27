/**
 * 星星与月亮（GLSL）。依赖 LIGHTS_COMMON。
 * - 星图：耶鲁亮星表（BSC5）在 CPU 上溅射成 J2000 赤道坐标的等距柱状 HDR 图（见 sky-assets.ts），
 *   这里把当地方向转成赤道坐标去采样。值存的是 ×1e4 的辐亮度（半精度装得下暗星）。
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

// 星星 + 银河，已乘相机上方大气的透射率 tUp（消光）。background：这个方向的天空辐亮度（kcd/m²，不含星星和月亮圆盘）
vec3 starRadiance(vec3 rd, vec3 tUp, vec3 background) {
  vec3 eq = uLocalToEquatorial * rd;
  float ra = atan(eq.y, eq.x);
  float dec = asin(clamp(eq.z, -1.0, 1.0));
  vec2 uv = vec2(fract(ra / (2.0 * M_PI)), 0.5 + dec / M_PI);
  vec4 s = texture(uStarMap, uv);
  vec3 mw = s.a * MILKY_WAY_UNIT * MILKY_WAY_TINT * tUp;
  float mwLum = dot(mw, vec3(0.2126, 0.7152, 0.0722));
  float bgLum = dot(background, vec3(0.2126, 0.7152, 0.0722));
  return s.rgb * 1e-4 * tUp + mw * milkyWayVisibility(mwLum, bgLum);
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
