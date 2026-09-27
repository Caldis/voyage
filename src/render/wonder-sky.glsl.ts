/**
 * 天幕层奇观（W01）：天梯 / 建木——一根从地平线下升起、直入太空的极细的线（GLSL）。
 * 依赖 ATMOSPHERE_COMMON、VIEW_COMMON、LIGHTS_COMMON、TRAFFIC_COMMON（空气透视的两个 3D 纹理在那里声明，本段不新增 sampler）。
 *
 * 几何：地心坐标（和 outsideRadiance 一样，相机在 (0, uCamR, 0)，y 朝天顶、x 朝东、−z 朝北）。
 * 天梯是一条过地心的射线上的细圆柱：基座 B = uWonderAxis × BOTTOM，向上一直延伸到太空。
 * 视线与轴线求最近点，得到视线到轴线的垂直距离 dist、最近点沿视线的距离 t、沿轴线离基座的高度 s。
 * 所有运算都相对基座做（几百 km 量级），不用地心的 6000 多 km 大数相减，float 精度够分辨 1/10 像素。
 *
 * 为什么「像真的存在」而不是一道渲染划痕（研究文档 §6.1 的最大风险）：
 * - 覆盖率按像素足迹解析积分（三角核，宽 ±1 像素）：亚像素的线按面积摊薄、能量守恒，不会逐帧闪、也没有阶梯；
 * - 光照是真的：太阳 / 月亮在该点的透射率（大气层内查透射率 LUT，层外按光线近地点判断地影），
 *   所以黄昏时下段已经在地球的影子里、上段还被（染红的）阳光照着，分界线的高度随太阳高度自然移动；
 * - 空气透视：线本身乘到它那一点的透射率，再加上相机到它之间的内散射，下半截自然融进地平线的霾；
 * - 一点光晕（前向散射）让被照亮的那段有「空气感」；夜里高处有微弱的航标灯，轿厢是一颗缓慢上升的亮点。
 * 只有一个调用点（outsideRadiance 的合成处）；uWonderOn = 0 时第一行就返回，关掉奇观模式时画面与原来逐像素一致。
 */
