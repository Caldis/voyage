/**
 * 天环（WS08，轨道环）：横贯天空的巨弧（GLSL）。设定、尺寸与随机见 wonders/ring-shape.ts。
 * 只拼进窗外程序的 OUTSIDE_WONDER 变体（outside-pass.ts 里包在 #ifdef 中，默认程序预处理后不含它），
 * 一个调用点（outsideRadiance 里天幕层奇观之后）；uRingOn = 0 时第一行就返回。
 * 依赖 ATMOSPHERE_COMMON、VIEW_COMMON、LIGHTS_COMMON、NOISE_COMMON（空气透视的两个 3D 纹理在 TRAFFIC_COMMON 里声明）。
 *
 * 几何（地心坐标，相机在 (0, uCamR, 0)）：环平面过地心、法线 n；环体是一只「箱形截面」的巨环——
 * 腹面（朝地面）在以 n 为轴、半径 r 的圆柱面上，沿 n 宽 2·W2；径向厚 Hd；两侧边缘各一根半径 Rt 的转子护套（圆管）。
 * - 视线与半径 r 的圆柱面求交（相机在圆柱里面，只有往外穿出的一个根），交点 Y 就是腹面所在的那一圈上的点（精确）。
 * - 在 Y 处取截面（垂直于环切向 T 的平面，基 U 径向朝外、n 沿法线）：视线投到截面里是一条过 (0, v)、方向 dh 的直线，
 *   e = (−dh.y, dh.x) 是截面里垂直于它、同时垂直于三维视线的方向，所以像素足迹沿 e 就是 fp = 像素张角 × 距离（精确）。
 *   截面上每个形状（箱体、腹面、两根圆管）投到 e 上是一段区间，覆盖率 = 这段区间对像素三角核的解析积分：
 *   亚像素时按面积摊薄、能量守恒——细亮带不会逐帧闪（铁律：宁可小不要糊）。
 *   只在环几乎顺着视线的掠射处（贴着地平线、在霾里）截面近似才有偏差。
 * - 支柱（缆塔）在环平面里：取视线与环平面交点所在的那一格（每格正中一根），视线到竖直轴线求最近点（同天梯的缆）。
 *
 * 光照：环在大气层以外（500–1400 km）。天空的内散射全部在它前面，所以它对像素的贡献是「加上 透射率 × 自身辐亮度」
 * （身后是黑的太空）——白天是一道比天空亮一点的淡白弧（像白天的月亮），贴近地平线的部分透射率低，自然被天空的蓝冲淡。
 * 太阳 / 月光按真实地影（光线近地点低于地面 = 在地球的影子里；擦过大气 = 被染红）：黄昏时环的一段仍在阳光里、
 * 一段已进地影，明暗交界是一条清楚的线，交界处发红。腹面朝地面，白天主要被下方地球反上来的光照亮（比直射面暗几倍），
 * 侧壁与转子护套被阳光直射——所以白天看到的是两道亮边夹着一条灰带。夜里是城市般的灯带（街区窗格、枢纽灯环、
 * 护套上的灯串与沿环奔跑的光脉冲），月光照着时是一道银灰的弧。
 */
