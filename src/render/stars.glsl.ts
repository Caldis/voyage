/**
 * 星星与月亮（GLSL）。依赖 LIGHTS_COMMON。
 * - 星图：耶鲁亮星表（BSC5）在 CPU 上溅射成 J2000 赤道坐标的等距柱状 HDR 图（见 sky-assets.ts），
 *   这里把当地方向转成赤道坐标去采样。值存的是 ×1e4 的辐亮度（半精度装得下暗星）。
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

vec3 starRadiance(vec3 rd) {
  vec3 eq = uLocalToEquatorial * rd;
  float ra = atan(eq.y, eq.x);
  float dec = asin(clamp(eq.z, -1.0, 1.0));
  vec2 uv = vec2(fract(ra / (2.0 * M_PI)), 0.5 + dec / M_PI);
  return texture(uStarMap, uv).rgb * 1e-4;
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
