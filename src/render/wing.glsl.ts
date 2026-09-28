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
uniform int uWingDebug;        // 调试开关（按位）：1 去掉油罐鼓包，2 去掉翼尖灯照明，4 去掉环境反射，8 去掉自阴影，16 只看漫反射的反照率，
                               // 64 关掉掠射射线的延长步数，128 边缘子射线一律从半路出发（T22 之前的做法，对照用），
                               // 256 / 1024 / 4096 见 wingView，8192 关掉「饿死的子射线按打中算」（W-STAIR 之前的做法，对照用）
uniform int uWingEdgeAA;       // 内轮廓 / 薄边超采样：0 关，1 开，2 开并把超采样的像素标成品红（调试）

const float CABIN_WALL_RADIUS = 1.85;  // 窗口内饰面到机身轴线的距离
const float WINDOW_HEIGHT = 0.25;      // 窗口中心高出机身轴线
const float FUSELAGE_RADIUS = 1.98;
const float ROOT_Z = 1.95;
const float TIP_Z = 17.0;
const float WING_SPAN = TIP_Z - ROOT_Z;
const float ROOT_Y = -1.3;
const float ROOT_CHORD = 6.0;
const float TIP_CHORD = 1.6;
const float SWEEP = 0.436;     // 25°
const float DIHEDRAL = 0.087;  // 5°
const float WINGLET_H = 2.4;   // 小翼高度（A320 sharklet 约 2.4 m）
const float WINGLET_SWEEP = 0.61; // 35°
const float WING_BEND_R = 0.55;     // 翼尖到小翼的弯折半径
const float WING_MAIN_END_Z = TIP_Z - WING_BEND_R;              // 平直主翼到这里为止，之后是弯折段
const float WING_S_END = (WING_MAIN_END_Z - ROOT_Z) / WING_SPAN;
// 增升装置的展向范围（相对半展长 s）与弦向位置（相对弦长 xi）
const float WING_FLAP_S0 = 0.03;
const float WING_FLAP_SPLIT = 0.31;  // 内、外襟翼的分界
const float WING_FLAP_S1 = 0.72;     // 再往外是副翼
const float WING_FLAP_LE = 0.70;     // 襟翼前缘（收起时藏在整流罩下）
const float WING_SHROUD_TE = 0.74;   // 扰流板后缘 / 襟翼整流罩的末端
const float WING_SPOILER_XI = 0.60;  // 扰流板铰链
const float WING_SPOILER_S0 = 0.10;
const float WING_SPOILER_S1 = 0.70;
const float WING_SLAT_XI = 0.12;
const float WING_SLAT_S0 = 0.06;
const float WING_SLAT_S1 = 0.955;
// 发动机：CFM56-5 量级，短舱最大直径约 2.1 m、长约 4.4 m，中心线离机身轴线 5.75 m
const float WING_ENG_Z = 5.75;
const float WING_ENG_Y = -2.2;
// 三个襟翼滑轨整流罩的展向位置
const float WING_FAIR_S1 = 0.30;
const float WING_FAIR_S2 = 0.49;
const float WING_FAIR_S3 = 0.68;

vec3 wingCabinToAircraft(vec3 p) {
  return vec3(uSeatSign * p.x - uWingRootLE, p.y + WINDOW_HEIGHT, p.z + CABIN_WALL_RADIUS);
}

vec3 wingAircraftToCabin(vec3 A) {
  return vec3(uSeatSign * (A.x + uWingRootLE), A.y - WINDOW_HEIGHT, A.z - CABIN_WALL_RADIUS);
}

// NACA 四位数翼型的半厚度分布（相对弦长 × 相对厚度）
float wingNacaHalf(float xi) {
  xi = clamp(xi, 0.0, 1.0);
  return 5.0 * (0.2969 * sqrt(xi) - 0.126 * xi - 0.3516 * xi * xi + 0.2843 * xi * xi * xi - 0.1036 * xi * xi * xi * xi);
}

// ---- 平直主翼的平面形状 ----
float wingSpanS(float z) { return (clamp(z, ROOT_Z, TIP_Z) - ROOT_Z) / WING_SPAN; }
float wingLeX(float z) { return -(clamp(z, ROOT_Z, TIP_Z) - ROOT_Z) * tan(SWEEP); }
float wingChordAt(float s) { return mix(ROOT_CHORD, TIP_CHORD, s); }
float wingTcAt(float s) { return mix(0.14, 0.11, s); }
float wingCamberAt(float xi, float c) { float x = clamp(xi, 0.0, 1.0); return c * 0.08 * x * (1.0 - x); }
float wingBaseY(float z, float s) { return ROOT_Y + (clamp(z, ROOT_Z, TIP_Z) - ROOT_Z) * tan(DIHEDRAL) + uWingFlex * s * s; }

struct WingCoord { float xi; float s; float chord; float yMid; float halfT; };

WingCoord wingCoord(vec3 P) {
  WingCoord w;
  w.s = wingSpanS(P.z);
  w.chord = wingChordAt(w.s);
  w.xi = (wingLeX(P.z) - P.x) / w.chord;
  w.yMid = wingBaseY(P.z, w.s) + wingCamberAt(w.xi, w.chord);
  w.halfT = w.chord * wingTcAt(w.s) * wingNacaHalf(w.xi);
  return w;
}

// 完整翼型（襟翼收起、缝翼收起时的截面）的距离，不含展向边界（W-STAIR 的分段下界用）
float wingFullSectionDist(vec3 P, WingCoord w) {
  return max(abs(P.y - w.yMid) - w.halfT, max(-w.xi, w.xi - 1.0) * w.chord * cos(SWEEP));
}

float sdWingMain(vec3 P) {
  WingCoord w = wingCoord(P);
  float yU = w.yMid + w.halfT;
  float yL = w.yMid - w.halfT;
  float xiA = 0.0;
  float xiB = 1.0;
  // 襟翼放下：主翼在襟翼段只到整流罩末端，下表面向上收成一片薄的整流罩（襟翼收起时就藏在它下面）
  if (uFlap > 1e-3 && w.s > WING_FLAP_S0 && w.s < WING_FLAP_S1) {
    xiB = WING_SHROUD_TE;
    yL = mix(yL, yU - 0.04, smoothstep(0.52, WING_SHROUD_TE, w.xi));
  }
  // 缝翼伸出：主翼前缘退到缝翼后面，切口收圆（「D 形前缘」）
  if (uSlat > 1e-3 && w.s > WING_SLAT_S0 && w.s < WING_SLAT_S1) {
    xiA = WING_SLAT_XI - 0.03;
    float k = sqrt(clamp((w.xi - xiA) / 0.05, 0.0, 1.0));
    float m = 0.5 * (yU + yL);
    float hh = 0.5 * (yU - yL) * k;
    yU = m + hh;
    yL = m - hh;
  }
  float dy = abs(P.y - 0.5 * (yU + yL)) - 0.5 * (yU - yL);
  float dx = max(xiA - w.xi, w.xi - xiB) * w.chord * cos(SWEEP);
  float d = max(dy, dx);
  // W-STAIR：襟翼段 / 缝翼段的截面和段外不同，段的两端是一道「台阶面」（例如副翼内端 s = 0.72：内侧只到整流罩末端，
  // 外侧是完整的翼型）。上面只按「P 在哪一段」算那一段的截面，段内离副翼内端面一两毫米的点报出的是到整流罩的距离（几十厘米），
  // 球体追踪一步跨过内端面、落进翼型里面几个像素深，法线取的是翼内的梯度（常常朝下），
  // 副翼内端、整流罩后面一片逐像素乱跳的点阵阴影（穿云、襟翼放下时最明显）。
  // 修法取下界：各段的截面（整流罩、D 形前缘）都是完整翼型的子集，离开自己这一段至少要走 m（到这一类段边界平面的距离，
  // P 在哪一段都成立），段外的形状又都在完整翼型里面，所以 真实距离 ≥ min(d, max(完整翼型的距离, m, 离台阶所在弦向区域的距离))。
  // 完整翼型的距离（wingFullSectionDist）弦向那一项不能省：只取竖直方向时，后缘后面、和翼型同高的点下界成了 m，
  // 射线在段边界平面上「打中」一面不存在的墙（云里一千多个像素）。
  // 这里在球体追踪最内层（每条射线每步都走）：放在 uniform 分支里，襟翼、缝翼都收起的巡航画面逐位不变、一条指令都不多走
  if (uFlap > 1e-3 || uSlat > 1e-3) {
    // 分区（W-STAIR 审查）：襟翼段两道边界只在 xi > 0.52（整流罩下表面开始上收处）以后有台阶，
    // 缝翼段两道边界只在 xi < 0.14（D 形前缘收圆结束处）以前有台阶；各自再与「离那片弦向区域的距离」取大，
    // 免得在没有表面的地方（s = 0.06 平面上的后缘之后、s = 0.72 平面上的缝翼槽）下界降到 0、造出幻影墙
    float z = P.z - ROOT_Z;
    float fd = wingFullSectionDist(P, w);
    float cc = w.chord * cos(SWEEP);
    if (uFlap > 1e-3)
      d = min(d, max(max(fd, min(abs(z - WING_FLAP_S0 * WING_SPAN), abs(z - WING_FLAP_S1 * WING_SPAN))), (0.52 - w.xi) * cc));
    if (uSlat > 1e-3)
      d = min(d, max(max(fd, min(abs(z - WING_SLAT_S0 * WING_SPAN), abs(z - WING_SLAT_S1 * WING_SPAN))), (w.xi - 0.14) * cc));
  }
  float dz = max(ROOT_Z - P.z, P.z - (WING_MAIN_END_Z + 0.04));
  return max(d, dz);
}