export const ORBIT_RING_COMMON = /* glsl */ `
uniform float uRingOn;   // 1 = 天环在场
uniform vec3 uRingN;     // 环平面法线（窗外坐标，单位向量）
uniform vec3 uRingA;     // 环平面里的参考方向（地心 → 环上一个固定点）：沿环的角度从这里起算
uniform vec4 uRingGeo;   // x 腹面半径 r（离地心，km）、y 半宽 W2（沿法线，km）、z 厚 Hd（径向，km）、w 转子护套半径 Rt（km）
uniform vec4 uRingDet;   // x 支柱间隔（弧度）、y 支柱半径（km）、z 浮现前沿（视线仰角的正弦）、w 种子

// 给 outside-pass 用：这个像素被天环（环体 + 支柱）盖住多少（点星按它挡掉）
float gRingCov = 0.0;

// 三角核（半宽 1 像素、面积 1）的累积分布；区间 [−h, h] 被中心在 c 的三角核覆盖的比例（单位：像素）
float ringTentCdf(float x) {
  x = clamp(x, -1.0, 1.0);
  return x < 0.0 ? 0.5 * (x + 1.0) * (x + 1.0) : 1.0 - 0.5 * (1.0 - x) * (1.0 - x);
}
float ringStrip(float c, float h) {
  return ringTentCdf(h - c) - ringTentCdf(-h - c);
}
// 区间 [x − f/2, x + f/2] 落在「每 P 一条、宽 w 的带」里的比例（盒式积分：远处自然平均成 w/P，不闪）
float ringBandInt(float x, float P, float w) {
  return floor(x / P) * w + min(fract(x / P) * P, w);
}
float ringBands(float x, float f, float P, float w) {
  f = max(f, 1e-3);
  return (ringBandInt(x + 0.5 * f, P, w) - ringBandInt(x - 0.5 * f, P, w)) / f;
}
float ringLum(vec3 v) { return dot(v, vec3(0.2126, 0.7152, 0.0722)); }

// 点 p（地心坐标）朝 dir 看光源的透射率：大气层以内查透射率 LUT；以外看这条光线的近地点——
// 低于地面 = 在地影里，落在大气层里 = 光穿过了一段大气（近地点处水平方向到层顶透射率的平方），所以地影边缘是红的
vec3 ringLightT(vec3 p, vec3 dir) {
  float rp = length(p);
  float mu = dot(p, dir) / rp;
  if (rp < TOP - 1.0) return sunTransmittance(rp, mu);
  if (mu >= 0.0) return vec3(1.0);
  float perigee = rp * sqrt(max(0.0, 1.0 - mu * mu));
  if (perigee >= TOP) return vec3(1.0);
  if (perigee <= BOTTOM) return vec3(0.0);
  vec3 h1 = transmittanceToTop(perigee, 0.0);
  return h1 * h1;
}

// 表面上沿方向 E 的坐标，本像素的足迹有多长（km）：视线横移 fp 时命中点在切平面（法线 N）上的位移，取沿 E 的分量的最大值
float ringFoot(vec3 rd, vec3 N, vec3 E, float fp) {
  float dn = dot(rd, N);
  dn = abs(dn) < 0.02 ? (dn < 0.0 ? -0.02 : 0.02) : dn;
  vec3 g = E - N * (dot(rd, E) / dn);
  return fp * length(g - rd * dot(g, rd));
}

// L：背景辐亮度（天空含内散射）；hitGround：这条视线打到地面（环和支柱都在地平线以外、比地面远，直接跳过）
vec3 orbitRing(vec3 L, vec3 rd, bool hitGround) {
  gRingCov = 0.0;
  if (uRingOn < 0.5 || hitGround) return L;
  // 浮现：从地平线往上一段段显出来（前沿是视线仰角的正弦，前沿以上 0.1 的渐变）
  float visF = 1.0 - smoothstep(uRingDet.z - 0.1, uRingDet.z, rd.y);
  if (visF <= 0.0) return L;
  vec3 n = uRingN;
  vec3 A = uRingA;
  vec3 B = cross(n, A);
  float r = uRingGeo.x;
  float W2 = uRingGeo.y;
  float Hd = uRingGeo.z;
  float Rt = uRingGeo.w;
  vec3 P = vec3(0.0, uCamR, 0.0);
  float pixA = 2.0 * uTanHalfFov / uResolution.y;
  float dn = dot(rd, n);
  float pn = uCamR * n.y;                         // 相机离环平面的有符号距离（km）
  // ---- 视线与腹面所在的圆柱面（轴 n、半径 r）求交：相机在圆柱里面，取往外穿出的根（数值稳定的写法）
  vec3 dp = rd - n * dn;
  float a2 = max(dot(dp, dp), 1e-6);
  float pr = uCamR * sqrt(max(1.0 - n.y * n.y, 0.0)); // 相机离轴线的距离
  float bq = dot(vec3(0.0, uCamR, 0.0) - n * pn, dp);
  float cq = (pr - r) * (pr + r);                  // < 0
  float sq = sqrt(max(bq * bq - a2 * cq, 0.0));
  float lam = bq > 0.0 ? -cq / (bq + sq) : (sq - bq) / a2;
  vec3 Y = P + rd * lam;
  float v = pn + lam * dn;                         // 交点沿法线的坐标（km）
  vec3 U = (Y - n * v) / r;                        // 径向（朝外）
  vec3 T = cross(n, U);                            // 沿环（角度增大的方向）
  float sAl = atan(dot(Y, B), dot(Y, A)) * r;      // 沿环的弧长坐标（km，固定在地球上）
  vec2 d2 = vec2(dot(rd, U), dot(rd, n));
  vec2 dh = d2 / max(length(d2), 1e-3);
  float fp = pixA * lam;                           // 这个距离上一个像素的宽度（km）
  float s0 = v * dh.x;                             // 视线在截面里相对腹面中线的横向偏移（沿 e）
  // ---- 覆盖率：箱体（u ∈ [0, Hd]、v ∈ [−W2, W2]）、其中的腹面、两根转子护套（截面圆心 (0, ±W2)）
  float cHull = ringStrip((s0 + 0.5 * Hd * dh.y) / fp, (0.5 * Hd * abs(dh.y) + W2 * abs(dh.x)) / fp);
  float cBelly = min(ringStrip(s0 / fp, W2 * abs(dh.x) / fp), cHull);
  float cWall = cHull - cBelly;
  float oR1 = s0 - W2 * dh.x;
  float oR2 = s0 + W2 * dh.x;
  float cR1 = ringStrip(oR1 / fp, Rt / fp);
  float cR2 = ringStrip(oR2 / fp, Rt / fp);

  // 结构层级的节奏：支柱间距 Lp → 枢纽（Lp/4）→ 肋（枢纽 / 5）；都以支柱为相位原点（肋与枢纽对齐支柱）
  float dth = uRingDet.x;
  float Lp = dth * r;
  float Lh = 0.25 * Lp;
  float Sr = 0.2 * Lh;
  float sx = sAl - 0.5 * Lp;
  vec3 Nb = -U;                                    // 腹面法线（朝地面）
  float fTb = ringFoot(rd, Nb, T, fp);             // 腹面上沿环方向的像素足迹（km）
  // ---- 枢纽：每 Lh（300–500 km）一座、沿环 18–34 km 长的舱段，截面比环体大一圈（往下凸出 Hh、两侧各伸出 Wx，把护套包在里面）。
  // 环的轮廓每几百 km 断一次——这是这把「尺子」上的刻度。沿环的范围按视线在舱段中部深度处的位置取，按足迹积分（不闪）
  float Hh = Hd;
  float Wx = 3.0 * Rt + 8.0;
  float sxH = sx - 0.5 * Hh * dot(rd, T) / max(d2.x, 0.02);
  float hubK = floor(sxH / Lh + 0.5);
  float hubLen = mix(24.0 + 22.0 * hash12(vec2(hubK, 53.0 + uRingDet.w * 97.0)), 35.0, smoothstep(0.1, 0.3, fTb / Lh));
  float hubA = ringBands(sxH + 0.5 * hubLen, fTb, Lh, hubLen);
  float uc = 0.5 * (Hd + 1.5 - Hh);
  float cHubBox = ringStrip((s0 + uc * dh.y) / fp, (0.5 * (Hd + 1.5 + Hh) * abs(dh.y) + (W2 + Wx) * abs(dh.x)) / fp);
  float cHubBelly = min(ringStrip((s0 - Hh * dh.y) / fp, (W2 + Wx) * abs(dh.x) / fp), cHubBox);
  cHull = mix(cHull, cHubBox, hubA);
  cBelly = mix(cBelly, cHubBelly, hubA);
  cWall = cHull - cBelly;
  cR1 *= 1.0 - hubA;
  cR2 *= 1.0 - hubA;

  // ---- 支柱：视线与环平面的交点落在哪一格（每格正中一根，相位由 ring-shape.ts 让最近的一根在半格以外）
  float cP = 0.0;
  float tP = 1e9;
  float altP = 0.0;
  vec3 aP = U;
  float tpl = -pn / (abs(dn) > 1e-4 ? dn : 1e-4);
  if (tpl > 0.0) {
    vec3 Q = P + rd * tpl;
    float thk = (floor(atan(dot(Q, B), dot(Q, A)) / dth) + 0.5) * dth;
    aP = cos(thk) * A + sin(thk) * B;
    float bb = dot(rd, aP);
    float nn = max(1.0 - bb * bb, 1e-6);
    float dd = dot(rd, P);
    float ee = dot(aP, P);
    tP = (bb * ee - dd) / nn;
    altP = (ee - bb * dd) / nn - BOTTOM;
    float XP = dot(P, cross(rd, aP)) * inversesqrt(nn);
    float fpP = pixA * max(tP, 1.0);
    // 腹面以上不画（接进环体里）；600 km 以内淡出（相位保证出现时最近的一根在 600 km 以外；飞近了也不让它挡在云前面）
    cP = tP > 0.0 ? ringStrip(XP / fpP, uRingDet.y / fpP) * (1.0 - smoothstep(r - BOTTOM - 2.0, r - BOTTOM, altP)) * smoothstep(420.0, 650.0, tP) : 0.0;
  }
  float cRing = 1.0 - (1.0 - cHull) * (1.0 - cR1) * (1.0 - cR2);
  // 前后：支柱比环体的交点近时挡住环，否则被环体挡住
  bool pFront = tP < lam;
  cP *= pFront ? 1.0 : 1.0 - cRing;

  // ---- 光照（整段共用一处）：太阳 / 月亮在交点处的透射率（真实地影）、下方地球反上来的光
  float dayF = smoothstep(-0.10, 0.02, uSunDir.y);
  vec3 eS = uSunIlluminance * ringLightT(Y, uSunDir);
  vec3 eM = uMoonIlluminance * ringLightT(Y, uMoonDir);
  float sunUp = dot(U, uSunDir);
  // 地球反照（反照率约 0.3，朝地面的面看到的地球大半被照亮时约 0.23 倍日照）：环下方的地面在白天一侧才有，
  // 星下点的太阳高度低于约 −20° 时看到的地球已全在夜里（只算太阳一路）
  float fE = smoothstep(-0.35, 0.6, sunUp);
  vec3 eEarth = uSunIlluminance * 0.23 * fE * fE;
  vec3 Ttop = transmittanceToTop(uCamR, rd.y);

  float sgW = dn > 0.0 ? -1.0 : 1.0;
  vec3 Nw = sgW * n;                               // 看得到的那面侧壁的法线（朝相机一侧）
  float fVb = ringFoot(rd, Nb, n, fp);
  float fUw = ringFoot(rd, Nw, U, fp);
  // 每段（两道肋之间）的随机：铺板深浅、是不是还没封板的桁架段。足迹大过半段时退回平均值（远处不逐段跳）
  float segK = floor(sx / Sr);
  float hs = hash12(vec2(segK, 7.0 + uRingDet.w * 97.0));
  float hr = hash12(vec2(segK, 31.0 + uRingDet.w * 97.0));
  float farSeg = smoothstep(0.15, 0.5, fTb / Sr);
  float segVar = mix(hs, 0.5, farSeg);
  float truss = mix(step(hs, 0.13), 0.13, farSeg);
  // 肋：宽窄不一、四分之一空着（按所在格的随机；格界在两道肋正中，带子在那里本来就是 0，不会有跳变）
  float ribK = floor((sx + 0.5 * Sr) / Sr);
  float ribW = mix(1.0 + 3.0 * hash12(vec2(ribK, 43.0)), 2.5, farSeg);
  float rib = ringBands(sx + 0.5 * ribW, fTb, Sr, ribW) * mix(step(0.25, hash12(vec2(ribK, 47.0))), 0.75, farSeg);
  float hub = hubA;
  // 铺板：沿环每 9 km、横向每 W2/3 一块，深浅按块随机（第三级纹理，远处按足迹退回平均）
  float pk = hash12(floor(vec2(sAl / 9.0, v / (0.34 * W2))) + vec2(3.0, 11.0));
  float panel = mix(pk, 0.5, smoothstep(0.2, 0.6, max(fTb / 9.0, fVb / (0.34 * W2))));
  // 桁架段：斜交的杆件，杆间露出暗的内部
  float fD = fTb + fVb;
  float lattice = 1.0 - (1.0 - ringBands(sAl + v, fD, 6.0, 1.1)) * (1.0 - ringBands(sAl - v, fD, 6.0, 1.1));
  float albB = 0.25 + 0.07 * (segVar - 0.5) + 0.03 * (panel - 0.5);
  albB = mix(albB, mix(0.05, 0.34, lattice), truss);
  albB = mix(albB, 0.36, rib);
  albB = mix(albB, 0.42, hub);
  // 侧壁：每 0.9 km 一层的窗带（白天略暗），枢纽处是整块浅色的舱段
  float uW = cWall > 0.0 ? clamp((sgW * W2 - v) / (abs(dh.y) > 1e-3 ? dh.y : 1e-3) * dh.x, 0.0, Hd) : 0.5 * Hd;
  float rows = ringBands(uW, fUw, 0.9, 0.32);
  float albW = mix(0.32 - 0.1 * rows + 0.05 * (segVar - 0.5), 0.42, hub);

  vec3 Eb = eS * max(dot(Nb, uSunDir), 0.0) + eM * max(dot(Nb, uMoonDir), 0.0) + eEarth;
  vec3 Ew = eS * max(dot(Nw, uSunDir), 0.0) + eM * max(dot(Nw, uMoonDir), 0.0) + 0.45 * eEarth;
  // 转子护套：两根圆管，本像素看到的那一点的法线（截面里朝相机的半圆），浅灰（0.5），不做金属高光
  vec2 e2 = vec2(-dh.y, dh.x);
  float q1 = clamp(oR1 / Rt, -1.0, 1.0);
  float q2 = clamp(oR2 / Rt, -1.0, 1.0);
  vec2 n1 = e2 * q1 - dh * sqrt(1.0 - q1 * q1);
  vec2 n2 = e2 * q2 - dh * sqrt(1.0 - q2 * q2);
  vec3 N1 = U * n1.x + n * n1.y;
  vec3 N2 = U * n2.x + n * n2.y;
  vec3 E1 = eS * max(dot(N1, uSunDir), 0.0) + eM * max(dot(N1, uMoonDir), 0.0) + eEarth * (0.5 - 0.5 * n1.x);
  vec3 E2 = eS * max(dot(N2, uSunDir), 0.0) + eM * max(dot(N2, uMoonDir), 0.0) + eEarth * (0.5 - 0.5 * n2.x);

  // 反射光（预乘覆盖率）：箱体两面，再盖上两根护套（护套凸在腹面边缘外）
  vec3 refl = (cBelly * albB * Eb + cWall * albW * Ew) / M_PI;
  refl = refl * (1.0 - cR1) + cR1 * 0.5 / M_PI * E1;
  refl = refl * (1.0 - cR2) + cR2 * 0.5 / M_PI * E2;

  // ---- 自发光（夜里的城市灯带；白天也亮着，只是比阳光下的结构暗几个数量级、看不出来）
  // 腹面：一片片「城区」（沿环 40 km、横向 25 km 尺度的低频噪声定疏密，桁架段不亮），城区里是 2.3 × 1.9 km 的灯格，
  // 都按像素足迹积分（远处噪声也退回平均，不闪）；枢纽是冷白的灯环；侧壁的窗带按同一片城区的疏密亮；
  // 护套上每 5 km 一盏灯，灯串上有沿环奔跑的光脉冲（约 9 km/s，每 700 km 一道：1500 km 外每秒挪几个像素，用时间给出尺度）
  float dens = smoothstep(0.3, 0.9, vnoise(vec2(sAl / 28.0, v / 20.0 + 17.0 * uRingDet.w)));
  dens *= mix(0.4 + 1.2 * vnoise(vec2(sAl / 6.0, v / 5.0 + 3.0)), 1.0, smoothstep(2.0, 5.0, max(fTb, fVb)));
  dens = mix(dens, 0.3, smoothstep(5.0, 14.0, max(fTb, fVb))) * (1.0 - truss);
  float grid = ringBands(sAl, fTb, 2.3, 0.45) * ringBands(v + 0.7, fVb, 1.9, 0.4);
  // 沿环的几条「大道」：腹面上每 W2/3 一条 0.5 km 宽的灯线，亮度沿环缓慢起伏（远看就是几道平行的灯带）
  float ave = ringBands(v + W2 + 0.25 * W2 / 3.0, fVb, W2 / 3.0, 0.5) * (0.35 + 0.65 * mix(vnoise(vec2(sAl / 55.0, floor(v * 3.0 / W2) + 5.0)), 0.5, smoothstep(20.0, 60.0, fTb)));
  vec3 emB = vec3(1.0, 0.66, 0.36) * (1.2e-4 * grid * dens + 1.5e-4 * ave * (1.0 - truss)) + vec3(0.8, 0.9, 1.0) * 1.2e-4 * grid * hub;
  vec3 emW = vec3(1.0, 0.72, 0.44) * 6e-5 * ringBands(uW, fUw, 0.9, 0.3) * (0.15 + dens);
  // 护套上的灯串：只在两根护套朝地面的底线上（截面点 (−Rt, ±W2)），0.6 km 粗的一道细线，每 5 km 一盏
  float bead = ringBands(sAl + 0.2, fTb, 5.0, 0.4);
  float cL1 = ringStrip((oR1 - Rt * dh.y) / fp, 0.3 / fp) * (1.0 - hubA);
  float cL2 = ringStrip((oR2 - Rt * dh.y) / fp, 0.3 / fp) * (1.0 - hubA);
  float ph1 = fract((sAl - 9.0 * uTime) / 700.0) - 0.5;
  float ph2 = fract((sAl + 9.0 * uTime) / 700.0) - 0.5;
  float pls1 = exp(-ph1 * ph1 * 700.0 * 700.0 / 450.0);
  float pls2 = exp(-ph2 * ph2 * 700.0 * 700.0 / 450.0);
  vec3 lampC = vec3(0.9, 0.95, 1.0) * 4e-3;
  vec3 emit = (cBelly * emB + cWall * emW) * (1.0 - cR1) * (1.0 - cR2);
  emit += lampC * (cL1 * (bead + 0.06 * pls1) + cL2 * (bead + 0.06 * pls2));

  // 亮度封顶（只管反射光）：大气层外被阳光直射的结构比暮色天空亮上千倍，按物理算会截成一道白色激光（W01b 的教训）。
  // 超过门限的部分按 x^0.18 压（保留色相，结构之间 3 倍的明暗差压成约 1.2 倍），仍是窗里最亮的东西。
  // 门限 = 同方向天空的 K 倍，但不低于「反照率 0.3 的面被月光照亮」的 K 倍：月光照着的环和月光下的云一样亮，不压
  vec3 addR = Ttop * refl;
  float K = 3.0;
  // 压缩系数只按「正对光源、反照率 0.3 的面」算（只随光照平滑变化，不随反照率的纹理变），所以肋、铺板、枢纽之间的明暗比原样保留
  vec3 Emax = eS + eM + eEarth;
  float x = ringLum(Ttop * 0.3 / M_PI * Emax) / max(K * max(ringLum(L), 0.1 * ringLum(uMoonIlluminance)), 1e-12);
  addR *= x > 1.0 ? pow(x, -0.82) : 1.0;
  float occ = pFront ? 1.0 - cP : 1.0;             // 支柱挡在环前面时，环的那部分被挡掉
  vec3 ringAdd = (addR + Ttop * emit) * visF * occ;

  // ---- 支柱：在大气里的那一段要做空气透视（同天梯的缆：竖直圆柱的平均漫反射 + 天光 + 地球反光）
  if (cP > 0.0) {
    vec3 X = aP * (BOTTOM + max(altP, 0.0));
    vec3 tS = ringLightT(X, uSunDir);
    vec3 lp = uSunDir - aP * dot(uSunDir, aP);
    vec3 vp = -rd - aP * dot(-rd, aP);
    float perp = length(lp);
    float cosA = clamp(dot(lp, vp) / max(perp * length(vp), 1e-6), -1.0, 1.0);
    float alpha = acos(cosA);
    float ph = (sin(alpha) + (M_PI - alpha) * cosA) * 0.25;
    vec3 eUp = 0.21 * uSunIlluminance * max(dot(aP, uSunDir), 0.0);
    vec3 eSky = skyIrradiance(min(BOTTOM + max(altP, 0.0), TOP), aP) * (1.0 - smoothstep(40.0, 100.0, altP));
    vec3 Lpil = 0.3 / M_PI * (uSunIlluminance * tS * perp * ph + 0.5 * (eSky + eUp) + 0.35 * eM);
    // 夜里：每 25 km 一盏暖白灯（足迹沿轴线积分）
    Lpil += vec3(1.0, 0.8, 0.55) * 2e-3 * ringBands(altP, pixA * tP * inversesqrt(max(1.0 - dot(rd, aP) * dot(rd, aP), 1e-6)), 25.0, 0.5);
    vec3 uvw = aerialPerspectiveUvw(rd, uSunDir, min(tP, AERIAL_MAX_DISTANCE));
    vec3 apL = texture(uAerialInscatterS, uvw).rgb * uSunIlluminance;
    vec3 apT = texture(uAerialTransmittanceS, uvw).rgb;
    // 月光那一路的内散射没有 LUT：按「背景里有多少比例的空气在支柱前面」近似（同 wonder-sky 的做法）
    vec3 fF = clamp((1.0 - apT) / max(1.0 - Ttop, vec3(1e-4)), 0.0, 1.0);
    vec3 lFront = max(apL, L * fF * (1.0 - smoothstep(-0.21, -0.14, uSunDir.y)));
    float xp = ringLum(apT * Lpil) / max(K * max(ringLum(L), 0.1 * ringLum(uMoonIlluminance)), 1e-12);
    L = mix(L, lFront + apT * Lpil * (xp > 1.0 ? pow(xp, -0.82) : 1.0), cP * visF);
  }
  gRingCov = max(cRing * occ, cP) * visF;
  return L + ringAdd;
}
`;
