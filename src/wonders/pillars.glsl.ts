/**
 * 巨柱群（WS07，research/WONDER_SCALE.md §3.6 第 1 名「垂直荒原」，含方尖碑阵变体）：天幕层奇观，GLSL。
 * 尺寸、截面（圆柱 / 方柱）与摆放由 wonders/pillar-shape.ts 按种子生成（uPillars 等）。
 *
 * 画面：海上 5–12 根混凝土巨柱（一群全是圆柱，或全是同一朝向的方柱），沿一条斜线往地平线退去，一根比一根远、一根比一根蓝，
 * 最远的柱脚沉到地平线以下只剩柱顶；柱脚被云海吞没，身上挂着和我们一样高的旗云，一架同高度的航班拖着航迹云从柱间穿过
 * （尺度参照：60 m 的飞机旁边是 3–7 km 粗、30–70 km 高的柱）；柱顶在稀薄的高空里比柱脚清楚得多；
 * 黄昏柱脚已入夜、柱顶还被阳光照着；夜里只剩柱顶同步慢闪的红灯和各层环带上稀疏的暖白灯。
 *
 * 只拼进窗外程序的 OWP 变体（OUTSIDE_WONDER + WONDER_PILLARS，outside-pass.ts），巨柱群在场时才后台编译；
 * 默认程序和天梯 / 建木的 OW 变体预处理后都不含这一段。依赖 WONDER_SKY_COMMON 里的小工具（wonderStrip / wonderPoint /
 * wonderLightT / wonderCapRef / wonderBands / wonderIrr / wonderLum / WONDER_CONCRETE），只调用、不改。
 *
 * 几何（同天梯锚塔，README 坑点「天幕层的粗大实体按像面做」）：柱子都平行于锚点的轴线 a（群宽不到 1°，柱顶的偏差 < 0.5 km），
 * 第 i 根的底在「锚点底 + 水平偏移 o」处。o ⟂ a，所以相对它的量都能从锚点的量加一个修正得到：
 * X_i = X − o·nh，t_i = t + (o·rd)/(1 − b²)，s_i = s + b·(o·rd)/(1 − b²)——每根柱只多两个点积。
 * 柱面上一点（相对柱轴的水平偏移 q）投到像面是 (q·nh, s·sn − b·(q·rd)/sn)，深度 t_i + (q·rd)/(1 − b²)：
 * 圆柱的轮廓半宽 = 半径；方柱朝相机的两个面在像面上各占前角一侧，轮廓半宽 = 半边长 ×（|n1·nh| + |n2·nh|），
 * 本像素落在哪个面、离轴多深都是闭式的（pillarSection）。
 * 覆盖率在像面上按三角核解析积分（横向：轮廓半宽；纵向：柱顶 / 柱底的上下沿），亚像素时按面积摊薄、不闪。
 * 每个像素只留最近的两根柱（按前表面深度）+ 三格云（按深度分在两根柱的前 / 中 / 后），从远到近五步着色合成：
 * 一个循环、重函数（透射率 / 天光 / 空气透视查表 / 封顶）各只有一个调用点（冷编译：FXC 按调用点整份内联）。
 * 循环上界都写成「常数 + uLoopGuard」，FXC 不展开。
 */
import { wonderPenumbraCommon } from "./penumbra.glsl";

