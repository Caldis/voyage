/**
 * 天幕层奇观（W01 / W01b / WS01）：天梯 / 建木——从地平线附近升起、直入太空的巨构（GLSL）。
 * 依赖 ATMOSPHERE_COMMON、VIEW_COMMON、LIGHTS_COMMON、NOISE_COMMON、TRAFFIC_COMMON（空气透视的两个 3D 纹理在那里声明，本段不新增 sampler）。
 *
 * 几何：地心坐标（和 outsideRadiance 一样，相机在 (0, uCamR, 0)，y 朝天顶、x 朝东、−z 朝北）。
 * 主体是一条过地心的射线上的柱：基座 B = uWonderAxis × BOTTOM，向上一直延伸到太空。
 * 视线与轴线求最近点，得到视线到轴线的有符号横向距离 X、最近点沿视线的距离 t、沿轴线离基座的高度 s。
 * 所有运算都相对基座做（几百 km 量级），不用地心的 6000 多 km 大数相减，float 精度够分辨 1/10 像素。
 *
 * 像面坐标（W01b，WS01 补全）：每个像素有一组正交基 (nh, up, rd)：nh = rd × a 归一（横向），up = (a − b·rd)/sn（纵向），
 * 相对基座的一点 p 在像面上是 (p·nh, p·up)，本像素自己是 (X, Y) = (w0·nh, w0·up)，Y = s·sn。
 * 视线穿过 p 当且仅当两者相等——所以「视线打不打得中」按像面判断是精确的（沿视线的正交投影），
 * 覆盖率在像面上按三角核（±1 像素）解析积分：亚像素时按面积摊薄、能量守恒，不会逐帧闪。
 * 轴线上高 h、半径 R 的水平圆在像面上是椭圆：横半轴 R、纵半轴 |b|·R（b = rd·a），中心 (0, sn·h)；
 * 朝相机的半圈在 b > 0（仰视）时是上半个椭圆，俯视时是下半个。锚塔、环站、扶壁、灯都按这一条换算。
 *
 * 天梯（skin 0，致敬《流浪地球 2》太空电梯；WS01 巨构化，尺寸由 wonders/tether-shape.ts 按种子随机）：
 * - 锚塔：30–40 km 高、3–4 级退台的截锥（底宽 14–18 km），粗野主义混凝土（反照率约 0.3，受光面 / 背光面大块明暗），
 *   面上只有横向施工缝和竖向雨痕两种纹理（按像素足迹积分，远处平均掉）；4–6 片放射状扶壁伸到海上。
 *   比雷暴云顶高一倍：窗里是一整块实心的体量，塔顶高过视平线约 8°，脚埋在地平线的霾里。
 * - 缆束：直径约 2 km，里面 3 根子缆（近处看得见之间的缝），300 km 以上收到一半。
 * - 环形站：3–5 只（环半径 12–35 km、环管 1–3 km，4–8 根辐条接到缆上）；从下面仰看是横在天上的扁椭圆，
 *   近侧的半圈挡在缆前面、远侧的在缆后面。
 * - 稳定缆：从塔顶斜拉到 45–70 km 外海上的六根细线（夜里是塔两侧淡淡的「帐篷」）。
 * - 舱体：上行 / 下行两条轨道，贴在缆束两侧，约 200 / 130 km/h。
 * - 夜灯（按用户「极简」的取向，放大不等于点亮）：缆上每 30 km 一盏红色障碍灯全部同步慢闪（保留）；
 *   缆上每 2 km 一盏暗白灯，每隔约 20 s 有一道光脉冲以约 2 km/s 往上爬（一分钟左右爬出窗口，用时间给出尺度）；
 *   锚塔每级退台朝相机的一圈轮廓灯（描出体量）；塔顶红灯同步慢闪。塔身灯格是开发者开关（uWonderSky.w，默认关）。
 *   白天：环站两端高强度白色频闪，从下往上依次闪（真实高塔白天白闪、夜里红闪）。
 * - 云的前后：塔在 200–260 km 外，比它远的云要排到它后面（outside-pass.ts 按 gWonderCov / gWonderT 调 cloudBeforeGround）。
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
 * - 空气透视：乘到它那一点的透射率，再加上相机到它之间的内散射，下半截自然融进地平线的霾（锚塔的脚蓝灰、反差低，上段衬在深蓝的天上更清楚）。
 * - 白天的可见性（W00 查因：正午线与天空的对比 < 1/255）：暗色细线本来就看不见；WS01 起靠体量（锚塔、环站）。
 * 只有一个调用点（outsideRadiance 的合成处）；uWonderOn = 0 时第一行就返回，关掉奇观模式时画面与原来逐像素一致。
 * PERF-13：整段只拼进窗外程序的 OUTSIDE_WONDER 变体（outside-pass.ts 里包在 #ifdef 中），默认程序预处理后不含它；
 * uWonderOn = 1 时才选这个变体（wantedOutsideKey），没编好之前不画天幕层奇观（浮现本来就从地平线的霾里开始）。
 * 重函数（透射率 / 辐照度 / 空气透视查表）各只算一次、各部分共用；天梯先只算几何覆盖率，一个像素什么都没盖到就不查表直接返回。
 * 循环（撑杆、退台、扶壁、环站、辐条）上界都写成「常数 + uLoopGuard」，FXC 不展开。
 */
