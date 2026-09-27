/**
 * 天幕层奇观（W01 / W01b）：天梯 / 建木——一根从地平线下升起、直入太空的极细的线，以及挂在它身上的「让人遐想」的东西（GLSL）。
 * 依赖 ATMOSPHERE_COMMON、VIEW_COMMON、LIGHTS_COMMON、NOISE_COMMON、TRAFFIC_COMMON（空气透视的两个 3D 纹理在那里声明，本段不新增 sampler）。
 *
 * 几何：地心坐标（和 outsideRadiance 一样，相机在 (0, uCamR, 0)，y 朝天顶、x 朝东、−z 朝北）。
 * 主体是一条过地心的射线上的细圆柱：基座 B = uWonderAxis × BOTTOM，向上一直延伸到太空。
 * 视线与轴线求最近点，得到视线到轴线的有符号横向距离 X、最近点沿视线的距离 t、沿轴线离基座的高度 s。
 * 所有运算都相对基座做（几百 km 量级），不用地心的 6000 多 km 大数相减，float 精度够分辨 1/10 像素。
 *
 * 像面坐标（W01b）：几百 km 外、几 km 大的东西近似正交投影。像面上以轴线为纵轴：横向 = X，纵向 = s·sin(视线与轴线夹角)。
 * 挂在轴线上的东西（中继站、舱体、航标灯）只要换算到这个坐标里，覆盖率就能和线本身一样解析积分（三角核，±1 像素），
 * 亚像素时按面积摊薄、能量守恒，不会逐帧闪；从轴线伸出去的「撑杆」（天梯的稳定缆、建木的枝）把三维曲线投到同一坐标里求横向距离。
 *
 * 天梯（skin 0，致敬《流浪地球 2》太空电梯）：
 * - 中继站：缆上七个扁椭球平台（16 km 起按约 1.85 倍往上排，大小不一），下面看是一道横在线上的短划；
 *   向阳时是亮点，日落后地影以上的几个还亮着，是「遐想」最强的时刻。边缘有一圈慢转的金属面板，
 *   太阳、面板、相机正好对上时「闪一下」（像铱星闪光：平面金属的镜面反射，白天也看得见）。
 * - 舱体：上行 / 下行两条轨道上稀疏的长椭球，约 200 / 130 km/h（在 370 km 外每秒挪 0.2 像素，要盯一会儿才发现在动）。
 * - 稳定缆：从最低的两个中继站斜拉到海上的六个锚点（18–52 km 外），比主缆细得多、淡得多。
 * - 海上系留平台：基座处一块宽而扁的平台，贴着地平线、在霾里若隐若现；夜里是一串灯群。
 * - 航标灯（节律）：夜里缆上每 30 km 一盏红灯，全部同步慢闪（高耸结构的障碍灯就是同步的）；
 *   白天改成中继站两端的高强度白色频闪，从下往上依次闪一遍（白天红灯看不见，真实的高塔也是白天白闪、夜里红闪）。
 * 建木（skin 1，《淮南子·地形训》「众帝所自上下」、《山海经·海内经》「百仞无枝，上有九欘」）：
 * - 九欘：高处（55 km 以上）九根弯着往上长的枝，树冠在窗里的高处，向阳一侧被照亮。
 * - 云气缭绕：12–30 km 高处树干上挂着的三圈云环（圈间有薄雾相连），远看是横在树干上、顺风拖向一侧的云絮（真实的旗云 / 帽云：
 *   高山、高塔身边会挂云）。云的反照率高，白天是地平线上方最先被注意到的白色云絮，黄昏被染成粉橙。
 * - 萤光：树冠一带稀疏的金色光点，夜里是缓慢明灭的微光，白天偶尔有一两点被阳光照到「闪一下」（黄实）。
 * - 众帝上下：沿树干缓慢升降的暖色光团（夜里才看得见）。
 *
 * 为什么「像真的存在」而不是一道渲染划痕（研究文档 §6.1 的最大风险）：
 * - 光照是真的：太阳 / 月亮在该点的透射率（大气层内查透射率 LUT，层外按光线近地点判断地影），
 *   所以黄昏时下段已经在地球的影子里、上段还被（染红的）阳光照着，分界线的高度随太阳高度自然移动；
 *   下方地球（海面 + 云）反上来的光照亮平台的底面和线的侧面。
 * - 空气透视：乘到它那一点的透射率，再加上相机到它之间的内散射，下半截自然融进地平线的霾。
 * - 白天的可见性（W00 查因：正午线与天空的对比 < 1/255）：暗色细线本来就看不见（天空亮度几乎全来自它前面的空气）；
 *   白天被注意到的是反照率高的东西（中继站、舱体、云气）、镜面闪光和频闪灯，它们比天空亮，而不是比天空暗。
 * 只有一个调用点（outsideRadiance 的合成处）；uWonderOn = 0 时第一行就返回，关掉奇观模式时画面与原来逐像素一致。
 * 循环只有「撑杆」一个（上界 9 + uLoopGuard，FXC 不展开），重函数（透射率 / 辐照度 / 空气透视查表）各只算一次、各部分共用。
 */
