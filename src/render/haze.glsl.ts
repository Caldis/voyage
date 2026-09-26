import { GROUND_LEVELS } from "../ground/clipmap";

/**
 * 低空障眼法（T18）：清晨谷地辐射雾（GLSL）。
 *
 * 边界层霾不在这里：它是大气里多出来的一层气溶胶，进了透射率 / 天空视图 / 空气透视 LUT
 * （atmosphere/common.glsl.ts 的 hazeExtinction，参数由 atmosphere/haze.ts 每帧给），地面、海面、云、天空自动都带上。
 *
 * 谷地雾是贴着地形的，LUT（以相机为中心、只随海拔变）表达不了，所以在地面着色里做：
 *   晴夜地面辐射降温，冷空气顺坡流进谷底积成雾；从高处看，雾顶是一片平的白色，山脊露在外面，雾的边缘沿着等高线。
 *   判断「这里是不是谷底」：命中点的地形高度 h 和周围几公里的平滑地形 hS（clipmap 最粗两级、1–2 km 像素的双线性）比，
 *   低于 hS 超过「下沉量」的地方就在雾里；雾的厚度 = hS − 下沉量 − h，按光学厚度（e 折 30 m）转成覆盖率。
 *   雾越强下沉量越小，雾积得越高；强雾时平原上也按 9 km 尺度的噪声出几块浅雾。
 *   雾顶当作厚层云的顶：反照率 0.85 的朗伯面，受主光源（含云影）和天空光照射。
 * 依赖：ATMOSPHERE_COMMON（BOTTOM、M_PI）、NOISE_COMMON（vnoise）、GROUND_COMMON（levelCovers / levelUv / uGroundHeight）、
 *       LIGHTS_COMMON（uKeyDir）。函数名一律带 haze 前缀（GLSL 没有命名空间）。
 */
export const HAZE_COMMON = /* glsl */ `
// 谷地雾（atmosphere/haze.ts 给）：x 强度 0..1，y 谷底下沉量（km），z 平原雾块强度 0..1
uniform vec4 uValleyFog;

// 清晨谷地辐射雾。P：地面命中点（地心坐标 km）；g：地面纹理坐标（km）；fpM：像素足迹（米）；
// ocean：海洋遮罩（海面上不起辐射雾）；eKey / eSky：命中点的主光源（已含云影）与天空光照度。
// 返回 rgb = 雾顶辐亮度（未乘空气透视），a = 覆盖率（0 = 无雾）
vec4 hazeValleyFog(vec3 P, vec2 g, float fpM, float ocean, vec3 eKey, vec3 eSky) {
  if (uValleyFog.x <= 0.0) return vec4(0.0);
  float h = length(P) - BOTTOM;
  // 周围几公里的平滑地形：最粗两级（约 1 km、2 km 像素）各取一次双线性，再平均
  float h6 = levelCovers(${GROUND_LEVELS - 1}, g) ? textureLod(uGroundHeight, levelUv(${GROUND_LEVELS - 1}, g), 0.0).r : h;
  float h5 = levelCovers(${GROUND_LEVELS - 2}, g) ? textureLod(uGroundHeight, levelUv(${GROUND_LEVELS - 2}, g), 0.0).r : h6;
  float hS = 0.5 * (h5 + h6);
  // 雾顶：平滑地形往下沉一点；强雾时平原上按 9 km 尺度的噪声起伏，出几块浅雾
  float patchN = vnoise(g / 9.0 + 17.0);
  float thick = hS - uValleyFog.y - h + uValleyFog.z * (patchN - 0.55) * 0.25;
  // 雾边的丝缕（约 140 m 尺度）：像素足迹比它大时淡出，免得远处闪烁
  thick += (vnoise(g * (1000.0 / 140.0)) - 0.5) * 0.03 * (1.0 - smoothstep(40.0, 160.0, fpM));
  float cover = (1.0 - exp(-max(thick, 0.0) / 0.03)) * smoothstep(0.0, 0.3, uValleyFog.x) * (1.0 - ocean);
  if (cover <= 0.0) return vec4(0.0);
  // 雾顶的明暗起伏（约 1 km 的缓丘），远处按足迹淡出
  float tone = 1.0 + 0.1 * (vnoise(g / 0.9) - 0.5) * (1.0 - smoothstep(150.0, 500.0, fpM));
  float mu = max(dot(normalize(P), uKeyDir), 0.0);
  vec3 L = 0.85 / M_PI * (eKey * mu + eSky) * tone;
  return vec4(L, cover);
}
`;