export const WONDER_SKY_COMMON = /* glsl */ `
uniform float uWonderOn;     // 1 = 有天幕层奇观要画（奇观模式开着且有奇观在场），0 = 整段早退
uniform vec3 uWonderAxis;    // 轴线方向：地心 → 基座（窗外坐标，单位向量）
uniform vec4 uWonderShape;   // x = 底部半径（km），y = 可见前沿高度（km，浮现编排用），z = 皮肤（0 天梯 / 1 建木），w = 航标灯与舱体 0/1
uniform vec3 uWonderAlbedo;  // 表面反照率
// 天梯的巨构尺寸（WS01，wonders/tether-shape.ts 按种子生成）
uniform vec4 uWonderSky;       // x 退台级数、y 环站个数、z 扶壁片数、w 塔身灯格（开发者开关 0/1）
uniform vec4 uWonderTower;     // x 塔高、y 底半径、z 顶半径（km）、w 方位起点（弧度）
uniform vec4 uWonderFin;       // x 扶壁伸出长度、y 扶壁半厚（km）
uniform vec4 uWonderTiers[4];  // 每级退台：底高、顶高、底半径、顶半径（km）
uniform vec4 uWonderRings[5];  // 每只环站：中心高度、环半径、环管半径（km）、辐条数

// 给 outside-pass 排远云用（WS01）：这个像素被奇观的实体盖住多少、奇观离相机多远（km）
float gWonderCov = 0.0;
float gWonderT = 0.0;

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

// 挂在轴线上的旋转椭球（舱体：长）。sc 中心高度，R 赤道半径，H 极半径（km）。
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

float wonderLum(vec3 v) { return dot(v, vec3(0.2126, 0.7152, 0.0722)); }

// 奇观表面（满覆盖时）的辐亮度封顶（W01b 返工）：亮度不超过同方向天空（背景）的 capLum，保留色相；
// 也不比背景暗过 40%（地影里的一段是略暗于天空的剪影，而不是一道黑缝）。scale 返回封顶的比例（光晕跟着缩）
vec3 wonderCap(vec3 v, vec3 bg, float capLum, out float scale) {
  scale = min(1.0, capLum / max(wonderLum(v), 1e-9));
  return max(v * scale, bg * 0.6);
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

// ---- WS01 天梯巨构的几何小工具（全部在像面坐标里，km）

// 一级退台（截锥 tier = 底高、顶高、底半径、顶半径）的像素覆盖率：横向按这一高度的半径（轮廓上的点正好在 h = Y/sn），
// 纵向上下沿是顶圆 / 底圆投影成的椭圆（竖半轴 |b|·r），所以退台的上沿在仰视、俯视时都是一道缓弧
float wonderFrustum(float X, float Y, float sn, float ab, float wPix, vec4 tr) {
  float hq = clamp(Y / sn, tr.x, tr.y);
  float rq = mix(tr.z, tr.w, (hq - tr.x) / max(tr.y - tr.x, 1e-3));
  float top = sn * tr.y + ab * sqrt(max(tr.w * tr.w - X * X, 0.0));
  float bot = sn * tr.x - ab * sqrt(max(tr.z * tr.z - X * X, 0.0));
  return wonderStrip(X / wPix, rq / wPix) * wonderStrip((Y - 0.5 * (top + bot)) / wPix, 0.5 * (top - bot) / wPix);
}

// 凸多边形有符号距离（Inigo Quilez 的 sdPolygon，四个顶点；里面为负）
void wonderEdge(vec2 p, vec2 vi, vec2 vj, inout float d, inout float sg) {
  vec2 e = vj - vi;
  vec2 w = p - vi;
  vec2 q = w - e * clamp(dot(w, e) / max(dot(e, e), 1e-12), 0.0, 1.0);
  d = min(d, dot(q, q));
  bvec3 c = bvec3(p.y >= vi.y, p.y < vj.y, e.x * w.y > e.y * w.x);
  if (all(c) || all(not(c))) sg = -sg;
}
float wonderSdQuad(vec2 p, vec2 v0, vec2 v1, vec2 v2, vec2 v3) {
  float d = 1e20;
  float sg = 1.0;
  wonderEdge(p, v0, v3, d, sg);
  wonderEdge(p, v1, v0, d, sg);
  wonderEdge(p, v2, v1, d, sg);
  wonderEdge(p, v3, v2, d, sg);
  return sg * sqrt(d);
}

// 点到线段的距离
float wonderSeg(vec2 p, vec2 a0, vec2 a1) {
  vec2 e = a1 - a0;
  vec2 w = p - a0;
  return length(w - e * clamp(dot(w, e) / max(dot(e, e), 1e-12), 0.0, 1.0));
}

// 点 p 到轴对齐椭圆（半轴 A、B）的最近点（迭代三次，误差远小于像素）
vec2 wonderEllipseNearest(vec2 p, float A, float B) {
  vec2 pa = abs(p);
  float tx = 0.70710678;
  float ty = 0.70710678;
  for (int i = 0; i < 3; i++) {
    float ex = (A * A - B * B) * tx * tx * tx / A;
    float ey = (B * B - A * A) * ty * ty * ty / B;
    vec2 r = vec2(A * tx - ex, B * ty - ey);
    vec2 q = pa - vec2(ex, ey);
    float k = length(r) / max(length(q), 1e-9);
    tx = clamp((q.x * k + ex) / A, 0.0, 1.0);
    ty = clamp((q.y * k + ey) / B, 0.0, 1.0);
    float tl = inversesqrt(tx * tx + ty * ty);
    tx *= tl;
    ty *= tl;
  }
  return vec2(A * tx, B * ty) * sign(p + 1e-9);
}

// 区间 [x − f/2, x + f/2] 落在「每 P 一条、宽 w 的带」里的比例：按像素足迹 f 做的盒式积分（施工缝、楼层，远处自然平均掉，不闪）
float wonderBandInt(float x, float P, float w) {
  return floor(x / P) * w + min(fract(x / P) * P, w);
}
float wonderBands(float x, float f, float P, float w) {
  f = max(f, 1e-4);
  return (wonderBandInt(x + 0.5 * f, P, w) - wonderBandInt(x - 0.5 * f, P, w)) / f;
}

// 环站外壳的反照率：朝上 / 朝外的一面是浅灰的隔热外壳（0.33，不做金属高光），朝下的一面铺着深色的散热 / 光伏板（0.07）。
// 从下面仰看时环管中间一道暗带、两侧亮边，是「一节节的工程结构」而不是一只均匀发白的甜甜圈
vec3 wonderRingAlb(vec3 n, vec3 a) {
  return mix(vec3(0.32, 0.33, 0.34), vec3(0.06, 0.065, 0.08), smoothstep(-0.15, -0.55, dot(n, a)));
}

// 漫反射照度：太阳 / 月亮直射 + 上半球天光 + 下方地球反光（n 为单位法线）
vec3 wonderIrr(vec3 n, vec3 a, vec3 eSun, vec3 eMoon, vec3 eSkyUp, vec3 eUp) {
  float up = dot(n, a);
  return eSun * max(dot(n, uSunDir), 0.0) + eMoon * max(dot(n, uMoonDir), 0.0) + eSkyUp * (0.5 + 0.5 * up) + eUp * (0.5 - 0.5 * up);
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
  bool tether = uWonderShape.z < 0.5;
  // 天梯的锚塔很粗（底半径 7–9 km）：塔的正面比轴线近一个半径，塔脚的边由锚塔自己的解析下沿（海面 h = 0）给，
  // 地面只在「明显比整座塔都近」时才挡（真实地形挡在前面）
  float tNear = tether ? t - uWonderTower.y - 1.0 : t;
  if (t <= 0.0 || tNear > tLimit || s < -1.5) return L;

  float pixelAngle = 2.0 * uTanHalfFov / uResolution.y;
  float wPix = t * pixelAngle;                   // 一个像素在那个距离上有多宽（km）
  // 越往上越细（天梯的缆束 150–350 km 收到一半）
  float radius = uWonderShape.x * (tether ? mix(1.0, 0.5, smoothstep(150.0, 350.0, s)) : mix(1.0, 0.45, smoothstep(0.0, 600.0, s)));
  float haloPx = 5.0;
  float x = X / wPix;                            // 横向像素偏移（有符号）
  float T = uTime;
  // 水平面上的两个正交方向（撑杆的方位、面板的方位用）
  vec3 e1 = normalize(cross(vec3(0.0, 0.0, 1.0), a));
  vec3 e2 = cross(a, e1);
  // 可见前沿（浮现 / 退场的编排）：前沿以上是长渐变，不是硬边
  float front = uWonderShape.y;
  float visF = (1.0 - smoothstep(0.35 * front, front, s)) * smoothstep(-1.5, 0.0, s);
  if (visF <= 0.0) return L;

  // ---- 天梯：先只算几何覆盖率（锚塔、扶壁、缆束、环站、辐条、稳定缆），什么都没盖到、附近也没有灯就直接返回（不查表）
  float Y = s * sn;                              // 本像素在像面上的纵坐标（km）
  float ab = abs(b);
  vec3 mh = (rd - a * b) / sn;                   // 水平面里「沿视线往远处」的单位向量（像面的深度方向）
  vec3 uph = (a - rd * b) / sn;                  // 像面纵轴
  float H = uWonderTower.x;
  float covTower = 0.0;
  vec4 tierHit = uWonderTiers[0];
  float covFinN = 0.0, covFinF = 0.0;            // 扶壁：朝相机一侧（画在塔前）/ 背向一侧（画在塔后）
  vec3 nFinN = vec3(0.0), nFinF = vec3(0.0);
  float covRingN = 0.0, covRingF = 0.0;          // 环站：近侧半圈（挡在缆前）/ 远侧半圈（在缆后）
  vec3 nRingN = vec3(0.0), nRingF = vec3(0.0);
  float segN = 1.0, segF = 1.0;                  // 环站舱段接缝的明暗
  float covSpokeN = 0.0, covSpokeF = 0.0;
  float ringLamp = -1.0;                         // 离本像素最近的环站编号（灯用）
  if (tether) {
    // 锚塔：各级退台的覆盖率相加（相邻两级在接缝处各 0.5，加起来正好 1，不会有细缝）
    if (s < H + 3.0 && dist < uWonderTower.y + 3.0 * wPix) {
      float cMax = 0.0;
      for (int k = 0; k < 4 + uLoopGuard; k++) {
        if (float(k) >= uWonderSky.x) break;
        vec4 tr = uWonderTiers[k];
        float ck = wonderFrustum(X, Y, sn, ab, wPix, tr);
        covTower += ck;
        if (ck > cMax) { cMax = ck; tierHit = tr; }
      }
      covTower = min(covTower, 1.0);
    }
    // 扶壁：放射状的混凝土板，从塔脚伸到海上（高到第一级退台）。像面上是一个凸四边形，按板厚往外扩；
    // 板正对 / 背对相机时退化成一条竖直的窄条，照样成立
    vec4 t0 = uWonderTiers[0];
    float finR = t0.z + uWonderFin.x;
    if (s < 0.5 * t0.y + 1.5 && dist < finR + 1.0 + 2.0 * wPix) {
      for (int i = 0; i < 6 + uLoopGuard; i++) {
        if (float(i) >= uWonderSky.z) break;
        float fi = float(i);
        float phi = uWonderTower.w + fi * 6.2832 / uWonderSky.z + 0.35 * (hash12(vec2(fi, 71.0)) - 0.5);
        vec3 hd = cos(phi) * e1 + sin(phi) * e2;
        vec3 q = cross(a, hd);
        vec2 hI = vec2(dot(hd, nh), dot(hd, uph));
        // 板的侧面是梯形：贴塔一侧高到第一级退台的 45%，外端还有 30% 那么高（一块敦实的墩，而不是往外张开的裙摆）
        float hTop = t0.y * 0.45;
        float rTop = mix(t0.z, t0.w, 0.45);
        vec2 p0 = hI * t0.z * 0.8;
        vec2 p1 = hI * finR;
        vec2 p2 = hI * finR + vec2(0.0, sn * 0.3 * hTop);
        vec2 p3 = hI * rTop + vec2(0.0, sn * hTop);
        float sd = wonderSdQuad(vec2(X, Y), p0, p1, p2, p3) - uWonderFin.y * length(vec2(dot(q, nh), dot(q, uph)));
        float cf = wonderTentCdf(-sd / wPix);
        vec3 nq = q * -sign(dot(q, rd));
        if (dot(hd, rd) < 0.0) { if (cf > covFinN) { covFinN = cf; nFinN = nq; } }
        else if (cf > covFinF) { covFinF = cf; nFinF = nq; }
      }
    }
    // 环形站：环的中心线在像面上是椭圆（横半轴 R、纵半轴 |b|R），环管是它两侧 rt 以内的带；辐条是从轴线到环上的线段
    for (int k = 0; k < 5 + uLoopGuard; k++) {
      if (float(k) >= uWonderSky.y) break;
      vec4 rg = uWonderRings[k];
      float yc = Y - sn * rg.x;
      float Bv = max(ab, 0.03) * rg.y;
      float m2 = 2.2 * rg.z + 2.0 * wPix;
      if (abs(X) > rg.y + m2 || abs(yc) > Bv + m2) continue;
      ringLamp = float(k);
      vec2 cp = wonderEllipseNearest(vec2(X, yc), rg.y, Bv);
      vec2 dl = vec2(X, yc) - cp;
      float cr = wonderStrip(length(dl) / wPix, rg.z / wPix);
      // 环上这一点的方位：像面 (R cosφ, −b R sinφ)；sinφ < 0 是朝相机的一侧
      float cphi = clamp(cp.x / rg.y, -1.0, 1.0);
      float sphi = -cp.y / (b * rg.y + (b < 0.0 ? -1e-6 : 1e-6));
      vec3 rad = normalize(cphi * nh + sphi * mh);
      vec3 tng = cross(a, rad);
      // 环管的法线：像面偏移换回三维，再补上朝相机的分量（冒充球），去掉沿环的切向分量
      vec3 nr = (dl.x * nh + dl.y * uph) / rg.z;
      nr += -rd * sqrt(max(1.0 - dot(nr, nr), 0.0));
      nr = normalize(nr - tng * dot(nr, tng) + 1e-6 * rad);
      // 环是一节节舱段拼起来的：每 7.5° 一道暗缝（按像素足迹在方位上积分，透视压缩的两端自然平均掉）
      float phiR = atan(sphi, cphi);
      float fphi = wPix / (rg.y * sqrt(sphi * sphi + b * b * cphi * cphi) + 1e-4);
      float seg = 1.0 - 0.45 * wonderBands(phiR + 3.1416, fphi, 0.1309, 0.012);
      if (sphi < 0.0) { if (cr > covRingN) { covRingN = cr; nRingN = nr; segN = seg; } }
      else if (cr > covRingF) { covRingF = cr; nRingF = nr; segF = seg; }
      // 辐条：细的张拉索（粗约为环管的 0.08），远看只是几根很淡的线，不读成车轮；
      // 每根辐条接在环上的一个节点舱（直径约为环管的 3 倍的球），环的轮廓因此不再是一根均匀的管子
      float ph0 = hash12(vec2(float(k), 53.0)) * 6.2832;
      for (int j = 0; j < 8 + uLoopGuard; j++) {
        if (float(j) >= rg.w) break;
        float ps = ph0 + float(j) * 6.2832 / rg.w;
        float sps = sin(ps);
        vec2 end = vec2(rg.y * cos(ps), -b * rg.y * sps);
        float cs = wonderStrip(wonderSeg(vec2(X, yc), vec2(0.0), end) / wPix, 0.035 * rg.z / wPix);
        if (sps < 0.0) covSpokeN = max(covSpokeN, cs);
        else covSpokeF = max(covSpokeF, cs);
        // 节点舱大小不一（1.1–2.1 倍环管），有的位置空着（只有辐条）
        float hn = hash12(vec2(float(j) + 8.0 * float(k), 29.0));
        float rn = (1.1 + 1.0 * hn) * rg.z * step(0.25, hn);
        vec2 dn = vec2(X, yc) - end;
        float cn = wonderTentCdf((rn - length(dn)) / wPix);
        if (rn > 0.0 && cn > 0.0) {
          vec3 nn3 = (dn.x * nh + dn.y * uph) / rn;
          nn3 = normalize(nn3 - rd * sqrt(max(1.0 - dot(nn3, nn3), 0.0)) + 1e-6 * a);
          if (sps < 0.0) { if (cn > covRingN) { covRingN = cn; nRingN = nn3; segN = 1.0; } }
          else if (cn > covRingF) { covRingF = cn; nRingF = nn3; segF = 1.0; }
        }
      }
    }
  }

  // 这一高度上最远的东西离轴线多远：稳定缆（天梯塔顶以下）、云气（建木 9–34 km）、树冠与萤光（建木 46 km 以上）
  float reach = max(radius + haloPx * 3.0 * wPix, 4.0);
  if (tether) {
    if (s < H + 2.0) reach = 72.0;
    if (ringLamp >= 0.0) reach = 1e9;
  }
  else if (s > 46.0) reach = 46.0;
  else if (s > 9.0 && s < 34.0) reach = 40.0;
  if (dist > reach) return L;

  // 天梯的部件都画在真实位置、只靠物理的空气透视融进霾里；建木（W01b）保留「下半截沉进霾与云海」的写法——
  // 离地几公里以内被低空的霾层吞掉，不给看清基座（「看不到它从哪里来」）
  float sink = tether ? 1.0 : smoothstep(0.0, 9.0, s);
  float vis = visF * sink * sink;

  // 缆束 / 树干 + 撑杆（同一种材质）。天梯的缆束里是三根子缆（绕轴线 0.55 倍半径排开），近处看得见之间的缝；
  // 缆从塔顶里伸出来，塔顶以下不画
  float cov;
  if (tether) {
    float rs = 0.46 * radius;
    cov = 0.0;
    for (int j = 0; j < 3; j++) {
      float pj = float(j) * 2.0944 + 0.4;
      float oj = 0.55 * radius * dot(cos(pj) * e1 + sin(pj) * e2, nh);
      cov += wonderStrip((X - oj) / wPix, rs / wPix);
    }
    cov = min(cov, 1.0) * smoothstep(H - 1.0, H, s);
  } else {
    cov = wonderStrip(x, radius / wPix);
  }
  int nStrut = tether ? (s < H ? 6 : 0) : (s > 46.0 ? 9 : 0);
  float covS = 0.0;
  for (int i = 0; i < 9 + uLoopGuard; i++) {
    if (i >= nStrut) break;
    float fi = float(i);
    float h1 = hash12(vec2(fi, 11.0 + uWonderShape.z));
    float h2 = hash12(vec2(fi, 23.0 + uWonderShape.z));
    float h3 = hash12(vec2(fi, 37.0 + uWonderShape.z));
    float sa, sb, rA, rB, bend, thA, thB, phi;
    if (tether) {
      // 稳定缆：从塔顶边缘斜拉到 45–70 km 外的海上墩台，六根方位错开（夜里是塔两侧淡淡的「帐篷」）
      sa = 0.0;
      sb = H - 0.3;
      rA = 45.0 + 25.0 * h1;
      rB = uWonderTower.z;
      bend = 0.0;
      thA = 0.12;
      thB = 0.08;
      phi = uWonderTower.w + fi * 1.0472 + 0.5 + 0.3 * h2;
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

  // ---- 舱体 / 光团：上行、下行两条轨道，间隔不规则（有的格子空着）
  float sU = (floor((s - 0.055 * T) / 61.0 + 0.5)) * 61.0 + 0.055 * T;
  float kU = floor((s - 0.055 * T) / 61.0 + 0.5);
  float sD = (floor((s + 0.036 * T) / 83.0 + 0.5)) * 83.0 - 0.036 * T;
  float kD = floor((s + 0.036 * T) / 83.0 + 0.5);
  bool okU = hash12(vec2(kU, 5.3 + uWonderShape.z)) > 0.3 && sU > 7.0;
  bool okD = hash12(vec2(kD, 8.9 + uWonderShape.z)) > 0.45 && sD > 7.0;
  float sPod = okU ? sU : sD;
  if (okU && okD && abs(s - sD) < abs(s - sU)) sPod = sD;
  bool hasPod = okU || okD;

  if (tether) {
    // 什么都没盖到、也不在灯串 / 轮廓灯 / 环站灯附近：不查表
    float anyCov = covTower + covFinN + covFinF + covRingN + covRingF + covSpokeN + covSpokeF + cov + covS;
    // 缆的光晕（半宽约 15 像素）、灯串、舱体（贴在缆束外侧）都在轴线附近
    bool nearLamp = (dist < radius + 1.0 + 16.0 * wPix && s > H - 2.0) || ringLamp >= 0.0 || (s < H + 1.0 && dist < uWonderTower.y + 3.0 * wPix);
    if (anyCov <= 0.0 && !nearLamp) return L;
  }

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
  // 「背景 × 线前面空气的比例」只用来补月光那一路（太阳在 −12° 以下才生效）。黄昏太阳那一路交给空气透视 LUT：
  // 暮色里低处的天光多半来自奇观身后远处仍被照亮的高层空气，线前面近处的空气已在地影里，所以地影里的一段应是淡淡的剪影
  // （W01b 返工：原来黄昏也按几何比例补，树干 / 缆在地影里那段和天空一样亮，整棵树像悬在半空）
  float moonW = 1.0 - smoothstep(-0.21, -0.14, uSunDir.y);
  vec3 lFront = max(apL, L * frontFrac * moonW);
  // 太阳落到地平线以下后，地影里的那段按「挡住身后至少 22% 的天光」画成淡剪影，一路接到地平线的霾里
  // （否则被照亮的上段像悬在半空；白天不动，正午的样子不变）
  float duskW = 1.0 - smoothstep(-0.02, 0.06, uSunDir.y);
  lFront = mix(lFront, min(lFront, L * 0.78), duskW);
  // 亮度封顶（W01b 返工）：被照亮的部分最亮只到同方向天空的 1.3（贴地平线）–2 倍（高处）。
  // 暮色天空比阳光暗 4–5 个数量级，按物理算被照亮的缆 / 枝会截成一根过曝的光柱（像激光、霓虹灯），
  // 眼睛（和相机）看远处暮色里的亮物体也会被空气的散射光冲淡，这里直接按天空亮度封顶，保留色温
  vec3 Lbg = L;
  // 白天（太阳在地平线以上）放宽到 4 倍：正午的中继站、云气本来就只比天空亮一点，不受影响
  float capLum = mix(4.0, mix(1.3, 2.0, smoothstep(10.0, 150.0, s)), duskW) * wonderLum(Lbg);
  float capScale;
  // 白天（太阳在地平线以上约 −6° 起）用白色频闪，夜里用红色障碍灯
  float dayF = smoothstep(-0.10, 0.02, uSunDir.y);

  // ---- 点光源：累加「光强 × 像素权重」（kcd），最后统一换成辐亮度
  vec3 lamp = vec3(0.0);
  float tm = t * 1000.0;

  if (tether) {
    float phb = fract(T / 2.0);
    float blink = 0.1 + 0.9 * smoothstep(0.0, 0.12, phb) * (1.0 - smoothstep(0.4, 0.62, phb));
    // 远侧的扶壁、环站远侧的半圈与辐条（在缆和塔的后面）
    const vec3 CONCRETE = vec3(0.31, 0.30, 0.285);
    float capO;
    if (covFinF > 0.0) {
      vec3 Lf = CONCRETE / M_PI * wonderIrr(nFinF, a, eSun, eMoon, eSkyUp, eUp);
      L = mix(L, wonderCap(lFront + apT * Lf, Lbg, capLum, capO), covFinF * vis);
    }
    vec3 Lsp = 0.12 / M_PI * (eSun * 0.3 + 0.5 * (eSkyUp + eUp) + eMoon * 0.3);
    if (covSpokeF > 0.0) L = mix(L, wonderCap(lFront + apT * Lsp, Lbg, capLum, capO), covSpokeF * vis);
    if (covRingF > 0.0) {
      vec3 Lr = wonderRingAlb(nRingF, a) * segF / M_PI * wonderIrr(nRingF, a, eSun, eMoon, eSkyUp, eUp);
      L = mix(L, wonderCap(lFront + apT * Lr, Lbg, capLum, capO), covRingF * vis);
    }
    // 稳定缆 + 缆束
    float c = min(cov + covS, 1.0) * vis;
    L = mix(L, wonderCap(lFront + apT * Lt, Lbg, capLum, capScale), c);
    float lineW = min(2.0 * radius / wPix, 1.0);
    L += capScale * apT * direct * vis * lineW * 0.012 * exp(-x * x / (2.0 * haloPx * haloPx)) * step(H, s);
    // 舱体：贴在缆束两侧（上行在 e1 一侧、下行在 −e1 一侧），朝相机的那一侧挡在缆前面
    if (hasPod && sPod > H + 1.0 && uWonderShape.w > 0.5) {
      bool up = okU && (!okD || abs(s - sU) < abs(s - sD));
      vec3 off = (up ? e1 : -e1) * (radius + 0.45);
      float xo = (X - dot(off, nh)) / wPix;
      float so = s - dot(off, uph) / sn;
      if (abs(xo) < 0.6 / wPix + 2.0) {
        vec4 o = wonderSpheroid(w0 - off, rd, a, sPod, 0.4, 1.25, xo, so, wPix, sn, b, eSun, eMoon, eSkyUp, eUp, 0.4);
        float podVis = dot(off, rd) < 0.0 ? 1.0 : 1.0 - min(cov, 1.0);
        L = mix(L, wonderCap(lFront + apT * o.rgb, Lbg, capLum, capO), o.a * vis * podVis);
        lamp += vec3(1.0, 0.97, 0.92) * 6.0 * (1.0 - dayF) * podVis * wonderPoint(xo, (so - sPod) * sn / wPix);
      }
    }
    // 锚塔：粗野主义混凝土。受光面 / 背光面按太阳方向大块分明；面上只有横向施工缝（每 1.05 km）和竖向雨痕，
    // 都按像素足迹积分（远处平均成均匀的一层灰）。俯视时（b < 0）退台顶面朝上受光
    if (covTower > 0.0) {
      float hq = clamp(s, tierHit.x, tierHit.y);
      float rq = mix(tierHit.z, tierHit.w, (hq - tierHit.x) / max(tierHit.y - tierHit.x, 1e-3));
      float cphi = clamp(X / rq, -1.0, 1.0);
      float sphi = -sqrt(1.0 - cphi * cphi);
      // 竖肋：每 1.3 km 一道（三角波把法线绕轴线左右偏 ±0.35 rad），受光的弧面上是一条条明暗相间的竖纹——粗野主义立面的节奏。
      // 肋距不到约 3 像素（轮廓附近透视压缩、或很远）时幅度淡到 0，平均成均匀的一层
      float u = rq * acos(cphi);
      float fu = wPix / max(-sphi, 0.05);
      float ribP = 1.3;
      float tri = abs(fract(u / ribP + tierHit.x * 0.37) - 0.5) * 4.0 - 1.0;
      float dAz = 0.35 * tri * (1.0 - smoothstep(0.2, 0.45, fu / ribP));
      float ca = cos(dAz), sa2 = sin(dAz);
      vec3 radial = cphi * nh + sphi * mh;
      vec3 tang = cross(a, radial);
      vec3 nW = normalize(radial * ca + tang * sa2 + a * (tierHit.z - tierHit.w) / max(tierHit.y - tierHit.x, 1e-3));
      float capF = 0.0;
      if (b < 0.0) {
        float yN = sn * tierHit.y - ab * sqrt(max(tierHit.w * tierHit.w - X * X, 0.0));
        capF = clamp((Y - yN) / wPix + 0.5, 0.0, 1.0);
      }
      vec3 nT = normalize(mix(nW, a, capF));
      // 纹理：每 2.1 km 一道内凹的楼板缝（暗 35%）、雨痕（沿方位的噪声，竖向拉长）、大块的面板色差。都按像素足迹积分 / 在轮廓附近淡掉
      float fh = wPix / sn;
      float joint = wonderBands(hq, fh, 2.1, 0.28);
      float streak = (vnoise(vec2(u / 0.6, hq / 6.0)) - 0.5) * (1.0 - smoothstep(0.25, 0.6, fu));
      float panel = vnoise(vec2(u / 3.0 + float(tierHit.x), hq / 4.0)) - 0.5;
      vec3 alb = CONCRETE * (1.0 - 0.35 * joint * (1.0 - capF) + 0.14 * streak + 0.12 * panel);
      vec3 Lw = alb / M_PI * wonderIrr(nT, a, eSun, eMoon, eSkyUp, eUp);
      // 塔身灯格（开发者开关，默认关）：楼层 0.3 km 一层、窗带占 40%，按像素足迹积分成暗暖色横纹；按 1.2 km × 1.6 km 的块随机亮灭
      if (uWonderSky.w > 0.5) {
        float fl = wonderBands(hq, fh, 0.3, 0.12);
        float lit = step(0.55, hash12(vec2(floor(hq / 1.2), floor(u / 1.6) + 17.0)));
        Lw += vec3(1.0, 0.72, 0.45) * 2.5e-4 * fl * lit * (1.0 - capF) * (1.0 - dayF) * smoothstep(1.0, 3.0, hq);
      }
      L = mix(L, wonderCap(lFront + apT * Lw, Lbg, capLum, capO), covTower * vis);
    }
    // 近侧的扶壁、环站近侧的半圈与辐条（挡在缆和塔的前面）
    if (covFinN > 0.0) {
      vec3 Lf = CONCRETE / M_PI * wonderIrr(nFinN, a, eSun, eMoon, eSkyUp, eUp);
      L = mix(L, wonderCap(lFront + apT * Lf, Lbg, capLum, capO), covFinN * vis);
    }
    if (covSpokeN > 0.0) L = mix(L, wonderCap(lFront + apT * Lsp, Lbg, capLum, capO), covSpokeN * vis);
    if (covRingN > 0.0) {
      vec3 Lr = wonderRingAlb(nRingN, a) * segN / M_PI * wonderIrr(nRingN, a, eSun, eMoon, eSkyUp, eUp);
      L = mix(L, wonderCap(lFront + apT * Lr, Lbg, capLum, capO), covRingN * vis);
    }
    gWonderCov = min(max(max(covTower, max(covFinN, covFinF)), max(max(covRingN, covRingF), min(cov + covS, 1.0))), 1.0) * vis;
    gWonderT = t;

    if (uWonderShape.w > 0.5) {
      // 缆上的红色障碍灯：塔顶以上每 30 km 一盏，全部同步慢闪（2 s 一次，像白炽灯一样缓起缓落），常亮底 10%
      float kb = max(floor(s / 30.0 + 0.5), ceil(H / 30.0));
      float dyb = (s - kb * 30.0) * sn / wPix;
      lamp += vec3(1.0, 0.08, 0.03) * 130.0 * blink * (1.0 - dayF) * wonderPoint(x, dyb);
      // 缆上的暗白灯串：每 2 km 一盏（和红灯重合的那盏让给红灯）；一道道光脉冲以 2 km/s 往上爬（每 45 km 一道）。
      // 灯距不到 3 像素（很高很远处）时换成等能量的连续细线，不逐盏画（否则会漏掉邻灯、按帧闪）
      if (s > H + 0.5) {
        float kw = floor(s / 2.0 + 0.5);
        float spacing = 2.0 * sn / wPix;
        float dyw = (s - kw * 2.0) * sn / wPix;
        float ph = fract((s - 2.0 * T) / 45.0);
        float pulse = exp(-(ph - 0.5) * (ph - 0.5) * 45.0 * 45.0 / 6.0);
        float notRed = step(0.5, abs(mod(kw, 15.0) - 0.0)) ;
        float dense = smoothstep(3.0, 1.5, spacing);
        float wStr = mix(wonderPoint(x, dyw) * notRed, max(0.0, 1.0 - abs(x)) / max(spacing, 1e-3), dense);
        lamp += vec3(0.85, 0.9, 1.0) * 2.5 * (1.0 + 12.0 * pulse) * (1.0 - dayF) * wStr;
      }
      // 锚塔：每级退台朝相机那一圈的轮廓灯（每 0.8 km 一盏，暖白、很暗），塔顶两角各一盏同步慢闪的红灯
      if (s < H + 1.0 && dist < uWonderTower.y + 3.0 * wPix) {
        for (int k = 0; k < 4 + uLoopGuard; k++) {
          if (float(k) >= uWonderSky.x) break;
          vec4 tr = uWonderTiers[k];
          float Rt = tr.w;
          if (abs(X) > Rt + 2.0 * wPix) continue;
          float yRim = sn * tr.y + b * sqrt(max(Rt * Rt - X * X, 0.0));
          if (abs(Y - yRim) > 3.0 * wPix) continue;
          float dph = 0.8 / Rt;
          float phiP = -acos(clamp(X / Rt, -1.0, 1.0));
          float j0 = floor(phiP / dph + 0.5);
          for (int jj = -1; jj <= 1; jj++) {
            float pj = (j0 + float(jj)) * dph;
            if (pj > 0.0 || pj < -3.1416) continue;
            vec2 lp = vec2(Rt * cos(pj), sn * tr.y - b * Rt * sin(pj));
            float on = step(0.25, hash12(vec2(j0 + float(jj), float(k) + 31.0)));
            lamp += vec3(1.0, 0.8, 0.58) * 2.5 * on * (1.0 - dayF) * wonderPoint((X - lp.x) / wPix, (Y - lp.y) / wPix);
          }
        }
        vec2 topL = vec2(uWonderTower.z * 0.97, sn * H);
        float wTop = wonderPoint((abs(X) - topL.x) / wPix, (Y - topL.y) / wPix) + wonderPoint(x, (Y - topL.y) / wPix);
        lamp += vec3(1.0, 0.08, 0.03) * 60.0 * blink * (1.0 - dayF) * wTop;
      }
      // 环站两端：夜里是常亮的暖白微光（有人住）；白天是高强度白色频闪，从下往上依次闪（4 s 一轮）
      if (ringLamp >= 0.0) {
        vec4 rg = uWonderRings[int(ringLamp)];
        float wEnds = wonderPoint((abs(X) - rg.y) / wPix, (Y - sn * rg.x) / wPix);
        float ph = fract(T / 4.0 - ringLamp * 0.09);
        float strobe = exp(-ph * ph / 0.0009);
        lamp += vec3(1.0, 0.93, 0.8) * (6.0 * (1.0 - dayF) + 8e4 * dayF * strobe) * wEnds;
      }
    }
    // 光强（kcd）→ 相机处照度（klux）= I / 距离²（m），再除以一个像素的立体角得到辐亮度
    L += apT * lamp * vis / (tm * tm * pixelAngle * pixelAngle);
    return L;
  }

  // ---- 建木（W01b，WS01 没动它）
  float c = min(cov + covS, 1.0) * vis;
  L = mix(L, wonderCap(lFront + apT * Lt, Lbg, capLum, capScale), c);

  // 光晕：被照亮的那段在空气里的一点前向散射（能量按线的覆盖宽度折算，很弱，只在暮色、夜里的暗背景上看得出）
  float lineW = min(2.0 * radius / wPix, 1.0);
  L += capScale * apT * direct * vis * lineW * 0.012 * exp(-x * x / (2.0 * haloPx * haloPx));

  // 云气缭绕。树干上挂着三圈云（约 12–30 km，间隔不规则），每圈是绕着树干的一道云环，远看是横在树干上、
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
    float capC;
    L = mix(L, wonderCap(lFront + apT * Lc, Lbg, capLum, capC), (1.0 - exp(-tau)) * visF);
  }
  // 众帝上下：沿树干升降的暖色光团（夜里才看得见）
  if (hasPod) lamp += vec3(1.0, 0.8, 0.5) * 40.0 * (1.0 - dayF) * wonderPoint(x, (s - sPod) * sn / wPix);
  // 萤光（黄实）：树冠一带稀疏的金色光点，格子 2.6 km × 3.4 km，缓慢上飘；夜里明灭的微光，白天偶尔被阳光照到闪一下
  if (s > 45.0 && s < 240.0) {
    float sd = s - 0.004 * T;
    vec2 cell = floor(vec2(X / 2.6, sd / 3.4));
    vec2 hc = hash22(cell + 71.0);
    float near = exp(-abs(cell.x * 2.6) / 14.0) * smoothstep(45.0, 70.0, s);
    if (hc.x < 0.2 * near) {
      vec2 pc = (cell + 0.5 + (hc - 0.5) * 0.5) * vec2(2.6, 3.4);
      float tw = 0.5 + 0.5 * sin(T * (0.5 + hc.y) + hc.x * 40.0);
      float spark = pow(max(sin(T * (0.3 + 0.5 * hc.y) + hc.y * 60.0), 0.0), 24.0);
      vec3 glow = vec3(1.0, 0.78, 0.4) * (6.0 * tw * tw * (1.0 - dayF) + 6e5 * spark * dot(tS, vec3(0.333)));
      lamp += glow * wonderPoint(x - pc.x / wPix, (sd - pc.y) * sn / wPix);
    }
  }
  // 光强（kcd）→ 相机处照度（klux）= I / 距离²（m），再除以一个像素的立体角得到辐亮度
  L += apT * lamp * vis / (tm * tm * pixelAngle * pixelAngle);
  return L;
}
`;
