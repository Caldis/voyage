/**
 * 光源（GLSL）：太阳、月亮、夜天光。依赖 ATMOSPHERE_COMMON。
 *
 * - 天空辐亮度 = 太阳天空视图 LUT × 日光照度 + 月亮天空视图 LUT × 月光照度 + 夜天光（气辉）
 * - 直射主光源 uKey*：白天是太阳，太阳低于 −4° 后换成月亮（巡航高度上太阳 −3.3° 才完全落下，切换时太阳已不再直射）
 * - 环境光 = 两路天空辐照度之和
 * 所有返回值都是绝对量：辐亮度 kcd/m²，照度 klux。
 */
export const LIGHTS_COMMON = /* glsl */ `
uniform vec3 uSunDir;
uniform vec3 uSunIlluminance;   // 大气层外的太阳照度，klux
uniform vec3 uMoonDir;
uniform vec3 uMoonIlluminance;  // 大气层外的月光照度，klux（由月亮视星等换算）
uniform vec3 uKeyDir;           // 直射主光源方向
uniform vec3 uKeyIlluminance;   // 直射主光源照度（大气层外），klux
uniform sampler2D uSkyViewLut;
uniform sampler2D uSkyViewMoonLut;
uniform sampler2D uIrradianceLut;
uniform float uCamR;

vec3 lutSky(sampler2D lut, vec3 rd, vec3 lightDir, bool hitGround) {
  vec2 h = rd.xz;
  vec2 s = lightDir.xz;
  float lh = length(h);
  float ls = length(s);
  float lightViewCos = (lh > 1e-5 && ls > 1e-5) ? dot(h, s) / (lh * ls) : 1.0;
  return texture(lut, skyViewUv(hitGround, rd.y, lightViewCos, uCamR)).rgb;
}

// 夜天光：气辉 + 星光散射的底色，约 22 等/角秒²（~2e-4 cd/m²）；气辉在离地平线 10–20° 处最亮（van Rhijn 效应），略偏绿
vec3 nightglow(vec3 rd) {
  float h = max(rd.y + 0.06, 0.0);
  float vanRhijn = 1.0 / sqrt(1.0 - 0.96 * (1.0 - h * h));
  return vec3(0.8, 1.0, 0.85) * 1.6e-7 * min(vanRhijn, 4.0);
}

// 从相机看出去的天空辐亮度（含到地面为止的空气透视）
vec3 skyRadiance(vec3 rd, bool hitGround) {
  vec3 L = lutSky(uSkyViewLut, rd, uSunDir, hitGround) * uSunIlluminance
         + lutSky(uSkyViewMoonLut, rd, uMoonDir, hitGround) * uMoonIlluminance;
  if (!hitGround) L += nightglow(rd);
  return L;
}

// 高度 r 处水平面受到的天空漫射照度（太阳和月亮两路），up 是当地的天顶方向
vec3 skyIrradiance(float r, vec3 up) {
  return texture(uIrradianceLut, irradianceUv(r, dot(up, uSunDir))).rgb * uSunIlluminance
       + texture(uIrradianceLut, irradianceUv(r, dot(up, uMoonDir))).rgb * uMoonIlluminance;
}

// 直射主光源到达高度 r 处的照度（垂直于光线），被地球挡住时为 0
vec3 keyLight(float r, vec3 up) {
  return uKeyIlluminance * sunTransmittance(r, dot(up, uKeyDir));
}
`;
