/**
 * 天环（WS08，轨道环）：横贯天空的巨弧（GLSL）。设定、尺寸与随机见 wonders/ring-shape.ts。
 * 只拼进窗外程序的 OWT 变体（OUTSIDE_WONDER + ORBIT_RING，outside-pass.ts；天环在场时才后台编译，默认程序与 OW / DOW / DROW 预处理后都不含它），
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
 * 侧壁与转子护套被阳光直射——所以白天看到的是两道亮边夹着一条灰带。夜里是城市般的灯带（成片的稀疏灯点、枢纽的密灯、
 * 护套上的灯串与沿环奔跑的光脉冲），月光照着时是一道银灰的弧。
 */
import { wonderPenumbraCommon } from "./penumbra.glsl";

export const ORBIT_RING_COMMON = /* glsl */ `
${wonderPenumbraCommon("ring")}
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
// 同上，但周期短到 4 个像素以内时淡到平均值 w/P：一个像素宽的盒式积分对「两三个像素一周期」的花纹仍留下六成反差，
// 随飞行 / 晃动沿线爬动、逐帧闪（WS08 live 实测：护套灯串在远段 2 像素一盏时闪烁像素 200+）
float ringBandsAA(float x, float f, float P, float w) {
  return mix(ringBands(x, f, P, w), w / P, smoothstep(0.25, 0.5, f / P));
}
float ringLum(vec3 v) { return dot(v, vec3(0.2126, 0.7152, 0.0722)); }

// 每 S km 一段、每段一个随机值 hash12(段号, salt)，在足迹 [x ± f/2] 上的平均（足迹小于一段时最多跨两段，按重叠长度加权）。
// 足迹大过半段时退回期望 0.5。段界是世界里的硬边，不这样过滤就会随飞行 / 晃动在像素之间跳（WS08 live 实测的远段闪烁）
float ringSegHash(float x, float f, float S, float salt) {
  f = max(f, 1e-3);
  float k0 = floor((x - 0.5 * f) / S);
  float a = clamp(((k0 + 1.0) * S - (x - 0.5 * f)) / f, 0.0, 1.0);
  float h = a * hash12(vec2(k0, salt)) + (1.0 - a) * hash12(vec2(k0 + 1.0, salt));
  return mix(h, 0.5, smoothstep(0.25, 0.5, f / S));
}
// 同上，但每段的值是「随机数 < thr」（这一段是不是某种段）：返回足迹里这种段所占的比例，远处退回 thr
float ringSegIs(float x, float f, float S, float salt, float thr) {
  f = max(f, 1e-3);
  float k0 = floor((x - 0.5 * f) / S);
  float a = clamp(((k0 + 1.0) * S - (x - 0.5 * f)) / f, 0.0, 1.0);
  float h = a * step(hash12(vec2(k0, salt)), thr) + (1.0 - a) * step(hash12(vec2(k0 + 1.0, salt)), thr);
  return mix(h, thr, smoothstep(0.25, 0.5, f / S));
}

// 城区疏密（WS08-b 重做）：q = (沿环弧长, 横向)（km），f = 像素足迹（km，0 = 不过滤，给按格取的灯用）。
// 原来是一层 28 × 20 km 的 value noise 过 smoothstep：value noise 的格子沿环 / 横向对齐，斜看时读成一块块边缘发虚的方格斑（低清贴图）。
// 现在：60–70 km 尺度的两路低频噪声把坐标推开 ±14 km（域扭曲，城区边界不再沿网格）+ 四个倍频（46 / 21 / 9.7 / 4.5 km，
// 每级转 37° 并错开，格子方向互不对齐）。比像素足迹小到采样不住的倍频淡到均值（远处不闪、不糊成大斑，细节一直保留到 2–4 个像素），
// 淡掉的那部分起伏不丢：阈值的过渡带按它的标准差放宽（「过滤后的阈值」，远处的平均灯量与近处按格取的期望一致）
float ringCity(vec2 q, float f) {
  float sd = uRingDet.w;
  vec2 wq = vec2(vnoise(q * vec2(0.0143, 0.018) + vec2(3.1 + 17.0 * sd, 7.7)),
                 vnoise(q * vec2(0.0167, 0.0143) + vec2(11.3, 5.2 + 13.0 * sd))) - 0.5;
  vec2 p = q + 28.0 * wq * (1.0 - smoothstep(10.0, 25.0, f));
  float n = 0.0, lam = 46.0, a = 0.5, va = 0.0;
  for (int i = 0; i < 4; i++) {
    float k = 1.0 - smoothstep(0.18, 0.42, f / lam);
    n += a * mix(0.5, vnoise(p / lam + vec2(19.7 * float(i) + 31.0 * sd, 7.3 * float(i))), k);
    va += a * a * (1.0 - k * k);
    p = mat2(0.8, 0.6, -0.6, 0.8) * p;
    lam *= 0.46;
    a *= 0.62;
  }
  n /= 0.5 + 0.31 + 0.1922 + 0.1192;                          // 权重和
  float sg = 0.2 * sqrt(va) / (0.5 + 0.31 + 0.1922 + 0.1192);  // 淡掉的倍频的标准差（value noise 单层约 0.2）
  return smoothstep(0.42 - 1.5 * sg, 0.7 + 1.5 * sg, n);
}

// 腹面某一处（沿环弧长 s、横向 v）有灯的概率：成片的城区（ringCity）、枢纽处固定 0.35、
// 还没封板的桁架段（每段 13%）不亮。只由位置决定——在灯所在的格子中心取，同一盏灯在所有像素上结论一致
// （WS08 返工：按像素取时，跨段界 / 枢纽边的灯会被切掉一半，飞机一晃就忽亮忽灭）。
// fC：格子边长（km）大于单盏灯的格子时，城区疏密按这一格过滤（得到这一格里的平均概率），见 ringLampPts 的「灯团」
float ringLampP(vec2 c, float Lp, float Lh, float Sr, float fC) {
  float sx = c.x - 0.5 * Lp;
  float hubK = floor(sx / Lh + 0.5);
  float hubP = step(abs(sx - hubK * Lh), 12.0 + 11.0 * hash12(vec2(hubK, 53.0 + uRingDet.w * 97.0)));
  float densP = ringCity(c, fC);
  float truss = step(hash12(vec2(floor(sx / Sr), 7.0 + uRingDet.w * 97.0)), 0.13);
  return mix(0.5 * densP, 0.35, hubP) * (1.0 - truss);
}

// 随机稀疏的灯：每 C km 一格、按 ringLampP 的概率有一盏边长 w 的小方块灯（位置、亮度随机，平均亮度 1）。
// 按真正的点光源画：灯心的三维位置投到垂直于视线的平面上，用 σ = 0.5 像素的高斯核（在屏幕上各向同性、归一化）分到像素，
// 每盏灯的总能量 = 投影面积 w²·cosI / 像素面积，灯挪半个像素时总能量不变（WS08 返工：先前在「沿环 × 横向」坐标里做盒式积分，
// 斜看的腹面上像素足迹不是这两个轴向的盒子，相邻像素的盒子不拼接，灯随头部晃动一亮一灭，live 闪烁像素 100+）。
// 返回以「灯面辐亮度」为单位的像素亮度；q 周围 2 × 2 格外的灯离本像素 ≥ C/2，高斯核早已为 0。
// 灯团（WS08-b）：lv ≥ 1 时一格边长 C = 8·2^lv km，代表格里 4^lv 盏灯的总和——这一格平均的有灯概率 p̄（城区疏密按这一格过滤），
// 以 2p̄（城区上限 1）的概率出现一团、能量除以这个概率（期望能量 = 格里各盏灯的期望之和，与单盏灯那一级逐级守恒）：
// 暗处是稀疏的亮点、城区是密集的亮点，远处仍是一粒粒有颜色的灯而不是一片发灰的平均面（W02：单个像素够亮才保得住钠灯的橙）。
// 有没有灯团只由世界坐标决定，不掺视角量（WS08 坑点）
float ringLampPts(vec2 q, vec3 rd, vec3 P, vec3 A, vec3 B, vec3 n, float r, float pixA, float cosI,
                  float lv, float seed, float Lp, float Lh, float Sr) {
  float C = 8.0 * exp2(lv);
  float fC = lv > 0.5 ? C : 0.0;
  float w2 = 0.64 * exp2(2.0 * lv);                           // 单盏灯 0.8 km 见方 × 格里的盏数
  seed += 5.17 * lv;
  vec2 c0 = floor(q / C - 0.5);
  float sum = 0.0;
  for (int i = 0; i < 4; i++) {
    vec2 cell = c0 + vec2(float(i - 2 * (i / 2)), float(i / 2));
    float e = hash12(cell + seed);
    float pb = ringLampP((cell + 0.5) * C, Lp, Lh, Sr, fC);
    float p = lv > 0.5 ? min(2.0 * pb, 1.0) : pb;            // 出现概率（城区满格、暗处稀疏：疏密靠点的多少，不靠亮度）
    vec2 lc = (cell + 0.15 + 0.7 * hash22(cell + seed + 7.3)) * C;
    float th = lc.x / r;
    vec3 dv = r * (cos(th) * A + sin(th) * B) + n * lc.y - P;
    float t = dot(dv, rd);
    vec3 pp = dv - rd * t;
    float px2 = pixA * pixA * t * t;
    sum += e < p ? (0.4 + 1.2 * e / p) * exp(-2.0 * dot(pp, pp) / px2) * 0.6366 * w2 * (pb / max(p, 1e-6)) * cosI / px2 : 0.0;
  }
  return sum;
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
  // ---- 枢纽：每 Lh（330–550 km）一座、沿环 24–46 km 长的舱段，截面比环体大一圈（往下凸出 Hh、两侧各伸出 Wx，把护套包在里面）。
  // 环的轮廓每几百 km 断一次——这是这把「尺子」上的刻度。沿环的范围按视线在舱段中部深度处的位置取，按足迹积分（不闪）
  float Hh = Hd;
  float Wx = 3.0 * Rt + 8.0;
  float sxH = sx - 0.5 * Hh * dot(rd, T) / max(d2.x, 0.02);
  float hubK = floor(sxH / Lh + 0.5);
  float hubLen = mix(24.0 + 22.0 * hash12(vec2(hubK, 53.0 + uRingDet.w * 97.0)), 35.0, smoothstep(0.1, 0.3, fTb / Lh));
  float hubA = ringBandsAA(sxH + 0.5 * hubLen, fTb, Lh, hubLen);
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
  // 真实地影 + 半影（penumbra.glsl.ts）：光线近地点低于地面 = 在影子里、擦过大气 = 被染红；交界按日面大小、大气折射与低层云软化。
  // tSRef / visS 只给亮度封顶用（按它定压缩比例，半影里的衰减才不会被封顶抵掉）
  vec3 tSRef, tMRef;
  float visS, visM;
  vec3 eS = uSunIlluminance * ringShadowT(Y, uSunDir, tSRef, visS);
  vec3 eM = uMoonIlluminance * ringShadowT(Y, uMoonDir, tMRef, visM);
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
  // 每段（两道肋之间）的随机：铺板深浅、是不是还没封板的桁架段（与 ringLampP 同一个随机数，桁架段不亮灯）。
  // 按足迹跨段加权、足迹大过半段时退回平均值（段界是硬边，不过滤会随晃动在像素间跳）
  float farSeg = smoothstep(0.15, 0.5, fTb / Sr);
  float segVar = ringSegHash(sx, fTb, Sr, 31.0 + uRingDet.w * 97.0);
  float truss = ringSegIs(sx, fTb, Sr, 7.0 + uRingDet.w * 97.0, 0.13);
  // 肋：宽窄不一、四分之一空着（按所在格的随机；格界在两道肋正中，带子在那里本来就是 0，不会有跳变）
  float ribK = floor((sx + 0.5 * Sr) / Sr);
  float ribW = mix(1.0 + 3.0 * hash12(vec2(ribK, 43.0)), 2.5, farSeg);
  float rib = ringBandsAA(sx + 0.5 * ribW, fTb, Sr, ribW) * mix(step(0.25, hash12(vec2(ribK, 47.0))), 0.75, farSeg);
  float hub = hubA;
  // 铺板：沿环每 9 km、横向每 W2/3 一块，深浅按块随机（第三级纹理，远处按足迹退回平均）
  float pk = hash12(floor(vec2(sAl / 9.0, v / (0.34 * W2))) + vec2(3.0, 11.0));
  float panel = mix(pk, 0.5, smoothstep(0.2, 0.6, max(fTb / 9.0, fVb / (0.34 * W2))));
  // 桁架段：斜交的杆件，杆间露出暗的内部
  float fD = fTb + fVb;
  float lattice = 1.0 - (1.0 - ringBandsAA(sAl + v, fD, 6.0, 1.1)) * (1.0 - ringBandsAA(sAl - v, fD, 6.0, 1.1));
  float albB = 0.25 + 0.07 * (segVar - 0.5) + 0.03 * (panel - 0.5);
  albB = mix(albB, mix(0.05, 0.34, lattice), truss);
  albB = mix(albB, 0.36, rib);
  albB = mix(albB, 0.42, hub);
  // 侧壁：每 0.9 km 一层的窗带（白天略暗），枢纽处是整块浅色的舱段
  float uW = cWall > 0.0 ? clamp((sgW * W2 - v) / (abs(dh.y) > 1e-3 ? dh.y : 1e-3) * dh.x, 0.0, Hd) : 0.5 * Hd;
  float rows = ringBandsAA(uW, fUw, 0.9, 0.32);
  float albW = mix(0.32 - 0.1 * rows + 0.05 * (segVar - 0.5), 0.42, hub);

  // 各面的照度拆成「太阳」与「其余（月光 + 地球反照）」两份：封顶按两种情形各算一次再按 visS 混（见下面「亮度封顶」）
  vec3 EbR = eM * max(dot(Nb, uMoonDir), 0.0) + eEarth;
  vec3 EwR = eM * max(dot(Nw, uMoonDir), 0.0) + 0.45 * eEarth;
  vec3 Eb = EbR + eS * max(dot(Nb, uSunDir), 0.0);
  vec3 Ew = EwR + eS * max(dot(Nw, uSunDir), 0.0);
  // 转子护套：两根圆管，本像素看到的那一点的法线（截面里朝相机的半圆），浅灰（0.5），不做金属高光
  vec2 e2 = vec2(-dh.y, dh.x);
  float q1 = clamp(oR1 / Rt, -1.0, 1.0);
  float q2 = clamp(oR2 / Rt, -1.0, 1.0);
  vec2 n1 = e2 * q1 - dh * sqrt(1.0 - q1 * q1);
  vec2 n2 = e2 * q2 - dh * sqrt(1.0 - q2 * q2);
  vec3 N1 = U * n1.x + n * n1.y;
  vec3 N2 = U * n2.x + n * n2.y;
  vec3 E1R = eM * max(dot(N1, uMoonDir), 0.0) + eEarth * (0.5 - 0.5 * n1.x);
  vec3 E2R = eM * max(dot(N2, uMoonDir), 0.0) + eEarth * (0.5 - 0.5 * n2.x);
  vec3 E1 = E1R + eS * max(dot(N1, uSunDir), 0.0);
  vec3 E2 = E2R + eS * max(dot(N2, uSunDir), 0.0);

  // 反射光（预乘覆盖率）：箱体两面，再盖上两根护套（护套凸在腹面边缘外）
  vec3 refl = (cBelly * albB * Eb + cWall * albW * Ew) / M_PI;
  refl = refl * (1.0 - cR1) + cR1 * 0.5 / M_PI * E1;
  refl = refl * (1.0 - cR2) + cR2 * 0.5 / M_PI * E2;
  vec3 reflR = (cBelly * albB * EbR + cWall * albW * EwR) / M_PI;
  reflR = reflR * (1.0 - cR1) + cR1 * 0.5 / M_PI * E1R;
  reflR = reflR * (1.0 - cR2) + cR2 * 0.5 / M_PI * E2R;

  // ---- 自发光（夜里的城市灯火；白天也亮着，只是比阳光下的结构暗几个数量级、看不出来）
  // 腹面：随机稀疏的灯（每 8 km 一格、按「城区疏密」的概率有一盏 0.8 km 的灯，亮度各不相同），疏密由域扭曲的多倍频噪声定
  // （ringCity：成片的城区与暗区，边界不沿网格），沿环每 W2/3 一条「大道」上灯更密（远看是几道断续的平行灯带）；
  // 桁架段不亮。灯是小而亮的点（单个像素够亮才保得住钠灯的橙色，W02 的浦肯野教训）；远处换成逐级守恒的灯团（ringLampPts），仍是点、不闪。
  // 枢纽是暖白的密灯；侧壁的窗带按同一片城区的疏密亮；护套底线上每 5 km 一盏白灯，
  // 灯串上有沿环奔跑的光脉冲（约 9 km/s，每 700 km 一道：1500 km 外每秒挪几个像素，用时间给出尺度）
  vec3 emB = vec3(0.0);
  float dens = 0.0;
  if (cBelly > 0.0) {
    // 灯亮不亮只由灯所在格子的位置决定（ringLampP），不掺像素足迹、不按像素取：否则灯会随飞行 / 头部晃动忽亮忽灭。
    // 远处的面亮度用按足迹过滤过的疏密（ringCity 里采样不住的倍频淡到均值，不闪）
    dens = ringCity(vec2(sAl, v), max(fTb, fVb));
    // 近处按点光源画（一格 8 km）；格子在屏幕上小于约 3 个像素时换到大一级的灯团（格边长翻倍），相邻两级按足迹连续混合。
    // （WS08 原来在这里换成「按足迹平均的面亮度」：远段成了一块块发虚的粉灰斑，WS08-b 改成逐级守恒的灯团，远处仍是点）
    float lvF = clamp(log2(max(3.0 * max(fTb, fVb) / 8.0, 1.0)), 0.0, 6.0);
    float lv0 = floor(lvF);
    float lamps = 0.0;
    for (int k = 0; k < 2; k++) {
      float wk = k == 0 ? 1.0 - (lvF - lv0) : lvF - lv0;
      if (wk > 0.0) lamps += wk * ringLampPts(vec2(sAl, v), rd, P, A, B, n, r, pixA, abs(d2.x), lv0 + float(k), 13.0 + 31.0 * uRingDet.w, Lp, Lh, Sr);
    }
    // 沿环的几条「大道」：腹面上每 W2/3 一条 2 km 宽的走廊，每 3 km 一盏灯，一段段亮、一段段暗（远看是几道断续的平行灯带）
    float aveOn = mix(smoothstep(0.35, 0.75, vnoise(vec2(sAl / 55.0, floor(v * 3.0 / W2) + 5.0 + 11.0 * uRingDet.w))), 0.5, smoothstep(12.0, 30.0, fTb));
    float ave = ringBandsAA(v + W2 + 0.25 * W2 / 3.0 + 1.0, fVb, W2 / 3.0, 2.0) * ringBandsAA(sAl, fTb, 3.0, 0.5) * aveOn;
    // 枢纽是密密麻麻的窗与灯（远小于像素）：再加一层按足迹平均的暖白底光，远看仍是一格格亮的舱段（尺子上的刻度）
    lamps += hub * 0.35 * 0.64 / 64.0;
    emB = (mix(vec3(1.0, 0.5, 0.18), vec3(1.0, 0.78, 0.55), hub) * lamps + vec3(1.0, 0.62, 0.3) * 0.02 * ave * (1.0 - truss)) * 5e-3;
  }
  vec3 emW = vec3(1.0, 0.7, 0.42) * 5e-5 * ringBandsAA(uW, fUw, 0.9, 0.3) * (0.15 + dens + hub);
  // 护套上的灯串：只在两根护套朝地面的底线上（截面点 (−Rt, ±W2)），0.6 km 粗的一道细线，每 5 km 一盏
  // 灯串是一条线：沿线方向的足迹 = 像素宽 ÷ 环切向垂直于视线的分量（这才是屏幕上沿线一个像素对应多少 km，盒式积分沿线逐像素拼接）
  float fLine = fp / max(length(T - rd * dot(rd, T)), 0.02);
  float bead = ringBandsAA(sAl + 0.2, fLine, 5.0, 0.4);
  float cL1 = ringStrip((oR1 - Rt * dh.y) / fp, 0.3 / fp) * (1.0 - hubA);
  float cL2 = ringStrip((oR2 - Rt * dh.y) / fp, 0.3 / fp) * (1.0 - hubA);
  float ph1 = fract((sAl - 9.0 * uTime) / 700.0) - 0.5;
  float ph2 = fract((sAl + 9.0 * uTime) / 700.0) - 0.5;
  // 脉冲本身是 σ = 15 km 的高斯；按沿环的像素足迹加宽（方差相加）并按比例减弱，能量不变——远处足迹几十 km 时不会一格一格地跳
  float sgE2 = 225.0 + fTb * fTb / 6.0;
  float pls1 = sqrt(225.0 / sgE2) * exp(-0.5 * ph1 * ph1 * 490000.0 / sgE2);
  float pls2 = sqrt(225.0 / sgE2) * exp(-0.5 * ph2 * ph2 * 490000.0 / sgE2);
  vec3 lampC = vec3(0.95, 0.95, 1.0) * 1.5e-3;
  vec3 emit = (cBelly * emB + cWall * emW) * (1.0 - cR1) * (1.0 - cR2);
  emit += lampC * (cL1 * (bead + 0.06 * pls1) + cL2 * (bead + 0.06 * pls2));

  // 亮度封顶（只管反射光）：大气层外被阳光直射的结构比暮色天空亮上千倍，按物理算会截成一道白色激光（W01b 的教训）。
  // 超过门限的部分按 x^0.18 压（保留色相，结构之间 3 倍的明暗差压成约 1.2 倍），仍是窗里最亮的东西。
  // 门限 = 同方向天空的 K 倍，但不低于「反照率 0.3 的面被月光照亮」的 K 倍：月光照着的环和月光下的云一样亮，不压
  float K = 3.0;
  // 压缩系数只按「正对光源、反照率 0.3 的面」算（只随光照平滑变化，不随反照率的纹理变），所以肋、铺板、枢纽之间的明暗比原样保留。
  // 太阳一路用半影的参考透射率（WS08-b：用实际透射率时，压缩把半影里的衰减整个抵掉，交界成了一像素的硬线）；
  // 「没有太阳」（地影里）的那份单独按自己的照度压，再按 visS 混——否则半影里地球反照那部分被太阳的压缩比例压暗，出一条比地影还暗的带
  float capD = max(K * max(ringLum(L), 0.1 * ringLum(uMoonIlluminance)), 1e-12);
  float x = ringLum(Ttop * 0.3 / M_PI * (uSunIlluminance * tSRef + eM + eEarth)) / capD;
  float xR = ringLum(Ttop * 0.3 / M_PI * (eM + eEarth)) / capD;
  vec3 addR = Ttop * mix(reflR * (xR > 1.0 ? pow(xR, -0.82) : 1.0), refl * (x > 1.0 ? pow(x, -0.82) : 1.0), visS);
  float occ = pFront ? 1.0 - cP : 1.0;             // 支柱挡在环前面时，环的那部分被挡掉
  vec3 ringAdd = (addR + Ttop * emit) * visF * occ;

  // ---- 支柱：在大气里的那一段要做空气透视（同天梯的缆：竖直圆柱的平均漫反射 + 天光 + 地球反光）
  if (cP > 0.0) {
    vec3 X = aP * (BOTTOM + max(altP, 0.0));
    vec3 tSR;
    float visP;
    vec3 tS = ringShadowT(X, uSunDir, tSR, visP);
    vec3 lp = uSunDir - aP * dot(uSunDir, aP);
    vec3 vp = -rd - aP * dot(-rd, aP);
    float perp = length(lp);
    float cosA = clamp(dot(lp, vp) / max(perp * length(vp), 1e-6), -1.0, 1.0);
    float alpha = acos(cosA);
    float ph = (sin(alpha) + (M_PI - alpha) * cosA) * 0.25;
    vec3 eUp = 0.21 * uSunIlluminance * max(dot(aP, uSunDir), 0.0);
    vec3 eSky = skyIrradiance(min(BOTTOM + max(altP, 0.0), TOP), aP) * (1.0 - smoothstep(40.0, 100.0, altP));
    vec3 Lsky = 0.3 / M_PI * (0.5 * (eSky + eUp) + 0.35 * eM);
    // 夜里：每 25 km 一盏暖白灯（足迹沿轴线积分）
    Lsky += vec3(1.0, 0.8, 0.55) * 2e-3 * ringBandsAA(altP, pixA * tP * inversesqrt(max(1.0 - dot(rd, aP) * dot(rd, aP), 1e-6)), 25.0, 0.5);
    vec3 Lpil = 0.3 / M_PI * uSunIlluminance * tS * perp * ph + Lsky;
    vec3 LpilR = 0.3 / M_PI * uSunIlluminance * tSR * perp * ph + Lsky; // 封顶比例按半影的参考透射率定（同环体）
    vec3 uvw = aerialPerspectiveUvw(rd, uApDir, min(tP, AERIAL_MAX_DISTANCE));
    vec3 apL = texture(uAerialInscatterS, uvw).rgb * uApIlluminance;
    vec3 apT = texture(uAerialTransmittanceS, uvw).rgb;
    // 月光那一路的内散射没有 LUT：按「背景里有多少比例的空气在支柱前面」近似（同 wonder-sky 的做法）
    vec3 fF = clamp((1.0 - apT) / max(1.0 - Ttop, vec3(1e-4)), 0.0, 1.0);
    vec3 lFront = max(apL, L * fF * (1.0 - smoothstep(-0.21, -0.14, uSunDir.y)));
    float xp = ringLum(apT * LpilR) / capD;
    float xq = ringLum(apT * Lsky) / capD;
    L = mix(L, lFront + apT * mix(Lsky * (xq > 1.0 ? pow(xq, -0.82) : 1.0), Lpil * (xp > 1.0 ? pow(xp, -0.82) : 1.0), visP), cP * visF);
  }
  gRingCov = max(cRing * occ, cP) * visF;
  return L + ringAdd;
}
`;