// ---- 翼尖弯折 + 鲨鳍小翼 ----
// 在翼尖的横截面（z-y 平面）里取局部坐标 (a, b)：a 沿翼尖处的翼面坡度（上反 + 弯曲）向外，b 垂直于它向上。
// 中面路径：a ≤ 0 是主翼的延长线；然后是半径 WING_BEND_R 的圆弧，转过 wingBendAngle；之后是一段直的小翼。
float wingTipTheta() { return atan(tan(DIHEDRAL) + 2.0 * uWingFlex * WING_S_END / WING_SPAN); }
// 小翼最终略向外倾约 3°：圆弧转过的角度 = 90° − 翼尖坡度 − 3°
float wingBendAngle() { return 1.5708 - wingTipTheta() - 0.05; }
float wingTipYEnd() { return ROOT_Y + (WING_MAIN_END_Z - ROOT_Z) * tan(DIHEDRAL) + uWingFlex * WING_S_END * WING_S_END; }

// 沿路径的弧长 → 前缘位置、弦长。弯折段里后掠角从 25° 平滑过渡到 35°
float wingTipLE(float sig, float arcLen) {
  float t = clamp(sig / arcLen, 0.0, 1.0);
  float ss = sig <= arcLen ? arcLen * (t * t * t - 0.5 * t * t * t * t) : arcLen * 0.5 + (sig - arcLen);
  return wingLeX(WING_MAIN_END_Z) - max(sig, 0.0) * tan(SWEEP) - (tan(WINGLET_SWEEP) - tan(SWEEP)) * ss;
}
// 后缘直接按一条折线定义（弯折段一段、小翼一段），弦长 = 前缘 − 后缘。
// 旧写法分别插值前缘和弦长，两者变化快慢不同，后缘在弯折处出现一个凹口
float wingTipChord(float sig, float arcLen, float wlLen) {
  float teEnd = wingLeX(WING_MAIN_END_Z) - wingChordAt(WING_S_END);
  float teArc = wingTipLE(arcLen, arcLen) - 1.35;
  float teTop = wingTipLE(arcLen + wlLen, arcLen) - 0.42;
  float te = sig <= arcLen ? mix(teEnd, teArc, clamp(sig / arcLen, 0.0, 1.0))
                           : mix(teArc, teTop, clamp((sig - arcLen) / wlLen, 0.0, 1.0));
  return max(wingTipLE(sig, arcLen) - te, 0.05);
}

// 翼尖局部坐标：sig 沿路径弧长，n 离中面的距离（朝弯折内侧、也就是主翼上表面 / 小翼内侧为正）
vec2 wingTipPath(vec3 P, out float arcLen) {
  float th = wingTipTheta();
  float ang = wingBendAngle();
  arcLen = WING_BEND_R * ang;
  vec2 d = vec2(P.z - WING_MAIN_END_Z, P.y - wingTipYEnd());
  float cs = cos(th), sn = sin(th);
  vec2 ab = vec2(d.x * cs + d.y * sn, -d.x * sn + d.y * cs);
  // 三段中面，取最近的一段
  float d1 = ab.x <= 0.0 ? abs(ab.y) : length(ab);
  vec2 v = ab - vec2(0.0, WING_BEND_R);
  float phi = atan(v.x, -v.y);
  float d2 = (phi >= 0.0 && phi <= ang) ? abs(length(v) - WING_BEND_R) : 1e5;
  vec2 E = vec2(WING_BEND_R * sin(ang), WING_BEND_R - WING_BEND_R * cos(ang));
  vec2 t = vec2(cos(ang), sin(ang));
  vec2 nIn = vec2(-sin(ang), cos(ang));
  vec2 e = ab - E;
  float al = dot(e, t);
  float d3 = al >= 0.0 ? abs(dot(e, nIn)) : length(e);
  if (d1 <= d2 && d1 <= d3) return vec2(min(ab.x, 0.0), ab.y);
  if (d2 <= d3) return vec2(WING_BEND_R * phi, WING_BEND_R - length(v));
  return vec2(arcLen + al, dot(e, nIn));
}

// 小翼离中面的路径位置 → 机体坐标（给灯的位置用）
vec3 wingTipToAircraft(float sig, float n, float x) {
  float th = wingTipTheta();
  float ang = wingBendAngle();
  float arcLen = WING_BEND_R * ang;
  vec2 ab;
  if (sig <= arcLen) {
    float phi = sig / WING_BEND_R;
    vec2 onArc = vec2(WING_BEND_R * sin(phi), WING_BEND_R - WING_BEND_R * cos(phi));
    ab = onArc + normalize(vec2(0.0, WING_BEND_R) - onArc) * n;
  } else {
    vec2 E = vec2(WING_BEND_R * sin(ang), WING_BEND_R - WING_BEND_R * cos(ang));
    ab = E + vec2(cos(ang), sin(ang)) * (sig - arcLen) + vec2(-sin(ang), cos(ang)) * n;
  }
  float cs = cos(th), sn = sin(th);
  return vec3(x, wingTipYEnd() + ab.x * sn + ab.y * cs, WING_MAIN_END_Z + ab.x * cs - ab.y * sn);
}

struct WingTipCoord { float sig; float n; float xi; float c; float halfT; float cam; float arcLen; float wlLen; };

WingTipCoord wingTipCoord(vec3 P) {
  WingTipCoord q;
  vec2 sn = wingTipPath(P, q.arcLen);
  q.wlLen = WINGLET_H - WING_BEND_R;
  q.sig = sn.x;
  q.n = sn.y;
  q.c = wingTipChord(q.sig, q.arcLen, q.wlLen);
  q.xi = (wingTipLE(q.sig, q.arcLen) - P.x) / q.c;
  float bend = smoothstep(0.0, q.arcLen, q.sig);
  float h = clamp((q.sig - q.arcLen) / q.wlLen, 0.0, 1.0);
  // 顶端收圆
  q.halfT = q.c * mix(wingTcAt(WING_S_END), 0.09, bend) * wingNacaHalf(q.xi) * sqrt(1.0 - smoothstep(0.9, 1.0, h));
  q.cam = wingCamberAt(q.xi, q.c) * (1.0 - 0.6 * bend);
  return q;
}

float sdWingTip(vec3 P) {
  // 包围：离翼尖很远时直接返回一个保守的距离，省掉 atan。
  // 只在离得足够远（> 0.5 m）时才用包围距离：包围面本身不是几何，射线贴近它时会被当成「擦边」甚至「命中」
  float outside = (WING_MAIN_END_Z - 1.7) - P.z;
  if (outside > 0.0) return outside + 0.5;
  WingTipCoord q = wingTipCoord(P);
  float dn = abs(q.n - q.cam) - q.halfT;
  float dx = max(-q.xi, q.xi - 1.0) * q.c * 0.8;
  float ds = max(-q.sig - 0.02, q.sig - (q.arcLen + q.wlLen));
  return max(max(dn, dx), ds);
}

// ---- Fowler 襟翼：先向后滑出（前 10° 主要是滑出），再绕铰链下偏 ----
float sdWingFlap(vec3 P) {
  if (uFlap < 1e-3) return 1e3;
  float s = wingSpanS(P.z);
  float c = wingChordAt(s);
  float xm = wingLeX(P.z) - P.x;                // 离前缘多少米（向后为正）
  float f = smoothstep(0.0, 0.3, uFlap);
  float qa = xm - WING_FLAP_LE * c - 0.22 * c * f;
  float qb = P.y - (wingBaseY(P.z, s) + wingCamberAt(WING_FLAP_LE, c)) + 0.03 * c * f;
  float cs = cos(uFlap), sn = sin(uFlap);
  float u = qa * cs - qb * sn;
  float v = qa * sn + qb * cs;
  float cf = (1.0 - WING_FLAP_LE) * c;
  float xiF = u / cf;
  float xiO = WING_FLAP_LE + (1.0 - WING_FLAP_LE) * clamp(xiF, 0.0, 1.0);  // 对应原翼型的弦向位置
  float hF = c * wingTcAt(s) * wingNacaHalf(xiO) * sqrt(clamp(xiF / 0.12, 0.0, 1.0));
  float cam = wingCamberAt(xiO, c) - wingCamberAt(WING_FLAP_LE, c);
  float dv = abs(v - cam) - hF;
  float du = max(-xiF, xiF - 1.0) * cf;
  float dz = max(ROOT_Z + WING_FLAP_S0 * WING_SPAN - P.z, P.z - (ROOT_Z + WING_FLAP_S1 * WING_SPAN));
  dz = max(dz, 0.04 - abs(P.z - (ROOT_Z + WING_FLAP_SPLIT * WING_SPAN))); // 内外襟翼之间的缝
  return max(max(dv, du), dz);
}

