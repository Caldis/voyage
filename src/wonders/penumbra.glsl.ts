/**
 * 地影的半影（WS08-b）：大气层外 / 高空的巨构被太阳（月亮）照亮时，按「日面被地球挡住多少」+「擦过大气的光被折射压扁」
 * +「贴地的光被低层云 / 霾挡掉」给明暗交界一段软边，越靠交界越红越暗。只拼进 OWT（天环，ring.glsl.ts）与 OWP（巨柱群，pillars.glsl.ts）
 * 两个按需变体，默认程序与 OW / DOW / DROW 都不含它（天梯 / 建木仍用 wonder-sky 的 wonderLightT，逐字不变）。
 * 依赖 ATMOSPHERE_COMMON（transmittanceToTop、BOTTOM、TOP、SUN_ANGULAR_RADIUS）。
 *
 * 物理：点 p 朝光源的一条光线，近地点高 h（距地面）。日面上角度差 2θ（θ = 日面视半径）的两条光线，近地点高度差：
 * - 没有大气时是 2θ·D（D = p 到近地点的距离）——天环在 3000 km 外看切点，几何半影约 30 km；
 * - 大气折射把低处的光多弯一点（贴地擦过的光双程约 0.02 rad = 70′，按约 7.5 km 的标高衰减）：日面在 p 处看被压扁，
 *   近地点高度差 = 2θ / (1/D + 0.02/7.5·e^{−h/7.5})。交界附近（h 为 0–5 km）是 2–3 km（天环、巨柱群都是这个量级），
 *   这就是日落时从太空看到的「压扁的太阳」。
 * 近地点低于地面的那部分日面被挡住：露在地面以上的弓形面积比 f，透射率取弓形形心那条光线的（近地点越低越红、越暗）。
 * 另外，近地点在几 km 以下的光线要贴地走几百 km，大多撞上云顶 / 霾层（月食时地影比几何的大约 2% 也是这个道理），
 * 透射率 LUT 只有晴空：按近地点 0–8 km 渐隐（cl）。交界前的一段先变成暗红再没入地影，而不是最亮的红一刀切掉。
 * 交界的位置（日面中心的光线擦地）与原来相同；近地点高于 8 km、整个日面都露出来时，返回值与原来逐值相同。
 *
 * 亮度封顶（W01b / WS05 / WS08：暮色里被阳光直射的结构比天空亮上千倍，要按比例压）是这条交界成一刀切的真正原因：
 * 封顶比例按实际照度定时，半影里的衰减被封顶整个抵掉，亮度一直顶在上限，直到照度掉到天空的量级才突然落下
 * （WS07 巨柱群、WS08 天环的一像素硬线）。所以另外输出：
 * - vis = √(f·cl)：太阳「露出来」的程度（0 = 地影里，1 = 整个日面都照到、没被云挡）；
 * - tRef = 形心光线的透射率（但近地点不低于云层顶 8 km）× vis：给封顶定比例用。封顶后受光部分的亮度约按 √(f·cl) 降下去。
 * 调用方把「封顶后的受光结果」与「只有天光 / 月光 / 地球反光的地影结果」按 vis 混合（直接用 tRef 定比例会把天光那部分也压暗，
 * 半影里出现一条比地影还暗的带）。
 */
// 天环与巨柱群的源码在 lint 看来都在同一个窗外程序里（按文本数，不看 #ifdef），所以按前缀各生成一份：ringShadowT / pillarShadowT
export const wonderPenumbraCommon = (pre: string): string => /* glsl */ `
// 从近地点高 h（km）擦过的光线到达 p 的透射率：p 在大气层外时是近地点处水平方向到层顶透射率的平方（路径对称）；
// p 在大气层里时查 p 处、指向这条光线的 μ
vec3 ${pre}GrazeT(float r, float h, bool inAtm) {
  if (!inAtm) {
    vec3 t = transmittanceToTop(BOTTOM + h, 0.0);
    return t * t;
  }
  float s = (BOTTOM + h) / r;
  return transmittanceToTop(r, -sqrt(max(0.0, 1.0 - s * s)));
}

vec3 ${pre}ShadowT(vec3 p, vec3 dir, out vec3 tRef, out float vis) {
  float r = length(p);
  float mu = dot(p, dir) / r;
  bool inAtm = r < TOP - 1.0;
  float rp = r * sqrt(max(0.0, 1.0 - mu * mu));
  float hc = rp - BOTTOM;
  vis = 1.0;
  // 朝上的光线、或近地点在大气层以上：不擦地
  if (mu >= 0.0 || hc >= TOP - BOTTOM) {
    tRef = inAtm ? transmittanceToTop(r, mu) : vec3(1.0);
    return tRef;
  }
  float D = -r * mu;                                          // p 到近地点的距离（km）
  float dh = 2.0 * SUN_ANGULAR_RADIUS / (1.0 / max(D, 1.0) + 0.00267 * exp(-max(hc, 0.0) / 7.5));
  float x = clamp(hc / (0.5 * dh), -1.0, 1.0);                // 地面在日面上的位置（日面半径为 1，x = 1 整个露出）
  float sx = sqrt(1.0 - x * x);
  float A = acos(-x) + x * sx;                                // 露出的弓形面积（单位圆）
  float uc = A > 1e-5 ? 0.6667 * sx * sx * sx / A : 1.0;      // 弓形形心（日面半径为 1）
  float he = max(hc + 0.5 * dh * uc, 0.0);
  float q = A / M_PI * smoothstep(0.0, 8.0, he);              // 露出的日面比例 × 没被低层云 / 霾挡掉的比例
  vis = sqrt(q);
  tRef = ${pre}GrazeT(r, max(he, 8.0), inAtm) * vis;   // 参考取在云层顶以上：压缩比例不随交界前的变红而放松；8 km 以上与实际透射率相同（受光段与原来逐值一致）
  return ${pre}GrazeT(r, he, inAtm) * q;
}
`;
