/**
 * 座椅（GLSL）：靠窗座位看出去，画面边缘的本排靠背（头枕侧翼）和前排靠背（背壳、木饰条、熄屏的娱乐屏、包过顶的头枕）。
 * 依赖 CABIN_SHADING_COMMON、LEATHER_COMMON（商务舱）或 FABRIC_COMMON（经济舱）、CABIN_COMMON（windowIrradiance / sunThroughWindow）。
 *
 * 几何沿用经济舱量级的估计（不是某个型号的实测）：排距 0.78 m（约 31 英寸），靠背后仰约 16°，
 * 座椅外侧离侧壁约 8 cm，靠背顶离地约 1.07 m；座舱系原点是窗洞中心，眼睛默认正对窗口，头枕在眼睛后方约 20 cm。
 * 材质按高端舱位做（T20，用户定「高级、先进、奢华」）：深石板灰皮革的靠背 + 暖灰白纳帕皮头枕（绗缝通道、撞色包边、双明线），
 * 背壳是珍珠灰缎面漆、胡桃木饰条、香槟色金属细线。配色是示意，不对应任何航司。
 * 舱等（T25）：几何两档共用；材质按 #define CABIN_CLASS_ECONOMY 分开编译——经济舱是 T06 的斜纹织物 + 平纹头枕套、
 * 浅灰塑料背壳（娱乐屏、小桌板缝、锁扣、靠近上沿被扶出的一点手印），没有木饰 / 金属；T35 起头枕用座椅同款深色面料 + 白色头巾。
 * T35（美术总监 wave5 第 3 处：「看前方 / 看后方」一根香肠头枕 + 白模感）：商务舱头枕改成扁圆截面（加厚、顶面放平、两侧护翼向前鼓出），
 * 顶面两条棱上走双明线；本排外侧（靠窗一侧）加一块固定的座椅壳体（高的护翼在靠背后面，往前顺一道圆弧降到扶手台面的高度），
 * 沿轮廓一圈香槟金属包边、内侧面嵌一条胡桃木；经济舱头枕上搭一块白色无纺布头巾（下摆略翘），背壳上加一块熄屏的娱乐屏。
 * 靠背用距离场表示，在两排的包围盒区间里球追踪；轮廓按「离表面最近的距离 / 像素宽度」算覆盖率，边缘不锯齿。
 * 所有细节按解析的像素足迹淡出（这里在分支里，不能用屏幕导数）。
 */