// 扰流板：主翼上表面的一块板，绕前缘铰链上翻
float sdWingSpoiler(vec3 P) {
  if (uSpoiler < 1e-3) return 1e3;
  float s = wingSpanS(P.z);
  float c = wingChordAt(s);
  float xm = wingLeX(P.z) - P.x;
  float hy = wingBaseY(P.z, s) + wingCamberAt(WING_SPOILER_XI, c) + c * wingTcAt(s) * wingNacaHalf(WING_SPOILER_XI);
  float L = (WING_SHROUD_TE - WING_SPOILER_XI) * c;
  float qa = xm - WING_SPOILER_XI * c;
  float qb = P.y - hy;
  float cs = cos(uSpoiler), sn = sin(uSpoiler);
  float u = qa * cs + qb * sn;
  float v = -qa * sn + qb * cs;
  float th = 0.03 * (1.0 - 0.6 * clamp(u / L, 0.0, 1.0));
  float dv = abs(v + th) - th;
  float du = max(-u, u - L);
  float dz = max(ROOT_Z + WING_SPOILER_S0 * WING_SPAN - P.z, P.z - (ROOT_Z + WING_SPOILER_S1 * WING_SPAN));
  // 五块板之间的缝
  float seg = fract((s - WING_SPOILER_S0) / (WING_SPOILER_S1 - WING_SPOILER_S0) * 5.0);
  dz = max(dz, 0.03 - min(seg, 1.0 - seg) * (WING_SPOILER_S1 - WING_SPOILER_S0) * WING_SPAN / 5.0);
  return max(max(dv, du), dz);
}

// 前缘缝翼：原翼型最前面 12%，下表面是凹进去的「缝翼槽」；伸出时向前、向下并低头
float sdWingSlat(vec3 P) {
  if (uSlat < 1e-3) return 1e3;
  float s = wingSpanS(P.z);
  float c = wingChordAt(s);
  float xm = wingLeX(P.z) - P.x;
  float px = WING_SLAT_XI * c;
  float qa = xm - px + 0.12 * c * uSlat;
  float qb = P.y - (wingBaseY(P.z, s) + wingCamberAt(WING_SLAT_XI, c)) + 0.06 * c * uSlat;
  float cs = cos(uSlat), sn = sin(uSlat);
  float a = qa * cs + qb * sn;
  float b = -qa * sn + qb * cs;
  float xiL = (px + a) / c;
  float mid = wingCamberAt(xiL, c) - wingCamberAt(WING_SLAT_XI, c);
  float hT = c * wingTcAt(s) * wingNacaHalf(xiL);
  float up = mid + hT;
  float lo = mid - hT * (1.0 - 1.8 * smoothstep(0.02, WING_SLAT_XI, xiL));
  float dy = abs(b - 0.5 * (up + lo)) - 0.5 * (up - lo);
  float dx = max(-xiL, xiL - WING_SLAT_XI) * c;
  float dz = max(ROOT_Z + WING_SLAT_S0 * WING_SPAN - P.z, P.z - (ROOT_Z + WING_SLAT_S1 * WING_SPAN));
  return max(max(dy, dx), dz);
}

// 襟翼滑轨整流罩（flap track fairing）：挂在下表面、伸出后缘的「独木舟」，钝尾。
// 前半截固定在机翼上；后半截（铰链之后）跟着襟翼整体绕铰链转——刚体转动，不做剪切，放下时尾段不会拉成犄角、前段也不会鼓包
// 截面是椭圆（半宽 W、半高 H）；u 是沿轴线的相对位置，r(u) 是截面缩放：椭圆头 → 等粗 → 收细到钝尾
float wingCanoe(float u, float yRel, float zRel, float len) {
  float uc = clamp(u, 0.0, 1.0);
  // 扁窄的独木舟（协调者定稿参数）：头部椭圆，最宽处约 18 cm 宽、40 cm 高；轴线顺着气流、整体略微上翘（不做下弯的弧）；
  // 伸出后缘的那一小段收成窄的扁尾：宽收到 25%、高收到 45%，尾端平切（不是圆头）
  float head = uc < 0.2 ? sqrt(max(1.0 - pow((0.2 - uc) / 0.2, 2.0), 0.0)) : 1.0;
  float tail = smoothstep(0.55, 1.0, uc);
  float wz = max(0.09 * head * mix(1.0, 0.25, tail), 0.004);
  float hy = max(0.2 * head * mix(1.0, 0.45, tail), 0.004);
  float yc = 0.1 * uc;                                   // 顺着气流、略微上翘（直线，不是弧）
  vec2 q = vec2(zRel / wz, (yRel - yc) / hy);
  float d = (length(q) - 1.0) * min(wz, hy);
  return max(d, max(-u, u - 1.0) * len);
}

float sdWingFairing(vec3 P) {
  float s = wingSpanS(P.z);
  float sf = abs(s - WING_FAIR_S1) < abs(s - WING_FAIR_S2) ? WING_FAIR_S1 : (abs(s - WING_FAIR_S2) < abs(s - WING_FAIR_S3) ? WING_FAIR_S2 : WING_FAIR_S3);
  float zf = ROOT_Z + sf * WING_SPAN;
  float c = wingChordAt(sf);
  // 轴线：铰链处下表面往下 0.16 m，一条直线（不跟着翼型弯）
  float hx = WING_FLAP_LE * c;
  float hy = wingBaseY(zf, sf) + wingCamberAt(WING_FLAP_LE, c) - c * wingTcAt(sf) * wingNacaHalf(WING_FLAP_LE) - 0.16;
  // 包围：展向 ±0.2 m、竖直方向不高于轴线以上 0.35 m（独木舟最高处约 0.3 m）。两者取大，都是真实距离的下界。
  // 旧版只按展向距离 |z − zf| 包围，翼面上方的点离整流罩几米高，距离场却只报几十厘米；
  // 自阴影的软阴影估计（14·d / 走过的距离）把它当成「擦边」，整片上翼面被压暗成一圈圈年轮纹（T22 根因）
  float bound = max(abs(P.z - zf) - 0.2, P.y - (hy + 0.35));
  if (bound > 0.3) return bound;
  float xm = wingLeX(zf) - P.x;
  float x0 = 0.45 * c;
  float len = 0.635 * c;   // 从 0.45c 到约 1.085c：只比后缘多出一小截（约 0.085c，旧版的一半）
  float uh = (hx - x0) / len;
  // 前半截
  float u0 = (xm - x0) / len;
  float dFront = max(wingCanoe(u0, P.y - hy, P.z - zf, len), (u0 - uh - 0.03) * len);
  // 后半截：转到襟翼的坐标里（和 sdWingFlap 一样的转法，只转不滑）
  float cs = cos(uFlap), sn = sin(uFlap);
  vec2 q = vec2(xm - hx, P.y - hy);
  vec2 l = vec2(q.x * cs - q.y * sn, q.x * sn + q.y * cs);
  float u1 = (hx + l.x - x0) / len;
  float dAft = max(wingCanoe(u1, l.y, P.z - zf, len), (uh - 0.03 - u1) * len);
  // 独木舟的椭圆距离在远处按短轴缩放、严重低估（尾段只有真实距离的 1/4），同样取包围的下界兜底
  return max(min(dFront, dAft), bound);
}

// 发动机短舱 + 吊挂。u = 从进气道唇口向后的距离
float wingEngInletX() { return wingLeX(WING_ENG_Z) + 2.6; }
float sdWingNacelle(vec3 P) {
  float u = wingEngInletX() - P.x;
  vec3 cen = vec3(wingEngInletX() - 2.4, WING_ENG_Y + 0.3, WING_ENG_Z);
  float bound = length(P - cen) - 3.3;
  if (bound > 0.3) return bound;
  float rr = length(P.yz - vec2(WING_ENG_Y, WING_ENG_Z));
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
  // 截面是圆角矩形（倒角 0.1 m），前端顺着短舱斜着降下去，后段收低成尖的整流尾，不是一块方盒
  vec3 pp = P - vec3(wingEngInletX() - 2.75, WING_ENG_Y + 0.95, WING_ENG_Z);
  vec3 qb = abs(pp) - vec3(2.15, 0.3, 0.13) + vec3(0.1);
  float dPy = length(max(qb, 0.0)) + min(max(qb.x, max(qb.y, qb.z)), 0.0) - 0.1;
  float front = P.y - (WING_ENG_Y + 0.95 + 0.3 * clamp((u - 0.6) / 1.2, 0.0, 1.0));
  float aft = P.y - (WING_ENG_Y + 1.25 - 0.55 * clamp((u - 3.4) / 1.5, 0.0, 1.0));
  dPy = max(dPy, max(front, aft) * 0.8);
  return min(min(min(dCowl, dSpin), dCore), dPy) * 0.85;
}

// 部件编号：0 主翼，1 翼尖 / 小翼，2 襟翼，3 扰流板，4 缝翼，5 滑轨整流罩，6 短舱 / 吊挂。sdWing 顺手记下最近的部件
int gWingPart = 0;
// 算自阴影时跳过着色点自己所在的部件（主翼和翼尖算一组）：凸的翼面对自己的「擦边」会被软阴影估计成半影，
// 翼面上出现一圈圈木纹似的明暗条带。−1 = 不跳过
int gWingSkip = -1;
// 命中点的曲率 1/R（1/m，四面体采样的拉普拉斯估计，见 wingTrace）。shadeWing 用它估计一个像素里法线转过多少，
// 给翼尖灯照明的地平线做像素足迹滤波（W-LAMP）。不放进 WingTraceResult：结构体每多一个字段，五条射线的结果都要多占寄存器
float gWingCurv = 0.0;

