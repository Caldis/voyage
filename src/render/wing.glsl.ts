/**
 * 机翼（GLSL）：座舱系里做光线步进（米），尺寸按 A320 量级。依赖 VIEW_COMMON / CABIN_COMMON / PANE_COMMON 里的工具函数。
 *
 * 机体坐标（米）：X 朝机头，Y 向上，Z 从机身轴线朝窗外。与座舱系的换算：
 *   X = uSeatSign · x − uWingRootLE（机翼根部前缘在机头方向上相对窗口的位置），Y = y + WINDOW_HEIGHT，Z = z + CABIN_WALL_RADIUS
 * 左侧座位时座舱 x 朝机尾，所以乘 uSeatSign = −1，机翼形状不用镜像。
 *
 * 组成（都是距离场，求并）：
 * - 主翼：NACA 四位数翼型，后掠 25°、上反 5°，翼尖随载荷上弯（uWingFlex）
 * - 翼尖弯折 + 鲨鳍小翼：沿「翼展 → 圆弧弯折 → 近乎竖直」的一条中面路径扫出，弯折处是连续的曲面（A320 sharklet 的样子）
 * - 增升装置：前缘缝翼（uSlat）、后缘 Fowler 襟翼（uFlap，先向后滑出再下偏）、扰流板（uSpoiler，绕前缘铰链上翻）
 * - 襟翼滑轨整流罩（三个「独木舟」，伸出后缘）、发动机短舱与吊挂（CFM56 量级）
 * 尺寸都是按公开的 A320 外形数据估计的量级，不是官方图纸。
 */
