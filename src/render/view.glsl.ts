/**
 * 视角与舷窗几何的公共 GLSL：场景着色器和云着色器都要知道「这个像素从哪只眼睛、朝哪个方向、能不能穿出窗外」。
 * 座舱坐标（米）：原点在舱壁内饰面上的窗洞中心，x 沿舱壁，y 向上，z 朝窗外。
 */
export const VIEW_COMMON = /* glsl */ `
uniform vec2 uResolution;      // 全分辨率像素尺寸
uniform vec3 uHead;
uniform mat3 uCamBasis;        // 列：右、上、后（座舱系）
uniform float uTanHalfFov;
uniform mat3 uCabinToWorld;    // 列：座舱 x、y、z 在窗外坐标系里的方向

// ---- 舷窗尺寸（米），大致按窄体客机 ----
const vec2 BEZEL_HALF = vec2(0.170, 0.235); // 舱壁内饰上的开口
const float BEZEL_RADIUS = 0.13;
const vec2 PANE_HALF = vec2(0.120, 0.175);  // 实际透光的窗板
const float PANE_RADIUS = 0.09;
const float PANE_DEPTH = 0.075;             // 窗板离内饰面的深度
const float SHADE_DEPTH = 0.060;            // 遮光板滑槽所在深度

float sdRoundRect(vec2 p, vec2 b, float r) {
  vec2 q = abs(p) - b + r;
  return length(max(q, 0.0)) + min(max(q.x, q.y), 0.0) - r;
}

// 全分辨率像素坐标 → 座舱系里的视线方向
vec3 cabinRay(vec2 fragCoord) {
  vec2 ndc = fragCoord / uResolution * 2.0 - 1.0;
  ndc.x *= uResolution.x / uResolution.y;
  return normalize(uCamBasis * vec3(ndc * uTanHalfFov, -1.0));
}

// 视线在窗板平面上到窗板边缘的有符号距离（米，负数表示穿出窗外）
float paneDistance(vec3 ro, vec3 rd) {
  if (rd.z < 1e-4) return 1.0;
  vec3 p = ro + rd * ((PANE_DEPTH - ro.z) / rd.z);
  return sdRoundRect(p.xy, PANE_HALF, PANE_RADIUS);
}
`;