float sdWing(vec3 P) {
  float d = gWingSkip == 0 ? 1e3 : sdWingMain(P);
  int id = 0;
  float x = gWingSkip == 0 ? 1e3 : sdWingTip(P);      if (x < d) { d = x; id = 1; }
  x = gWingSkip == 2 ? 1e3 : sdWingFlap(P);           if (x < d) { d = x; id = 2; }
  x = gWingSkip == 3 ? 1e3 : sdWingSpoiler(P);        if (x < d) { d = x; id = 3; }
  x = gWingSkip == 4 ? 1e3 : sdWingSlat(P);           if (x < d) { d = x; id = 4; }
  x = gWingSkip == 5 ? 1e3 : sdWingFairing(P);        if (x < d) { d = x; id = 5; }
  x = gWingSkip == 6 ? 1e3 : sdWingNacelle(P);        if (x < d) { d = x; id = 6; }
  gWingPart = id;
  return d;
}

// 一个像素在单位距离上对应的长度（弧度）
float wingPixelAngle() { return 2.0 * uTanHalfFov / uResolution.y; }

// 整架机翼（含小翼、放下的襟翼、短舱）的包围盒，机体坐标（米），四周留了余量
const vec3 WING_BOX_MIN = vec3(-10.0, -3.6, 1.8);
const vec3 WING_BOX_MAX = vec3(1.4, 4.2, 17.6);

