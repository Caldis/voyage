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
 * 朝相机的半圈在 b > 0（仰视）时是上半个椭圆，俯视时是下半个。锚塔、环站、灯都按这一条换算。
 *
 * 天梯（skin 0，致敬《流浪地球 2》太空电梯；WS01 巨构化，尺寸由 wonders/tether-shape.ts 按种子随机）：
 * - 锚塔：30–40 km 高、3–4 级退台的截锥（底宽 14–18 km），粗野主义混凝土（反照率约 0.3，受光面 / 背光面大块明暗），
 *   面上是竖肋、横向楼板缝和竖向雨痕（按像素足迹积分，远处平均掉）；9.5–12.5 km 处挂着一圈顺风拖长的旗云。
 *   比雷暴云顶高一倍：窗里是一整块实心的体量，塔顶高过视平线约 8°，脚埋在地平线的霾里。
 * - 缆束：直径约 2 km，里面 3 根子缆（近处看得见之间的缝），300 km 以上收到一半。
 * - 环形站：3–5 只（环半径 12–35 km、环管 1–3 km，环上 4–8 个大小不一的节点舱）；从下面仰看是横在天上的扁椭圆，
 *   近侧的半圈挡在缆前面、远侧的在缆后面。
 * - 稳定缆：从塔顶斜拉到 45–70 km 外海上的六根细线（夜里是塔两侧淡淡的「帐篷」）。
 * - 舱体：上行 / 下行两条轨道，贴在缆束两侧，约 200 / 130 km/h；0.8 km 粗的舱在 2 km 的缆束边上看不出形状，只在夜里画它的航行灯。
 * - 夜灯（按用户「极简」的取向，放大不等于点亮）：缆上每 30 km 一盏红色障碍灯全部同步慢闪（保留）；
 *   缆上每 2 km 一盏暗白灯，每隔约 20 s 有一道光脉冲以约 2 km/s 往上爬（一分钟左右爬出窗口，用时间给出尺度）；
 *   锚塔每级退台朝相机的一圈轮廓灯（描出体量）；塔顶红灯同步慢闪。塔身灯格是开发者开关（uWonderSky.w，默认关）。
 *   白天：环站两端高强度白色频闪，从下往上依次闪（真实高塔白天白闪、夜里红闪）。
 * - 云的前后：塔在 200–260 km 外，比它远的云要排到它后面（outside-pass.ts 按 gWonderCov / gWonderT 调 cloudBeforeGround）。
 * 建木（skin 1，《淮南子·地形训》「众帝所自上下」、《山海经》「百仞无枝，上有九欘，下有九枸」「青叶紫茎，玄华黄实」；
 * WS05 巨构化，尺寸按种子（uWonderShape.w = −种子）在着色器里取）：
 * - 树干：底部直径 6–8 km（一座山那样粗），近乎直线收分到树冠处 2.4–3.4 km，笔直无枝；树皮三级细节（轮廓 → 竖向深棱 → 树皮板块）。
 * - 九枸（板根）：九片板状巨根，贴着树干处高 7–15 km、往外越来越低，在 18–40 km 外没入脚下的云海（像面上精确反解）。
 * - 九欘：48–62 km 起分三层的瓶形巨枝，枝梢托着 8–15 km 的扁椭球叶盘（层层的古松），第九根是托起树顶的顶枝；树冠出画。
 * - 云：脚下一圈 48 km 的云海（真实的平板求交，挡住比它远的实体部分）；8–24 km 树干上三圈云环（云气缭绕）。
 * - 夜里：几乎是一整片剪影（遮住星空），只有叶盘里极弱的金色光点（黄实）和沿树干升降的暖色光团（众帝上下）。
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
 * 重函数（透射率 / 辐照度 / 空气透视查表）各只算一次、各部分共用；天梯先算各部件的几何覆盖率，再统一着色合成。
 * 循环（撑杆、退台、环站、节点舱）上界都写成「常数 + uLoopGuard」，FXC 不展开。
 */
/**
 * 开发者开关（WS01）：塔身灯格。URL 带 `?towerwin` 时才编进窗外 OW 变体，再用 `__voyage.wonders.tetherWindows = true` 打开。
 * 默认不编：这一小段会让 OW 变体的离线 FXC 多约 9%，而它默认是关的（用户按「关 / 开」对照图拍板之后再决定要不要常驻）。
 */
const TOWER_WINDOWS = typeof location !== "undefined" && new URLSearchParams(location.search).has("towerwin");
const TOWER_WINDOWS_GLSL = TOWER_WINDOWS
  ? /* glsl */ `
      // 塔身灯格（开发者开关，默认关）：楼层 0.3 km 一层、窗带占 40%，按像素足迹积分成暗暖色横纹；
      // 按 0.6 km × 0.8 km 的小块随机亮灭、亮度各不相同（约三成亮着），块的亮度再用一层低频噪声调成一片片（不是规则棋盘）
      if (uWonderSky.w > 0.5) {
        float fl = wonderBands(hq, fh, 0.3, 0.12);
        float hb2 = hash12(vec2(floor(hq / 0.6), floor(u / 0.8) + 17.0));
        float lit = smoothstep(0.62, 0.8, hb2 * (0.55 + 0.9 * vnoise(vec2(u / 4.0, hq / 3.0))));
        Lw += vec3(1.0, 0.72, 0.45) * 2.0e-4 * fl * lit * (0.5 + hb2) * (1.0 - capF) * (1.0 - dayF) * smoothstep(1.0, 3.0, hq);
      }`
  : "";