export const WING_COMMON = /* glsl */ `
uniform float uSeatSign;       // 右侧 +1，左侧 −1
uniform float uWingRootLE;     // 翼根前缘在机头方向上相对窗口中心的距离（米），负数在身后
uniform float uWingFlex;       // 翼尖向上的弯曲（米），含静弯和湍流颤动
uniform float uStrobe;         // 频闪灯此刻的亮度 0..1
uniform float uFlap;           // 襟翼偏角（弧度），0 = 收起
uniform float uSlat;           // 缝翼偏角（弧度）
uniform float uSpoiler;        // 扰流板偏角（弧度）
uniform int uWingSteps;        // 机翼光线步进的最大步数（128）。用 uniform 做循环上限，FXC 就不会展开循环（展开后冷编译时间翻倍）
uniform int uWingShadowSteps;  // 机翼自阴影的最大步数（24）

const float CABIN_WALL_RADIUS = 1.85;  // 窗口内饰面到机身轴线的距离
const float WINDOW_HEIGHT = 0.25;      // 窗口中心高出机身轴线
const float FUSELAGE_RADIUS = 1.98;
const float ROOT_Z = 1.95;
const float TIP_Z = 17.0;
const float SPAN = TIP_Z - ROOT_Z;
const float ROOT_Y = -1.3;
const float ROOT_CHORD = 6.0;
const float TIP_CHORD = 1.6;
const float SWEEP = 0.436;     // 25°
const float DIHEDRAL = 0.087;  // 5°
const float WINGLET_H = 2.4;   // 小翼高度（A320 sharklet 约 2.4 m）
const float WINGLET_SWEEP = 0.61; // 35°
const float BEND_R = 0.55;     // 翼尖到小翼的弯折半径
const float MAIN_END_Z = TIP_Z - BEND_R;              // 平直主翼到这里为止，之后是弯折段
const float S_END = (MAIN_END_Z - ROOT_Z) / SPAN;
// 增升装置的展向范围（相对半展长 s）与弦向位置（相对弦长 xi）
const float FLAP_S0 = 0.03;
const float FLAP_SPLIT = 0.31;  // 内、外襟翼的分界
const float FLAP_S1 = 0.72;     // 再往外是副翼
const float FLAP_LE = 0.70;     // 襟翼前缘（收起时藏在整流罩下）
const float SHROUD_TE = 0.74;   // 扰流板后缘 / 襟翼整流罩的末端
const float SPOILER_XI = 0.60;  // 扰流板铰链
const float SPOILER_S0 = 0.10;
const float SPOILER_S1 = 0.70;
const float SLAT_XI = 0.12;
const float SLAT_S0 = 0.06;
const float SLAT_S1 = 0.955;
// 发动机：CFM56-5 量级，短舱最大直径约 2.1 m、长约 4.4 m，中心线离机身轴线 5.75 m
const float ENG_Z = 5.75;
const float ENG_Y = -2.2;
// 三个襟翼滑轨整流罩的展向位置
const float FAIR_S1 = 0.30;
const float FAIR_S2 = 0.49;
const float FAIR_S3 = 0.68;

vec3 cabinToAircraft(vec3 p) {
  return vec3(uSeatSign * p.x - uWingRootLE, p.y + WINDOW_HEIGHT, p.z + CABIN_WALL_RADIUS);
}

vec3 aircraftToCabin(vec3 A) {
  return vec3(uSeatSign * (A.x + uWingRootLE), A.y - WINDOW_HEIGHT, A.z - CABIN_WALL_RADIUS);
}

// NACA 四位数翼型的半厚度分布（相对弦长 × 相对厚度）
float nacaHalf(float xi) {
  xi = clamp(xi, 0.0, 1.0);
  return 5.0 * (0.2969 * sqrt(xi) - 0.126 * xi - 0.3516 * xi * xi + 0.2843 * xi * xi * xi - 0.1036 * xi * xi * xi * xi);
}

// ---- 平直主翼的平面形状 ----
float spanS(float z) { return (clamp(z, ROOT_Z, TIP_Z) - ROOT_Z) / SPAN; }
float leX(float z) { return -(clamp(z, ROOT_Z, TIP_Z) - ROOT_Z) * tan(SWEEP); }
float chordAt(float s) { return mix(ROOT_CHORD, TIP_CHORD, s); }
float tcAt(float s) { return mix(0.14, 0.11, s); }
float camberAt(float xi, float c) { float x = clamp(xi, 0.0, 1.0); return c * 0.08 * x * (1.0 - x); }
float baseY(float z, float s) { return ROOT_Y + (clamp(z, ROOT_Z, TIP_Z) - ROOT_Z) * tan(DIHEDRAL) + uWingFlex * s * s; }

struct WingCoord { float xi; float s; float chord; float yMid; float halfT; };

WingCoord wingCoord(vec3 P) {
  WingCoord w;
  w.s = spanS(P.z);
  w.chord = chordAt(w.s);
  w.xi = (leX(P.z) - P.x) / w.chord;
  w.yMid = baseY(P.z, w.s) + camberAt(w.xi, w.chord);
  w.halfT = w.chord * tcAt(w.s) * nacaHalf(w.xi);
  return w;
}

float sdWingMain(vec3 P) {
  WingCoord w = wingCoord(P);
  float yU = w.yMid + w.halfT;
  float yL = w.yMid - w.halfT;
  float xiA = 0.0;
  float xiB = 1.0;
  // 襟翼放下：主翼在襟翼段只到整流罩末端，下表面向上收成一片薄的整流罩（襟翼收起时就藏在它下面）
  if (uFlap > 1e-3 && w.s > FLAP_S0 && w.s < FLAP_S1) {
    xiB = SHROUD_TE;
    yL = mix(yL, yU - 0.04, smoothstep(0.52, SHROUD_TE, w.xi));
  }
  // 缝翼伸出：主翼前缘退到缝翼后面，切口收圆（「D 形前缘」）
  if (uSlat > 1e-3 && w.s > SLAT_S0 && w.s < SLAT_S1) {
    xiA = SLAT_XI - 0.03;
    float k = sqrt(clamp((w.xi - xiA) / 0.05, 0.0, 1.0));
    float m = 0.5 * (yU + yL);
    float hh = 0.5 * (yU - yL) * k;
    yU = m + hh;
    yL = m - hh;
  }
  float dy = abs(P.y - 0.5 * (yU + yL)) - 0.5 * (yU - yL);
  float dx = max(xiA - w.xi, w.xi - xiB) * w.chord * cos(SWEEP);
  float dz = max(ROOT_Z - P.z, P.z - (MAIN_END_Z + 0.04));
  return max(max(dy, dx), dz);
}

// ---- 翼尖弯折 + 鲨鳍小翼 ----
// 在翼尖的横截面（z-y 平面）里取局部坐标 (a, b)：a 沿翼尖处的翼面坡度（上反 + 弯曲）向外，b 垂直于它向上。
// 中面路径：a ≤ 0 是主翼的延长线；然后是半径 BEND_R 的圆弧，转过 bendAngle；之后是一段直的小翼。
float tipTheta() { return atan(tan(DIHEDRAL) + 2.0 * uWingFlex * S_END / SPAN); }
// 小翼最终略向外倾约 3°：圆弧转过的角度 = 90° − 翼尖坡度 − 3°
float bendAngle() { return 1.5708 - tipTheta() - 0.05; }
float tipYEnd() { return ROOT_Y + (MAIN_END_Z - ROOT_Z) * tan(DIHEDRAL) + uWingFlex * S_END * S_END; }

// 沿路径的弧长 → 前缘位置、弦长。弯折段里后掠角从 25° 平滑过渡到 35°
float tipLE(float sig, float arcLen) {
  float t = clamp(sig / arcLen, 0.0, 1.0);
  float ss = sig <= arcLen ? arcLen * (t * t * t - 0.5 * t * t * t * t) : arcLen * 0.5 + (sig - arcLen);
  return leX(MAIN_END_Z) - max(sig, 0.0) * tan(SWEEP) - (tan(WINGLET_SWEEP) - tan(SWEEP)) * ss;
}
// 后缘直接按一条折线定义（弯折段一段、小翼一段），弦长 = 前缘 − 后缘。
// 旧写法分别插值前缘和弦长，两者变化快慢不同，后缘在弯折处出现一个凹口
float tipChord(float sig, float arcLen, float wlLen) {
  float teEnd = leX(MAIN_END_Z) - chordAt(S_END);
  float teArc = tipLE(arcLen, arcLen) - 1.35;
  float teTop = tipLE(arcLen + wlLen, arcLen) - 0.42;
  float te = sig <= arcLen ? mix(teEnd, teArc, clamp(sig / arcLen, 0.0, 1.0))
                           : mix(teArc, teTop, clamp((sig - arcLen) / wlLen, 0.0, 1.0));
  return max(tipLE(sig, arcLen) - te, 0.05);
}

// 翼尖局部坐标：sig 沿路径弧长，n 离中面的距离（朝弯折内侧、也就是主翼上表面 / 小翼内侧为正）
vec2 tipPath(vec3 P, out float arcLen) {
  float th = tipTheta();
  float ang = bendAngle();
  arcLen = BEND_R * ang;
  vec2 d = vec2(P.z - MAIN_END_Z, P.y - tipYEnd());
  float cs = cos(th), sn = sin(th);
  vec2 ab = vec2(d.x * cs + d.y * sn, -d.x * sn + d.y * cs);
  // 三段中面，取最近的一段
  float d1 = ab.x <= 0.0 ? abs(ab.y) : length(ab);
  vec2 v = ab - vec2(0.0, BEND_R);
  float phi = atan(v.x, -v.y);
  float d2 = (phi >= 0.0 && phi <= ang) ? abs(length(v) - BEND_R) : 1e5;
  vec2 E = vec2(BEND_R * sin(ang), BEND_R - BEND_R * cos(ang));
  vec2 t = vec2(cos(ang), sin(ang));
  vec2 nIn = vec2(-sin(ang), cos(ang));
  vec2 e = ab - E;
  float al = dot(e, t);
  float d3 = al >= 0.0 ? abs(dot(e, nIn)) : length(e);
  if (d1 <= d2 && d1 <= d3) return vec2(min(ab.x, 0.0), ab.y);
  if (d2 <= d3) return vec2(BEND_R * phi, BEND_R - length(v));
  return vec2(arcLen + al, dot(e, nIn));
}

// 小翼离中面的路径位置 → 机体坐标（给灯的位置用）
vec3 tipToAircraft(float sig, float n, float x) {
  float th = tipTheta();
  float ang = bendAngle();
  float arcLen = BEND_R * ang;
  vec2 ab;
  if (sig <= arcLen) {
    float phi = sig / BEND_R;
    vec2 onArc = vec2(BEND_R * sin(phi), BEND_R - BEND_R * cos(phi));
    ab = onArc + normalize(vec2(0.0, BEND_R) - onArc) * n;
  } else {
    vec2 E = vec2(BEND_R * sin(ang), BEND_R - BEND_R * cos(ang));
    ab = E + vec2(cos(ang), sin(ang)) * (sig - arcLen) + vec2(-sin(ang), cos(ang)) * n;
  }
  float cs = cos(th), sn = sin(th);
  return vec3(x, tipYEnd() + ab.x * sn + ab.y * cs, MAIN_END_Z + ab.x * cs - ab.y * sn);
}

struct TipCoord { float sig; float n; float xi; float c; float halfT; float cam; float arcLen; float wlLen; };

TipCoord tipCoord(vec3 P) {
  TipCoord q;
  vec2 sn = tipPath(P, q.arcLen);
  q.wlLen = WINGLET_H - BEND_R;
  q.sig = sn.x;
  q.n = sn.y;
  q.c = tipChord(q.sig, q.arcLen, q.wlLen);
  q.xi = (tipLE(q.sig, q.arcLen) - P.x) / q.c;
  float bend = smoothstep(0.0, q.arcLen, q.sig);
  float h = clamp((q.sig - q.arcLen) / q.wlLen, 0.0, 1.0);
  // 顶端收圆
  q.halfT = q.c * mix(tcAt(S_END), 0.09, bend) * nacaHalf(q.xi) * sqrt(1.0 - smoothstep(0.9, 1.0, h));
  q.cam = camberAt(q.xi, q.c) * (1.0 - 0.6 * bend);
  return q;
}

float sdTip(vec3 P) {
  // 包围：离翼尖很远时直接返回一个保守的距离，省掉 atan。
  // 只在离得足够远（> 0.5 m）时才用包围距离：包围面本身不是几何，射线贴近它时会被当成「擦边」甚至「命中」
  float outside = (MAIN_END_Z - 1.7) - P.z;
  if (outside > 0.0) return outside + 0.5;
  TipCoord q = tipCoord(P);
  float dn = abs(q.n - q.cam) - q.halfT;
  float dx = max(-q.xi, q.xi - 1.0) * q.c * 0.8;
  float ds = max(-q.sig - 0.02, q.sig - (q.arcLen + q.wlLen));
  return max(max(dn, dx), ds);
}

// ---- Fowler 襟翼：先向后滑出（前 10° 主要是滑出），再绕铰链下偏 ----
float sdFlap(vec3 P) {
  if (uFlap < 1e-3) return 1e3;
  float s = spanS(P.z);
  float c = chordAt(s);
  float xm = leX(P.z) - P.x;                // 离前缘多少米（向后为正）
  float f = smoothstep(0.0, 0.3, uFlap);
  float qa = xm - FLAP_LE * c - 0.22 * c * f;
  float qb = P.y - (baseY(P.z, s) + camberAt(FLAP_LE, c)) + 0.03 * c * f;
  float cs = cos(uFlap), sn = sin(uFlap);
  float u = qa * cs - qb * sn;
  float v = qa * sn + qb * cs;
  float cf = (1.0 - FLAP_LE) * c;
  float xiF = u / cf;
  float xiO = FLAP_LE + (1.0 - FLAP_LE) * clamp(xiF, 0.0, 1.0);  // 对应原翼型的弦向位置
  float hF = c * tcAt(s) * nacaHalf(xiO) * sqrt(clamp(xiF / 0.12, 0.0, 1.0));
  float cam = camberAt(xiO, c) - camberAt(FLAP_LE, c);
  float dv = abs(v - cam) - hF;
  float du = max(-xiF, xiF - 1.0) * cf;
  float dz = max(ROOT_Z + FLAP_S0 * SPAN - P.z, P.z - (ROOT_Z + FLAP_S1 * SPAN));
  dz = max(dz, 0.04 - abs(P.z - (ROOT_Z + FLAP_SPLIT * SPAN))); // 内外襟翼之间的缝
  return max(max(dv, du), dz);
}

// 扰流板：主翼上表面的一块板，绕前缘铰链上翻
float sdSpoiler(vec3 P) {
  if (uSpoiler < 1e-3) return 1e3;
  float s = spanS(P.z);
  float c = chordAt(s);
  float xm = leX(P.z) - P.x;
  float hy = baseY(P.z, s) + camberAt(SPOILER_XI, c) + c * tcAt(s) * nacaHalf(SPOILER_XI);
  float L = (SHROUD_TE - SPOILER_XI) * c;
  float qa = xm - SPOILER_XI * c;
  float qb = P.y - hy;
  float cs = cos(uSpoiler), sn = sin(uSpoiler);
  float u = qa * cs + qb * sn;
  float v = -qa * sn + qb * cs;
  float th = 0.03 * (1.0 - 0.6 * clamp(u / L, 0.0, 1.0));
  float dv = abs(v + th) - th;
  float du = max(-u, u - L);
  float dz = max(ROOT_Z + SPOILER_S0 * SPAN - P.z, P.z - (ROOT_Z + SPOILER_S1 * SPAN));
  // 五块板之间的缝
  float seg = fract((s - SPOILER_S0) / (SPOILER_S1 - SPOILER_S0) * 5.0);
  dz = max(dz, 0.03 - min(seg, 1.0 - seg) * (SPOILER_S1 - SPOILER_S0) * SPAN / 5.0);
  return max(max(dv, du), dz);
}

// 前缘缝翼：原翼型最前面 12%，下表面是凹进去的「缝翼槽」；伸出时向前、向下并低头
float sdSlat(vec3 P) {
  if (uSlat < 1e-3) return 1e3;
  float s = spanS(P.z);
  float c = chordAt(s);
  float xm = leX(P.z) - P.x;
  float px = SLAT_XI * c;
  float qa = xm - px + 0.12 * c * uSlat;
  float qb = P.y - (baseY(P.z, s) + camberAt(SLAT_XI, c)) + 0.06 * c * uSlat;
  float cs = cos(uSlat), sn = sin(uSlat);
  float a = qa * cs + qb * sn;
  float b = -qa * sn + qb * cs;
  float xiL = (px + a) / c;
  float mid = camberAt(xiL, c) - camberAt(SLAT_XI, c);
  float hT = c * tcAt(s) * nacaHalf(xiL);
  float up = mid + hT;
  float lo = mid - hT * (1.0 - 1.8 * smoothstep(0.02, SLAT_XI, xiL));
  float dy = abs(b - 0.5 * (up + lo)) - 0.5 * (up - lo);
  float dx = max(-xiL, xiL - SLAT_XI) * c;
  float dz = max(ROOT_Z + SLAT_S0 * SPAN - P.z, P.z - (ROOT_Z + SLAT_S1 * SPAN));
  return max(max(dy, dx), dz);
}

// 襟翼滑轨整流罩：挂在下表面、伸出后缘的「独木舟」；襟翼放下时后半截跟着向下转
float sdFairing(vec3 P) {
  float s = spanS(P.z);
  float sf = abs(s - FAIR_S1) < abs(s - FAIR_S2) ? FAIR_S1 : (abs(s - FAIR_S2) < abs(s - FAIR_S3) ? FAIR_S2 : FAIR_S3);
  float zf = ROOT_Z + sf * SPAN;
  float side = abs(P.z - zf) - 0.2;
  if (side > 0.3) return side;
  float c = chordAt(sf);
  float xm = leX(zf) - P.x;
  float x0 = 0.5 * c;
  float len = 0.72 * c;
  float u = (xm - x0) / len;
  float uc = clamp(u, 0.0, 1.0);
  // 前 30% 是椭圆的头，后面逐渐收成尖尾
  float r = uc < 0.3 ? sqrt(max(1.0 - pow((0.3 - uc) / 0.3, 2.0), 0.0)) : 1.0 - pow((uc - 0.3) / 0.7, 1.3);
  float xiC = min(xm / c, 1.0);
  float lower = baseY(zf, sf) + camberAt(xiC, c) - c * tcAt(sf) * nacaHalf(xiC);
  float drop = max(xm - FLAP_LE * c, 0.0) * sin(uFlap) * 0.9;
  const float W = 0.16;
  const float H = 0.3;
  vec2 q = vec2((P.z - zf) / W, (P.y - (lower - drop - 0.8 * H * r)) / H);
  float d = (length(q) - r) * W;
  return max(d, max(-u, u - 1.0) * len);
}

// 发动机短舱 + 吊挂。u = 从进气道唇口向后的距离
float engInletX() { return leX(ENG_Z) + 2.6; }
float sdNacelle(vec3 P) {
  float u = engInletX() - P.x;
  vec3 cen = vec3(engInletX() - 2.4, ENG_Y + 0.3, ENG_Z);
  float bound = length(P - cen) - 3.3;
  if (bound > 0.3) return bound;
  float rr = length(P.yz - vec2(ENG_Y, ENG_Z));
  // 风扇整流罩：唇口圆 → 最粗 → 向后收
  float uc = clamp(u, 0.0, 2.7);
  float rCowl = uc < 0.45 ? 0.9 + 0.15 * sqrt(uc / 0.45) : 1.05 - 0.13 * smoothstep(0.45, 2.7, uc);
  float dCowl = max(rr - rCowl, max(-u, u - 2.7));
  // 进气道：唇口里面挖进去约 0.55 m 才到风扇
  dCowl = max(dCowl, -max(rr - 0.84, u - 0.55));
  // 风扇轮毂前的整流锥
  float dSpin = max(rr - 0.3 * clamp((u - 0.2) / 0.35, 0.0, 1.0), max(0.2 - u, u - 0.6));
  // 核心机整流罩 + 尾锥
  float uk = clamp(u, 2.5, 4.4);
  float rCore = uk < 3.75 ? mix(0.66, 0.5, (uk - 2.5) / 1.25) : 0.36 * sqrt(max(1.0 - (uk - 3.75) / 0.65, 0.0));
  float dCore = max(rr - rCore, max(2.5 - u, u - 4.4));
  // 吊挂：短舱顶上的一道梁，一直伸到机翼下面
  vec3 pp = P - vec3(engInletX() - 2.75, ENG_Y + 0.95, ENG_Z);
  vec3 qb = abs(pp) - vec3(2.15, 0.3, 0.13);
  float dPy = length(max(qb, 0.0)) + min(max(qb.x, max(qb.y, qb.z)), 0.0) - 0.04;
  return min(min(min(dCowl, dSpin), dCore), dPy) * 0.85;
}

// 部件编号：0 主翼，1 翼尖 / 小翼，2 襟翼，3 扰流板，4 缝翼，5 滑轨整流罩，6 短舱 / 吊挂。sdWing 顺手记下最近的部件
int gWingPart = 0;
// 算自阴影时跳过着色点自己所在的部件（主翼和翼尖算一组）：凸的翼面对自己的「擦边」会被软阴影估计成半影，
// 翼面上出现一圈圈木纹似的明暗条带。−1 = 不跳过
int gWingSkip = -1;

float sdWing(vec3 P) {
  float d = gWingSkip == 0 ? 1e3 : sdWingMain(P);
  int id = 0;
  float x = gWingSkip == 0 ? 1e3 : sdTip(P);      if (x < d) { d = x; id = 1; }
  x = gWingSkip == 2 ? 1e3 : sdFlap(P);           if (x < d) { d = x; id = 2; }
  x = gWingSkip == 3 ? 1e3 : sdSpoiler(P);        if (x < d) { d = x; id = 3; }
  x = gWingSkip == 4 ? 1e3 : sdSlat(P);           if (x < d) { d = x; id = 4; }
  x = gWingSkip == 5 ? 1e3 : sdFairing(P);        if (x < d) { d = x; id = 5; }
  x = gWingSkip == 6 ? 1e3 : sdNacelle(P);        if (x < d) { d = x; id = 6; }
  gWingPart = id;
  return d;
}

// 一个像素在单位距离上对应的长度（弧度）
float pixelAngle() { return 2.0 * uTanHalfFov / uResolution.y; }

// 整架机翼（含小翼、放下的襟翼、短舱）的包围盒，机体坐标（米），四周留了余量
const vec3 WING_BOX_MIN = vec3(-10.0, -3.6, 1.8);
const vec3 WING_BOX_MAX = vec3(1.4, 4.2, 17.6);

// 机身挡住阳光：从 P 朝太阳的射线是否穿过机身圆柱（轴线沿 X）
float fuselageShadow(vec3 P, vec3 l) {
  vec2 o = P.yz;
  vec2 d = l.yz;
  float a = dot(d, d);
  if (a < 1e-6) return 1.0;
  float b = dot(o, d);
  float c = dot(o, o) - FUSELAGE_RADIUS * FUSELAGE_RADIUS;
  float disc = b * b - a * c;
  if (disc < 0.0) return 1.0;
  float t = (-b - sqrt(disc)) / a;
  return t > 0.0 ? 0.0 : 1.0;
}

struct WingTrace {
  float t;       // 命中距离（座舱系，米）；擦边时是离机翼最近的地方；没打到是 −1
  float cov;     // 覆盖率：打中 1，擦边按「最近距离 / 像素宽度」解析算出（轮廓抗锯齿，不用屏幕导数），没打到 0
  vec3 nA;       // 法线（机体系），已经掰到朝向视线的一侧
  float shadow;  // 机翼自身的软阴影（小翼、短舱、扰流板、整流罩投到翼面上），1 = 不挡
  int part;      // 部件编号（见 gWingPart）
};

vec3 tetraDir(int i) {
  return vec3(float(((i + 3) >> 1) & 1), float((i >> 1) & 1), float(i & 1)) * 2.0 - 1.0;
}

// 视线（座舱系）与机翼：求交 → 法线 → 朝光源的自阴影，三段共用一个循环、一处 sdWing 调用。
// 为什么这么写：FXC（Windows 上 ANGLE 的后端）会把每一处函数调用都内联展开；sdWing 很大，
// 求交、法线、阴影各调一处时整个场景着色器冷编译从约 40 秒涨到 85–95 秒，而且首次加载时出现过 VALIDATE_STATUS false + 上下文丢失。
// 循环次数都依赖 uniform，FXC 也不会展开循环。
// 求交的命中阈值取亚像素（旧版取 0.002·t，约两个像素，擦边的射线命中与否取决于步进落点，轮廓成了阶梯）。
WingTrace traceWing(vec3 ro, vec3 rd, float tStart, vec3 lA) {
  WingTrace w;
  w.t = -1.0;
  w.cov = 0.0;
  w.nA = vec3(0.0, 1.0, 0.0);
  w.shadow = 1.0;
  w.part = 0;
  float pa = pixelAngle();
  vec3 oA = cabinToAircraft(ro);
  vec3 dA = vec3(uSeatSign * rd.x, rd.y, rd.z);
  // 先和包围盒求交：打不到盒子的视线（大半个天空、远处的海面）直接跳过，打得到的从盒子入口开始走
  vec3 inv = 1.0 / (dA + vec3(1e-7));
  vec3 t0 = (WING_BOX_MIN - oA) * inv;
  vec3 t1 = (WING_BOX_MAX - oA) * inv;
  vec3 tn = min(t0, t1);
  vec3 tf = max(t0, t1);
  float tEnter = max(max(tn.x, tn.y), tn.z);
  float tExit = min(min(min(tf.x, tf.y), tf.z), 60.0);
  if (tExit < max(tEnter, tStart)) return w;

  float t = max(tStart, tEnter);
  float best = 1e9;
  float tBest = -1.0;
  int partBest = 0;
  int phase = 0;        // 0 求交，1 法线（四面体四次采样），2 自阴影
  int j = 0;
  vec3 P = vec3(0.0);
  vec3 n = vec3(0.0);
  float ts = 0.12;
  float res = 1.0;
  int total = uWingSteps + 4 + uWingShadowSteps;
  for (int i = min(uWingSteps, 0); i < total; i++) {
    vec3 q = phase == 0 ? oA + dA * t : (phase == 1 ? P + tetraDir(j) * 0.0023 : P + w.nA * 0.01 + lA * ts);
    float d = sdWing(q);
    if (phase == 0) {
      float fp = pa * t;                    // 这里一个像素多宽（米）
      bool done = false;
      if (d < 0.25 * fp) {
        w.t = t;
        w.cov = 1.0;
        w.part = gWingPart;
        done = true;
      } else {
        float r = d / fp;
        if (r < best) { best = r; tBest = t; partBest = gWingPart; }
        // 距离场只是近似（盒子式组合 + 翼型前缘陡），近处步长打六折保险；离得远（> 0.3 m）时相对误差小，打八五折省步数。
        // 最小步长取亚像素，免得穿过毫米级的后缘
        t += max(d * (d > 0.3 ? 0.85 : 0.6), max(0.2 * fp, 0.002));
        if (t > tExit || i >= uWingSteps - 1) {
          // 像素中心离轮廓 best 个像素：覆盖率按一个像素宽的盒子滤波（轮廓整体外扩半个像素，看不出来）
          w.cov = clamp(1.0 - best, 0.0, 1.0);
          if (w.cov <= 0.0) return w;
          w.t = tBest;
          w.part = partBest;
          done = true;
        }
      }
      if (done) { P = oA + dA * w.t; phase = 1; }
    } else if (phase == 1) {
      n += tetraDir(j) * d;
      j++;
      if (j == 4) {
        n = normalize(n);
        // 蒙皮在肋和桁条之间会微微鼓起（「油罐效应」），天空的倒影因此轻轻起伏。扰动约 0.5°
        vec2 qq = P.xz * vec2(1.6, 2.2);
        vec2 wav = vec2(vnoise(qq) - 0.5, vnoise(qq + 17.3) - 0.5) * 0.018;
        n = normalize(n + vec3(wav.x, 0.0, wav.y));
        // 背向视线的法线（轮廓上、后缘这种薄边上常见）掰到略微朝向视线，而不是整个翻过来：
        // 翻转会让相邻像素在上、下表面的法线之间跳，后缘成了一串亮点
        float ndv = dot(n, -dA);
        if (ndv < 0.05) n = normalize(n - dA * (0.05 - ndv));
        w.nA = n;
        phase = 2;
        gWingSkip = w.part <= 1 ? 0 : w.part;
        // 背光面不用算阴影
        if (dot(n, lA) <= 0.0 || fuselageShadow(P, lA) <= 0.0) break;
      }
    } else {
      // 软阴影：半影按「最近距离 / 走过的距离」估计
      res = min(res, 6.0 * d / ts);
      if (res < 0.02) break;
      ts += clamp(d * 0.8, 0.05, 1.5);
      if (ts > 24.0) break;
    }
  }
  gWingSkip = -1;
  w.shadow = smoothstep(0.0, 1.0, res);
  return w;
}

float ggxD(float nh, float a) {
  float a2 = a * a;
  float d = nh * nh * (a2 - 1.0) + 1.0;
  return a2 / (M_PI * d * d);
}

float smithG(float nv, float nl, float a) {
  float k = a * 0.5;
  return (nv / (nv * (1.0 - k) + k)) * (nl / (nl * (1.0 - k) + k));
}

// 细线（面板缝、标线）：按像素宽度抗锯齿，返回覆盖率。
// fw 是 x 在一个像素内的变化量——由命中距离 × 像素张角解析算出，不用屏幕导数：
// 机翼着色发生在光线步进命中之后的分支里，那里的屏幕导数没有定义（D3D 会报 X3595 警告，机翼边缘可能闪烁）
float seam(float x, float width, float fw) {
  float w = max(fw, 1e-5);
  return 1.0 - smoothstep(width * 0.5, width * 0.5 + w, abs(x));
}

// 按像素足迹淡出的 fbm：某个倍频的周期短于约两个像素时换成它的平均值（0.5），远处不闪、不出摩尔纹。
// fw 是 p 在一个像素内的变化量（取变化最快的那个方向）
float fbmAA(vec2 p, float fw) {
  float s = 0.0, a = 0.5;
  for (int i = 0; i < 4; i++) {
    float keep = 1.0 - smoothstep(0.25, 0.5, fw);
    s += a * mix(0.5, vnoise(p), keep);
    p = p * 2.03 + 17.1;
    fw *= 2.03;
    a *= 0.5;
  }
  return s;
}

struct WingSurface { vec3 albedo; float metal; float rough; vec3 emit; float coat; };

// 翼面漆：浅灰、半光（清漆层），每块蒙皮板的漆色和光泽略有差别
const vec3 WING_PAINT = vec3(0.70, 0.71, 0.72);
const vec3 LIVERY = vec3(0.045, 0.10, 0.27);   // 小翼上的航司色（示例：深蓝，不对应真实航司）

WingSurface paint(vec3 albedo, float rough) {
  WingSurface m;
  m.albedo = albedo;
  m.metal = 0.0;
  m.rough = rough;
  m.emit = vec3(0.0);
  m.coat = 0.9;
  return m;
}

WingSurface bareMetal(float albedo, float rough) {
  WingSurface m;
  m.albedo = vec3(albedo, albedo * 1.01, albedo * 1.03);
  m.metal = 1.0;
  m.rough = rough;
  m.emit = vec3(0.0);
  m.coat = 0.0;
  return m;
}

// 翼面（主翼、襟翼、扰流板共用）：xi 弦向（相对原翼型），zm 离翼根的展向米数，chord 当地弦长
WingSurface skin(float xi, float zm, float s, float chord, float pix, int part) {
  WingSurface m = paint(WING_PAINT, 0.25);
  float xm = xi * chord;
  float fwX = pix / chord;
  // 前缘缝翼：裸铝，抛光后被雨蚀得略毛。缝翼伸出时还是它
  if (xi < 0.1 || part == 4) m = bareMetal(0.86, 0.16 + 0.1 * vnoise(vec2(zm * 3.0, 1.7)));
  // 后缘襟翼、扰流板区域颜色略灰
  if (xi > 0.72 || part == 2) m.albedo *= 0.92;
  // 面板缝：展向（缝翼、前后梁、扰流板铰链、襟翼前缘）+ 弦向（每块扰流板 / 襟翼的分段）
  float lines = 0.0;
  lines = max(lines, seam(xi - 0.1, 0.006 / chord, fwX));
  lines = max(lines, seam(xi - 0.62, 0.004 / chord, fwX));
  lines = max(lines, seam(xi - 0.72, 0.006 / chord, fwX));
  if (xi > 0.62) lines = max(lines, seam(fract(zm / 1.6 + 0.5) - 0.5, 0.004 / 1.6, pix / 1.6));
  if (xi < 0.1) lines = max(lines, seam(fract(zm / 2.4 + 0.5) - 0.5, 0.004 / 2.4, pix / 2.4));
  // 副翼：外侧 25% 展长、后 25% 弦长
  if (s > 0.72) lines = max(lines, seam(s - 0.72, 0.005 / SPAN, pix / SPAN) * step(0.72, xi));
  m.albedo *= 1.0 - 0.55 * lines;
  // 每块蒙皮板的漆色、光泽略有差别（批次、补漆、老化程度不同）
  float zone = xi < 0.1 ? 0.0 : (xi < 0.62 ? 1.0 : (xi < 0.72 ? 2.0 : 3.0));
  float panelId = floor(zm / (xi > 0.62 ? 1.6 : 2.4)) + zone * 31.0 + float(part) * 7.0;
  float ph = hash12(vec2(panelId, zone));
  m.albedo *= 1.0 + (ph - 0.5) * 0.07;
  if (m.metal < 0.5) m.rough = mix(0.2, 0.34, hash12(vec2(panelId, 5.3)));
  // 铆钉：沿前后梁的两排点 + 沿翼肋（弦向，约每 0.6 m 一道）的淡线；远处细于像素时淡成一条浅灰线
  float fade = 1.0 - smoothstep(0.004, 0.02, pix);
  for (int k = 0; k < 2; k++) {
    float spar = k == 0 ? 0.18 : 0.6;
    float row = seam(xi - spar, 0.006 / chord, fwX);
    float dots = 1.0 - smoothstep(0.002, 0.003, length(vec2(fract(zm / 0.12) - 0.5, 0.0)) * 0.12);
    m.albedo *= 1.0 - row * mix(0.05, 0.14 * dots, fade);
  }
  if (xi > 0.1 && xi < 0.62 && part == 0) {
    float rib = seam(fract(zm / 0.6 + 0.5) - 0.5, 0.005 / 0.6, pix / 0.6);
    m.albedo *= 1.0 - 0.05 * rib;
  }
  if (part == 0) {
    // 燃油舱检修口：沿展向每 1.5 m 一个椭圆口盖（约 45 × 30 cm），外圈一圈螺钉
    if (xi > 0.3 && xi < 0.55 && zm > 1.0 && zm < 13.0) {
      vec2 pc = vec2(xm - (0.42 * chord), fract(zm / 1.5 + 0.5) * 1.5 - 0.75);
      float e = length(pc / vec2(0.15, 0.225));
      float ring = seam(e - 1.0, 0.012 / 0.2, pix / 0.2);
      m.albedo *= 1.0 - 0.25 * ring;
      float ang = atan(pc.y / 0.225, pc.x / 0.15);
      float nearRing = 1.0 - smoothstep(0.0, 0.08, abs(e - 1.18));
      float screw = nearRing * (1.0 - smoothstep(0.05, 0.12, abs(fract(ang / (2.0 * M_PI) * 12.0) - 0.5)));
      m.albedo *= 1.0 - 0.3 * screw * (1.0 - smoothstep(0.003, 0.012, pix));
    }
    // 翼根的走道：黑色边线围出的一块区域（写着 NO STEP 的那种）
    float walk = seam(zm - 3.2, 0.05, pix) * step(0.25, xi) * step(xi, 0.6);
    walk = max(walk, (seam(xi - 0.25, 0.05 / chord, fwX) + seam(xi - 0.6, 0.05 / chord, fwX)) * step(zm, 3.2));
    m.albedo = mix(m.albedo, vec3(0.03), clamp(walk, 0.0, 1.0));
    // 防滑走道本身是哑光的深灰涂层
    float walkway = step(zm, 3.2) * step(0.25, xi) * step(xi, 0.6);
    m.albedo = mix(m.albedo, vec3(0.5, 0.505, 0.51), walkway * 0.6);
    m.rough = mix(m.rough, 0.6, walkway);
    m.coat *= 1.0 - 0.6 * walkway;
  }
  // 顺气流方向的污渍：后缘和扰流板附近多，沿弦向拉长（展向变化快，按展向的像素足迹淡出高频）
  float grime = fbmAA(vec2(xm * 1.5, zm * 12.0), pix * 12.0) * smoothstep(0.5, 1.0, xi);
  m.albedo *= mix(vec3(1.0), vec3(0.86, 0.83, 0.78), clamp(grime * 1.3 - 0.35, 0.0, 1.0));
  m.rough = mix(m.rough, 0.45, grime);
  // 扰流板后面、襟翼上的深色排气 / 液压油污
  float streak = fbmAA(vec2(xm * 0.6, zm * 25.0), pix * 25.0) * smoothstep(0.7, 0.95, xi);
  m.albedo *= 1.0 - 0.22 * smoothstep(0.5, 0.78, streak);
  // 前缘附近的雨蚀：漆面发乌、光泽变差
  float erosion = (1.0 - smoothstep(0.1, 0.2, xi)) * step(0.1, xi);
  m.rough = mix(m.rough, 0.45, erosion * 0.6);
  return m;
}

// pix：命中点处一个像素对应的长度（米）；up：命中点的法线是否朝上（机体系 y）
WingSurface wingSurface(vec3 P, float pix, float up, int part) {
  if (part == 1) {
    // 翼尖弯折 + 小翼：竖直段和弯折上半截涂航司色，弯折下半截是翼面灰；前缘一条裸金属防蚀条
    TipCoord q = tipCoord(P);
    float lw = pix / q.arcLen;
    float liv = smoothstep(0.62 - lw, 0.62 + lw, q.sig / q.arcLen);
    WingSurface m = paint(mix(WING_PAINT * 0.97, LIVERY, liv), 0.18);
    // 小翼和翼尖的对接缝
    m.albedo *= 1.0 - 0.5 * seam(q.sig - 0.12, 0.006, pix);
    // 航司色的漆层里有细小的金属颗粒（金属漆），光泽更「深」
    float flake = hash12(floor(P.xy * 900.0) + floor(P.z * 900.0)) - 0.5;
    m.albedo *= 1.0 + 0.08 * flake * liv * (1.0 - smoothstep(0.0005, 0.002, pix));
    if (q.xi < 0.035) m = bareMetal(0.8, 0.22);
    // 后缘的静电放电刷底座：一小段深色
    m.albedo *= 1.0 - 0.4 * seam(q.xi - 0.985, 0.03, pix / q.c) * step(q.arcLen, q.sig);
    return m;
  }
  if (part == 6) {
    float u = engInletX() - P.x;
    float rr = length(P.yz - vec2(ENG_Y, ENG_Z));
    bool pylon = rr > 1.06 || (P.y > ENG_Y + 0.7 && abs(P.z - ENG_Z) < 0.16);
    if (pylon) return paint(WING_PAINT * 0.95, 0.3);
    if (rr < 0.86 && u < 0.62) {
      // 进气道里：整流锥（带一道白色螺旋标记的深色锥）、36 片风扇叶片（CFM56-5B 的叶片数）、进气道内壁
      if (u > 0.5 && rr > 0.31) {
        float ang = atan(P.y - ENG_Y, P.z - ENG_Z);
        float blade = abs(fract(ang / (2.0 * M_PI) * 36.0 + rr * 0.6) - 0.5);
        WingSurface f = bareMetal(0.35, 0.3);
        f.albedo *= 0.25 + 0.75 * smoothstep(0.05, 0.2, blade);
        return f;
      }
      if (rr < 0.31) {
        float ang = atan(P.y - ENG_Y, P.z - ENG_Z);
        WingSurface sp = paint(vec3(0.03), 0.3);
        float spiral = abs(fract(ang / (2.0 * M_PI) + rr * 1.5) - 0.5);
        sp.albedo = mix(sp.albedo, vec3(0.8), 1.0 - smoothstep(0.03, 0.05, spiral));
        return sp;
      }
      return paint(vec3(0.3, 0.31, 0.32), 0.45);                        // 进气道内壁（吸音衬里）
    }
    if (u < 0.28) return bareMetal(0.88, 0.1);                          // 进气道唇口：抛光铝
    if (u > 3.75) return bareMetal(0.12, 0.45);                         // 尾锥：高温发黑
    if (u > 2.62) return bareMetal(0.42, 0.4);                          // 核心机整流罩
    WingSurface m = paint(vec3(0.8, 0.8, 0.81), 0.2);                   // 风扇整流罩：白漆
    m.albedo *= 1.0 - 0.5 * seam(u - 0.45, 0.006, pix);                 // 进气道与整流罩的对缝
    m.albedo *= 1.0 - 0.5 * seam(u - 1.55, 0.006, pix);                 // 反推整流罩的分缝
    m.albedo *= 1.0 - 0.35 * seam(u - 2.62, 0.02, pix);
    return m;
  }
  if (part == 5) {
    WingSurface m = paint(WING_PAINT * 0.9, 0.3);
    float sf = spanS(P.z);
    float c = chordAt(sf);
    float xm = leX(P.z) - P.x;
    // 尾端被襟翼排出的气流熏黑
    m.albedo *= 1.0 - 0.3 * smoothstep(1.05 * c, 1.25 * c, xm);
    return m;
  }
  WingCoord w = wingCoord(P);
  float zm = P.z - ROOT_Z;
  float xi = w.xi;
  if (part == 2) {
    // 襟翼：按襟翼自己的弦向坐标映射回原翼型
    float f = smoothstep(0.0, 0.3, uFlap);
    xi = FLAP_LE + (w.xi - FLAP_LE - 0.22 * f) * 1.0;
    xi = clamp(xi, FLAP_LE, 1.0);
  }
  if (part == 4) xi = clamp(w.xi + 0.12 * uSlat, 0.0, SLAT_XI);
  WingSurface m = skin(xi, zm, w.s, w.chord, pix, part);
  // 襟翼放下后露出的前缘和整流罩下的凹槽：没有清漆的浅灰底漆
  if (part == 2 && xi < FLAP_LE + 0.05) { m.albedo = vec3(0.55, 0.58, 0.56); m.coat = 0.2; m.rough = 0.5; }
  // 扰流板翻起后露出的凹槽：结构件和作动筒，深灰
  if (part == 0 && uSpoiler > 1e-3 && up > 0.0 && w.xi > SPOILER_XI && w.xi < SHROUD_TE
      && w.s > SPOILER_S0 && w.s < SPOILER_S1) {
    m.albedo *= 0.35;
    m.coat = 0.1;
    m.rough = 0.6;
  }
  if (part == 3 && up < 0.0) { m.albedo *= 0.5; m.coat = 0.2; }
  return m;
}
`;