// 机身挡住阳光：从 P 朝太阳的射线是否穿过机身圆柱（轴线沿 X）
float wingFuselageShadow(vec3 P, vec3 l) {
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

struct WingTraceResult {
  float t;       // 命中距离（座舱系，米）；擦边时是离机翼最近的地方；没打到是 −1
  float cov;     // 覆盖率：打中 1，擦边按「最近距离 / 像素宽度」解析算出（轮廓抗锯齿，不用屏幕导数），没打到 0
  vec3 nA;       // 法线（机体系），已经掰到朝向视线的一侧
  vec3 nGeo;     // 不带油罐鼓包的几何法线（翼尖灯照明用，见 shadeWing）
  float shadow;  // 机翼自身的软阴影（小翼、短舱、扰流板、整流罩投到翼面上），1 = 不挡
  int part;      // 部件编号（见 gWingPart）
  bool inner;    // 打中之前先擦过另一处轮廓（内轮廓）
  float tGraze;  // 内轮廓：第一次擦过别的部件时离它最近的那一步的距离（边缘超采样的子射线从这里附近出发）
  int steps;     // 求交用了几步（边缘超采样的子射线共用一份步数预算）
  float bumpVar; // 按像素足迹滤掉的油罐鼓包斜率方差（并入粗糙度）
  bool edge;     // 打中之前先擦过另一处轮廓（襟翼压在主翼上、小翼压在翼面上这类「内轮廓」），或者打中的是几乎侧对视线的薄边
};
// bumpVar < 0 表示「饿死」的子射线（W-STAIR）：共用的步数用完时还在包围盒里，按「打中」算，但不着色（沿用中心射线的颜色，见 wingView）。
// 借 bumpVar 做标记而不是另加一个 bool 字段：结构体每多一个字段，五条射线的结果都要多占寄存器
bool wingStarved(WingTraceResult w) { return w.bumpVar < 0.0; }

// 外轮廓的解析覆盖率（W-EDGE）：像素中心离轮廓 s 个像素（外正内负），轮廓在一个像素里当成直线，
// 它的法线 nA（机体系）投到屏幕上是 (a, b)。覆盖率 = 正方形像素落在轮廓内侧的面积（盒滤波，和超采样的参考图同一个口径）：
// 正方形沿 (a, b) 的投影是宽 a、宽 b 两段均匀分布的卷积（梯形），面积就是这个梯形分布的累积——两头二次、中间线性。
// 轮廓和像素网格对齐时过渡宽 1 像素、线性；斜 45° 时宽 1.41 像素、两头圆。s ≥ 0.71 一定是 0，≤ −0.71 一定是 1
float wingEdgeCov(float s, vec3 nA) {
  vec3 nc = vec3(uSeatSign * nA.x, nA.y, nA.z);
  vec2 ab = abs(vec2(dot(nc, uCamBasis[0]), dot(nc, uCamBasis[1])));
  float l = length(ab);
  ab = l > 1e-4 ? ab / l : vec2(0.0, 1.0);
  float lo = max(min(ab.x, ab.y), 1e-3);
  float hi = max(ab.x, ab.y);
  float h = 0.5 * (lo + hi);
  float x = clamp(-s, -h, h);
  if (x < lo - h) return (x + h) * (x + h) / (2.0 * lo * hi);
  if (x > h - lo) return 1.0 - (h - x) * (h - x) / (2.0 * lo * hi);
  return (x + h - 0.5 * lo) / hi;
}

vec3 wingTetraDir(int i) {
  return vec3(float(((i + 3) >> 1) & 1), float((i >> 1) & 1), float(i & 1)) * 2.0 - 1.0;
}

// 视线（座舱系）与机翼：求交 → 法线 → 朝光源的自阴影，三段共用一个循环、一处 sdWing 调用。
// 为什么这么写：FXC（Windows 上 ANGLE 的后端）会把每一处函数调用都内联展开；sdWing 很大，
// 求交、法线、阴影各调一处时整个场景着色器冷编译从约 40 秒涨到 85–95 秒，而且首次加载时出现过 VALIDATE_STATUS false + 上下文丢失。
// 循环次数都依赖 uniform，FXC 也不会展开循环。
// 求交的命中阈值取亚像素（旧版取 0.002·t，约两个像素，擦边的射线命中与否取决于步进落点，轮廓成了阶梯）。
// marchSteps：求交最多走几步；shadowSteps：自阴影步数。边缘超采样的子射线从中心射线命中点附近出发，
// 传较少的步数、不算阴影（沿用中心射线的）——一个 warp 里只要有一个边缘像素，整个 warp 都得等它走完。
// tJump：内轮廓像素的子射线擦过前面的部件以后直接跳到这个距离（中心射线已经确认前面是空的）；−1 = 不跳
WingTraceResult wingTrace(vec3 ro, vec3 rd, float tStart, vec3 lA, int marchSteps, int shadowSteps, float tJump) {
  WingTraceResult w;
  w.t = -1.0;
  w.cov = 0.0;
  w.nA = vec3(0.0, 1.0, 0.0);
  w.nGeo = w.nA;
  w.shadow = 1.0;
  w.part = 0;
  w.edge = false;
  w.inner = false;
  w.tGraze = -1.0;
  w.steps = 0;
  w.bumpVar = 0.0;
  float pa = wingPixelAngle();
  vec3 oA = wingCabinToAircraft(ro);
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
  float rPrev = 1e9;
  float tPrev = 0.0;
  bool grazed = false;
  float dHit = 0.0;     // 命中点的距离场值（算曲率用）
  float sumD = 0.0;     // 四面体四个采样的和  // 走过一个「离表面不到一个像素、然后又远离」的地方
  int phase = 0;        // 0 求交，1 法线（四面体四次采样），2 自阴影
  int j = 0;
  vec3 P = vec3(0.0);
  vec3 n = vec3(0.0);
  float ts = 0.12;
  float res = 1.0;
  // 求交的步数上限：中心射线贴着表面掠射（外轮廓附近）时可以延长到 3 倍，见下面「步数用完」一段
  int limit = marchSteps;
  // 外轮廓解析覆盖率（W-EDGE，见法线段末尾）：探测段 ≤ 14 步、延续段 ≤ 64 步，只有中心射线（带自阴影的）会走
  int total = marchSteps * 3 + 4 + shadowSteps + (shadowSteps > 0 ? 80 : 0);
  // w.cov > 1.5：解析覆盖率待定（W-EDGE），像素中心离外轮廓 w.cov − 3 个像素（外正内负），循环结束后按 wingEdgeCov 出覆盖率。
  // 探测段（phase 3）不另开变量（冷编译对「跨循环活着的变量」很敏感），借用法线段用完的：
  // n.x = 弦上最低采样点离命中点的距离，sumD = 那一点的距离场值，dHit = 它前一个采样点的值，n.y = 入射处的 |n·v|，n.z = 已走的步数
  for (int i = min(uWingSteps, 0); i < total; i++) {
    vec3 q = phase == 1 ? P + wingTetraDir(j) * 0.0023 : (phase == 2 ? P + w.nA * 0.01 + lA * ts : oA + dA * t);
    float d = sdWing(q);
    if (phase == 0) {
      float fp = pa * t;                    // 这里一个像素多宽（米）
      // 命中阈值：子射线 0.4 个像素；中心射线 0.05 个像素（W-EDGE）。中心射线按 0.4 算命中时，离表面 0.05–0.4 个像素的擦边射线
      // 也进探测段，探测段第一步就往上、深度取命中那一步的距离场值——它取决于步进落点，逐帧乱跳（sunset 主翼前缘飞行中爬行翻倍）。
      // 阈值小了这些射线接着走，按「没打中」用外侧解析覆盖率（最近距离取自球体追踪的小步，误差约 0.01）。
      // 着色点仍取第一次进到 0.4 个像素以内的那一步（w.t，见下面的 else 分支）：着色点落到真表面上时，夜里被翼尖灯照亮的薄边
      // （小翼后缘、翼尖端面）法线极端，单样本一串白点逐帧闪（夜间「翼尖灯与主翼前缘」闪烁像素 15 → 60）。
      // 真命中那一步记在 tBest（命中以后 tBest 不再用于「最近点」），探测段从它出发
      float hthr = shadowSteps > 0 ? 0.05 : 0.4;
      bool done = false;
      if (d < 0.4 * fp && j == 5 && gWingPart != w.part) {
        // 延续段（W-EDGE，j == 5）打到别的部件（短舱压在翼面上、小翼前缘压在主翼上……）：轮廓背后还是机翼，
        // 解析覆盖率不知道后面是什么颜色，照旧超采样。又擦到同一块表面（弦出口附近）不算，接着走
        w.edge = true;
        w.cov = 1.0;
        phase = 2;
      } else if (d < hthr * fp && j != 5) {
        if (w.t < 0.0) { w.t = t; dHit = d; }
        tBest = t;
        w.cov = 1.0;
        w.part = gWingPart;
        w.edge = grazed;
        w.inner = grazed;
        done = true;
      } else {
        float r = d / fp;
        // 中心射线进到 0.4 个像素以内：先记下着色点（旧的命中点）接着走；又离开了（擦过前面的部件、内轮廓）就作废
        if (d < 0.4 * fp && w.t < 0.0 && j != 5 && shadowSteps > 0) { w.t = t; dHit = d; }
        else if (d >= 0.4 * fp && j != 5 && w.t >= 0.0) w.t = -1.0;
        if (r < best) { best = r; tBest = t; partBest = gWingPart; }
        // 擦边判定取 2 个像素（W-STAIR）：旧版取 1 个像素，球体追踪的采样点常常跨过最近点附近（步长 ≈ 0.6·d），
        // 同一条内轮廓（整流罩后缘压在襟翼上）上的像素一个判成边缘、一个没判上，超采样隔一个做一个，边上一串虚线似的台阶
        if (rPrev < 2.0 && r > rPrev) {
          if (!grazed) w.tGraze = tPrev;
          grazed = true;
        }
        rPrev = r;
        tPrev = t;
        // 距离场只是近似（盒子式组合 + 翼型前缘陡），近处步长打六折保险；离得远（> 0.3 m）时相对误差小，打八五折省步数。
        // 最小步长取亚像素，免得穿过毫米级的后缘
        t += max(d * (d > 0.3 ? 0.85 : 0.6), max(0.3 * fp, 0.002));
        // 内轮廓像素的子射线（tJump > 0）：已经擦过前面的部件（离它最近不到 3 个像素、现在远离了 1 个像素以上），
        // 直接跳到中心射线命中后面那个部件之前几个像素的地方（中心射线已经确认这段是空的）。
        // 否则它要贴着前面部件的下表面一步步远离，几十步才走到后面的短舱 / 整流罩（PERF-3）
        if (tJump > t && best < 3.0 && r > best + 1.0) {
          t = tJump;
          tJump = -1.0;
          best = 1e9;
          rPrev = 1e9;
        }
        // 掠射：还在包围盒里、离表面不到 3 个像素、还没过最近点（r 没比最近时大出一个像素）
        bool approaching = t <= tExit && best < 3.0 && r < best + 1.0;
        bool nearGraze = approaching && marchSteps == uWingSteps;
        // 轮廓附近的射线几乎和表面相切，球体追踪每步只能挪近一点点。从上方斜看前缘时，边缘超采样的子射线（64 步）
        // 走不到前缘就用完了，四条都算「没打中」，这个像素整个露出背景——前缘外轮廓成了一级级 1 像素的硬台阶
        // （T22，穿云场景最明显）；中心射线同理（128 步用完一律算打中）。
        // 这种射线再给步数（最多 3 倍），走完以后按真正的最近距离算。只落在轮廓附近一两个像素宽的一条线上
        bool extend = approaching && i >= limit - 1 && limit < 3 * marchSteps && marchSteps == uWingSteps && (uWingDebug & 64) == 0 && j != 5;
        if (extend) limit += marchSteps;
        if (!extend && (t > tExit || i >= limit - 1) && j == 5) {
          // 延续段走出包围盒（或步数用完）没打到别的部件：轮廓背后是窗外，用解析覆盖率。
          // 步数给 64（park 版 33）：薄后缘压在整流罩上时，出了弦贴着下表面一步步挪，33 步走不到整流罩，
          // 当成窗外会让内轮廓漏出背后的天空（sunset 后缘一条亮线）。「步数用完一律超采样」试过：外轮廓大量退回超采样，差和反而 +15%
          w.tGraze = -2.0;
          phase = 2;
        } else if (!extend && (t > tExit || i >= limit - 1)) {
          // 像素中心离轮廓 best 个像素：覆盖率按盒滤波解析算（wingEdgeCov，要用法线，法线段末尾再定；这里先占位）。
          // W-EDGE 之前是 1 − best：过渡从命中阈值 0.4 一直拖到 1 个像素外，轮廓整体外扩约半个像素
          w.cov = best < 0.7072 ? 3.0 + best : 0.0;
          // 步数用完时还在包围盒里、离表面不到 3 个像素：多半是贴着表面掠射、一步步挪不完，算打中。
          // 否则边缘超采样的子射线（步数只有 1/4）会被误判成「没打中」，把背后更亮的天空 / 海面混进来，
          // 内轮廓和后缘上出现一串亮点
          // 只对中心射线这样做：边缘超采样的子射线一旦被「提升」成命中，着色点就落在薄后缘外的空中、
          // 法线取的是后缘端面，夕阳下后缘成了一串白点（审查返工第 1 项的根因）
          // 已经过了最近点、正在远离表面的射线是擦边而过，不提升（T22）
          if (nearGraze) w.cov = 1.0;
          // W-STAIR：子射线常在还没走到后面那块表面时就把共用的步数用完——擦过薄后缘以后要一路走到下面的短舱，
          // 或者在内轮廓的缝里（整流罩后缘和襟翼之间）贴着表面挪。以前这算「没打中」，背后的天空 / 云从这条子样本漏进来，
          // 后缘、内轮廓上隔一个像素一个亮点（夕阳下一串亮珠、云里一串白点；调试位 1024 给足步数就消失）。
          // 现在分到的步数不足 uWingSteps/4 的子射线（被前面的子射线挤掉了预算，「饿死」的）还在包围盒里就用完了步数，
          // 算打中，但不在这里着色（着色点在空中、法线不可信，T22 的一串白点），沿用中心射线的颜色（中心射线打中了才会有子射线）。
          // 分到的步数够多还走不完的，多半是擦过外轮廓以后贴着翼面慢慢远离、背后是天空（商务舱正午看前缘），仍按没打中算——
          // 一律按打中算的话外轮廓外扩、斜边的过渡被吃掉，台阶反而更硬（W-STAIR 试过）。
          // 门槛按「与给足步数（调试位 1024）的参考图逐像素比」选：uWingSteps/4 在 sunset-wing / 商务舱正午 / 云里三处都最接近参考，
          // /8 次之，「一律算打中」和「只算还在逼近表面的」都更差。调试位 8192：关掉（旧做法，对照用）
          else if (marchSteps < uWingSteps / 4 && t <= tExit && i >= limit - 1 && (uWingDebug & 8192) == 0) { w.cov = 1.0; w.bumpVar = -1.0; }
          if (w.cov <= 0.0) { w.steps = i + 1; return w; }
          w.t = tBest;
          w.part = partBest;
          done = true;
        }
      }
      if (done) {
        P = oA + dA * w.t;
        phase = 1;
        w.steps = i + 1;
        if (w.bumpVar < 0.0) break;   // 饿死的子射线：不着色，法线也不用算
      }
    } else if (phase == 1) {
      n += wingTetraDir(j) * d;
      sumD += d;
      j++;
      if (j == 4) {
        n = normalize(n);
        // 蒙皮在翼肋（展向约 0.6 m 一道）和桁条（弦向约 0.2 m 一道）之间微微鼓起（「油罐效应」），天空的倒影因此轻轻起伏。
        // 用解析的鼓包 h = A·(1−cos 2πa)(1−cos 2πb)/4，梯度在格子边界处为零，法线处处连续。
        // 旧写法用值噪声直接当法线扰动：值噪声的导数不连续，近看时反射被切成一块块的「碎面台阶」
        // 肋距 / 桁距不是等距的：坐标用一维值噪声扭一下，每格宽窄差 ±15%（导数 < 0.5，坐标仍单调，格子不会折叠）；
        // 鼓的幅度逐格 0.5–1 倍随机。规则网格在远处和掠射角下会和像素网格干涉出一圈圈的纹（铁律：随机性造就真实）
        vec2 cell = vec2(P.z / 0.6, P.x / 0.2);
        cell += 0.15 * (vec2(vnoise(vec2(cell.x, 3.7)), vnoise(vec2(cell.y, 9.1))) * 2.0 - 1.0);
        vec2 fc = fract(cell);
        float amp = 0.0005 * (0.5 + 0.5 * hash12(floor(cell) + 7.1));   // 每格鼓得不一样（米）
        vec2 g = vec2(
          sin(6.2832 * fc.x) * (1.0 - cos(6.2832 * fc.y)) * 6.2832 / 0.6,
          (1.0 - cos(6.2832 * fc.x)) * sin(6.2832 * fc.y) * 6.2832 / 0.2) * amp * 0.25;
        // 按像素足迹淡出（LEAN 的思路）：桁距 0.2 m 的起伏在一个像素里放不下几个周期时，逐像素的法线只剩欠采样的噪声，
        // 换成平均法线 + 把滤掉的斜率方差并入粗糙度（shadeWing 里 α² += 2σ²）。足迹按掠射拉长（1/(n·v)）。
        // σ² 取这组鼓包斜率的均方值：A²/16 · 1.5 · 0.5 · (2π/0.2)²，A 取平均幅度
        float fpB = pa * w.t / max(abs(dot(n, dA)), 0.2);
        float keepB = 1.0 - smoothstep(0.03, 0.1, fpB);
        g *= keepB;
        // 只作用在主翼上下表面（法线大致朝上 / 朝下时），g = (∂h/∂z, ∂h/∂x)
        float flatness = (w.part == 0 && (uWingDebug & 1) == 0) ? abs(n.y) : 0.0;   // 只作用在主翼蒙皮上：圆弧前缘、襟翼、小翼上会被拉成一块块的斑
        float bumpVar = (1.0 - keepB * keepB) * 6.5e-6;   // (0.375 mm / 4)² · 0.75 · (2π / 0.2 m)² ≈ 6.5e-6
        vec3 nFlat = n;
        n = normalize(n - vec3(g.y, 0.0, g.x) * flatness * sign(n.y));
        w.bumpVar = bumpVar * flatness;
        // 背向视线的法线（轮廓上、后缘这种薄边上常见）掰到略微朝向视线，而不是整个翻过来：
        // 翻转会让相邻像素在上、下表面的法线之间跳，后缘成了一串亮点
        float ndv = dot(n, -dA);
        // 离外轮廓还有几个像素？局部当成半径 R 的凸面，命中点离切线轮廓 ≈ R·(n·v)²/2（米）。
        // R 由四面体采样的拉普拉斯估计：Σd_i − 4d₀ ≈ 2h²·∇²d，∇²d ≈ 1/R（取柱面，偏保守）。
        // 薄后缘、盒子式拼接的棱角处 ∇²d 很大，R 很小，自然也算边缘像素。只按 |n·v| 判断的话，
        // 斜着看的大片翼面（夕阳场景约 4% 的像素）都会被当成边缘去超采样，白白多花 1 毫秒多
        float lap = (sumD - 4.0 * dHit) / (2.0 * 0.0023 * 0.0023);
        float rad = 1.0 / max(lap, 1e-3);
        gWingCurv = max(lap, 0.0);
        float silPx = rad * ndv * ndv * 0.5 / (pa * w.t);
        if (silPx < 1.5) w.edge = true;
        if (ndv < 0.05) n = normalize(n - dA * (0.05 - ndv));
        w.nA = n;
        w.nGeo = nFlat;
        // 擦边没打中：解析覆盖率（法线在最近点处，正好垂直于视线，投到屏幕上就是轮廓的法向）
        // W-EDGE：打中了、不是内轮廓的中心射线，先探测「像素中心在轮廓里面多深」，再看轮廓背后是不是窗外，
        // 是的话按解析覆盖率出结果、不做边缘超采样（见下面的探测段、延续段）。
        // 每个命中都要验：曲率判远（silPx ≥ 3 且 n·v ≥ 0.12）的先只在 0.75 个像素深处采一次（n.z = 13 标记），够深（> 0.71 像素）
        // 就是覆盖率 1，不够再从头探测。park 版只探测曲率判近的：拉普拉斯曲率逐像素跳、折角轮廓（小翼后缘）上是 0，
        // 同一个像素逐帧在「不探测、覆盖率 1」和「探测、≈ 0.5」之间切，飞行中沿轮廓爬（sunset 小翼后缘最明显）
        if (w.cov == 1.0 && !grazed && shadowSteps > 0 && (uWingEdgeAA == 1 || uWingEdgeAA == 2) && (uWingDebug & 16384) == 0) {
          bool nearSil = silPx < 3.0 || dot(nFlat, -dA) < 0.12;
          phase = 3;
          n = vec3(0.0, max(dot(nFlat, -dA), 0.02), nearSil ? 0.0 : 13.0);
          sumD = min(dHit, 0.0);
          t = tBest + (nearSil ? 0.15 : 0.75) * pa * w.t / n.y;
        } else phase = 2;
        // 不要自阴影的调用（边缘超采样的子射线，沿用中心射线的阴影）到这里就结束。
        // 以前 shadowSteps = 0 只是少算了循环总数，阴影段照样走到循环用完（子射线 64·3+4 次里剩下的一百多次），
        // 结果又被中心射线的阴影覆盖——夜景里边缘超采样约四成的迭代白花了（PERF-3）
        if (shadowSteps <= 0) break;
      }
    } else if (phase == 3) {
      // 探测段（W-EDGE）：沿视线往表面里面等步长走，找弦上距离场的最小值（< 0）。光滑的凸轮廓（圆前缘、短舱、小翼前缘）上，
      // 最低点处离表面最近的方向垂直于视线，|最小值| 就是像素中心到轮廓的屏幕距离——经典的距离场抗锯齿，只是把「外侧的最近距离」
      // 推广到内侧，两边连续。部分覆盖的像素深度 < 0.71 像素，最低点（半弦长）< 1.42 像素 / (n·v)，步长取 0.15 像素 / (n·v)，12 步够
      float dS = 0.15 * pa * w.t / n.y;
      if (d < -0.7072 * pa * t) {
        // 离表面超过 0.71 个像素的点：以它为心、半径 0.71 像素的球都在机翼里，整个像素的视线都要穿过它——覆盖率就是 1，不用超采样
        w.tGraze = -2.0;
        phase = 2;
      } else if (d <= sumD && n.z < 12.0) {
        dHit = sumD;
        sumD = d;
        n.x = t - tBest;
        n.z += 1.0;
        t += dS;
      } else if (n.z > 12.5) {
        // 曲率判远的一次性验深没过：从入口重新按小步探测
        n.z = 0.0;
        t = tBest + 0.15 * pa * w.t / n.y;
      } else if (d <= sumD) {
        // 走完还没见底：放弃，照旧（w.edge 的像素超采样）。
        // park 版这里还有「折角 → 超采样」（最低点两侧的差 > 0.6·斜率·步长）：判据随采样相位来回翻，
        // 解析覆盖率与超采样（子射线命中阈值 0.4 像素，偏高约 +0.15）逐帧切换，是小翼前缘飞行中爬行的主因之一，去掉了。
        // 折角的 |最小值| 按楔形几何（两面斜率都不大时）本来就接近到棱的屏幕距离
        phase = 2;
      } else {
        // 深度另取几何估计：光滑凸面的弦上最低点在弦中点，深度 = 入射斜率 × 半弦长 / 2（圆截面精确）。盒子式拼接 / 按比例缩放的部件
        // （襟翼滑轨整流罩、短舱）内部的距离场偏小，只看最小值时轮廓内侧覆盖率偏低（商务舱正午整流罩下沿一圈低 0.25 以上）；两者取深的。
        // 第一步就往上（n.x = 0）：射线其实从表面外擦过（命中只是阈值给的），最近点就在入口
        float sEdge = (sumD < 0.0 ? min(sumD, -0.5 * n.y * n.x) : sumD) / (pa * (w.t + n.x));
        // 整个像素都在里面（不用超采样）；否则从弦的出口（光滑凸面约在最低点的两倍处）再往后一个像素，
        // 用求交段接着走（j = 5 标记延续段），看轮廓背后是什么
        if (sEdge < -0.7072) { w.tGraze = -2.0; phase = 2; }
        // 审查返工（必须项）：命中部件是滑轨整流罩（part == 5）时不走解析覆盖率，改回 RGSS 超采样。
        // 整流罩是盒子式拼接的距离场（wingCanoe），外侧最近距离偏小、内侧深度也偏浅（序列法按路径统计：
        // 码 1 外侧解析 +0.113、码 2 探测→解析 −0.155），像素中心从「擦边没打中」变成「打中」时覆盖率不升反降约 0.27，
        // 轮廓上逐帧出现非单调的跳变，飞行中 sunset 整流罩外轮廓带内闪烁像素约 ×4（367–536 对基线 88–122）。
        // 光滑部件（前缘、小翼）上这条路径的误差只有 +0.01，不受影响，不用全局收紧
        else if (w.part == 5) { w.edge = true; phase = 2; }
        else {
          w.cov = 3.0 + sEdge;
          j = 5;
          phase = 0;
          t = tBest + 2.0 * n.x + pa * w.t;
          limit = i + 64;
        }
      }
    } else {
      // 自阴影段的第一步：跳过着色点自己所在的部件（这一步的距离场值作废）；背光面、被机身挡住、襟翼（见下）不用算
      if (ts == 0.12 && gWingSkip == -1) {
        gWingSkip = w.part <= 1 ? 0 : w.part;
        // 襟翼不算自阴影：它贴在整流罩下面，近似的距离场在那条缝里给出一片片硬边的「迷彩」暗斑（穿云时最明显）；
        // 襟翼前段被整流罩挡住的部分已经在材质里按弦向位置压暗
        if (dot(w.nA, lA) <= 0.0 || wingFuselageShadow(P, lA) <= 0.0 || w.part == 2) break;
        continue;
      }
      // 软阴影：半影按「最近距离 / 走过的距离」估计
      // 半影系数取大一点（阴影边更硬）：距离场是近似的，系数小时襟翼、整流罩上的软阴影边缘被拉成一团团斑块
      res = min(res, 14.0 * d / ts);
      if (res < 0.02) break;
      ts += clamp(d * 0.8, 0.05, 1.5);
      if (ts > 24.0) break;
    }
  }
  // 解析覆盖率（W-EDGE）：擦边没打中的、探测段确认背后是窗外的，都在这里按像素中心离轮廓的距离出覆盖率（放在循环外面，冷编译省）
  if (w.cov > 1.5) w.cov = wingEdgeCov(w.cov - 3.0, w.nGeo);
  gWingSkip = -1;
  w.shadow = (uWingDebug & 8) != 0 ? 1.0 : smoothstep(0.0, 1.0, res);
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
float wingSeam(float x, float width, float fw) {
  float w = max(fw, 1e-5);
  return 1.0 - smoothstep(width * 0.5, width * 0.5 + w, abs(x));
}

// 按像素足迹淡出的 fbm：某个倍频的周期短于约两个像素时换成它的平均值（0.5），远处不闪、不出摩尔纹。
// fw 是 p 在一个像素内的变化量（取变化最快的那个方向）
float wingFbmAA(vec2 p, float fw) {
  float s = 0.0, a = 0.5;
  for (int i = min(uWingSteps, 0); i < 4; i++) {  // 起点依赖 uniform：不让 FXC 展开
    float keep = 1.0 - smoothstep(0.25, 0.5, fw);
    s += a * mix(0.5, vnoise(p), keep);
    p = p * 2.03 + 17.1;
    fw *= 2.03;
    a *= 0.5;
  }
  return s;
}

// coatRough：清漆层的粗糙度（翼面 0.06，光滑的清漆；小翼的航司色涂装 0.15，见 wingTipSurface）
struct WingSurface { vec3 albedo; float metal; float rough; vec3 emit; float coat; float coatRough; };

// 翼面漆：浅灰、半光（清漆层），每块蒙皮板的漆色和光泽略有差别
const vec3 WING_PAINT = vec3(0.70, 0.71, 0.72);
const vec3 WING_LIVERY = vec3(0.045, 0.10, 0.27);   // 小翼上的航司色（示例：深蓝，不对应真实航司）

WingSurface wingPaint(vec3 albedo, float rough) {
  WingSurface m;
  m.albedo = albedo;
  m.metal = 0.0;
  m.rough = rough;
  m.emit = vec3(0.0);
  m.coat = 0.9;
  m.coatRough = 0.06;
  return m;
}

WingSurface wingBareMetal(float albedo, float rough) {
  WingSurface m;
  m.albedo = vec3(albedo, albedo * 1.01, albedo * 1.03);
  m.metal = 1.0;
  m.rough = rough;
  m.emit = vec3(0.0);
  m.coat = 0.0;
  m.coatRough = 0.06;
  return m;
}

// 翼面（主翼、襟翼、扰流板共用）：xi 弦向（相对原翼型），zm 离翼根的展向米数，chord 当地弦长
WingSurface wingSkin(float xi, float zm, float s, float chord, float pix, int part) {
  WingSurface m = wingPaint(WING_PAINT, 0.25);
  float xm = xi * chord;
  float fwX = pix / chord;
  // 前缘缝翼：裸铝，抛光后被雨蚀得略毛。缝翼伸出时还是它
  if (xi < 0.1 || part == 4) m = wingBareMetal(0.86, 0.16 + 0.1 * vnoise(vec2(zm * 3.0, 1.7)));
  // 后缘襟翼、扰流板区域颜色略灰
  if (xi > 0.72 || part == 2) m.albedo *= 0.92;
  // 面板缝：展向（缝翼、前后梁、扰流板铰链、襟翼前缘）+ 弦向（每块扰流板 / 襟翼的分段）
  float lines = 0.0;
  lines = max(lines, wingSeam(xi - 0.1, 0.006 / chord, fwX));
  lines = max(lines, wingSeam(xi - 0.62, 0.004 / chord, fwX));
  lines = max(lines, wingSeam(xi - 0.72, 0.006 / chord, fwX));
  if (xi > 0.62) lines = max(lines, wingSeam(fract(zm / 1.6 + 0.5) - 0.5, 0.004 / 1.6, pix / 1.6));
  if (xi < 0.1) lines = max(lines, wingSeam(fract(zm / 2.4 + 0.5) - 0.5, 0.004 / 2.4, pix / 2.4));
  // 副翼：外侧 25% 展长、后 25% 弦长
  if (s > 0.72) lines = max(lines, wingSeam(s - 0.72, 0.005 / WING_SPAN, pix / WING_SPAN) * step(0.72, xi));
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
    float row = wingSeam(xi - spar, 0.006 / chord, fwX);
    float dots = 1.0 - smoothstep(0.002, 0.003, length(vec2(fract(zm / 0.12) - 0.5, 0.0)) * 0.12);
    m.albedo *= 1.0 - row * mix(0.05, 0.14 * dots, fade);
  }
  if (xi > 0.1 && xi < 0.62 && part == 0) {
    float rib = wingSeam(fract(zm / 0.6 + 0.5) - 0.5, 0.005 / 0.6, pix / 0.6);
    m.albedo *= 1.0 - 0.05 * rib;
  }
  if (part == 0) {
    // 燃油舱检修口：沿展向每 1.5 m 一个椭圆口盖（约 45 × 30 cm），外圈一圈螺钉
    if (xi > 0.3 && xi < 0.55 && zm > 1.0 && zm < 13.0) {
      vec2 pc = vec2(xm - (0.42 * chord), fract(zm / 1.5 + 0.5) * 1.5 - 0.75);
      float e = length(pc / vec2(0.15, 0.225));
      float ring = wingSeam(e - 1.0, 0.012 / 0.2, pix / 0.2);
      m.albedo *= 1.0 - 0.25 * ring;
      float ang = atan(pc.y / 0.225, pc.x / 0.15);
      float nearRing = 1.0 - smoothstep(0.0, 0.08, abs(e - 1.18));
      float screw = nearRing * (1.0 - smoothstep(0.05, 0.12, abs(fract(ang / (2.0 * M_PI) * 12.0) - 0.5)));
      m.albedo *= 1.0 - 0.3 * screw * (1.0 - smoothstep(0.003, 0.012, pix));
    }
    // 翼根的走道：黑色边线围出的一块区域（写着 NO STEP 的那种）
    float walk = wingSeam(zm - 3.2, 0.05, pix) * step(0.25, xi) * step(xi, 0.6);
    walk = max(walk, (wingSeam(xi - 0.25, 0.05 / chord, fwX) + wingSeam(xi - 0.6, 0.05 / chord, fwX)) * step(zm, 3.2));
    m.albedo = mix(m.albedo, vec3(0.03), clamp(walk, 0.0, 1.0));
    // 防滑走道本身是哑光的深灰涂层
    float walkway = step(zm, 3.2) * step(0.25, xi) * step(xi, 0.6);
    m.albedo = mix(m.albedo, vec3(0.5, 0.505, 0.51), walkway * 0.6);
    m.rough = mix(m.rough, 0.6, walkway);
    m.coat *= 1.0 - 0.6 * walkway;
  }
  // 顺气流方向的污渍：后缘和扰流板附近多，沿弦向拉长（展向变化快，按展向的像素足迹淡出高频）
  float grime = wingFbmAA(vec2(xm * 1.5, zm * 12.0), pix * 12.0) * smoothstep(0.5, 1.0, xi);
  m.albedo *= mix(vec3(1.0), vec3(0.86, 0.83, 0.78), clamp(grime * 1.3 - 0.35, 0.0, 1.0));
  m.rough = mix(m.rough, 0.45, grime);
  // 扰流板后面、襟翼上的深色排气 / 液压油污
  float streak = wingFbmAA(vec2(xm * 0.6, zm * 25.0), pix * 25.0) * smoothstep(0.7, 0.95, xi);
  m.albedo *= 1.0 - 0.22 * smoothstep(0.5, 0.78, streak);
  // 前缘附近的雨蚀：漆面发乌、光泽变差
  float erosion = (1.0 - smoothstep(0.1, 0.2, xi)) * step(0.1, xi);
  m.rough = mix(m.rough, 0.45, erosion * 0.6);
  return m;
}

// 各部件的材质都写成「一个变量、末尾一次 return」：分支里提前 return 时 FXC 会报 X4000（返回值可能未初始化）

// 翼尖弯折 + 小翼：竖直段和弯折上半截涂航司色，弯折下半截是翼面灰；前缘一条裸金属防蚀条
WingSurface wingTipSurface(vec3 P, float pix) {
  WingTipCoord q = wingTipCoord(P);
  float lw = pix / q.arcLen;
  // 航司色从弯折段的下三分之一处开始，分界线朝后缘略微抬高（沿气流斜着收），整段弯折几乎都是航司色。
  // 旧版在弯折 62% 处水平分界：弯折下半截那一小段翼面灰朝着天空、特别亮，看上去像小翼根部单独嵌了一截白色的块（用户 12.png）
  float livEdge = 0.3 + 0.15 * clamp(q.xi, 0.0, 1.0);
  float liv = smoothstep(livEdge - lw, livEdge + lw, q.sig / q.arcLen);
  // 航司色的底漆层按哑光处理（0.35），光泽交给清漆层：底漆也按 0.18 算镜面时，两层高光叠起来又亮又宽，像金属
  WingSurface m = wingPaint(mix(WING_PAINT * 0.97, WING_LIVERY, liv), mix(0.18, 0.45, liv));
  // 航司色涂装的清漆不是镜面：粗糙度 0.15（旧版和翼面一样 0.06，天空倒影清清楚楚，读起来像镀铬）。
  // T47（美术总监 wave6 第 11 条：小翼仍是一条从白到深蓝的镜面渐变，像镀铬件）：小翼是复合材料蒙皮上的涂装，
  // 外场飞了几年的面漆光泽远不如新清漆——清漆粗糙度 0.15 → 0.3（wingEnv 按粗糙度把天空倒影摊成大片的平均，
  // 地平线那道亮带不再清清楚楚地映在上面），清漆层强度减半（掠射时菲涅尔把整片天空反进来的那一路），底漆 0.35 → 0.45
  m.coatRough = mix(0.06, 0.3, liv);
  m.coat *= mix(1.0, 0.5, liv);
  // 小翼和翼尖的对接缝
  m.albedo *= 1.0 - 0.5 * wingSeam(q.sig - 0.12, 0.006, pix);
  // 航司色的漆层里有细小的金属颗粒（金属漆），光泽更「深」
  float flake = hash12(floor(P.xy * 900.0) + floor(P.z * 900.0)) - 0.5;
  m.albedo *= 1.0 + 0.08 * flake * liv * (1.0 - smoothstep(0.0005, 0.002, pix));
  if (q.xi < 0.035) m = wingBareMetal(0.8, 0.22);
  // 后缘的静电放电刷底座：一小段深色
  m.albedo *= 1.0 - 0.4 * wingSeam(q.xi - 0.985, 0.03, pix / q.c) * step(q.arcLen, q.sig);
  return m;
}

// 短舱与吊挂。进气道里面照不到多少光：越往里越暗（环境光遮蔽的近似）；风扇叶片是钛合金，但有涂层、不抛光，不能像镀铬
WingSurface wingNacelleSurface(vec3 P, float pix) {
  float u = wingEngInletX() - P.x;
  float rr = length(P.yz - vec2(WING_ENG_Y, WING_ENG_Z));
  bool pylon = rr > 1.06 || (P.y > WING_ENG_Y + 0.7 && abs(P.z - WING_ENG_Z) < 0.16);
  float ang = atan(P.y - WING_ENG_Y, P.z - WING_ENG_Z);
  WingSurface m = wingPaint(vec3(0.8, 0.8, 0.81), 0.2);                    // 风扇整流罩：白漆
  if (pylon) {
    m = wingPaint(WING_PAINT * 0.95, 0.3);
  } else if (rr < 0.86 && u < 0.62) {
    float inside = 1.0 - 0.75 * smoothstep(0.0, 0.5, u);                    // 进气道深处压暗
    if (u > 0.5 && rr > 0.31) {
      // 36 片风扇叶片（CFM56-5B 的叶片数）：暗灰、半哑光
      float blade = abs(fract(ang / (2.0 * M_PI) * 36.0 + rr * 0.6) - 0.5);
      m = wingPaint(vec3(0.16, 0.165, 0.17), 0.45);
      m.metal = 0.5;
      m.coat = 0.0;
      m.albedo *= 0.35 + 0.65 * smoothstep(0.05, 0.2, blade);
    } else if (rr < 0.31) {
      // 整流锥：深色，带一道白色螺旋标记
      m = wingPaint(vec3(0.03), 0.5);
      float spiral = abs(fract(ang / (2.0 * M_PI) + rr * 1.5) - 0.5);
      m.albedo = mix(m.albedo, vec3(0.7), 1.0 - smoothstep(0.03, 0.05, spiral));
      m.coat = 0.1;
    } else {
      m = wingPaint(vec3(0.22, 0.225, 0.23), 0.55);                        // 进气道内壁（吸音衬里）
      m.coat = 0.0;
    }
    m.albedo *= inside;
  } else if (u < 0.28) {
    m = wingBareMetal(0.8, 0.28);                                           // 进气道唇口：铝，有风蚀，不是镜面
  } else if (u > 3.75) {
    m = wingBareMetal(0.12, 0.45);                                          // 尾锥：高温发黑
  } else if (u > 2.62) {
    m = wingBareMetal(0.42, 0.4);                                           // 核心机整流罩
  } else {
    m.albedo *= 1.0 - 0.5 * wingSeam(u - 0.45, 0.006, pix);                 // 进气道与整流罩的对缝
    m.albedo *= 1.0 - 0.5 * wingSeam(u - 1.55, 0.006, pix);                 // 反推整流罩的分缝
    m.albedo *= 1.0 - 0.35 * wingSeam(u - 2.62, 0.02, pix);
  }
  return m;
}

// 襟翼滑轨整流罩：和翼面同色，尾端被襟翼排出的气流熏黑
WingSurface wingFairingSurface(vec3 P) {
  // 与翼下表面一致的浅灰漆、半哑光，清漆很薄：不要比翼面更亮的镜面高光
  WingSurface m = wingPaint(WING_PAINT * 0.9, 0.45);
  m.coat = 0.25;
  float c = wingChordAt(wingSpanS(P.z));
  float xm = wingLeX(P.z) - P.x;
  m.albedo *= 1.0 - 0.3 * smoothstep(1.0 * c, 1.2 * c, xm);
  return m;
}

// 主翼、襟翼、扰流板、缝翼
WingSurface wingPanelSurface(vec3 P, float pix, float up, int part) {
  WingCoord w = wingCoord(P);
  float zm = P.z - ROOT_Z;
  float xi = w.xi;
  float f = smoothstep(0.0, 0.3, uFlap);
  // 襟翼：按襟翼自己的弦向坐标映射回原翼型
  if (part == 2) xi = clamp(WING_FLAP_LE + (w.xi - WING_FLAP_LE - 0.22 * f), WING_FLAP_LE, 1.0);
  if (part == 4) xi = clamp(w.xi + 0.12 * uSlat, 0.0, WING_SLAT_XI);
  WingSurface m = wingSkin(xi, zm, w.s, w.chord, pix, part);
  if (part == 2) {
    // 襟翼放下后露出的前缘：没有清漆的浅灰底漆；前段还压在扰流板 / 整流罩下面，越往前越暗（遮蔽）
    float nose = 1.0 - smoothstep(WING_FLAP_LE + 0.02, WING_FLAP_LE + 0.07, xi);
    m.albedo = mix(m.albedo, vec3(0.5, 0.53, 0.51), nose);
    m.coat = mix(m.coat, 0.15, nose);
    m.rough = mix(m.rough, 0.5, nose);
    m.albedo *= mix(1.0, 0.45, (1.0 - smoothstep(WING_FLAP_LE, WING_FLAP_LE + 0.12, xi)) * f);
  }
  // 扰流板翻起后露出的凹槽：结构件和作动筒，深灰
  if (part == 0 && uSpoiler > 1e-3 && up > 0.0 && w.xi > WING_SPOILER_XI && w.xi < WING_SHROUD_TE
      && w.s > WING_SPOILER_S0 && w.s < WING_SPOILER_S1) {
    m.albedo *= 0.35;
    m.coat = 0.1;
    m.rough = 0.6;
  }
  // 襟翼放下后主翼整流罩的下表面（从后面能看到的「缝」）：结构件，深色
  if (part == 0 && uFlap > 1e-3 && w.xi > 0.5 && w.s > WING_FLAP_S0 && w.s < WING_FLAP_S1) {
    float under = smoothstep(0.2, -0.4, up);
    m.albedo *= mix(1.0, 0.4, under);
    m.coat = mix(m.coat, 0.1, under);
  }
  if (part == 3 && up < 0.0) { m.albedo *= 0.5; m.coat = 0.2; }
  return m;
}

// pix：命中点处一个像素对应的长度（米）；up：命中点的法线是否朝上（机体系 y）；part：wingTrace 给出的部件编号
WingSurface wingSurface(vec3 P, float pix, float up, int part) {
  WingSurface m;
  if (part == 1) m = wingTipSurface(P, pix);
  else if (part == 6) m = wingNacelleSurface(P, pix);
  else if (part == 5) m = wingFairingSurface(P);
  else m = wingPanelSurface(P, pix, up, part);
  return m;
}
`;