export const WONDER_PILLARS_COMMON = /* glsl */ `
${wonderPenumbraCommon("pillar")}
uniform vec4 uPillars[12];   // 每根柱：x 东、y 南偏移（km），z 底部尺度（km：圆柱 = 半径；负数 = 方柱，绝对值是半边长），w 高度（km）
uniform vec4 uPillarE;       // xyz 锚点处「东」（窗外坐标），w 根数
uniform vec4 uPillarS;       // xyz 锚点处「南」，w 群的包围半径（km）
uniform vec4 uPillarC;       // x、y 群中心（km），z 风向（弧度），w 种子
uniform vec4 uPillarD;       // 航迹云：x 航向（弧度，东起往南），y 离群中心的横向偏移（km），z 高度（km），w 相位

// 每根柱的环带参数：节距 Pc（7–14 km）、环带厚 wc（0.6–1.4 km）、相位 ph（km）
vec3 pillarCollar(float hs) {
  return vec3(7.0 + 7.0 * hs, 0.6 + 0.8 * fract(hs * 7.31), 5.0 * fract(hs * 13.1));
}

// 柱身尺度随高度（km）：底部尺度 R0，往上收 8%（几乎竖直，粗野主义的整块体量；平顶、不做柱头——外张的柱头一加就读成烟囱）；
// 约三分之一的柱子在 45–70% 高处退一级台（上段收到 0.78 倍），轮廓不再根根一样。
// 环带：每 7–14 km 一道略外凸（3%）的环（「分段」：柱子被横着切成一节节，节距就是一把尺子），约三成的环缺着（节距不规则）。
// 退台与环带的上下沿都按像素高度足迹 fh 积分（wonderBands），轮廓在台阶处不锯齿。fc 输出本像素落在环带里的比例
float pillarR(float h, float fh, float R0, float H, float hs, out float fc) {
  vec3 C = pillarCollar(hs);
  float x = h + C.z;
  fc = wonderBands(x, fh, C.x, C.y) * step(0.3, hash12(vec2(floor(x / C.x), hs * 57.0)))
     * smoothstep(2.0, 3.0, h) * (1.0 - smoothstep(H - 4.0, H - 3.0, h));
  float hStep = H * (0.45 + 0.25 * fract(hs * 5.9));
  float stepF = fract(hs * 23.7) < 0.35 ? clamp((h - hStep) / max(fh, 1e-3) + 0.5, 0.0, 1.0) : 0.0;
  return R0 * (1.0 - 0.08 * h / H) * (1.0 + 0.03 * fc) * (1.0 - 0.22 * stepF);
}

// 截面：Xi 本像素离柱轴的横向距离，R 这一高度的尺度；sq 方柱，n1 / n2 方柱朝相机的两个面的法线（水平单位向量）。
// 返回 x = 轮廓半宽，y = 近侧表面离柱轴的深度（沿视线的水平方向，km），z = 方柱：本像素在第一个面上的比例（前角两侧按像素摊开）
vec3 pillarSection(float Xi, float R, bool sq, vec3 n1, vec3 n2, vec3 nh, vec3 mh, float wP) {
  if (!sq) return vec3(R, sqrt(max(R * R - Xi * Xi, 0.0)), 0.0);
  float a1 = dot(n1, nh), a2 = dot(n2, nh);
  float xc = R * (a1 + a2);                      // 朝相机的那条竖棱
  float side = a2 > 0.0 ? -1.0 : 1.0;            // 第一个面在竖棱的哪一侧
  float f1 = clamp(side * (Xi - xc) / wP + 0.5, 0.0, 1.0);
  float l1 = clamp((Xi / R - a1) / (abs(a2) > 1e-4 ? a2 : 1e-4), -1.0, 1.0);
  float l2 = clamp((Xi / R - a2) / (abs(a1) > 1e-4 ? a1 : 1e-4), -1.0, 1.0);
  float d1 = -dot(R * (n1 + l1 * n2), mh);
  float d2 = -dot(R * (n2 + l2 * n1), mh);
  return vec3(R * (abs(a1) + abs(a2)), max(mix(d2, d1, f1), 0.0), f1);
}

// 同高度航班的航迹云（尺度参照，写法同浮空古城 flcContrail）：锚点处水平坐标里的一条直线，海拔 10.3–11.8 km、
// 顺着地球曲率（离开最近点 d km 下沉 d²/2R）；机头以 0.25 km/s 往前走，身后的云随「离飞机的时间」变宽、变淡。
// 返回 (光学厚度, 深度 km)
vec2 pillarContrail(vec3 w0, vec3 rd, vec3 a, vec3 E, vec3 S, float pixelAngle, float T) {
  float sd = uPillarC.w;
  vec3 A = E * cos(uPillarD.x) + S * sin(uPillarD.x);
  vec3 N = cross(a, A);
  N *= dot(N, w0) < 0.0 ? -1.0 : 1.0;            // 水平面里朝相机的那一侧
  float off = uPillarD.y;
  vec3 P0 = a * uPillarD.z + E * uPillarC.x + S * uPillarC.y - N * off;
  float ph = fract(T / 720.0 + uPillarD.w);
  float v = 0.25;
  float sPlane = -90.0 + 180.0 * ph;
  vec3 wc = w0 - P0;
  float b = dot(rd, A);
  float den = max(1.0 - b * b, 1e-4);
  float dw = dot(rd, wc), ew = dot(A, wc);
  float tr = (b * ew - dw) / den;
  float sl = (ew - b * dw) / den;
  float age = (sPlane - sl) / v;
  if (tr <= 0.0 || age < 2.0) return vec2(0.0, 1e9);
  vec3 dv = (w0 + rd * tr) - (P0 + A * sl - a * (sl * sl + off * off) / 12740.0);
  float wd = 0.04 + 0.0035 * age;
  float fpx = tr * pixelAngle;
  float we2 = wd * wd + fpx * fpx;
  float patchy = 0.55 + 0.45 * sin(sl * 0.37 + sd * 40.0) * sin(sl * 0.11 + 1.3);
  // 横截面光学厚度取 1（新生的航迹云是一道不透明的白线；浮空古城用 0.5 是因为它近一半）：190 km 外管子比像素细，
  // 按能量守恒摊薄以后只剩一两级灰——太淡就起不到「尺子」的作用
  float tau = 1.0 * patchy * exp(-age / 900.0) * smoothstep(2.0, 12.0, age) * (wd / sqrt(we2)) * exp(-dot(dv, dv) / we2) / max(sqrt(den), 0.2);
  // 两端淡出：机头走到 +75 km 以后整道淡掉（下一趟从另一头重新出现）；离群中心超过包围半径之前淡到 0（整群早退不切出硬边）
  tau *= smoothstep(88.0, 70.0, abs(sl)) * smoothstep(90.0, 75.0, sPlane) * smoothstep(uPillarS.w - 5.0, uPillarS.w - 25.0, abs(sl) + abs(off));
  return vec2(tau, tr);
}

// L：背景辐亮度；tLimit：这条视线打到地面的距离（打不到传一个大数）
vec3 wonderPillars(vec3 L, vec3 rd, float tLimit) {
  if (uWonderOn < 0.5) return L;
  vec3 a = uWonderAxis;
  vec3 w0 = vec3(0.0, uCamR, 0.0) - a * BOTTOM;
  vec3 n = cross(rd, a);
  float nn = dot(n, n);
  if (nn < 1e-6) return L;
  float sn = sqrt(nn);
  vec3 nh = n / sn;
  float X = dot(w0, nh);
  float b = dot(rd, a);
  float ab = abs(b);
  float d = dot(rd, w0);
  float e = dot(a, w0);
  float t = (b * e - d) / nn;
  float s = (e - b * d) / nn;
  vec3 E = uPillarE.xyz;
  vec3 S = uPillarS.xyz;
  float Enh = dot(E, nh), Snh = dot(S, nh), Erd = dot(E, rd), Srd = dot(S, rd);
  // 整群的早退：离群中心的竖直轴线（像面横向）超过包围半径
  float oc = uPillarC.x * Erd + uPillarC.y * Srd;
  if (t + oc / nn <= 0.0 || abs(X - uPillarC.x * Enh - uPillarC.y * Snh) > uPillarS.w) return L;

  float pixelAngle = 2.0 * uTanHalfFov / uResolution.y;
  float T = uTime;
  float sd = uPillarC.w;
  float front = uWonderShape.y;
  vec3 mh = (rd - a * b) / sn;                   // 水平面里「沿视线往远处」
  float Wx = dot(E * cos(uPillarC.z) + S * sin(uPillarC.z), nh); // 顺风方向在像面上的横向分量
  // 方柱（方尖碑阵变体）：一群同一个朝向（按种子），朝相机的两个面的法线
  float psi = 6.2831853 * fract(sd * 7.13);
  vec3 f1 = E * cos(psi) + S * sin(psi);
  vec3 n1 = dot(f1, mh) < 0.0 ? f1 : -f1;
  vec3 f2 = cross(a, f1);
  vec3 n2 = dot(f2, mh) < 0.0 ? f2 : -f2;

  // ---- 几何：每根柱的覆盖率与前表面深度，只留最近的两根（B 最近、A 次近）
  vec4 gA = vec4(0.0), gB = vec4(0.0);          // X_i、t_i、s_i、覆盖率
  vec4 pA = vec4(0.0), pB = vec4(0.0);          // 柱的参数
  float iA = -1.0, iB = -1.0, tA = 1e9, tB = 1e9;
  for (int i = 0; i < 12 + uLoopGuard; i++) {
    if (float(i) >= uPillarE.w) break;
    vec4 P = uPillars[i];
    bool sq = P.z < 0.0;
    float R0 = abs(P.z);
    float od = P.x * Erd + P.y * Srd;
    float Xi = X - (P.x * Enh + P.y * Snh);
    float ti = t + od / nn;
    float wP = ti * pixelAngle;
    if (ti <= 0.0 || abs(Xi) > R0 * (sq ? 1.45 : 1.05) + 2.0 * wP) continue;
    float si = s + b * od / nn;
    float hs = hash12(vec2(float(i) + 3.7, 17.0 + 31.0 * sd));
    float fh = wP / sn;
    float fc;
    vec3 sec = pillarSection(Xi, pillarR(clamp(si, 0.0, P.w), fh, R0, P.w, hs, fc), sq, n1, n2, nh, mh, wP);
    vec3 secT = pillarSection(Xi, pillarR(P.w, fh, R0, P.w, hs, fc), sq, n1, n2, nh, mh, wP);
    vec3 secB = pillarSection(Xi, R0, sq, n1, n2, nh, mh, wP);
    float Yi = si * sn;
    float top = sn * P.w + ab * secT.y;
    float bot = -sn - ab * secB.y;
    float cov = wonderStrip(Xi / wP, sec.x / wP) * wonderStrip((Yi - 0.5 * (top + bot)) / wP, 0.5 * (top - bot) / wP);
    float tF = ti - sec.y / sn;
    if (tF > tLimit) cov = 0.0;                  // 海面挡在前面（地平线以下的柱脚）
    bool nearTop = abs(Yi - top) < 3.0 * wP;     // 柱顶的红灯：柱顶上方一两个像素也要画
    if (cov <= 0.0 && !nearTop) continue;
    vec4 g = vec4(Xi, ti, si, cov);
    if (tF < tB) {
      gA = gB; pA = pB; iA = iB; tA = tB;
      gB = g; pB = P; iB = float(i); tB = tF;
    } else if (tF < tA) {
      gA = g; pA = P; iA = float(i); tA = tF;
    }
  }

  // ---- 云：柱脚云（柱子从云海里拔出来，脚下缠着一圈被它搅起、顺风拖出去的云墙）、旗云（约三分之一的柱子在 8–13 km、
  // 和我们一样高的地方挂一面顺风拖长的旗云：柱子从云里穿出去、被切成上下两段）、同高度航班的航迹云。
  // 按深度分进三格：比 A 远（画在 A 之前）、A 与 B 之间、比 B 近——云裹在柱子外面（深度取柱子前表面再往前一点），
  // 所以自己的柱脚被自己的云吞没，而更近的柱子照样挡住它。x = 光学厚度，y = × 深度，z = × 高度（着色时取加权平均）
  vec3 c0 = vec3(0.0), c1 = vec3(0.0), c2 = vec3(0.0);
  for (int i = 0; i < 12 + uLoopGuard; i++) {
    if (float(i) >= uPillarE.w) break;
    vec4 P = uPillars[i];
    float R0 = abs(P.z);
    float od = P.x * Erd + P.y * Srd;
    float Xi = X - (P.x * Enh + P.y * Snh);
    float ti = t + od / nn;
    float xo = Xi * (Wx >= 0.0 ? 1.0 : -1.0);
    float lw = 16.0 * abs(Wx) + R0 * 2.5;        // 顺风一侧拖出去的长度（像面横向）
    if (ti <= 0.0 || abs(xo) > 2.6 * max(lw, R0 * 2.0 + 3.0)) continue;
    float si = s + b * od / nn;
    for (int k = 0; k < 2 + uLoopGuard; k++) {
      float hk = hash12(vec2(float(i) * 3.0 + float(k), 41.0 + 17.0 * sd));
      if (k == 1 && hk < 0.62) break;
      float hc = k == 0 ? 1.1 + 1.3 * hk : 8.0 + 5.0 * (hk - 0.62) / 0.38;
      float th0 = k == 0 ? 0.8 + 0.6 * hk : 0.35 + 0.5 * fract(hk * 7.7);
      float wid = xo > 0.0 ? lw * (k == 0 ? 1.0 : 0.8) : R0 * 1.4 + 2.0;
      float th = th0 * (1.0 + 0.8 * max(xo, 0.0) / lw);
      float ds = si - hc - 0.03 * max(xo, 0.0);
      if (abs(ds) > 3.0 * th || abs(xo) > 2.6 * wid) continue;
      float nz = 0.6 * vnoise(vec2(Xi * 0.25 - T * 0.004 + float(i) * 17.0, ds * 0.9 + float(k) * 9.0))
               + 0.4 * vnoise(vec2(Xi * 0.7 + 3.0 + float(i) * 5.0, ds * 1.6 - T * 0.002));
      float tau = (k == 0 ? 2.2 : 1.8) * exp(-ds * ds / (th * th) - xo * xo / (wid * wid)) * smoothstep(0.3, 0.72, nz);
      float tc = ti - R0 * 1.3 - 0.5;
      vec3 add = vec3(tau, tau * tc, tau * hc);
      if (tc > tA) c0 += add; else if (tc > tB) c1 += add; else c2 += add;
    }
  }
  vec2 ct = pillarContrail(w0, rd, a, E, S, pixelAngle, T);
  if (ct.x > 1e-4) {
    vec3 add = vec3(ct.x, ct.x * ct.y, ct.x * 11.0);
    if (ct.y > tA) c0 += add; else if (ct.y > tB) c1 += add; else c2 += add;
  }
  if (iB < 0.0 && c0.x + c1.x + c2.x < 1e-3) return L;
  // 给 outside-pass 排远云：只按柱子的实体（半透明的解析云不去裁真实的云——裁出来是一圈圈按云深度走的等高线）
  // 乘可见前沿：浮现 / 退场时没显形的部分不挡星、不裁云（WS07 审查：否则夜空出现无星竖带）
  float visA = 1.0 - smoothstep(0.35 * front, front, clamp(gA.z, 0.0, pA.w));
  float visB = 1.0 - smoothstep(0.35 * front, front, clamp(gB.z, 0.0, pB.w));
  gWonderCov = max(gA.w * visA, gB.w * visB);
  gWonderT = gB.w > 0.0 ? tB : tA;

  // ---- 着色（从远到近五步）：比 A 远的云 → A → A、B 之间的云 → B → 最近的云。
  // 每一步查表各一次（透射率 / 天光 / 空气透视），一个循环、一个调用点
  vec3 Lbg = L;
  float dayF = smoothstep(-0.10, 0.02, uSunDir.y);
  float moonW = 1.0 - smoothstep(-0.21, -0.14, uSunDir.y);
  float duskW = 1.0 - smoothstep(-0.02, 0.06, uSunDir.y);
  float fwd = 1.0 + 1.5 * pow(max(dot(rd, uSunDir), 0.0), 4.0);
  float phb = fract(T / 2.0);
  float blink = 0.1 + 0.9 * smoothstep(0.0, 0.12, phb) * (1.0 - smoothstep(0.4, 0.62, phb));
  vec3 skyTop = max(vec3(1.0) - transmittanceToTop(uCamR, rd.y), vec3(1e-4));
  for (int k = 0; k < 5 + uLoopGuard; k++) {
    if (k > 4) break;
    bool isCloud = k == 0 || k == 2 || k == 4;
    vec3 cb = k == 0 ? c0 : (k == 2 ? c1 : c2);
    bool useA = k == 1;
    vec4 g = useA ? gA : gB;
    vec4 P = useA ? pA : pB;
    float idx = useA ? iA : iB;
    if (isCloud ? cb.x < 1e-3 : idx < 0.0) continue;
    float hq = isCloud ? cb.z / cb.x : clamp(g.z, 0.0, P.w);
    float tk = isCloud ? cb.y / cb.x : (useA ? tA : tB);
    float Xi = g.x;
    float wP = g.y * pixelAngle;
    // 浮现：可见前沿从地平线的霾里往上长（前沿以上是长渐变）
    float visk = 1.0 - smoothstep(0.35 * front, front, hq);
    // 光照：太阳 / 月亮直射（真实地影：黄昏柱脚已入夜、柱顶还亮着）、上半球天光、下方地球反上来的光。
    // WS08-b：地影交界按日面大小、大气折射与低层云给出半影（penumbra.glsl.ts），越靠交界越红越暗；tSRef / visS 只给封顶用
    vec3 Pw = a * (BOTTOM + hq) + (isCloud ? vec3(0.0) : E * P.x + S * P.y);
    float rr = length(Pw);
    vec3 tSRef, tMRef;
    float visS, visM;
    vec3 eSun = uSunIlluminance * pillarShadowT(Pw, uSunDir, tSRef, visS);
    vec3 eMoon = uMoonIlluminance * pillarShadowT(Pw, uMoonDir, tMRef, visM);
    vec3 eSkyUp = skyIrradiance(min(rr, TOP), a) * (1.0 - smoothstep(40.0, 100.0, hq));
    vec3 eUp = 0.21 * (uSunIlluminance * max(dot(a, uSunDir), 0.0) + uMoonIlluminance * max(dot(a, uMoonDir), 0.0));
    // 空气透视：远柱更淡更蓝，柱脚埋在霾里、柱顶在稀薄的高空里清楚（大气分层是物理的，不另加）
    vec3 uvw = aerialPerspectiveUvw(rd, uApDir, min(tk, AERIAL_MAX_DISTANCE));
    vec3 apL = texture(uAerialInscatterS, uvw).rgb * uApIlluminance;
    vec3 apT = texture(uAerialTransmittanceS, uvw).rgb;
    // 相机到柱之间的内散射：月光那一路按「背景里线前面那段空气的比例」补（同天梯）；黄昏地影里的一段画成挡掉约 22% 天光的淡剪影
    vec3 frontFrac = 1.0 - apT;
    if (tLimit > 1e8) frontFrac = clamp(frontFrac / skyTop, 0.0, 1.0);
    vec3 lFront = max(apL, Lbg * frontFrac * moonW);
    lFront = mix(lFront, min(lFront, Lbg * 0.78), duskW);
    // 亮度封顶（同天梯 / 建木）：暮色里被照亮的柱顶不超过同方向天空的 1.3–2 倍；按部件最亮时定比例，受光 / 背光的明暗保留
    float capLum = mix(4.0, mix(1.3, 2.0, smoothstep(10.0, 150.0, hq)), duskW) * wonderLum(Lbg);
    // 封顶比例按半影的参考透射率定（WS08-b）：按实际的 eSun 定时，半影里的衰减被封顶整个抵掉，交界是一像素的硬线（WS07 遗留）。
    // 另算一份「没有太阳」的（LsR / LrefR = 地影里的样子），最后按 visS 在两者之间混：半影里天光那部分不会被太阳的封顶比例压暗
    vec3 eRest = eMoon + eSkyUp + eUp;
    vec3 eMax = uSunIlluminance * tSRef + eRest;
    vec3 Ls, Lref, LsR, LrefR;
    float covk;
    vec3 lamp = vec3(0.0);
    if (isCloud) {
      LsR = 0.8 / M_PI * (eMoon * 0.8 + eSkyUp + 0.5 * eUp);
      LrefR = LsR;
      Ls = LsR + 0.8 / M_PI * eSun * 0.8 * fwd;
      Lref = LsR + 0.8 / M_PI * uSunIlluminance * tSRef * 0.8 * fwd;
      covk = 1.0 - exp(-cb.x);
    } else {
      covk = g.w;
      bool sq = P.z < 0.0;
      float R0 = abs(P.z);
      float hs = hash12(vec2(idx + 3.7, 17.0 + 31.0 * sd));
      float fh = wP / sn;
      float fc;
      float rq = pillarR(hq, fh, R0, P.w, hs, fc);
      vec3 sec = pillarSection(Xi, rq, sq, n1, n2, nh, mh, wP);
      // 法线与沿面的弧长（竖肋、雨痕、面板用）：圆柱按方位；方柱按所在的面（前角两侧一个像素内过渡），弧长从前角量起
      vec3 radial, tang;
      float uA, fu;
      if (sq) {
        radial = normalize(mix(n2, n1, sec.z));
        float a1 = dot(n1, nh), a2 = dot(n2, nh);
        float xc = rq * (a1 + a2);
        float slope = max(sec.z > 0.5 ? abs(a2) : abs(a1), 0.05);
        uA = abs(Xi - xc) / slope + (sec.z > 0.5 ? 0.0 : 37.0);
        fu = wP / slope;
      } else {
        float cphi = clamp(Xi / rq, -1.0, 1.0);
        float sphi = -sqrt(1.0 - cphi * cphi);
        radial = cphi * nh + sphi * mh;
        uA = rq * acos(cphi);
        fu = wP / max(-sphi, 0.05);
      }
      tang = cross(a, radial);
      // 竖肋：每 0.9–1.5 km 一道（法线绕轴左右偏），受光面上一条条明暗相间的竖纹；肋距不到约 3 像素时淡成均匀的一层
      float ribP = 0.9 + 0.6 * fract(hs * 5.3);
      float tri = abs(fract(uA / ribP + hs) - 0.5) * 4.0 - 1.0;
      float dAz = 0.12 * tri * (1.0 - smoothstep(0.2, 0.45, fu / ribP));
      vec3 nW = normalize(radial * cos(dAz) + tang * sin(dAz) + a * 0.08 * R0 / P.w);
      // 纹理：每 1.8 km 一道横向施工缝（暗 12%）、环带下沿的一道阴影、竖向雨痕、3–5 km 一块的面板色差（浇筑批次不同）、
      // 柱脚被海雾 / 盐沤暗的一截、柱顶一圈风化的暗带；都按像素足迹积分 / 淡出
      vec3 C = pillarCollar(hs);
      float shadowBand = wonderBands(hq + C.z + 0.5, fh, C.x, 0.5) * smoothstep(2.0, 3.0, hq) * step(0.3, hash12(vec2(floor((hq + C.z + 0.5) / C.x), hs * 57.0)));
      float joint = wonderBands(hq, fh, 1.8, 0.12);
      float streak = (vnoise(vec2(uA / 0.9 + 7.0 * hs, hq / 5.0 + idx * 3.1)) - 0.5) * (1.0 - smoothstep(0.3, 0.8, fu));
      float blot = vnoise(vec2(uA / 3.5 + 11.0 * hs, hq / 4.5 + idx * 7.3)) - 0.5;
      vec3 tint = mix(vec3(1.03, 1.0, 0.95), vec3(0.95, 1.0, 1.04), fract(hs * 3.7));
      vec3 alb = WONDER_CONCRETE * tint * (0.62 + 0.3 * fract(hs * 11.9)) * mix(0.7, 1.0, smoothstep(0.5, 5.0, hq))
               * (1.0 - 0.12 * joint - 0.35 * shadowBand + 0.12 * fc + 0.3 * streak + 0.3 * blot) * (1.0 - 0.18 * smoothstep(P.w - 1.2, P.w - 0.6, hq));
      Ls = alb / M_PI * wonderIrr(nW, a, eSun, eMoon, eSkyUp, eUp);
      LsR = Ls - alb / M_PI * eSun * max(dot(nW, uSunDir), 0.0);   // wonderIrr 对各路照度是线性的
      Lref = alb * 1.4 / M_PI * eMax;
      LrefR = alb * 1.4 / M_PI * eRest;
      // 夜灯（克制）：柱顶两角 + 前棱 / 正中的红色障碍灯（全部同步慢闪）；每道环带上沿朝相机的一圈暖白灯（每 0.7 km 一盏、三分之一空着），
      // 描出柱子的形与分段——灯距就是一把尺子
      float Yi = g.z * sn;
      vec3 secT = pillarSection(Xi, pillarR(P.w, fh, R0, P.w, hs, fc), sq, n1, n2, nh, mh, wP);
      float yT = sn * P.w + ab * secT.y;
      float xMid = sq ? pillarR(P.w, fh, R0, P.w, hs, fc) * dot(n1 + n2, nh) : 0.0;
      float wTop = wonderPoint((abs(Xi) - 0.9 * secT.x) / wP, (Yi - yT) / wP) + wonderPoint((Xi - xMid) / wP, (Yi - yT) / wP);
      lamp += vec3(1.0, 0.08, 0.03) * 60.0 * blink * wTop;
      float kc = floor((hq + C.z - C.y) / C.x + 0.5);
      float hcol = kc * C.x - C.z + C.y;
      if (hcol > 2.5 && hcol < P.w - 4.0 && hash12(vec2(kc, hs * 57.0)) >= 0.3) {
        float Rt = pillarR(hcol - 0.5 * C.y, 0.0, R0, P.w, hs, fc) * 1.03;
        // 环带上沿朝相机的一圈：圆柱上按方位每 0.7 km 一盏；方柱上沿两个面各一排。只取离本像素最近的一盏
        vec3 q;
        float spc;
        if (sq) {
          float a1 = dot(n1, nh), a2 = dot(n2, nh);
          bool onF1 = (Xi - Rt * (a1 + a2)) * (a2 > 0.0 ? -1.0 : 1.0) >= 0.0;
          vec3 m = onF1 ? n1 : n2, o = onF1 ? n2 : n1;
          float lam = clamp((Xi / Rt - dot(m, nh)) / (abs(dot(o, nh)) > 1e-4 ? dot(o, nh) : 1e-4), -1.0, 1.0);
          float dl = 0.7 / Rt;
          float j0 = floor((lam + 1.0) / dl + 0.5);
          q = Rt * (m + (j0 * dl - 1.0) * o);
          spc = 0.7 * abs(dot(o, nh));
          kc += onF1 ? 0.0 : 0.5;
          kc += j0 * 0.013;
        } else {
          float dph = 0.7 / Rt;
          float j0 = floor(-acos(clamp(Xi / Rt, -1.0, 1.0)) / dph + 0.5);
          float pj = j0 * dph;
          q = Rt * (cos(pj) * nh + sin(pj) * mh);
          spc = 0.7 * abs(sin(pj));
          kc += j0 * 0.013;
        }
        float on = step(0.33, hash12(vec2(kc * 7.0 + idx, 31.0)));
        // 轮廓附近灯距被透视压到 1.5 像素以下时淡掉（不然挤成一串逐帧跳的亮点）
        on *= smoothstep(1.5, 3.0, spc / wP);
        lamp += vec3(1.0, 0.8, 0.58) * 2.5 * on * wonderPoint((Xi - dot(q, nh)) / wP, (Yi - sn * hcol + b * dot(q, rd) / sn) / wP);
      }
      lamp *= 1.0 - dayF;
    }
    vec3 Lc = mix(wonderCapRef(lFront + apT * LsR, lFront + apT * LrefR, Lbg, capLum),
                  wonderCapRef(lFront + apT * Ls, lFront + apT * Lref, Lbg, capLum), visS);
    L = mix(L, Lc, covk * visk);
    float tm = tk * 1000.0;
    L += apT * lamp * visk / (tm * tm * pixelAngle * pixelAngle);
  }
  return L;
}
`;