export const SEATS_COMMON = /* glsl */ `
const float SEAT_PITCH = 0.78;
const float SEAT_C = 0.96106, SEAT_S = 0.27636;   // 后仰 16° 的 cos / sin
const vec2 SEAT_PIVOT = vec2(-0.06, -0.66);        // 本排靠背根部：前后位置 a（朝机头为正）、高度 y
const float SEAT_TOP = 0.64;                       // 沿靠背从根部到顶
const float SEAT_BOTTOM = -0.50;                   // 往下延伸到地板附近（看不到，只是不让它悬空）
const float SEAT_ZC = -0.30, SEAT_HW = 0.22;       // 座椅宽度中心、半宽
const float SEAT_CORNER = 0.07;                    // 靠背顶角的圆角

// 座舱系 → 某一排的靠背局部坐标：x = f（厚度方向，正面朝机头为正），y = s（沿靠背向上），z 不变
vec3 seatFrame(vec3 p, float row) {
  float a = uSeatSign * p.x - SEAT_PIVOT.x - row * SEAT_PITCH;
  float y = p.y - SEAT_PIVOT.y;
  return vec3(a * SEAT_C + y * SEAT_S, -a * SEAT_S + y * SEAT_C, p.z);
}
vec3 seatDirToCabin(vec3 d) {
  vec2 ay = vec2(d.x * SEAT_C - d.y * SEAT_S, d.x * SEAT_S + d.y * SEAT_C);
  return vec3(uSeatSign * ay.x, ay.y, d.z);
}

float seatHalfThick(float s) { return mix(0.055, 0.037, clamp(s / SEAT_TOP, 0.0, 1.0)); }

// 靠背某一高度的截面：x = 截面中心相对靠背中面朝前的偏移，y = 半厚度，z = 棱边倒圆半径。wz：离座椅中线的横向距离
vec3 seatSection(float s, float wz) {
  float th = seatHalfThick(s);
  float r = mix(0.025, 0.034, smoothstep(SEAT_TOP - 0.12, SEAT_TOP, s));
#ifndef CABIN_CLASS_ECONOMY
  // 商务舱头枕（T35）：原来是半厚 3.7 cm、倒圆 3.4 cm 的圆管（读成「香肠」）。改成扁圆截面：往背后加厚 1 cm、倒圆收到 2 cm，
  // 顶面有一块平的；两侧 7 cm 的护翼向前鼓出 2 cm。正面只动护翼：再往前鼓，默认坐姿时本排头枕的护翼就会挤进画面右下角
  float hz = smoothstep(SEAT_TOP - 0.27, SEAT_TOP - 0.21, s);
  float wing = 0.02 * smoothstep(SEAT_HW - 0.12, SEAT_HW - 0.05, abs(wz)) * hz;
  return vec3(0.5 * wing - 0.005 * hz, th + 0.005 * hz + 0.5 * wing, mix(r, 0.02, hz));
#else
  return vec3(0.0, th, r);
#endif
}

#ifdef CABIN_CLASS_ECONOMY
// 经济舱的白色头巾（T35）：约 31 cm 宽的一块白色无纺布搭在头枕上，正面垂下约 19 cm、背面约 11 cm。
// 每张座椅的头巾位置、垂下的长度都略有不同（铁律 4）。soft：边缘的过渡宽度（距离场里用 4 mm，着色时按像素足迹）
float seatClothMask(vec3 q, float row, float soft) {
  float jx = 0.012 * (hash12(vec2(row, 3.7)) - 0.5);
  float wz = q.z - SEAT_ZC - jx;
  float hang = q.x > 0.0 ? SEAT_TOP - 0.19 + 0.02 * hash12(vec2(row, 5.1)) : SEAT_TOP - 0.11;
  return (1.0 - smoothstep(0.155 - soft, 0.155 + soft, abs(wz))) * smoothstep(hang - soft, hang + soft, q.y);
}
// 头巾在距离场里的厚度：布本身约 1 mm，下摆和两侧的边略微翘起（离开头枕套 2–3 mm）
float seatClothLift(vec3 q, float row) {
  float m = seatClothMask(q, row, 0.004);
  if (m <= 0.0) return 0.0;
  float hang = q.x > 0.0 ? SEAT_TOP - 0.19 + 0.02 * hash12(vec2(row, 5.1)) : SEAT_TOP - 0.11;
  float wz = q.z - SEAT_ZC - 0.012 * (hash12(vec2(row, 3.7)) - 0.5);
  float curl = 0.0018 * (1.0 - smoothstep(0.0, 0.015, q.y - hang)) + 0.0008 * (1.0 - smoothstep(0.0, 0.012, 0.155 - abs(wz)));
  return m * (0.001 + curl);
}
#endif

float sdSeatBack(vec3 q, float row) {
  float wz = clamp((q.z - SEAT_ZC) / SEAT_HW, -1.0, 1.0);
  vec3 sec = seatSection(q.y, q.z - SEAT_ZC);
  // 正面软垫中间略鼓
  float bulge = 0.008 * (1.0 - wz * wz) * smoothstep(-0.1, 0.1, q.x);
  // 侧面轮廓（s–z 平面）：顶角圆角的矩形
  vec2 sz = vec2(q.y - 0.5 * (SEAT_TOP + SEAT_BOTTOM), q.z - SEAT_ZC);
  float d2 = sdRoundRect(sz, vec2(0.5 * (SEAT_TOP - SEAT_BOTTOM), SEAT_HW), SEAT_CORNER);
  // 挤出成有厚度的靠背，棱边倒圆（头枕区的截面见 seatSection）
  float r = sec.z;
  float coverPuff = 0.003 * smoothstep(SEAT_TOP - 0.26, SEAT_TOP - 0.22, q.y) * (1.0 - wz * wz);
  vec2 w = vec2(d2 + r, abs(q.x - sec.x) - sec.y - bulge - coverPuff + r);
  float d = min(max(w.x, w.y), 0.0) + length(max(w, 0.0)) - r;
  // 可调头枕与靠背之间的一道横缝
  d += 0.003 * (1.0 - smoothstep(0.0, 0.006, abs(q.y - (SEAT_TOP - 0.25))));
#ifdef CABIN_CLASS_ECONOMY
  d -= seatClothLift(q, row);
#endif
  return d;
}

#ifndef CABIN_CLASS_ECONOMY
// 商务舱的座椅壳体（T35）：本排外侧（靠窗一侧、离座椅 1 cm）一块 2.2 cm 厚的固定壳板，不随靠背后仰。
// 侧面轮廓（u = 相对靠背根部朝机头的距离，y）：靠背后面是高到头枕顶的护翼，往前顺一道大圆弧降到扶手台面（离窗中心 40 cm 以下）。
// 尺寸是示意（对标反鱼骨 / 交错式商务舱座椅的外侧壳体），不对应某个型号
const float SHELL_ZC = -0.058, SHELL_HT = 0.011;
float seatShellProfile(vec2 uy) {
  float a = sdRoundRect(uy - vec2(-0.30, -0.57), vec2(0.10, 0.54), 0.05);   // 护翼：u −0.40…−0.20，顶在 y = −0.03
  float b = sdRoundRect(uy - vec2(-0.08, -0.76), vec2(0.32, 0.36), 0.03);   // 扶手台面：u −0.40…0.24，顶在 y = −0.40
  float h = clamp(0.5 + 0.5 * (b - a) / 0.1, 0.0, 1.0);                     // 平滑并集：两段之间是一道圆弧
  return mix(b, a, h) - 0.1 * h * (1.0 - h);
}
float sdSeatShell(vec3 p, float row) {
  float u = uSeatSign * p.x - SEAT_PIVOT.x - row * SEAT_PITCH;
  float d2 = seatShellProfile(vec2(u, p.y));
  const float re = 0.005;                                                    // 棱边倒圆 5 mm
  vec2 w = vec2(d2 + re, abs(p.z - SHELL_ZC) - SHELL_HT + re);
  return min(max(w.x, w.y), 0.0) + length(max(w, 0.0)) - re;
}
#endif

// 某一排的某个部件（isShell = 1：壳体，只有商务舱有）
float sdSeatPart(vec3 p, float row, float isShell) {
#ifndef CABIN_CLASS_ECONOMY
  if (isShell > 0.5) return sdSeatShell(p, row);
#endif
  return sdSeatBack(seatFrame(p, row), row);
}

float sdSeats(vec3 p) {
  float d = min(sdSeatBack(seatFrame(p, 0.0), 0.0), sdSeatBack(seatFrame(p, 1.0), 1.0));
#ifndef CABIN_CLASS_ECONOMY
  d = min(d, min(sdSeatShell(p, 0.0), sdSeatShell(p, 1.0)));
#endif
  return d;
}

// 某一排靠背的包围盒（座舱系）
bool seatBox(vec3 ro, vec3 rd, float row, out vec2 tt) {
  vec3 o = seatFrame(ro, row);
  vec2 ay = vec2(uSeatSign * rd.x, rd.y);
  vec3 d = vec3(ay.x * SEAT_C + ay.y * SEAT_S, -ay.x * SEAT_S + ay.y * SEAT_C, rd.z);
  vec3 bmin = vec3(-0.075, SEAT_BOTTOM - 0.01, SEAT_ZC - SEAT_HW - 0.01);
  vec3 bmax = vec3(0.075, SEAT_TOP + 0.01, SEAT_ZC + SEAT_HW + 0.01);
  vec3 inv = 1.0 / d;
  vec3 t0 = (bmin - o) * inv, t1 = (bmax - o) * inv;
  vec3 tn = min(t0, t1), tf = max(t0, t1);
  tt = vec2(max(max(tn.x, tn.y), tn.z), min(min(tf.x, tf.y), tf.z));
  return tt.y > max(tt.x, 0.0);
}

#ifndef CABIN_CLASS_ECONOMY
// 某一排壳体的包围盒（座舱系，壳体不后仰，直接是轴对齐的盒子）
bool seatShellBox(vec3 ro, vec3 rd, float row, out vec2 tt) {
  float u0 = SEAT_PIVOT.x + row * SEAT_PITCH - 0.41, u1 = SEAT_PIVOT.x + row * SEAT_PITCH + 0.25;
  vec3 bmin = vec3(uSeatSign > 0.0 ? u0 : -u1, -1.12, SHELL_ZC - SHELL_HT - 0.002);
  vec3 bmax = vec3(uSeatSign > 0.0 ? u1 : -u0, -0.02, SHELL_ZC + SHELL_HT + 0.002);
  vec3 inv = 1.0 / rd;
  vec3 t0 = (bmin - ro) * inv, t1 = (bmax - ro) * inv;
  vec3 tn = min(t0, t1), tf = max(t0, t1);
  tt = vec2(max(max(tn.x, tn.y), tn.z), min(min(tf.x, tf.y), tf.z));
  return tt.y > max(tt.x, 0.0);
}
#endif

struct SeatHit { float cov; float t; };

// 球追踪；cov = 覆盖率（命中 1；擦边而过时按最近距离 / 像素宽度给部分覆盖，轮廓就是抗锯齿的）
SeatHit traceSeats(vec3 ro, vec3 rd, float tMax, float pixAng) {
  SeatHit sh;
  sh.cov = 0.0;
  sh.t = -1.0;
  vec2 b;
  float tS = 1e9, tE = 0.0;
  if (seatBox(ro, rd, 0.0, b)) { tS = min(tS, b.x); tE = max(tE, b.y); }
  if (seatBox(ro, rd, 1.0, b)) { tS = min(tS, b.x); tE = max(tE, b.y); }
#ifndef CABIN_CLASS_ECONOMY
  if (seatShellBox(ro, rd, 0.0, b)) { tS = min(tS, b.x); tE = max(tE, b.y); }
  if (seatShellBox(ro, rd, 1.0, b)) { tS = min(tS, b.x); tE = max(tE, b.y); }
#endif
  if (tS > 1e8) return sh;
  float t = max(tS, 0.0);
  float tEnd = min(tE, tMax);
  float best = 1e9;
  float tBest = t;
  // 步数 48：「看前方」时视线顺着壳板的内侧面掠过，球追踪步长很小（循环上界带 uLoopGuard，FXC 不展开）
  for (int i = 0; i < 48 + uLoopGuard; i++) {
    if (t > tEnd) break;
    float d = sdSeats(ro + rd * t);
    float ratio = d / (t * pixAng);
    if (ratio < best) { best = ratio; tBest = t; }
    if (ratio < 0.05) break;
    t += max(d * 0.9, 0.0004);   // 头枕护翼、头巾让距离场略超 1-Lipschitz，步长打九折
  }
  sh.cov = 1.0 - smoothstep(0.05, 1.0, best);
  sh.t = tBest;
  return sh;
}

vec3 seatNormal(vec3 p, float e, float row, float isShell) {
  const vec2 k = vec2(1.0, -1.0);
  return normalize(k.xyy * sdSeatPart(p + k.xyy * e, row, isShell) + k.yyx * sdSeatPart(p + k.yyx * e, row, isShell)
                 + k.yxy * sdSeatPart(p + k.yxy * e, row, isShell) + k.xxx * sdSeatPart(p + k.xxx * e, row, isShell));
}

// 距离场 AO：沿法线取两个点，看离别的表面（另一排座椅、侧壁）有多近
float seatAO(vec3 p, vec3 n) {
  const float h = 0.08;
  vec3 x = p + n * h;
  float d = min(sdSeats(x), wallZ(x.y) - x.z);
  return clamp(1.0 - 0.6 * (h - d) / h, 0.25, 1.0);
}

#ifndef CABIN_CLASS_ECONOMY
// 皮面上的缝：横缝（头枕的绗缝通道、头枕与靠背的接缝、背面头枕包边）+ 竖缝（头枕两侧的撞色包边、护翼的分片缝、靠背正面的分片缝）
// + 顶缝（T35：头枕顶面两条棱上的双明线，顶面那块皮与前后两块的接缝）。
// 返回 x = 线覆盖率、y = 凹槽压暗；dn：法线扰动（座舱系）
vec2 seatSeams(vec3 q, float fr, float wz, float pix, float coverZone, out vec3 dn) {
  float ys, singleH;
  if (fr > 0.45) {
    // 正面：头枕底边一道缝，往上两道绗缝通道（间距 7.5 cm），都是双明线（缝在凹槽里的单线藏在阴影里看不见）
    float k = clamp(floor((q.y - (SEAT_TOP - 0.25)) / 0.075 + 0.5), 0.0, 2.0);
    ys = SEAT_TOP - 0.25 + k * 0.075;
    singleH = 0.0;
  } else {
    // 背面：头枕包下来的下沿
    ys = SEAT_TOP - 0.065;
    singleH = 1.0;
  }
  vec4 h = leatherSeam(q.y - ys, wz, pix, singleH) * coverZone;
  // 竖缝：头枕区两侧是撞色包边（单线），靠背正面是两道分片缝（双明线）
  bool upper = q.y > SEAT_TOP - 0.25;
  float xs = upper ? SEAT_HW - 0.03 : 0.11;
  float vOn = upper ? 1.0 : step(0.45, fr);
  vec4 v = leatherSeam(abs(wz) - xs, q.y, pix, upper ? 1.0 : 0.0) * vOn;
  vec3 sec = seatSection(q.y, wz);
  float xc = q.x - sec.x;
  // 护翼的分片缝：头枕正面、离两侧 10 cm，双明线。T47：只走正面和正面的圆棱，到顶面前沿那道顶缝为止（T 字接进去）；
  // 原来一直走过顶面的前半，和顶缝交叉成「十」字（美术总监 wave6 第 8 条）
  float onFace = smoothstep(-0.002, 0.002, xc - (sec.y - sec.z) + 0.001);
  vec4 vw = leatherSeam(abs(wz) - (SEAT_HW - 0.10), q.y, pix, 0.0) * (upper ? step(0.45, fr) * coverZone * onFace : 0.0);
  // 顶缝：顶面平的那块两侧（离截面中心 半厚 − 倒圆），双明线；只在头枕顶上约 4 cm 的范围
  vec4 c = leatherSeam(abs(xc) - (sec.y - sec.z), q.z, pix, 0.0) * smoothstep(SEAT_TOP - 0.05, SEAT_TOP - 0.035, q.y) * coverZone;
  vec3 up = seatDirToCabin(vec3(0.0, 1.0, 0.0));
  vec3 fwd = seatDirToCabin(vec3(1.0, 0.0, 0.0)) * (xc < 0.0 ? -1.0 : 1.0);
  vec3 side = vec3(0.0, 0.0, wz < 0.0 ? -1.0 : 1.0);
  dn = -up * h.z - side * (v.z + vw.z) - fwd * c.z;
  return vec2(max(max(h.x, v.x), max(vw.x, c.x)), max(max(h.y, v.y), max(vw.y, c.y)));
}
#endif

vec3 shadeSeat(vec3 ro, vec3 rd, SeatHit sh, float pixAng, CabinLights cl, float shadeBottom) {
  vec3 p = ro + rd * sh.t;
  float pixRaw = sh.t * pixAng;
  // 哪一排、哪个部件、局部坐标
  vec3 q0 = seatFrame(p, 0.0), q1 = seatFrame(p, 1.0);
  float dB0 = sdSeatBack(q0, 0.0), dB1 = sdSeatBack(q1, 1.0);
  bool front = dB1 < dB0;
  vec3 q = front ? q1 : q0;
  float seatId = front ? 1.0 : 0.0;
  float isShell = 0.0;
#ifndef CABIN_CLASS_ECONOMY
  float dS0 = sdSeatShell(p, 0.0), dS1 = sdSeatShell(p, 1.0);
  if (min(dS0, dS1) < min(dB0, dB1)) {
    isShell = 1.0;
    seatId = dS1 < dS0 ? 1.0 : 0.0;
  }
#endif
  vec3 n = seatNormal(p, max(0.0006, pixRaw * 0.7), seatId, isShell);
  // T47：轮廓上擦边而过的像素（覆盖率 < 1），着色点是视线离表面最近的那个空中的点，离表面可达一个像素。
  // 沿法线把它落回表面再取材质分区与局部坐标：原来空中的点会被分到别的材质区（如背壳的亮漆面），
  // 头枕轮廓外一圈 1 px、逐像素跳的白色虚线（美术总监 wave6 第 6 条）
  float dHit = min(dB0, dB1);
#ifndef CABIN_CLASS_ECONOMY
  dHit = isShell > 0.5 ? min(dS0, dS1) : dHit;
#endif
  p -= n * max(dHit, 0.0);
  q = seatFrame(p, seatId);
  vec3 v = -rd;
  float nvGeo = max(dot(n, v), 0.0);
  float pix = pixRaw / max(nvGeo, 0.25);
  vec3 sec = seatSection(q.y, q.z - SEAT_ZC);
  float th = sec.y;
  float fr = (q.x - sec.x + th) / (2.0 * th);         // 0 背面 … 1 正面
  float wz = q.z - SEAT_ZC;
  // 局部坐标里的法线：选投影平面（在棱边处换投影，那里正好是皮面的缝）
  vec2 ay = vec2(uSeatSign * n.x, n.y);
  vec3 nl = vec3(ay.x * SEAT_C + ay.y * SEAT_S, -ay.x * SEAT_S + ay.y * SEAT_C, n.z);
  vec3 an = abs(nl);
  vec2 uv; vec3 tu; vec3 tv;
  if (an.x >= an.y && an.x >= an.z) { uv = q.zy; tu = vec3(0.0, 0.0, 1.0); tv = seatDirToCabin(vec3(0.0, 1.0, 0.0)); }
  else if (an.z >= an.y) { uv = q.xy; tu = seatDirToCabin(vec3(1.0, 0.0, 0.0)); tv = seatDirToCabin(vec3(0.0, 1.0, 0.0)); }
  else { uv = q.zx; tu = vec3(0.0, 0.0, 1.0); tv = seatDirToCabin(vec3(1.0, 0.0, 0.0)); }

  // 材质分区
  float top = smoothstep(SEAT_TOP - 0.05, SEAT_TOP - 0.03, q.y);
  // 两块皮的交界按像素足迹做抗锯齿过渡（硬 step 在头枕侧边会出锯齿）
  float coverZone = 1.0 - smoothstep(-pix, pix, abs(wz) - (SEAT_HW - 0.03));
  // 头枕（浅色皮）：正面上部 25 cm，翻过顶部，在背面包下约 6.5 cm；两侧 3 cm 是深色皮的撞色包边
  float yF = smoothstep(-pix, pix, q.y - (SEAT_TOP - 0.25)), yB = smoothstep(-pix, pix, q.y - (SEAT_TOP - 0.065));
  float cover = coverZone * max(yF * step(0.45, fr), max(top, yB * step(fr, 0.45)));
  // 背壳：背面那三分之一厚度，头枕包住的地方除外
  float shell = (1.0 - smoothstep(0.26, 0.34, fr)) * (1.0 - cover) * (1.0 - top);

  vec3 albedo;
  vec3 nn = n;
  float rough;
#ifdef CABIN_CLASS_ECONOMY
  vec3 sheenC = vec3(0.0);
  float sheenA = 0.5;
  // 白色头巾（T35）：盖住的地方不管底下是织物还是背壳，都按布料着色
  float cloth = seatClothMask(q, seatId, pix);
  shell *= 1.0 - step(0.5, cloth);
  if (shell > 0.5) {
    // 经济舱（T06，T25 收敛使用痕迹）：浅灰塑料背壳、细磨砂；娱乐屏、小桌板的轮廓缝和锁扣
    albedo = vec3(0.50, 0.50, 0.49);
    rough = 0.42;
    vec3 nd = vnoiseD(uv * 1200.0 + seatId * 7.0);
    float fine = 1.0 - smoothstep(0.0003, 0.001, pix);
    nn = normalize(n + (tu * nd.y + tv * nd.z) * 1200.0 * 0.000015 * fine);
    albedo *= 1.0 + 0.03 * (nd.x - 0.5) * fine;
    // 娱乐屏（T35）：约 9 英寸（20 × 11.5 cm），嵌在背壳上部、头巾下沿之下；黑玻璃 + 一圈 5 mm 的深灰塑料框
    float dS = sdRoundRect(vec2(wz, q.y - (SEAT_TOP - 0.20)), vec2(0.10, 0.058), 0.006);
    float bezelS = 1.0 - smoothstep(0.005 - pix * 0.5, 0.005 + pix * 0.5, dS);
    float glassS = 1.0 - smoothstep(-pix * 0.5, pix * 0.5, dS);
    albedo = mix(albedo, vec3(0.07, 0.07, 0.075), bezelS);
    albedo = mix(albedo, vec3(0.008), glassS);
    rough = mix(rough, 0.06, glassS);
    // 小桌板：宽 0.40、上沿在顶下 0.30 m（屏幕下方）；锁扣在上沿中间
    float trayTop = SEAT_TOP - 0.30;
    vec2 tq = vec2(wz, q.y - (trayTop - 0.15));
    float trayD = abs(sdRoundRect(tq, vec2(0.20, 0.15), 0.02));
    float trayGroove = lineCov(trayD, 0.0012, pix);
    float latch = 1.0 - smoothstep(0.0, max(pix, 0.001), sdRoundRect(vec2(wz, q.y - trayTop - 0.02), vec2(0.018, 0.008), 0.004));
    albedo *= 1.0 - 0.5 * trayGroove;
    albedo = mix(albedo, vec3(0.10, 0.10, 0.11), latch);
    // 靠近上沿被后排的人扶出的一点手印（T06 的一半）：略暗、略亮光
    float grab = smoothstep(SEAT_TOP - 0.2, SEAT_TOP - 0.06, q.y) * smoothstep(0.4, 0.75, fbm2(uv * 30.0 + seatId)) * (1.0 - bezelS);
    albedo *= 1.0 - 0.06 * grab;
    rough = mix(rough, 0.3, grab);
  } else {
    // 织物（fabric.glsl.ts）：座椅面料是深蓝灰的斜纹提花。头枕也是同一种深色面料（T35：原来的浅灰平纹头枕套去掉，
    // 白色头巾压在深色面料上才一眼认得出；浅灰套上再搭白布反而分不清）
    float kind = 0.0;
    Fabric fb = fabricSample(uv + seatId * 1.37, pix, kind);
    albedo = fb.albedo;
    sheenC = fb.sheen;
    sheenA = fb.sheenRough;
    rough = 0.8;
    // 微褶：头枕套被头压出的横向褶皱；座椅面料在棱边附近被绷紧的细褶
    float wr = mix(0.35, 1.0, kind);
    vec3 wn = vnoiseD(vec2(uv.x * 18.0, uv.y * 55.0) + seatId * 3.0);
    vec2 wslope = wn.yz * vec2(18.0, 55.0) * 0.0012 * wr;
    nn = normalize(n + tu * (fb.slope.x + wslope.x) + tv * (fb.slope.y + wslope.y));
    // 头枕套的包边：沿边缘一道暗线
    float hem = lineCov(abs(abs(wz) - (SEAT_HW - 0.035)), 0.0015, pix) + lineCov(abs(q.y - (SEAT_TOP - 0.25)), 0.0015, pix) * step(0.45, fr);
    albedo *= 1.0 - 0.25 * clamp(hem, 0.0, 1.0) * kind;
    // 头巾（T35）：白色的无纺布 / 亚麻混纺，纤维是不规则的短絮（不是经纬网格），比像素细时淡成均匀的白；
    // 布边内 6 mm 一道同色的缝线
    if (cloth > 0.0) {
      float fF = 1.0 - smoothstep(0.0002, 0.0006, pix);
      vec3 fb1 = vnoiseD(mat2(0.8, 0.6, -0.6, 0.8) * uv * 2200.0 + seatId * 4.0);
      float fl = 0.6 * vnoise(uv * 700.0 + seatId) + 0.4 * fb1.x;
      vec3 clothC = vec3(0.88, 0.88, 0.86) * (1.0 + 0.06 * (fl - 0.5) * fF);
      float jx = 0.012 * (hash12(vec2(seatId, 3.7)) - 0.5);
      float hang = q.x > 0.0 ? SEAT_TOP - 0.19 + 0.02 * hash12(vec2(seatId, 5.1)) : SEAT_TOP - 0.11;
      float stitch = lineCov(abs(abs(wz - jx) - 0.149), 0.0003, pix) + lineCov(abs(q.y - hang - 0.006), 0.0003, pix);
      clothC *= 1.0 - 0.12 * clamp(stitch, 0.0, 1.0);
      albedo = mix(albedo, clothC, cloth);
      sheenC = mix(sheenC, vec3(0.12), cloth);
      sheenA = mix(sheenA, 0.6, cloth);
      nn = normalize(mix(nn, normalize(n + (tu * fb1.y + tv * fb1.z) * 2200.0 * 0.000008 * fF), cloth));
    }
  }
#else
  float metal = 0.0;   // 香槟色金属饰条的覆盖率
  float glass = 0.0;   // 屏幕玻璃
  float wood = 0.0;    // 胡桃木饰条的覆盖率
  // 木饰的纹理坐标与种子（壳体和背壳都有木饰，leatherWalnut 只在后面调用一次）
  vec2 woodUV = vec2(0.0);
  float woodSeed = 0.0;
  if (isShell > 0.5) {
    // 座椅壳体（T35）：珍珠灰缎面漆；沿侧面轮廓一圈 7 mm 的香槟金属包边（包住倒圆的棱）；
    // 内侧面（朝座位）距边 1.6–4.4 cm 嵌一条胡桃木，两侧各一道金属细线
    float u = uSeatSign * p.x - SEAT_PIVOT.x - seatId * SEAT_PITCH;
    float d2 = -seatShellProfile(vec2(u, p.y));        // 离轮廓边缘的距离（壳板内为正）
    albedo = vec3(0.60, 0.585, 0.56);
    rough = 0.3;
    vec3 nd = vnoiseD(vec2(u, p.y) * 1200.0 + seatId * 7.0 + 3.3);
    float fine = 1.0 - smoothstep(0.0003, 0.001, pix);
    nn = normalize(n + vec3(uSeatSign * nd.y, nd.z, 0.0) * 1200.0 * 0.00001 * fine);
    float inner = smoothstep(0.3, 0.7, -n.z);
    metal = 1.0 - smoothstep(0.007 - pix * 0.5, 0.007 + pix * 0.5, d2);
    float wb = abs(d2 - 0.03);
    wood = (1.0 - smoothstep(0.014 - pix * 0.5, 0.014 + pix * 0.5, wb)) * inner;
    woodUV = vec2(u, d2);                              // 纹理顺着轮廓走（弯木贴皮）
    woodSeed = seatId * 5.0 + 9.0;
    metal = max(metal, lineCov(abs(wb - 0.0145), 0.0005, pix) * inner);
  } else if (shell > 0.5) {
    // 背壳：珍珠灰的缎面漆，极细的磨砂；上沿一条胡桃木饰条（上下各一道金属细线），中间一块熄屏的娱乐屏（黑玻璃 + 金属细框）
    albedo = vec3(0.60, 0.585, 0.56);
    rough = 0.32;
    vec3 nd = vnoiseD(uv * 1200.0 + seatId * 7.0);
    float fine = 1.0 - smoothstep(0.0003, 0.001, pix);
    nn = normalize(n + (tu * nd.y + tv * nd.z) * 1200.0 * 0.00001 * fine);
    float inW = step(abs(wz), SEAT_HW - 0.035);
    // 木饰条：宽 2.4 cm，在头枕包边下方 2 cm
    float yb = q.y - (SEAT_TOP - 0.10);
    wood = (1.0 - smoothstep(0.012 - pix * 0.5, 0.012 + pix * 0.5, abs(yb))) * inW;
    woodUV = vec2(wz, yb) + seatId * 0.31;
    woodSeed = seatId * 5.0 + 2.0;
    metal = lineCov(abs(abs(yb) - 0.0125), 0.0005, pix) * inW;
    // 屏幕：宽 23 cm、高 15 cm，圆角 1 cm；外面一圈 1.2 mm 的金属细框
    float dS = sdRoundRect(vec2(wz, q.y - (SEAT_TOP - 0.27)), vec2(0.115, 0.075), 0.01);
    glass = 1.0 - smoothstep(-pix * 0.5, pix * 0.5, dS);
    metal = max(metal, lineCov(abs(dS - 0.0009), 0.0006, pix));
    albedo = mix(albedo, vec3(0.006), glass);
    rough = mix(rough, 0.05, glass);
  } else {
    float kind = cover;
    Leather lt = leatherSample(uv + seatId * 1.37, pix, kind, seatId * 3.1 + 1.0);
    albedo = lt.albedo;
    rough = lt.rough;
    vec3 dn;
    vec2 sm = seatSeams(q, fr, wz, pix, coverZone, dn);
    // 缝线：深色皮上是暖灰的撞色线，浅色皮上是同色系略深的线
    vec3 threadC = mix(vec3(0.36, 0.33, 0.28), vec3(0.30, 0.265, 0.22), kind);
    albedo = mix(albedo * (1.0 - sm.y), threadC, sm.x);
    rough = mix(rough, 0.55, sm.x);
    nn = normalize(n + tu * lt.slope.x + tv * lt.slope.y + dn);
  }
  if (wood > 0.0) {
    float wr;
    vec3 woodC = leatherWalnut(woodUV, pix, woodSeed, wr);
    albedo = mix(albedo, woodC, wood);
    rough = mix(rough, wr, wood);
  }
#endif

  // T47：轮廓最后一两个像素里 n·v 从 0.3 掉到 0，窗光 / 阳光的掠射高光（1/(4·n·v)）和菲涅尔都在这里陡升，
  // 每个像素取到的是陡坡上的一个点——头枕轮廓一圈比背景和皮面都亮、逐像素跳的 1 px 白色虚线（美术总监 wave6 第 6 条）。
  // 着色法线往视线方向掰到 n·v ≥ 0.3：相当于按像素足迹里的平均朝向着色（同机翼边缘的做法），轮廓内侧的明暗不变
  float ndv = dot(nn, v);
  if (ndv < 0.3) nn = normalize(nn + v * (0.3 - ndv));
  float ao = seatAO(p, n);
  float nv = max(dot(nn, v), 1e-3);
  float sunVis = sunThroughWindow(p, cl.sunC, shadeBottom) * step(0.0, cl.sunC.z);
  vec3 eWin = windowIrradiance(p, nn, cl.lWin);
  vec3 e = cabinIrradiance(p, nn, cl) * ao + eWin * sqrt(ao) + cl.eSunNormal * max(dot(nn, cl.sunC), 0.0) * sunVis;
  vec3 col = albedo / M_PI * e;

#ifdef CABIN_CLASS_ECONOMY
  if (shell > 0.5) {
    float F = fresnelRough(nv, 0.04, rough);
    vec3 r = reflect(rd, nn);
    col += F * mix(cabinEnv(r, cl), cl.lWin, sunThroughWindow(p, r, shadeBottom)) * ao;
    col += keySpec(nn, v, cl.sunC, rough * rough, 0.04, cl.eSunNormal) * sunVis;
  } else {
    // 布料光泽：直射光 + 窗口（当成从窗中心来的光）+ 环境（掠射角更亮）
    vec3 lw = normalize(vec3(0.0, 0.0, PANE_DEPTH) - p);
    vec3 hs = normalize(cl.sunC + v), hw = normalize(lw + v);
    float nls = max(dot(nn, cl.sunC), 0.0), nlw = max(dot(nn, lw), 0.0);
    col += sheenC * sheenBrdf(nls, nv, max(dot(nn, hs), 0.0), sheenA) * cl.eSunNormal * nls * sunVis;
    col += sheenC * sheenBrdf(nlw, nv, max(dot(nn, hw), 0.0), sheenA) * eWin * sqrt(ao);
    col += sheenC * cabinIrradiance(p, nn, cl) / M_PI * ao * (0.25 + 1.5 * pow(1.0 - nv, 3.0));
  }
  return col;
#else
  // 高光：窗户（当成从窗中心来的光，面光源把高光撑宽）、直射光、氛围灯、舱内环境。皮革和漆面都是电介质（F0 = 4%）
  vec3 r = reflect(rd, nn);
  float a2 = rough * rough;
  vec3 lw = normalize(vec3(0.0, 0.0, PANE_DEPTH) - p);
  col += keySpec(nn, v, lw, max(a2, 0.12), 0.04, eWin) * sqrt(ao);
  col += keySpec(nn, v, cl.sunC, a2, 0.04, cl.eSunNormal) * sunVis;
  col += cabinMoodSpec(p, nn, v, max(a2, 0.08), 0.04, cl.moodI) * ao;
  // 胡桃木是开放漆面：掠射时漆膜的反射按菲涅尔涨得很快，会把木色冲成灰白（「看前方」时整条饰条发白）。
  // 真实的开放漆面有导管纹打散的微观起伏，掠射反射远弱于镜面清漆，这里在木饰条上把环境反射压掉一半多（T25）
  // T47：轮廓上的菲涅尔按 n·v ≥ 0.3 算（同机翼边缘的做法）。n·v 在轮廓最后一两个像素里从 0.2 掉到 0，
  // 菲涅尔跟着陡升，舱内环境被整片反进来，头枕轮廓外一圈比背景和皮面都亮的 1 px 白色虚线（美术总监 wave6 第 6 条）。
  // 粗糙的皮面（α ≈ 0.16）在像素足迹里本来就是一片微表面的平均，掠射端的菲涅尔远没有单一镜面那么陡
  float F = fresnelRough(max(nv, 0.3), 0.04, rough) * (1.0 - 0.6 * wood);
  // 光滑的面（漆面、木饰、屏幕玻璃）能照出窗户；皮面太粗，只取舱内环境
  float mirror = 1.0 - smoothstep(0.15, 0.35, rough);
  vec3 envR = cabinEnv(r, cl);
  if (mirror > 0.0) envR = mix(envR, cl.lWin, sunThroughWindow(p, r, shadeBottom) * mirror);
  col += F * envR * ao;
  if (metal > 0.0) col = mix(col, cabinChampagne(p, nn, rd, 0.28, ao, e, cl), metal);
  return col;
#endif
}
`;