export const WONDER_SKY_COMMON = /* glsl */ `
uniform float uWonderOn;     // 1 = 有天幕层奇观要画（奇观模式开着且有奇观在场），0 = 整段早退
uniform vec3 uWonderAxis;    // 轴线方向：地心 → 基座（窗外坐标，单位向量）
uniform vec4 uWonderShape;   // x = 底部半径（km），y = 可见前沿高度（km，浮现编排用），z = 皮肤（0 天梯 / 1 建木），w = 航标灯与轿厢 0/1
uniform vec3 uWonderAlbedo;  // 表面反照率

// 三角核（半宽 1 像素、面积 1）的累积分布：线的覆盖率 = F(右边缘) − F(左边缘)
float wonderTentCdf(float x) {
  x = clamp(x, -1.0, 1.0);
  return x < 0.0 ? 0.5 * (x + 1.0) * (x + 1.0) : 1.0 - 0.5 * (1.0 - x) * (1.0 - x);
}

// 点 p（地心坐标）朝 dir 看光源的透射率。大气层以内查透射率 LUT（地平线以下为 0，按日面大小软过渡）；
// 大气层以外看这条光线的近地点：低于地面 = 在地影里；落在大气层里 = 光穿过了一段大气
// （这段的透射率正好是近地点处水平方向到层顶的透射率的平方，路径对称），所以地影边缘是红的
vec3 wonderLightT(vec3 p, vec3 dir) {
  float r = length(p);
  float mu = dot(p, dir) / r;
  if (r < TOP - 1.0) return sunTransmittance(r, mu);
  if (mu >= 0.0) return vec3(1.0);
  float perigee = r * sqrt(max(0.0, 1.0 - mu * mu));
  if (perigee >= TOP) return vec3(1.0);
  if (perigee <= BOTTOM) return vec3(0.0);
  vec3 half1 = transmittanceToTop(perigee, 0.0);
  return half1 * half1;
}

// 细圆柱（宽度远小于一个像素也成立）朝视线的平均漫反射系数：截面上可见的半圆按投影宽度平均，
// 相位角 alpha（在垂直于轴线的平面里量）时 = (sin α + (π − α) cos α) / 4；正对光源时是 π/4
float wonderCylinderPhase(vec3 lightDir, vec3 V, vec3 a, out float perp) {
  vec3 lp = lightDir - a * dot(lightDir, a);
  perp = length(lp);
  vec3 vp = V - a * dot(V, a);
  float cosA = clamp(dot(lp, vp) / max(perp * length(vp), 1e-6), -1.0, 1.0);
  float alpha = acos(cosA);
  return (sin(alpha) + (M_PI - alpha) * cosA) * 0.25;
}

// L：线背后的背景辐亮度（天空含内散射，地面 / 海面已含空气透视）；tLimit：这条视线打到地面的距离（打不到传一个大数）
vec3 wonderSky(vec3 L, vec3 rd, float tLimit) {
  if (uWonderOn < 0.5) return L;
  vec3 a = uWonderAxis;
  vec3 w0 = vec3(0.0, uCamR, 0.0) - a * BOTTOM; // 相机相对基座
  vec3 n = cross(rd, a);
  float nn = dot(n, n);                          // = 1 − (rd·a)²
  if (nn < 1e-6) return L;                       // 顺着轴线看（不会发生在侧窗里）
  float dist = abs(dot(w0, n)) * inversesqrt(nn);
  float b = dot(rd, a);
  float d = dot(rd, w0);
  float e = dot(a, w0);
  float t = (b * e - d) / nn;                    // 最近点沿视线的距离（km）
  float s = (e - b * d) / nn;                    // 最近点离基座的高度（km）
  if (t <= 0.0 || t > tLimit || s < -1.0) return L;

  float pixelAngle = 2.0 * uTanHalfFov / uResolution.y;
  float wPix = t * pixelAngle;                   // 一个像素在那个距离上有多宽（km）
  // 越往上越细
  float radius = uWonderShape.x * mix(1.0, 0.45, smoothstep(0.0, 600.0, s));
  // 轿厢：一颗缓慢上升的「结」（约 180 km/h，80 分钟一趟），让人看出这根线是一个东西
  float climbS = 8.0 + mod(uTime * 0.05, 260.0);
  float knot = uWonderShape.w * exp(-(s - climbS) * (s - climbS) / 1.2);
  radius *= 1.0 + 0.9 * knot;
  float haloPx = 5.0;
  if (dist > radius + haloPx * 3.0 * wPix) return L;

  // 可见前沿（浮现 / 退场的编排）：前沿以上是长渐变，不是硬边
  float front = uWonderShape.y;
  float vis = (1.0 - smoothstep(0.35 * front, front, s)) * smoothstep(-1.0, 0.5, s);
  if (vis <= 0.0) return L;

  // 覆盖率：三角核在垂直于线的方向上积分（二维足迹对细线来说就是一维的）
  float cov = wonderTentCdf((radius - dist) / wPix) - wonderTentCdf((-radius - dist) / wPix);

  // 光照：太阳、月亮的直射（真实地影）+ 天空光
  vec3 P = a * (BOTTOM + max(s, 0.0));
  float r = BOTTOM + max(s, 0.0);
  vec3 V = -rd;
  float perpS, perpM;
  float phS = wonderCylinderPhase(uSunDir, V, a, perpS);
  float phM = wonderCylinderPhase(uMoonDir, V, a, perpM);
  vec3 eSun = uSunIlluminance * wonderLightT(P, uSunDir) * perpS * phS;
  vec3 eMoon = uMoonIlluminance * wonderLightT(P, uMoonDir) * perpM * phM;
  // 竖直的柱面大约接收半个天空的漫射光；大气层以外没有天空光
  vec3 eSky = skyIrradiance(min(r, TOP), a) * 0.5 * (1.0 - smoothstep(40.0, 100.0, s));
  vec3 albedo = uWonderAlbedo * (1.0 + 1.5 * knot);
  vec3 direct = albedo / M_PI * (eSun + eMoon);
  vec3 Lt = direct + albedo / M_PI * eSky;

  // 空气透视（LUT 最远 400 km；更远的那段视线已经在大气层外，没有更多内散射）
  vec3 uvw = aerialPerspectiveUvw(rd, uSunDir, min(t, AERIAL_MAX_DISTANCE));
  vec3 apL = texture(uAerialInscatterS, uvw).rgb * uSunIlluminance;
  vec3 apT = texture(uAerialTransmittanceS, uvw).rgb;

  // 下半截沉进霾与云海：离地几公里以内被低空的霾层吞掉（按霾的颜色，也就是背后的背景），
  // 不给看见基座——「看不到它从哪里来」
  float sink = smoothstep(0.0, 9.0, s);
  vis *= sink * sink;
  float c = cov * vis;
  // 相机到线之间的内散射：空气透视 LUT 只有太阳一路；月光那一路没有 LUT，按「背景里有多少比例的空气在线前面」近似：
  // 天空的内散射 ∝ 沿视线的消光，线前面那段占 (1 − T线) / (1 − T层顶)。否则月夜里线会黑得像一道裂缝。
  // （气辉在 90 km 高的一层，大多在线后面，所以无月的夜里线确实是一道比天空略暗的剪影）
  vec3 frontFrac = 1.0 - apT;
  if (tLimit > 1e8) frontFrac = clamp(frontFrac / max(1.0 - transmittanceToTop(uCamR, rd.y), vec3(1e-4)), 0.0, 1.0);
  vec3 lFront = max(apL, L * frontFrac);
  L = mix(L, lFront + apT * Lt, c);

  // 光晕：被照亮的那段在空气里的一点前向散射（能量按线的覆盖宽度折算，很弱，只在暮色、夜里的暗背景上看得出）
  float x = dist / wPix;
  float lineW = min(2.0 * radius / wPix, 1.0);
  L += apT * direct * vis * lineW * 0.012 * exp(-x * x / (2.0 * haloPx * haloPx));

  // 航标灯与轿厢灯（只有天梯皮肤）：点光源按像素足迹（二维三角核）摊开，能量守恒，远处也不闪
  if (uWonderShape.w > 0.5) {
    const float SPACING = 30.0;                  // 每 30 km 一盏
    float k = max(floor(s / SPACING + 0.5), 1.0);
    float sk = k * SPACING;
    float dy = (s - sk) * sqrt(nn) / wPix;       // 沿线方向的像素偏移
    float wgt = max(0.0, 1.0 - x) * max(0.0, 1.0 - abs(dy));
    // 慢闪：每盏相位不同，约 2.4 s 一次
    float blink = 0.12 + 0.88 * pow(0.5 + 0.5 * sin(6.2832 * (uTime / 2.4 + k * 0.37)), 8.0);
    // 光强（kcd）→ 相机处照度（klux）= I / 距离²（m），再除以一个像素的立体角得到辐亮度
    float tm = t * 1000.0;
    vec3 beacon = vec3(1.0, 0.08, 0.03) * 60.0 * blink * wgt;
    float dyc = (s - climbS) * sqrt(nn) / wPix;
    vec3 climber = vec3(1.0, 0.95, 0.85) * 15.0 * max(0.0, 1.0 - x) * max(0.0, 1.0 - abs(dyc));
    L += apT * (beacon + climber) * vis / (tm * tm * pixelAngle * pixelAngle);
  }
  return L;
}
`;