export const WONDER_SKY_COMMON = /* glsl */ `
uniform float uWonderOn;     // 1 = 有天幕层奇观要画（奇观模式开着且有奇观在场），0 = 整段早退
uniform vec3 uWonderAxis;    // 轴线方向：地心 → 基座（窗外坐标，单位向量）
uniform vec4 uWonderShape;   // x = 底部半径（km），y = 可见前沿高度（km，浮现编排用），z = 皮肤（0 天梯 / 1 建木），w = 航标灯与舱体 0/1
uniform vec3 uWonderAlbedo;  // 表面反照率

// 三角核（半宽 1 像素、面积 1）的累积分布
float wonderTentCdf(float x) {
  x = clamp(x, -1.0, 1.0);
  return x < 0.0 ? 0.5 * (x + 1.0) * (x + 1.0) : 1.0 - 0.5 * (1.0 - x) * (1.0 - x);
}

// 区间 [−h, h]（像素）被中心在 c 的三角核覆盖的比例：细线 / 细条的像素覆盖率，h < 0.5 时按面积摊薄
float wonderStrip(float c, float h) {
  return wonderTentCdf(h - c) - wonderTentCdf(-h - c);
}

// 点光源的像素权重（二维三角核，面积 1）：dx、dy 是像素偏移
float wonderPoint(float dx, float dy) {
  return max(0.0, 1.0 - abs(dx)) * max(0.0, 1.0 - abs(dy));
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

// 天梯的中继站：k = 0..6，高度 16 km 起按约 1.85 倍往上排（带 ±8% 的不规则），半径 0.9–2.6 km，第 2 个（约 55 km）是大的中继站
float wonderStationS(float k) {
  return 16.0 * pow(1.85, k) * (0.92 + 0.16 * hash12(vec2(k, 3.7)));
}
float wonderStationR(float k) {
  return k == 2.0 ? 3.1 : 0.9 + 1.7 * hash12(vec2(k, 9.1));
}

// 挂在轴线上的旋转椭球（中继站：扁；舱体：长；系留平台：又宽又扁）。sc 中心高度，R 赤道半径，H 极半径（km）。
// 返回 rgb = 表面辐亮度（还没乘空气透视），a = 像素覆盖率。覆盖率在像面上按椭圆的弦解析积分（三角核），
// 法线由视线与椭球求交得到（没打中时取轮廓上的点）；光照：太阳 / 月亮直射 + 上半球天光 + 下方地球反光
vec4 wonderSpheroid(vec3 w0, vec3 rd, vec3 a, float sc, float R, float H, float x, float s, float wPix, float sn, float b,
                    vec3 eSun, vec3 eMoon, vec3 eSkyUp, vec3 eUp, float albedo) {
  float ax = R / wPix;
  float ay = sqrt(H * H * sn * sn + R * R * b * b) / wPix;
  float y = (s - sc) * sn / wPix;
  float q = min(abs(x) / max(ax, 1e-3), 0.95);
  float cov = wonderStrip(y, ay * sqrt(1.0 - q * q)) * wonderStrip(x, ax);
  if (cov <= 0.0) return vec4(0.0);
  // 缩放到球（沿轴线拉伸 R / H 倍）求交
  float f = R / H;
  vec3 p = w0 - a * sc;
  vec3 pp = p + a * (dot(p, a) * (f - 1.0));
  vec3 dd = rd + a * (b * (f - 1.0));
  float A = dot(dd, dd);
  float tc = -dot(pp, dd) / A;
  vec3 hp = pp + dd * tc;
  float d2 = dot(hp, hp);
  if (d2 < R * R) hp = pp + dd * (tc - sqrt((R * R - d2) / A));
  else hp *= R * inversesqrt(d2);
  vec3 nrm = normalize(hp + a * (dot(hp, a) * (f - 1.0)));
  float up = dot(nrm, a);
  vec3 E = eSun * max(dot(nrm, uSunDir), 0.0) + eMoon * max(dot(nrm, uMoonDir), 0.0)
         + eSkyUp * (0.5 + 0.5 * up) + eUp * (0.5 - 0.5 * up);
  return vec4(albedo / M_PI * E, cov);
}

// 从轴线伸出去的一根「撑杆」（天梯的稳定缆 / 建木的枝）：在水平方位 h（垂直于轴线的单位向量）上，
// 高度 σ ∈ [sa, sb] 处离轴线 r(σ) = rA + (rB − rA)·g(u)，u = (σ − sa)/(sb − sa)，g(u) = u + bend·u·(1 − u)
// （bend = 0 直线；bend = 1 时根部斜着长出、梢部转成竖直，导数处处有限），半径从 thA 渐变到 thB（km）。
// 像面上：横向 X_Q = r·(h·n̂)，纵向 = sn·(σ − k·r)（k = b·(h·rd)/sn²，h 有朝向相机的分量时看起来会偏高 / 偏低）。
// 解出和本像素同一纵向位置的 σ（牛顿法两步），返回像素覆盖率
float wonderStrut(float X, float s, float sn, float b, vec3 nh, vec3 rd, vec3 h, float wPix,
                  float sa, float sb, float rA, float rB, float bend, float thA, float thB) {
  float hx = dot(h, nh);
  float k = b * dot(h, rd) / (sn * sn);
  float span = sb - sa;
  float sig = s;
  for (int j = 0; j < 2; j++) {
    float u = clamp((sig - sa) / span, 0.0, 1.0);
    float r = rA + (rB - rA) * (u + bend * u * (1.0 - u));
    float dr = (rB - rA) * (1.0 + bend * (1.0 - 2.0 * u)) / span;
    sig -= (sig - s - k * r) / (1.0 - k * dr);
  }
  float u = (sig - sa) / span;
  if (u < 0.0 || u > 1.0) return 0.0;
  float r = rA + (rB - rA) * (u + bend * u * (1.0 - u));
  float dr = (rB - rA) * (1.0 + bend * (1.0 - 2.0 * u)) / span;
  float m = dr * hx / (sn * (1.0 - k * dr));
  float perp = abs(X - r * hx) * inversesqrt(1.0 + m * m);
  return wonderStrip(perp / wPix, mix(thA, thB, u) / wPix);
}

// L：线背后的背景辐亮度（天空含内散射，地面 / 海面已含空气透视）；tLimit：这条视线打到地面的距离（打不到传一个大数）
vec3 wonderSky(vec3 L, vec3 rd, float tLimit) {
  if (uWonderOn < 0.5) return L;
  vec3 a = uWonderAxis;
  vec3 w0 = vec3(0.0, uCamR, 0.0) - a * BOTTOM; // 相机相对基座
  vec3 n = cross(rd, a);
  float nn = dot(n, n);                          // = 1 − (rd·a)²
  if (nn < 1e-6) return L;                       // 顺着轴线看（不会发生在侧窗里）
  float sn = sqrt(nn);
  vec3 nh = n / sn;
  float X = dot(w0, nh);                         // 视线离轴线的有符号横向距离（km）
  float dist = abs(X);
  float b = dot(rd, a);
  float d = dot(rd, w0);
  float e = dot(a, w0);
  float t = (b * e - d) / nn;                    // 最近点沿视线的距离（km）
  float s = (e - b * d) / nn;                    // 最近点离基座的高度（km）
  if (t <= 0.0 || t > tLimit || s < -1.5) return L;
  bool tether = uWonderShape.z < 0.5;

  float pixelAngle = 2.0 * uTanHalfFov / uResolution.y;
  float wPix = t * pixelAngle;                   // 一个像素在那个距离上有多宽（km）
  // 越往上越细
  float radius = uWonderShape.x * mix(1.0, 0.45, smoothstep(0.0, 600.0, s));
  float haloPx = 5.0;
  // 这一高度上最远的东西离轴线多远：稳定缆 / 系留平台（天梯低处）、云气（建木 9–34 km）、树冠与萤光（建木 46 km 以上）
  float reach = max(radius + haloPx * 3.0 * wPix, 4.0);
  if (tether) { if (s < 34.0) reach = 58.0; }
  else if (s > 46.0) reach = 46.0;
  else if (s > 9.0 && s < 34.0) reach = 40.0;
  if (dist > reach) return L;

  // 可见前沿（浮现 / 退场的编排）：前沿以上是长渐变，不是硬边
  float front = uWonderShape.y;
  float visF = (1.0 - smoothstep(0.35 * front, front, s)) * smoothstep(-1.5, 0.0, s);
  if (visF <= 0.0) return L;
  // 下半截沉进霾与云海：离地几公里以内被低空的霾层吞掉，不给看清基座——「看不到它从哪里来」（系留平台不乘这一项，靠真实的空气透视）
  float sink = smoothstep(0.0, 9.0, s);
  float vis = visF * sink * sink;

  // ---- 光照（各部分共用，查表各一次）：太阳、月亮的直射（真实地影）、上半球天光、下方地球（海面 + 云，反照率约 0.3）反上来的光
  float sP = max(s, 0.0);
  vec3 P = a * (BOTTOM + sP);
  float r = BOTTOM + sP;
  vec3 tS = wonderLightT(P, uSunDir);
  vec3 eSun = uSunIlluminance * tS;
  vec3 eMoon = uMoonIlluminance * wonderLightT(P, uMoonDir);
  // 大气层以外没有天空光
  vec3 eSkyUp = skyIrradiance(min(r, TOP), a) * (1.0 - smoothstep(40.0, 100.0, s));
  vec3 eUp = 0.21 * (uSunIlluminance * max(dot(a, uSunDir), 0.0) + uMoonIlluminance * max(dot(a, uMoonDir), 0.0));
  vec3 V = -rd;
  float perpS, perpM;
  float phS = wonderCylinderPhase(uSunDir, V, a, perpS);
  float phM = wonderCylinderPhase(uMoonDir, V, a, perpM);
  vec3 direct = uWonderAlbedo / M_PI * (eSun * perpS * phS + eMoon * perpM * phM);
  // 竖直的柱面看到半个天空、半个地球
  vec3 Lt = direct + uWonderAlbedo / M_PI * 0.5 * (eSkyUp + eUp);

  // 空气透视（LUT 最远 400 km；更远的那段视线已经在大气层外，没有更多内散射）
  vec3 uvw = aerialPerspectiveUvw(rd, uSunDir, min(t, AERIAL_MAX_DISTANCE));
  vec3 apL = texture(uAerialInscatterS, uvw).rgb * uSunIlluminance;
  vec3 apT = texture(uAerialTransmittanceS, uvw).rgb;
  // 相机到线之间的内散射：空气透视 LUT 只有太阳一路；月光那一路没有 LUT，按「背景里有多少比例的空气在线前面」近似：
  // 天空的内散射 ∝ 沿视线的消光，线前面那段占 (1 − T线) / (1 − T层顶)。否则月夜里线会黑得像一道裂缝。
  // （气辉在 90 km 高的一层，大多在线后面，所以无月的夜里线确实是一道比天空略暗的剪影）
  vec3 frontFrac = 1.0 - apT;
  if (tLimit > 1e8) frontFrac = clamp(frontFrac / max(1.0 - transmittanceToTop(uCamR, rd.y), vec3(1e-4)), 0.0, 1.0);
  vec3 lFront = max(apL, L * frontFrac);

  float x = X / wPix;                            // 横向像素偏移（有符号）
  float T = uTime;
  // 白天（太阳在地平线以上约 −6° 起）用白色频闪，夜里用红色障碍灯
  float dayF = smoothstep(-0.10, 0.02, uSunDir.y);

  // ---- 主缆 / 树干 + 撑杆（同一种材质）
  float cov = wonderStrip(x, radius / wPix);
  // 水平面上的两个正交方向（撑杆的方位、面板的方位用）
  vec3 e1 = normalize(cross(vec3(0.0, 0.0, 1.0), a));
  vec3 e2 = cross(a, e1);
  int nStrut = tether ? (s < 34.0 ? 6 : 0) : (s > 46.0 ? 9 : 0);
  float covS = 0.0;
  for (int i = 0; i < 9 + uLoopGuard; i++) {
    if (i >= nStrut) break;
    float fi = float(i);
    float h1 = hash12(vec2(fi, 11.0 + uWonderShape.z));
    float h2 = hash12(vec2(fi, 23.0 + uWonderShape.z));
    float h3 = hash12(vec2(fi, 37.0 + uWonderShape.z));
    float sa, sb, rA, rB, bend, thA, thB, phi;
    if (tether) {
      // 稳定缆：前三根从最低的中继站拉到 18–24 km 外，后三根从第二个拉到 40–52 km 外；方位错开
      bool lo = i < 3;
      float fj = lo ? fi : fi - 3.0;
      sa = 0.0;
      sb = wonderStationS(lo ? 0.0 : 1.0);
      rA = lo ? 18.0 + 6.0 * h1 : 40.0 + 12.0 * h1;
      rB = 0.0;
      bend = 0.0;
      thA = 0.05;
      thB = 0.035;
      phi = fj * 2.0944 + (lo ? 0.35 : 1.4) + 0.25 * h2;
    } else {
      // 九欘：55–125 km 高处长出来，弯着往上、往外伸 12–38 km，越往梢越细
      sa = 55.0 + 70.0 * h1;
      sb = sa + 35.0 + 45.0 * h2;
      rA = 0.0;
      rB = 12.0 + 26.0 * h3;
      bend = 1.0;
      thA = 0.26;
      thB = 0.04;
      phi = fi * 0.6981 + 0.5 * h2;
    }
    vec3 h = cos(phi) * e1 + sin(phi) * e2;
    covS += wonderStrut(X, s, sn, b, nh, rd, h, wPix, sa, sb, rA, rB, bend, thA, thB);
  }
  float c = min(cov + covS, 1.0) * vis;
  L = mix(L, lFront + apT * Lt, c);

  // 光晕：被照亮的那段在空气里的一点前向散射（能量按线的覆盖宽度折算，很弱，只在暮色、夜里的暗背景上看得出）
  float lineW = min(2.0 * radius / wPix, 1.0);
  L += apT * direct * vis * lineW * 0.012 * exp(-x * x / (2.0 * haloPx * haloPx));

  // ---- 点光源：累加「光强 × 像素权重」（kcd），最后统一换成辐亮度
  vec3 lamp = vec3(0.0);
  vec3 lampBase = vec3(0.0);                     // 系留平台的灯群：不乘「沉进霾」那一项，只靠真实的空气透视
  float tm = t * 1000.0;
  // 舱体 / 光团：上行、下行两条轨道，间隔不规则（有的格子空着）
  float sU = (floor((s - 0.055 * T) / 61.0 + 0.5)) * 61.0 + 0.055 * T;
  float kU = floor((s - 0.055 * T) / 61.0 + 0.5);
  float sD = (floor((s + 0.036 * T) / 83.0 + 0.5)) * 83.0 - 0.036 * T;
  float kD = floor((s + 0.036 * T) / 83.0 + 0.5);
  bool okU = hash12(vec2(kU, 5.3 + uWonderShape.z)) > 0.3 && sU > 7.0;
  bool okD = hash12(vec2(kD, 8.9 + uWonderShape.z)) > 0.45 && sD > 7.0;
  float sPod = okU ? sU : sD;
  if (okU && okD && abs(s - sD) < abs(s - sU)) sPod = sD;
  bool hasPod = okU || okD;

  if (tether && uWonderShape.w > 0.5) {
    // ---- 中继站 / 舱体 / 系留平台：取离本像素最近的一个，走同一个椭球函数
    float kS = clamp(floor(log(max(s, 1.0) / 16.0) / log(1.85) + 0.5), 0.0, 6.0);
    float sSt = wonderStationS(kS);
    float RSt = wonderStationR(kS);
    float sc = sSt;
    float R = RSt;
    float H = 0.3 * RSt + 0.12;
    float alb = 0.3;                             // 浅色金属 / 隔热涂层
    float kind = 0.0;                            // 0 中继站、1 舱体、2 系留平台
    if (hasPod && abs(s - sPod) < abs(s - sSt) - H) {
      sc = sPod; R = 0.55; H = 0.9; alb = 0.4; kind = 1.0;
    }
    if (s < 5.0) {
      sc = 0.6; R = 8.5; H = 1.1; alb = 0.12; kind = 2.0;
    }
    float objVis = kind > 1.5 ? visF : vis;
    if (dist < R + 2.0 * wPix) {
      vec4 o = wonderSpheroid(w0, rd, a, sc, R, H, x, s, wPix, sn, b, eSun, eMoon, eSkyUp, eUp, alb);
      L = mix(L, lFront + apT * o.rgb, o.a * objVis);
    }
    float y = (s - sc) * sn / wPix;
    float ax = R / wPix;
    if (kind < 0.5) {
      // 边缘的金属面板（16 块，倾角各不相同）跟着平台慢转（约 1.5 分钟一圈）：
      // 半角向量 H 的方位正好对上某块面板、倾角也在那块面板的范围内时，那块面板把太阳反射过来——一个短促的亮点（像铱星闪光）
      vec3 Hv = normalize(uSunDir + V);
      float hz = dot(Hv, a);
      vec3 hh = Hv - a * hz;
      float hl = length(hh);
      if (hl > 1e-4) {
        hh /= hl;
        float omega = 6.2832 / (80.0 + 30.0 * hash12(vec2(kS, 2.2)));
        float az = atan(dot(hh, e2), dot(hh, e1)) - omega * T;
        float j = floor(az / 0.3927 + 0.5);    // 2π / 16
        float dAz = az - j * 0.3927;
        float tilt = (hash12(vec2(j + 16.0 * kS, 4.4)) - 0.5) * 1.6;
        float lobe = exp(-dAz * dAz / 0.0004 - (asin(hz) - tilt) * (asin(hz) - tilt) / 0.012);
        // 面板在轮廓上的位置（像面）：亮点落在朝向相机的那一侧边缘
        float gx = x - R * dot(hh, nh) / wPix;
        float gy = y + R * b * dot(hh, rd) / (sn * wPix);
        float facing = smoothstep(0.0, 0.1, dot(hh, V));
        // 光强 = 面板反射率 × 太阳辐亮度 × 等效面积（弯曲面板把反射摊到约 ±6°，等效 1.2 m²）：正午约是天空一个像素的 5 倍
        lamp += tS * uSunIlluminance * 1.6e4 * lobe * facing * wonderPoint(gx, gy);
      }
      // 平台两端的灯：夜里是常亮的暖白微光（有人住）；白天是高强度白色频闪，从下往上依次闪（4 s 一轮）
      float wEnds = wonderPoint(abs(x) - ax * 0.97, y);
      float ph = fract(T / 4.0 - kS * 0.09);
      float strobe = exp(-ph * ph / 0.0009);
      lamp += vec3(1.0, 0.93, 0.8) * (25.0 * (1.0 - dayF) + 8e4 * dayF * strobe) * wEnds;
    } else if (kind < 1.5) {
      // 舱体的航行灯：夜里一点常亮的白光
      lamp += vec3(1.0, 0.97, 0.92) * 10.0 * (1.0 - dayF) * wonderPoint(x, y);
    } else {
      // 系留平台上的灯群：0.5 km 一格，三层，一半的格子有灯，钠灯 / 白光混着，亮度各不相同
      float gx = floor(X / 0.5 + 0.5);
      float gy = clamp(floor((s - 0.35) / 0.55 + 0.5), 0.0, 2.0);
      float hl = hash12(vec2(gx, gy + 40.0));
      float inPlat = step(abs(gx * 0.5), R * (1.0 - 0.25 * gy));
      vec3 col = hl > 0.75 ? vec3(0.85, 0.9, 1.0) : vec3(1.0, 0.72, 0.4);
      float wl = wonderPoint(x - gx * 0.5 / wPix, (s - 0.35 - gy * 0.55) * sn / wPix);
      lampBase = col * 6.0 * step(0.5, hl) * (0.4 + hl) * inPlat * (1.0 - dayF) * wl;
    }
    // 缆上的红色障碍灯：每 30 km 一盏，全部同步慢闪（2 s 一次，像白炽灯一样缓起缓落），常亮底 10%
    float kb = max(floor(s / 30.0 + 0.5), 1.0);
    float dyb = (s - kb * 30.0) * sn / wPix;
    float phb = fract(T / 2.0);
    float blink = 0.1 + 0.9 * smoothstep(0.0, 0.12, phb) * (1.0 - smoothstep(0.4, 0.62, phb));
    lamp += vec3(1.0, 0.08, 0.03) * 300.0 * blink * (1.0 - dayF) * wonderPoint(x, dyb);
  } else if (!tether) {
    // ---- 建木：云气缭绕。树干上挂着三圈云（约 12–30 km，间隔不规则），每圈是绕着树干的一道云环，远看是横在树干上、
    // 顺风往一侧拖长的云絮（像山顶的旗云），越往上越薄；圈与圈之间有一层很淡的薄雾把它们连起来。
    // 噪声沿横向拉长（絮状），最细的起伏约 2 km（六七个像素），不会逐帧闪
    if (s > 9.0 && s < 34.0) {
      float kc = clamp(floor((s - 12.5) / 7.0 + 0.5), 0.0, 2.0);
      float hc1 = hash12(vec2(kc, 61.0));
      float hc2 = hash12(vec2(kc, 67.0));
      float sc = 12.5 + 7.0 * kc + 2.4 * (hc1 - 0.5);
      float xo = X - 3.0 * (hc1 - 0.4);
      float wid = (6.0 + 6.0 * hc2 - kc) * (xo > 0.0 ? 1.8 : 0.7);
      float th = (0.6 + 0.7 * hc2) * (0.6 + 0.8 * vnoise(vec2(X * 0.3 + kc * 9.0, 2.0)));
      float ds = s - sc - 0.05 * X * (hc2 - 0.5) - 1.2 * (vnoise(vec2(X * 0.18 + T * 0.003, kc * 7.0)) - 0.5);
      float nz = 0.6 * vnoise(vec2(X * 0.2 - T * 0.003, ds * 0.8 + kc * 13.0)) + 0.4 * vnoise(vec2(X * 0.5 + 3.0, ds * 1.3 + kc * 5.0));
      // 最后一项：离轴线 28–38 km 渐隐到 0（上面 reach 在 40 km 处截断，不能留下硬边）
      float tau = (2.6 - 0.7 * kc) * exp(-ds * ds / (th * th) - xo * xo / (wid * wid)) * smoothstep(0.15, 0.75, nz) * (1.0 - smoothstep(28.0, 38.0, dist));
      // 薄雾：贴着树干、很淡，把几圈云连成「缭绕」
      tau += 0.22 * exp(-X * X / 30.0) * smoothstep(10.0, 14.0, s) * (1.0 - smoothstep(24.0, 32.0, s)) * vnoise(vec2(X * 0.25, s * 0.3 - T * 0.002));
      // 云：反照率约 0.8；朝太阳看时前向散射更亮
      float fwd = 1.0 + 1.5 * pow(max(dot(rd, uSunDir), 0.0), 4.0);
      vec3 Lc = 0.8 / M_PI * (eSun * 0.8 * fwd + eMoon * 0.8 + eSkyUp + 0.5 * eUp);
      L = mix(L, lFront + apT * Lc, (1.0 - exp(-tau)) * visF);
    }
    // 众帝上下：沿树干升降的暖色光团（夜里才看得见）
    if (hasPod) lamp += vec3(1.0, 0.8, 0.5) * 40.0 * (1.0 - dayF) * wonderPoint(x, (s - sPod) * sn / wPix);
    // 萤光（黄实）：树冠一带稀疏的金色光点，格子 2.6 km × 3.4 km，缓慢上飘；夜里明灭的微光，白天偶尔被阳光照到闪一下
    if (s > 45.0 && s < 240.0) {
      float sd = s - 0.004 * T;
      vec2 cell = floor(vec2(X / 2.6, sd / 3.4));
      vec2 hc = hash22(cell + 71.0);
      float near = exp(-abs(cell.x * 2.6) / 14.0) * smoothstep(45.0, 70.0, s);
      if (hc.x < 0.35 * near) {
        vec2 pc = (cell + 0.5 + (hc - 0.5) * 0.5) * vec2(2.6, 3.4);
        float tw = 0.5 + 0.5 * sin(T * (0.5 + hc.y) + hc.x * 40.0);
        float spark = pow(max(sin(T * (0.3 + 0.5 * hc.y) + hc.y * 60.0), 0.0), 24.0);
        vec3 glow = vec3(1.0, 0.78, 0.4) * (15.0 * tw * tw * (1.0 - dayF) + 1.2e6 * spark * dot(tS, vec3(0.333)));
        lamp += glow * wonderPoint(x - pc.x / wPix, (sd - pc.y) * sn / wPix);
      }
    }
  }
  // 光强（kcd）→ 相机处照度（klux）= I / 距离²（m），再除以一个像素的立体角得到辐亮度
  L += apT * (lamp * vis + lampBase * visF) / (tm * tm * pixelAngle * pixelAngle);
  return L;
}
`;