export const WONDER_SKY_COMMON = /* glsl */ `
uniform float uWonderOn;     // 1 = 有天幕层奇观要画（奇观模式开着且有奇观在场），0 = 整段早退
uniform vec3 uWonderAxis;    // 轴线方向：地心 → 基座（窗外坐标，单位向量）
uniform vec4 uWonderShape;   // x = 底部半径（km），y = 可见前沿高度（km，浮现编排用），z = 皮肤（0 天梯 / 1 建木），w = 航标灯与舱体 0/1
uniform vec3 uWonderAlbedo;  // 表面反照率
// 天梯的巨构尺寸（WS01，wonders/tether-shape.ts 按种子生成）
uniform vec4 uWonderSky;       // x 退台级数、y 环站个数、w 塔身灯格（开发者开关 0/1，要 URL 带 ?towerwin 才编进来）
uniform vec4 uWonderTower;     // x 塔高、y 底半径、z 顶半径（km）、w 方位起点（弧度）
uniform vec4 uWonderTiers[4];  // 每级退台：底高、顶高、底半径、顶半径（km）
uniform vec4 uWonderRings[5];  // 每只环站：中心高度、环半径、环管半径（km）、节点舱位置数

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

float wonderLum(vec3 v) { return dot(v, vec3(0.2126, 0.7152, 0.0722)); }

// 奇观表面（满覆盖时）的辐亮度封顶（W01b 返工）：亮度不超过同方向天空（背景）的 capLum，保留色相；
// 也不比背景暗过 40%（地影里的一段是略暗于天空的剪影，而不是一道黑缝）。scale 返回封顶的比例（光晕跟着缩）
vec3 wonderCap(vec3 v, vec3 bg, float capLum, out float scale) {
  scale = min(1.0, capLum / max(wonderLum(v), 1e-9));
  return max(v * scale, bg * 0.6);
}
// 同上，但封顶的比例按「这个部件最亮时」vRef 定、整个部件共用（WS05）：逐像素各自封顶会把受光面和背光面压成同一个亮度，
// 暮色里被照亮的大块叶盘 / 树干就成了一片平涂的剪纸；共用一个比例，明暗关系保留
vec3 wonderCapRef(vec3 v, vec3 vRef, vec3 bg, float capLum) {
  return max(v * min(1.0, capLum / max(wonderLum(vRef), 1e-9)), bg * 0.6);
}

// 从轴线伸出去的一根「撑杆」（天梯的稳定缆 / 建木的枝）：在水平方位 h（垂直于轴线的单位向量）上，
// 高度 σ ∈ [sa, sb] 处离轴线 r(σ) = rA + (rB − rA)·g(u)，u = (σ − sa)/(sb − sa)，g(u) = u + bend·u·(1 − u)
// （bend = 0 直线；bend = 1 时根部斜着长出、梢部转成竖直，导数处处有限），半径从 thA 渐变到 thB（km）。
// 像面上：横向 X_Q = r·(h·n̂)，纵向 = sn·(σ − k·r)（k = b·(h·rd)/sn²，h 有朝向相机的分量时看起来会偏高 / 偏低）。
// 解出和本像素同一纵向位置的 σ（牛顿法两步），返回像素覆盖率。
// WS05：另外输出横向距离 perpO（km，按两端截住的 u 算）和没截住的 uO（建木的叶簇要知道像素离枝多远、在枝的哪一段、有没有越过枝梢）
float wonderStrut(float X, float s, float sn, float b, vec3 nh, vec3 rd, vec3 h, float wPix,
                  float sa, float sb, float rA, float rB, float bend, float thA, float thB, out float perpO, out float uO) {
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
  uO = (sig - sa) / span;
  float u = clamp(uO, 0.0, 1.0);
  float r = rA + (rB - rA) * (u + bend * u * (1.0 - u));
  float dr = (rB - rA) * (1.0 + bend * (1.0 - 2.0 * u)) / span;
  float m = dr * hx / (sn * (1.0 - k * dr));
  perpO = abs(X - r * hx) * inversesqrt(1.0 + m * m);
  // 牛顿法没收敛（WS05：仰看时朝着 / 背着相机伸的长枝 k 很大，两步解不出来）就当没打中，
  // 否则会在天上画出横贯窗口的假弧线；天梯的稳定缆是直线（bend = 0），一步就精确，不受影响
  float res = abs(sig - s - k * r) * sn;
  return (u == uO && res < 2.0 * wPix) ? wonderStrip(perpO / wPix, mix(thA, thB, u) / wPix) : 0.0;
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

// 锚塔的混凝土（反照率约 0.3，略偏暖，不做高光）
const vec3 WONDER_CONCRETE = vec3(0.31, 0.30, 0.285);

// ---- WS05 建木巨构的小工具
// 树干半径（km）随高度：J = (r0 底部半径, rTop 树冠处半径, sCrown 第一根枝的高度, sTip 树梢)。
// 下粗上细（(1 − u)^1.15，接近直线收分：一根笔直的巨柱，不是细杆），脚下再加一圈往外张的根颈（接进板根）；
// 树冠以上继续收到树梢。drO 返回 dr/ds（法线往上仰多少）
float jmTrunkR(float s, vec4 J, out float drO) {
  float u = clamp(s / J.z, 0.0, 1.0);
  float fl = J.x * 0.4 * exp(-max(s, 0.0) / 2.5);
  float r = J.y + (J.x - J.y) * pow(1.0 - u, 1.15) + fl;
  drO = -(J.x - J.y) * 1.15 * pow(max(1.0 - u, 1e-3), 0.15) / J.z - fl / 2.5;
  if (s > J.z) {
    float v = clamp((s - J.z) / (J.w - J.z), 0.0, 1.0);
    r = J.y * sqrt(1.0 - v);
    drO = -0.5 * J.y / (sqrt(max(1.0 - v, 1e-3)) * (J.w - J.z));
  }
  return r;
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
  // 建木（WS05）的板根伸到 18–40 km 外、脚下还有一片 50 km 的云海：各部件自己按深度和地面比，这里只挡「整棵树都在地面后面」
  float tNear = tether ? t - uWonderTower.y - 1.0 : t - 50.0;
  if (t <= 0.0 || tNear > tLimit || s < (tether ? -1.5 : -4.0)) return L;

  float pixelAngle = 2.0 * uTanHalfFov / uResolution.y;
  float wPix = t * pixelAngle;                   // 一个像素在那个距离上有多宽（km）
  // 越往上越细（天梯的缆束 150–350 km 收到一半）
  // 建木（WS05）的尺寸按每次出现的种子（uWonderShape.w = −种子）取：J = 底部半径 3–4 km（直径 6–8 km，「一座山那样粗」）、
  // 树冠处 1.2–1.7 km、第一根枝在 48–62 km、树梢再高 44–54 km（窗里只看得到树冠以下，树梢总在画外）
  float jSeed = -uWonderShape.w;
  vec4 J = vec4(3.0 + 1.0 * hash12(vec2(jSeed * 91.7, 1.3)), 1.2 + 0.5 * hash12(vec2(jSeed * 91.7, 2.9)), 48.0 + 14.0 * hash12(vec2(jSeed * 91.7, 4.1)), 0.0);
  J.w = J.z + 44.0 + 10.0 * hash12(vec2(jSeed * 91.7, 5.7));
  float jDr;
  float radius = tether ? uWonderShape.x * mix(1.0, 0.5, smoothstep(150.0, 350.0, s)) : jmTrunkR(s, J, jDr);
  float haloPx = 5.0;
  float x = X / wPix;                            // 横向像素偏移（有符号）
  float T = uTime;
  // 水平面上的两个正交方向（撑杆的方位、面板的方位用）
  vec3 e1 = normalize(cross(vec3(0.0, 0.0, 1.0), a));
  vec3 e2 = cross(a, e1);
  // 可见前沿（浮现 / 退场的编排）：前沿以上是长渐变，不是硬边
  float front = uWonderShape.y;
  float visF = (1.0 - smoothstep(0.35 * front, front, s)) * (tether ? smoothstep(-1.5, 0.0, s) : 1.0);
  if (visF <= 0.0) return L;

  // ---- 天梯：先只算几何覆盖率（锚塔、缆束、环站、稳定缆），什么都没盖到、附近也没有灯就直接返回（不查表）
  float Y = s * sn;                              // 本像素在像面上的纵坐标（km）
  float ab = abs(b);
  vec3 mh = (rd - a * b) / sn;                   // 水平面里「沿视线往远处」的单位向量（像面的深度方向）
  vec3 uph = (a - rd * b) / sn;                  // 像面纵轴
  float H = uWonderTower.x;
  float covTower = 0.0;
  vec4 tierHit = uWonderTiers[0];
  // 环站（环管 + 节点舱）：只留覆盖率最大的那个部件（xyz 法线、w 覆盖率），partM = 舱段接缝的明暗，
  // partFar = 在环的远侧（画在缆后面）。着色只有一个调用点（冷编译：FXC 按调用点整份内联）
  vec4 partL = vec4(0.0);
  float partM = 1.0;
  bool partFar = false;
  float ringLamp = -1.0;                         // 离本像素最近的环站编号（灯用）
  vec4 ringHit = vec4(0.0);                      // 那只环站的参数（在循环里存下，不在循环外按编号动态取 uniform 数组：FXC 冷编译 −9%）
  float rimW = 0.0;                              // 退台轮廓灯的像素权重（夜里用）
  if (tether) {
    // 锚塔：各级退台的覆盖率相加（相邻两级在接缝处各 0.5，加起来正好 1，不会有细缝）；
    // 顺带算每级退台朝相机那一圈的轮廓灯（每 0.8 km 一盏，只取离本像素最近的一盏，四分之一的位置空着）
    if (s < H + 3.0 && dist < uWonderTower.y + 3.0 * wPix) {
      float cMax = 0.0;
      for (int k = 0; k < 4 + uLoopGuard; k++) {
        if (float(k) >= uWonderSky.x) break;
        vec4 tr = uWonderTiers[k];
        float ck = wonderFrustum(X, Y, sn, ab, wPix, tr);
        covTower += ck;
        if (ck > cMax) { cMax = ck; tierHit = tr; }
        float Rt = tr.w;
        float yRim = sn * tr.y + b * sqrt(max(Rt * Rt - X * X, 0.0));
        if (abs(X) < Rt + 2.0 * wPix && abs(Y - yRim) < 3.0 * wPix) {
          float dph = 0.8 / Rt;
          float j0 = floor(-acos(clamp(X / Rt, -1.0, 1.0)) / dph + 0.5);
          float pj = j0 * dph;
          float on = step(0.25, hash12(vec2(j0, float(k) + 31.0)));
          rimW += on * wonderPoint((X - Rt * cos(pj)) / wPix, (Y - sn * tr.y + b * Rt * sin(pj)) / wPix);
        }
      }
      covTower = min(covTower, 1.0);
    }
    // （研究里的放射状扶壁没做：220 km 外塔脚埋在霾和近处的云海后面，扶壁几乎看不出来，却让这个变体的离线 FXC 多约 8%）
    // 环形站：环的中心线在像面上是椭圆（横半轴 R、纵半轴 |b|R），环管是它两侧 rt 以内的带
    for (int k = 0; k < 5 + uLoopGuard; k++) {
      if (float(k) >= uWonderSky.y) break;
      vec4 rg = uWonderRings[k];
      float yc = Y - sn * rg.x;
      float Bv = max(ab, 0.03) * rg.y;
      float m2 = 2.2 * rg.z + 2.0 * wPix;
      if (abs(X) > rg.y + m2 || abs(yc) > Bv + m2) continue;
      ringLamp = float(k);
      ringHit = rg;
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
      if (cr > partL.w) { partL = vec4(nr, cr); partM = seg; partFar = sphi >= 0.0; }
      // 节点舱：环上 4–8 个大小不一的球形舱（1.1–2.1 倍环管，有的位置空着），环的轮廓因此不再是一根均匀的管子。
      // 接到缆上的辐条（张拉索）在 200 km 外细到看不见，不画——画出来就是一只自行车轮
      float ph0 = hash12(vec2(float(k), 53.0)) * 6.2832;
      for (int j = 0; j < 8 + uLoopGuard; j++) {
        if (float(j) >= rg.w) break;
        float ps = ph0 + float(j) * 6.2832 / rg.w;
        float sps = sin(ps);
        float hn = hash12(vec2(float(j) + 8.0 * float(k), 29.0));
        float rn = (1.1 + 1.0 * hn) * rg.z;
        vec2 dn = vec2(X, yc) - vec2(rg.y * cos(ps), -b * rg.y * sps);
        float cn = hn > 0.25 ? wonderTentCdf((rn - length(dn)) / wPix) : 0.0;
        if (cn > partL.w) {
          vec3 nn3 = (dn.x * nh + dn.y * uph) / rn;
          partL = vec4(normalize(nn3 - rd * sqrt(max(1.0 - dot(nn3, nn3), 0.0)) + 1e-6 * a), cn);
          partM = 1.0;
          partFar = sps >= 0.0;
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
  // 建木（WS05）：树冠（枝伸出 38–88 km、叶簇再宽几 km）、板根与脚下的云海（50 km）、树干上的云环（45 km）
  else if (s > J.z - 12.0) reach = 96.0;
  else if (s < 16.0) reach = 52.0;
  else if (s < 30.0) reach = 45.0;
  if (dist > reach) return L;

  // 部件都画在真实位置，只靠物理的空气透视融进霾里（WS05 起建木也一样：脚埋进它自己的云海和近处的真实云里，
  // 不再用「下半截整段淡掉」的写法——那样 5–8 km 粗的树干会像悬在半空）
  float vis = visF;

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
  // 建木的九欘（枝）与叶簇：按枝在树干前 / 后分两层（前面的盖住树干，后面的被树干挡住）
  float woodF = 0.0, woodB = 0.0, folF = 0.0, folB = 0.0;
  vec4 folN = vec4(0.0);                         // 盖得最多的那团叶簇的法线（xyz）与覆盖率（w）
  int nStrut = tether ? (s < H ? 6 : 0) : (s > J.z - 12.0 ? 9 : 0);
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
      // 九欘（WS05 放大）：前八根分三层（3 + 3 + 2），层距约 16 km。枝先贴着树干往上、再往外张开（瓶形的冠，bend < 0），
      // 梢端伸出 20–50 km（下层长、上层短，像一棵层层的松），根部粗约 1 km、梢部 0.14 km；每层方位错开再加随机（按种子）。
      // 第九根是顶枝：顺着树干直上，托起树顶的那片叶盘（树梢藏在里面，不露出一根针尖）
      float tier = floor(fi / 3.0);
      float hs = hash12(vec2(jSeed * 91.7 + fi, 8.3));
      sa = J.z + tier * 16.0 + 4.0 * (h1 - 0.5);
      sb = sa + 15.0 + 12.0 * h2;
      rA = 0.0;
      rB = (48.0 - 10.0 * tier) * (0.72 + 0.5 * h3);
      bend = -0.5;
      thA = 0.25 + 0.55 * J.y;
      thB = 0.14;
      phi = 6.2832 * jSeed + tier * 1.05 + mod(fi, 3.0) * 2.0944 + 0.7 * (hs - 0.5);
      if (i == 8) {
        sa = J.w - 12.0;
        sb = J.w + 2.0;
        rB = 2.0 + 3.0 * h3;
        bend = 0.0;
        thA = 0.5 * J.y;
      }
    }
    vec3 h = cos(phi) * e1 + sin(phi) * e2;
    float perpS, uS;
    float cs = wonderStrut(X, s, sn, b, nh, rd, h, wPix, sa, sb, rA, rB, bend, thA, thB, perpS, uS);
    covS += cs;
    if (!tether) {
      // 叶盘（青叶）：每根枝梢托着一片平展的叶盘——主盘半径 8–15 km、厚 1.5–3 km 的扁椭球，两侧各一个小一号的副盘
      // （层层的「云盖」，像画里的古松）。扁椭球投到像面上是椭圆：横半轴 R、纵半轴 √(R²b² + T²sn²)，
      // 从下面仰看是一片横在天上的扁椭圆、看得见底面。边缘被噪声啃过，中间按噪声透出几处天（稀疏的冠）；
      // 法线按椭球补出来，顶面受光、底面暗，不是剪纸
      vec3 hp = cross(a, h);
      bool back = dot(h, rd) > 0.0;
      float R0 = 8.0 + 7.0 * hash12(vec2(jSeed * 91.7 + fi, 41.9));
      for (int m = 0; m < 3 + uLoopGuard; m++) {
        float fm = float(m);
        float hb = hash12(vec2(jSeed * 91.7 + fi * 7.0 + fm, 31.3));
        float side = fm < 0.5 ? 0.0 : (fm < 1.5 ? 1.0 : -1.0);
        float Rp = R0 * (m == 0 ? 1.0 : 0.5 + 0.2 * hb);
        float Tp = 1.5 + 1.5 * hb;
        vec3 C = a * (sb + side * (2.5 * hb - 1.5)) + h * (rB - abs(side) * 0.3 * R0) + hp * side * (0.55 + 0.25 * hb) * R0;
        float dx = X - dot(C, nh);
        float dy = Y - dot(C, uph);
        float Bv = sqrt(Rp * Rp * b * b + Tp * Tp * sn * sn);
        if (abs(dx) > 1.3 * Rp || abs(dy) > 1.3 * Bv) continue;
        vec2 el = vec2(dx / Rp, dy / Bv);
        float q = length(el);
        vec2 pn = vec2(dx, dy * Rp / Bv);
        float nq = vnoise(pn / (0.28 * Rp) + vec2(fi * 3.1, fm * 5.7));
        float qn = 0.8 + 0.35 * nq;
        float gq = length(vec2(el.x / Rp, el.y / Bv)) / max(q, 1e-3);
        // 透天的空当只在外圈（中间是实的一团）：否则满盘圆洞，像一块奶酪
        float cf = wonderTentCdf((qn - q) / max(gq * wPix, 1e-4)) * smoothstep(0.1, 0.4, nq + 1.3 * (0.8 - q));
        if (cf > folN.w) {
          float ez = sqrt(max(1.0 - dot(el, el), 0.0));
          vec3 nb = el.x * nh + el.y * uph - ez * rd;
          folN = vec4(normalize(nb + a * dot(nb, a) * (Rp / Tp - 1.0) * 0.4), cf);
        }
        if (back) folB += cf; else folF += cf;
      }
      if (back) woodB += cs; else woodF += cs;
    }
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

  // 天梯锚塔的旗云所在的高度（9.5–12.5 km，按方位种子取）与范围
  float hbSeed = fract(uWonderTower.w * 0.371);
  float hb = 9.5 + 3.0 * hbSeed;
  bool inBanner = tether && abs(s - hb) < 4.0 && dist < 45.0;
  float cc = 0.0;
  // （试过在这里「什么都没盖到就不查表、提前返回」：省的是塔两侧稳定缆那片空白像素的几次查表，GPU 上量不出来，
  //  却让 OW 变体的离线 FXC 多约 10%，撤了）

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
    // 环站：远侧的半圈画在缆的后面，近侧的画在前面；着色只算一次
    float capO;
    vec3 Lp = wonderCap(lFront + apT * wonderRingAlb(partL.xyz, a) * partM / M_PI * wonderIrr(partL.xyz, a, eSun, eMoon, eSkyUp, eUp), Lbg, capLum, capO);
    if (partFar) L = mix(L, Lp, partL.w * vis);
    // 稳定缆 + 缆束
    float c = min(cov + covS, 1.0) * vis;
    L = mix(L, wonderCap(lFront + apT * Lt, Lbg, capLum, capScale), c);
    float lineW = min(2.0 * radius / wPix, 1.0);
    L += capScale * apT * direct * vis * lineW * 0.012 * exp(-x * x / (2.0 * haloPx * haloPx)) * step(H, s);
    // 舱体：缆束已有 2 km 粗，0.8 km 的舱贴在侧面在 220 km 外只是缆边上一个凸起，白天不单独画；
    // 夜里是贴在缆束两侧（上行在 e1 一侧、下行在 −e1 一侧）的一点白色航行灯，背向相机的那侧被缆挡住
    if (hasPod && sPod > H + 1.0 && uWonderShape.w > 0.5) {
      bool up = okU && (!okD || abs(s - sU) < abs(s - sD));
      vec3 off = (up ? e1 : -e1) * (radius + 0.45);
      float podVis = dot(off, rd) < 0.0 ? 1.0 : 1.0 - min(cov, 1.0);
      lamp += vec3(1.0, 0.97, 0.92) * 6.0 * (1.0 - dayF) * podVis * wonderPoint((X - dot(off, nh)) / wPix, (s - dot(off, uph) / sn - sPod) * sn / wPix);
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
      float streak = (vnoise(vec2(u / 0.9 + tierHit.x, hq / 5.0)) - 0.5) * (1.0 - smoothstep(0.3, 0.8, fu));
      vec3 alb = WONDER_CONCRETE * (1.0 - 0.35 * joint * (1.0 - capF) + 0.22 * streak);
      vec3 Lw = alb / M_PI * wonderIrr(nT, a, eSun, eMoon, eSkyUp, eUp);
${TOWER_WINDOWS_GLSL}
      L = mix(L, wonderCap(lFront + apT * Lw, Lbg, capLum, capO), covTower * vis);
    }
    if (!partFar) L = mix(L, Lp, partL.w * vis);
    // 旗云：塔身 9.5–12.5 km 处挂着的一圈云（高塔 / 高山身边真实会挂的旗云），顺风往一侧拖长 20–30 km。
    // 云顶和我们差不多高：塔从云里穿出去、被切成上下两段，「比云高得多」一眼就量出来了。写法同建木的云气（噪声沿横向拉长、不闪）
    if (inBanner) {
      float side = hbSeed > 0.5 ? 1.0 : -1.0;
      float xo = (X - side * 4.0) * side;
      float rTw = uWonderTower.y * 0.9;
      float wid = (xo > 0.0 ? 16.0 + 10.0 * hbSeed : rTw + 3.0);
      float n1 = vnoise(vec2(X * 0.15 + T * 0.003, 3.0));
      float th = (0.5 + 0.4 * hbSeed) * (0.6 + 0.8 * n1);
      float ds = s - hb - 0.04 * xo - 0.9 * (n1 - 0.5);
      float nz = vnoise(vec2(X * 0.3 - T * 0.004, ds * 1.1 + 11.0));
      float tau = 2.4 * exp(-ds * ds / (th * th) - xo * xo / (wid * wid)) * smoothstep(0.2, 0.7, nz) * (1.0 - smoothstep(32.0, 44.0, dist));
      float fwd = 1.0 + 1.5 * pow(max(dot(rd, uSunDir), 0.0), 4.0);
      vec3 Lc = 0.8 / M_PI * (eSun * 0.8 * fwd + eMoon * 0.8 + eSkyUp + 0.5 * eUp);
      cc = (1.0 - exp(-tau)) * vis;
      L = mix(L, wonderCap(lFront + apT * Lc, Lbg, capLum, capO), cc);
    }
    gWonderCov = max(min(max(max(covTower, partL.w), min(cov + covS, 1.0)), 1.0) * vis, cc);
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
      // 锚塔：每级退台朝相机那一圈的轮廓灯（暖白、很暗，权重在上面退台的循环里算好了），塔顶两角各一盏同步慢闪的红灯
      lamp += vec3(1.0, 0.8, 0.58) * 2.5 * (1.0 - dayF) * rimW;
      if (s < H + 1.0 && dist < uWonderTower.y + 3.0 * wPix) {
        vec2 topL = vec2(uWonderTower.z * 0.97, sn * H);
        float wTop = wonderPoint((abs(X) - topL.x) / wPix, (Y - topL.y) / wPix) + wonderPoint(x, (Y - topL.y) / wPix);
        lamp += vec3(1.0, 0.08, 0.03) * 60.0 * blink * (1.0 - dayF) * wTop;
      }
      // 环站两端：夜里是常亮的暖白微光（有人住）；白天是高强度白色频闪，从下往上依次闪（4 s 一轮）
      if (ringLamp >= 0.0) {
        vec4 rg = ringHit;
        float wEnds = wonderPoint((abs(X) - rg.y) / wPix, (Y - sn * rg.x) / wPix);
        float ph = fract(T / 4.0 - ringLamp * 0.09);
        float strobe = exp(-ph * ph / 0.0009);
        lamp += vec3(1.0, 0.93, 0.8) * (6.0 * (1.0 - dayF) + 8e4 * dayF * strobe) * wEnds;
      }
    }
    // 光强（kcd）→ 相机处照度（klux）= I / 距离²（m），再除以一个像素的立体角得到辐亮度（旗云后面的轮廓灯被云挡掉）
    L += apT * lamp * vis * (1.0 - cc) / (tm * tm * pixelAngle * pixelAngle);
    return L;
  }

  // ---- 建木（WS05 巨构化，《山海经·海内经》「百仞无枝，上有九欘，下有九枸」、《海内南经》「青叶紫茎，玄华黄实」）
  // 树干：底部直径 5–8 km 的一座「山」，往上收成一根笔直的柱（百仞无枝），树冠处 1–1.8 km，树梢在画外。
  // 九枸（板根）：九片从树干斜伸下去的板状巨根——热带大树的板根放大到山脊的尺度：贴着树干处高 7–15 km、几乎竖直，
  // 往外越来越低平，在 18–40 km 外没入脚下的云海。在像面上是精确的：板根所在的竖直平面（含轴线和方位 h）上一点 (ρ, σ)
  // 投到 (ρ·(h·nh), σ·sn − ρ·b·(h·rd)/sn)，是线性的，所以按本像素的横坐标直接反解 ρ、再解 σ，和板根上沿比一下就知道盖没盖住。
  float finF = 0.0, finB = 0.0;
  vec3 nFin = a;
  float tObj = 1e9;                              // 本像素被盖住的最前面那个实体的深度（km，脚下的云海排前后用）
  if (s < 16.0) {
    float cMax = 0.0;
    float rJ = 0.7 * J.x;
    for (int i = 0; i < 9 + uLoopGuard; i++) {
      float fi = float(i);
      float g1 = hash12(vec2(jSeed * 91.7 + fi, 13.1));
      float g2 = hash12(vec2(jSeed * 91.7 + fi, 17.9));
      float g3 = hash12(vec2(jSeed * 91.7 + fi, 21.7));
      float phi = 6.2832 * jSeed + fi * 0.6981 + 0.55 * (g1 - 0.5);
      vec3 h = cos(phi) * e1 + sin(phi) * e2;
      float hx = dot(h, nh);
      // 正对 / 背对相机的板根在像面上缩成树干后面的一条竖缝，交给树干
      if (abs(hx) < 0.06) continue;
      float hrd = dot(h, rd);
      float rho = X / hx;
      float Lr = 18.0 + 22.0 * g2;
      if (rho < 0.3 * rJ || rho > Lr) continue;
      float sig = (Y + rho * b * hrd / sn) / sn;
      float tF = t + (sig - s) * b + rho * hrd;
      if (tF > tLimit) continue;                 // 海面挡在前面
      float hr = 7.0 + 8.0 * g3;
      float q = clamp((Lr - rho) / (Lr - rJ), 0.0, 1.0);
      // 上沿的起伏（慢波，几 km 一个）：板根不是一刀切的直线
      float bump = 1.0 + 0.12 * sin(rho * 0.9 + g2 * 20.0);
      float z = hr * q * q * bump;
      float dz = -2.0 * hr * q / (Lr - rJ) * bump;
      float slope = (sn * dz - b * hrd / sn) / hx;
      float wF = tF * pixelAngle;
      float cf = wonderTentCdf((z - sig) * sn / wF * inversesqrt(1.0 + slope * slope)) * smoothstep(-1.0, 0.0, sig);
      if (hrd > 0.0) finB += cf; else finF += cf;
      if (cf > 0.5) tObj = min(tObj, tF);
      if (cf > cMax) {
        cMax = cf;
        vec3 np = cross(a, h);
        nFin = normalize((dot(np, rd) > 0.0 ? -np : np) + 0.3 * a);
      }
    }
  }
  if (cov > 0.5) tObj = min(tObj, t - sqrt(max(radius * radius - X * X, 0.0)) / sn);

  // 树皮（紫茎）：三级细节——轮廓（几十到几百像素）→ 竖向深棱（板根往上延伸成的棱，一圈 14–22 道，绕着树干慢慢拧，
  // 220 km 外约 5 像素一道）→ 树皮板块（2–3 像素，按像素足迹淡出成均匀的一层）。
  // 下段偏灰绿（苔、地衣），上段偏紫褐；受光面 / 背光面按太阳方向大块分明
  vec3 bark = uWonderAlbedo * mix(vec3(0.9, 1.06, 0.95), vec3(1.04, 0.96, 1.06), smoothstep(4.0, 22.0, s));
  vec3 LT = vec3(0.0);
  if (cov > 0.0) {
    float cphi = clamp(X / radius, -1.0, 1.0);
    float sphi = -sqrt(1.0 - cphi * cphi);
    vec3 radial = cphi * nh + sphi * mh;
    // 沿方位的弧长按「离正对相机那条母线多远」量（同天梯锚塔的竖肋）：视线绕树转得极慢（250 km 外每秒 0.07°，
    // 树皮纹理每秒挪 0.02 像素），看不出纹理跟着人转；比按世界方位 atan 省一截冷编译
    float uA = radius * acos(cphi);
    float nFl = floor(14.0 + 9.0 * hash12(vec2(jSeed * 91.7, 7.7)));
    float fu = wPix / max(-sphi, 0.05);          // 一个像素沿方位在树皮上跨多少 km（轮廓附近被透视压缩）
    float flP = 6.2832 * radius / nFl;           // 棱距（km）
    float ph = uA / flP + 0.006 * nFl * s;
    float amp = 1.0 - smoothstep(0.2, 0.45, fu / flP);
    float tri = abs(fract(ph) - 0.5) * 4.0 - 1.0;
    float dAz = 0.5 * tri * amp;
    vec3 tang = cross(a, radial);
    vec3 nT = normalize(radial * cos(dAz) + tang * sin(dAz) - a * jDr);
    // 棱与棱之间的沟更暗（遮蔽）；淡出时换成它的平均值，远处亮度不变
    float ao = 1.0 - 0.3 * mix(0.5, 0.5 - 0.5 * tri, amp);
    float fs = wPix / sn;
    float plate = (vnoise(vec2(uA / 0.45 + 17.0 * jSeed, s / 1.7)) - 0.5) * (1.0 - smoothstep(0.35, 0.8, max(fu / 0.45, fs / 1.7)));
    // （0.2 km 一道的细裂纹在 200 km 外按足迹积分只剩一层均匀的暗，直接折进反照率 ×0.9，不再单算）
    LT = bark * 0.9 * (1.0 + 0.4 * plate) * ao / M_PI * wonderIrr(nT, a, eSun, eMoon, eSkyUp, eUp);
  }
  // 板根（16 km 以下）和叶盘（树冠里）不会出现在同一个像素上，合成一种「另一种材质」只着色一次（冷编译：少一个
  // wonderIrr / 封顶的调用点，FXC 按调用点整份内联）。
  // 板根：同一种树皮，法线朝相机那一面（略往上仰），整片受光或整片在阴影里——大块的明暗面。
  // 叶盘（青叶，深的蓝绿）：按椭球法线受光（顶面亮、底面暗），叶子透光，朝太阳看时背光面也透出一点（前向散射）；
  // 叶盘里再有一层 1–2 km 的明暗斑驳（6–10 像素，不闪）
  float fwd = 1.0 + 1.5 * pow(max(dot(rd, uSunDir), 0.0), 4.0);
  bool low = s < 16.0;
  vec3 leafA = vec3(0.035, 0.06, 0.055);
  float mott = 0.75 + 0.5 * vnoise(vec2(X / 1.3, s * sn / 1.3) + 5.0 * jSeed);
  vec3 albO = low ? bark * vec3(0.9, 1.0, 0.9) : leafA * mott;
  vec3 nO = low ? nFin : (folN.w > 0.0 ? folN.xyz : a);
  vec3 LO = albO / M_PI * (wonderIrr(nO, a, eSun, eMoon, eSkyUp, eUp) + (low ? 0.0 : 0.12 * fwd) * (eSun + eMoon));
  float oB = min(low ? finB : folB, 1.0) * vis;
  float oF = min(low ? finF : folF, 1.0) * vis;
  // 各部件「最亮时」的样子（正对光源），封顶比例按它定（wonderCapRef）
  vec3 eMax = eSun * (1.0 + 0.12 * fwd) + eMoon + eSkyUp + eUp;

  // 合成（从后往前）：树干后面的叶盘 / 板根、枝 → 树干 → 前面的枝、叶盘 / 板根
  float capO;
  vec3 Cw = wonderCap(lFront + apT * Lt, Lbg, capLum, capScale);
  vec3 Co = wonderCapRef(lFront + apT * LO, lFront + apT * (low ? bark : leafA * 1.25) / M_PI * eMax, Lbg, capLum);
  L = mix(L, Co, oB);
  L = mix(L, Cw, min(woodB, 1.0) * vis);
  L = mix(L, wonderCapRef(lFront + apT * LT, lFront + apT * bark * 1.4 / M_PI * eMax, Lbg, capLum), cov * vis);
  L = mix(L, Cw, min(woodF, 1.0) * vis);
  L = mix(L, Co, oF);
  float covAll = min(max(max(cov, min(finF + finB, 1.0)), max(min(woodF + woodB, 1.0), min(folF + folB, 1.0))), 1.0);

  // 云：云反照率约 0.8；朝太阳看时前向散射更亮
  vec3 Lc = 0.8 / M_PI * (eSun * 0.8 * fwd + eMoon * 0.8 + eSkyUp + 0.5 * eUp);
  cc = 0.0;
  // 脚下的云海：树脚一圈 48 km 的云层（0.9–2.9 km 高），板根斜着扎进去、树干从中间穿出来。按真实的平板求交：
  // 视线在云层里（又在 48 km 的圆柱里）的那一段，按段中点取噪声（横向 5 km、纵深 22 km 的尺度——掠射时一行像素跨几 km 纵深，
  // 纵深方向的噪声要粗，不然逐行跳），只取实体前面的那一段挡实体
  if (s < 16.0 && b < -1e-4) {
    float lat2 = 2304.0 - X * X;
    if (lat2 > 0.0) {
      float hc = sqrt(lat2) / sn;
      float ta = max((2.9 - e) / b, t - hc);
      float tb = min(min((0.9 - e) / b, t + hc), tLimit);
      if (tb > ta) {
        vec3 pm = w0 + rd * (0.5 * (ta + tb));
        vec3 qh = pm - a * dot(a, pm);
        float lx = dot(qh, nh);
        float lz = dot(qh, mh);
        float nzz = 0.65 * vnoise(vec2(lx / 5.0 + T * 0.002, lz / 22.0 + 7.0 * jSeed)) + 0.35 * vnoise(vec2(lx / 1.8 - T * 0.003, lz / 9.0 + 3.0));
        float den = smoothstep(48.0, 16.0, length(qh)) * smoothstep(0.28, 0.62, nzz);
        float tau = 0.35 * den * mix(tb - ta, max(0.0, min(tb, tObj) - ta), covAll * vis);
        cc = (1.0 - exp(-tau)) * visF;
        L = mix(L, wonderCap(lFront + apT * Lc, Lbg, capLum, capO), cc);
      }
    }
  }
  // 云气缭绕（W01b 的三圈云环，WS05 挪到 8–24 km、按树干放大）：每圈是绕着树干的一道云环，远看是横在树干上、
  // 顺风往一侧拖长的云絮（像山顶的旗云），最低一圈和我们差不多高——树干从云里穿出去，被切成几段，「树比云高得多」一眼就量出来了。
  // 噪声沿横向拉长（絮状），最细的起伏约 2 km，不会逐帧闪
  if (s > 5.0 && s < 28.0) {
    float kc = clamp(floor((s - 9.0) / 6.5 + 0.5), 0.0, 2.0);
    float hc1 = hash12(vec2(kc + 11.0 * jSeed, 61.0));
    float hc2 = hash12(vec2(kc + 11.0 * jSeed, 67.0));
    float sc = 9.0 + 6.5 * kc + 2.0 * (hc1 - 0.5);
    float xo = X - 5.0 * (hc1 - 0.4);
    float wid = (radius * 2.2 + 8.0 + 9.0 * hc2 - 1.5 * kc) * (xo > 0.0 ? 1.8 : 0.8);
    float th = (0.7 + 0.8 * hc2) * (0.6 + 0.8 * vnoise(vec2(X * 0.2 + kc * 9.0, 2.0)));
    float ds = s - sc - 0.04 * X * (hc2 - 0.5) - 1.3 * (vnoise(vec2(X * 0.12 + T * 0.003, kc * 7.0)) - 0.5);
    float nz = 0.6 * vnoise(vec2(X * 0.14 - T * 0.003, ds * 0.8 + kc * 13.0)) + 0.4 * vnoise(vec2(X * 0.4 + 3.0, ds * 1.3 + kc * 5.0));
    // 最后一项：离轴线 32–43 km 渐隐到 0（上面 reach 在 45 km 处截断，不能留下硬边）
    float tau = (2.6 - 0.6 * kc) * exp(-ds * ds / (th * th) - xo * xo / (wid * wid)) * smoothstep(0.15, 0.75, nz) * (1.0 - smoothstep(32.0, 43.0, dist));
    // 薄雾：贴着树干、很淡，把几圈云连成「缭绕」
    tau += 0.22 * exp(-X * X / (4.0 * radius * radius + 20.0)) * smoothstep(7.0, 10.0, s) * (1.0 - smoothstep(20.0, 26.0, s)) * nz;
    float c2 = (1.0 - exp(-tau)) * visF;
    L = mix(L, wonderCap(lFront + apT * Lc, Lbg, capLum, capO), c2);
    cc = max(cc, c2);
  }
  gWonderCov = max(covAll * vis, cc);
  gWonderT = t;

  // 众帝上下：沿树干正面缓慢升降的暖色光团（夜里才看得见，很弱）
  if (hasPod) lamp += vec3(1.0, 0.8, 0.5) * 12.0 * (1.0 - dayF) * wonderPoint(x, (s - sPod) * sn / wPix);
  // 黄实：叶簇里稀疏的金色光点，格子 3 km × 3.4 km，缓慢上飘；夜里是极弱的、缓慢明灭的生物光，白天偶尔被阳光照到闪一下。
  // 只长在叶簇上（按本像素的叶簇覆盖率）
  float folC = min(folF + folB, 1.0);
  if (folC > 0.0) {
    float sd = s - 0.004 * T;
    vec2 cell = floor(vec2(X / 3.0, sd / 3.4));
    vec2 hc = hash22(cell + 71.0 + 13.0 * jSeed);
    if (hc.x < 0.3) {
      vec2 pc = (cell + 0.5 + (hc - 0.5) * 0.5) * vec2(3.0, 3.4);
      float tw = 0.5 + 0.5 * sin(T * (0.5 + hc.y) + hc.x * 40.0);
      float spark = pow(max(sin(T * (0.3 + 0.5 * hc.y) + hc.y * 60.0), 0.0), 24.0);
      vec3 glow = vec3(1.0, 0.78, 0.4) * (4.0 * tw * tw * (1.0 - dayF) + 4e5 * spark * dot(tS, vec3(0.333)));
      lamp += glow * folC * wonderPoint(x - pc.x / wPix, (sd - pc.y) * sn / wPix);
    }
  }
  // 光强（kcd）→ 相机处照度（klux）= I / 距离²（m），再除以一个像素的立体角得到辐亮度（云后面的光被云挡掉）
  L += apT * lamp * vis * (1.0 - cc) / (tm * tm * pixelAngle * pixelAngle);
  return L;
}
`;
