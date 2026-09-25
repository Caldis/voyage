/**
 * 座椅（GLSL）：靠窗座位看出去，画面边缘的本排靠背（头枕侧翼、头枕套）和前排靠背（塑料背壳、小桌板、搭过顶的头枕套）。
 * 依赖 CABIN_SHADING_COMMON、FABRIC_COMMON、CABIN_COMMON（windowIrradiance / sunThroughWindow）。
 *
 * 尺寸按经济舱的常见量级估计（不是某个型号的实测）：排距 0.78 m（约 31 英寸），靠背后仰约 16°，
 * 座椅外侧离侧壁约 8 cm，靠背顶离地约 1.07 m；座舱系原点是窗洞中心，眼睛默认正对窗口，头枕在眼睛后方约 20 cm。
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

float sdSeatBack(vec3 q) {
  float th = seatHalfThick(q.y);
  float wz = clamp((q.z - SEAT_ZC) / SEAT_HW, -1.0, 1.0);
  // 正面软垫中间略鼓
  float bulge = 0.008 * (1.0 - wz * wz) * smoothstep(-0.1, 0.1, q.x);
  // 侧面轮廓（s–z 平面）：顶角圆角的矩形
  vec2 sz = vec2(q.y - 0.5 * (SEAT_TOP + SEAT_BOTTOM), q.z - SEAT_ZC);
  float d2 = sdRoundRect(sz, vec2(0.5 * (SEAT_TOP - SEAT_BOTTOM), SEAT_HW), SEAT_CORNER);
  // 挤出成有厚度的靠背，棱边倒圆 2.5 cm
  const float r = 0.025;
  vec2 w = vec2(d2 + r, abs(q.x) - th - bulge + r);
  float d = min(max(w.x, w.y), 0.0) + length(max(w, 0.0)) - r;
  // 可调头枕与靠背之间的一道横缝
  d += 0.003 * (1.0 - smoothstep(0.0, 0.006, abs(q.y - (SEAT_TOP - 0.25))));
  return d;
}

float sdSeats(vec3 p) {
  return min(sdSeatBack(seatFrame(p, 0.0)), sdSeatBack(seatFrame(p, 1.0)));
}

// 某一排靠背的包围盒（座舱系）
bool seatBox(vec3 ro, vec3 rd, float row, out vec2 tt) {
  float a0 = SEAT_PIVOT.x + row * SEAT_PITCH - SEAT_TOP * SEAT_S - 0.07;
  float a1 = SEAT_PIVOT.x + row * SEAT_PITCH - SEAT_BOTTOM * SEAT_S + 0.07;
  vec3 bmin = vec3(min(uSeatSign * a0, uSeatSign * a1), SEAT_PIVOT.y + SEAT_BOTTOM * SEAT_C - 0.03, SEAT_ZC - SEAT_HW - 0.01);
  vec3 bmax = vec3(max(uSeatSign * a0, uSeatSign * a1), SEAT_PIVOT.y + SEAT_TOP * SEAT_C + 0.03, SEAT_ZC + SEAT_HW + 0.01);
  vec3 inv = 1.0 / rd;
  vec3 t0 = (bmin - ro) * inv, t1 = (bmax - ro) * inv;
  vec3 tn = min(t0, t1), tf = max(t0, t1);
  tt = vec2(max(max(tn.x, tn.y), tn.z), min(min(tf.x, tf.y), tf.z));
  return tt.y > max(tt.x, 0.0);
}

struct SeatHit { float cov; float t; };

// 球追踪；cov = 覆盖率（命中 1；擦边而过时按最近距离 / 像素宽度给部分覆盖，轮廓就是抗锯齿的）
SeatHit traceSeats(vec3 ro, vec3 rd, float tMax, float pixAng) {
  SeatHit sh;
  sh.cov = 0.0;
  sh.t = -1.0;
  vec2 b0, b1;
  bool h0 = seatBox(ro, rd, 0.0, b0);
  bool h1 = seatBox(ro, rd, 1.0, b1);
  if (!h0 && !h1) return sh;
  float t = max(min(h0 ? b0.x : 1e9, h1 ? b1.x : 1e9), 0.0);
  float tEnd = min(max(h0 ? b0.y : 0.0, h1 ? b1.y : 0.0), tMax);
  float best = 1e9;
  float tBest = t;
  for (int i = 0; i < 48 + uLoopGuard; i++) {
    if (t > tEnd) break;
    float d = sdSeats(ro + rd * t);
    float ratio = d / (t * pixAng);
    if (ratio < best) { best = ratio; tBest = t; }
    if (ratio < 0.05) break;
    t += max(d, 0.0004);
  }
  sh.cov = 1.0 - smoothstep(0.05, 1.0, best);
  sh.t = tBest;
  return sh;
}

vec3 seatNormal(vec3 p, float e) {
  const vec2 k = vec2(1.0, -1.0);
  return normalize(k.xyy * sdSeats(p + k.xyy * e) + k.yyx * sdSeats(p + k.yyx * e)
                 + k.yxy * sdSeats(p + k.yxy * e) + k.xxx * sdSeats(p + k.xxx * e));
}

// 距离场 AO：沿法线取两个点，看离别的表面（另一排座椅、侧壁）有多近
float seatAO(vec3 p, vec3 n) {
  float ao = 1.0;
  for (int i = 1; i <= 2; i++) {
    float h = 0.035 * float(i * i);
    vec3 x = p + n * h;
    float d = min(sdSeats(x), wallZ(x.y) - x.z);
    ao -= (h - d) / h * (i == 1 ? 0.35 : 0.25);
  }
  return clamp(ao, 0.25, 1.0);
}

vec3 shadeSeat(vec3 ro, vec3 rd, SeatHit sh, float pixAng, CabinLights cl, float shadeBottom) {
  vec3 p = ro + rd * sh.t;
  float pixRaw = sh.t * pixAng;
  vec3 n = seatNormal(p, max(0.0006, pixRaw * 0.7));
  vec3 v = -rd;
  float nvGeo = max(dot(n, v), 0.0);
  float pix = pixRaw / max(nvGeo, 0.25);

  // 哪一排、局部坐标
  vec3 q0 = seatFrame(p, 0.0), q1 = seatFrame(p, 1.0);
  bool front = sdSeatBack(q1) < sdSeatBack(q0);
  vec3 q = front ? q1 : q0;
  float th = seatHalfThick(q.y);
  float fr = (q.x + th) / (2.0 * th);                 // 0 背面 … 1 正面
  float wz = q.z - SEAT_ZC;
  // 局部坐标里的法线：选投影平面（在棱边处换投影，那里正好是面料的缝线）
  vec2 ay = vec2(uSeatSign * n.x, n.y);
  vec3 nl = vec3(ay.x * SEAT_C + ay.y * SEAT_S, -ay.x * SEAT_S + ay.y * SEAT_C, n.z);
  vec3 an = abs(nl);
  vec2 uv; vec3 tu; vec3 tv;
  if (an.x >= an.y && an.x >= an.z) { uv = q.zy; tu = vec3(0.0, 0.0, 1.0); tv = seatDirToCabin(vec3(0.0, 1.0, 0.0)); }
  else if (an.z >= an.y) { uv = q.xy; tu = seatDirToCabin(vec3(1.0, 0.0, 0.0)); tv = seatDirToCabin(vec3(0.0, 1.0, 0.0)); }
  else { uv = q.zx; tu = vec3(0.0, 0.0, 1.0); tv = seatDirToCabin(vec3(1.0, 0.0, 0.0)); }

  // 材质分区
  float top = smoothstep(SEAT_TOP - 0.05, SEAT_TOP - 0.03, q.y);
  float coverZone = step(abs(wz), SEAT_HW - 0.03);
  // 头枕套：正面上部 25 cm，翻过顶部，在背面垂下约 6 cm
  float cover = coverZone * max(step(SEAT_TOP - 0.25, q.y) * step(0.45, fr), max(top, step(SEAT_TOP - 0.065, q.y) * step(fr, 0.45)));
  // 背壳：背面那三分之一厚度（塑料），头枕套盖住的地方除外
  float shell = (1.0 - smoothstep(0.26, 0.34, fr)) * (1.0 - cover) * (1.0 - top);
  float seatId = front ? 1.0 : 0.0;

  vec3 albedo;
  vec3 nn = n;
  float rough = 0.4;
  vec3 sheenC = vec3(0.0);
  float sheenA = 0.5;
  if (shell > 0.5) {
    // 塑料背壳：浅暖灰、细磨砂；小桌板的轮廓缝和锁扣
    albedo = vec3(0.50, 0.50, 0.48);
    vec3 nd = vnoiseD(uv * 1200.0 + seatId * 7.0);
    float fine = 1.0 - smoothstep(0.0003, 0.001, pix);
    nn = normalize(n + (tu * nd.y + tv * nd.z) * 1200.0 * 0.000015 * fine);
    albedo *= 1.0 + 0.03 * (nd.x - 0.5) * fine;
    // 小桌板：宽 0.40、上沿在顶下 0.17 m；锁扣在上沿中间
    float trayTop = SEAT_TOP - 0.17;
    vec2 tq = vec2(wz, q.y - (trayTop - 0.15));
    float trayD = abs(sdRoundRect(tq, vec2(0.20, 0.15), 0.02));
    float trayGroove = lineCov(trayD, 0.0012, pix);
    float latch = 1.0 - smoothstep(0.0, max(pix, 0.001), sdRoundRect(vec2(wz, q.y - trayTop - 0.02), vec2(0.018, 0.008), 0.004));
    albedo *= 1.0 - 0.55 * trayGroove;
    albedo = mix(albedo, vec3(0.10, 0.10, 0.11), latch);
    // 背壳上的蹭痕和手印（靠近上沿被后排的人扶）
    float grab = smoothstep(SEAT_TOP - 0.2, SEAT_TOP - 0.06, q.y) * smoothstep(0.35, 0.7, fbm2(uv * 30.0 + seatId));
    albedo *= 1.0 - 0.12 * grab;
    rough = mix(0.42, 0.25, grab);
  } else {
    float kind = cover > 0.5 ? 1.0 : 0.0;
    Fabric fb = fabricSample(uv + seatId * 1.37, pix, kind);
    albedo = fb.albedo;
    sheenC = fb.sheen;
    sheenA = fb.sheenRough;
    // 微褶：头枕套被头压出的横向褶皱；座椅面料在棱边附近被绷紧的细褶
    float wr = kind > 0.5 ? 1.0 : 0.35;
    vec3 wn = vnoiseD(vec2(uv.x * 18.0, uv.y * 55.0) + seatId * 3.0);
    vec2 wslope = wn.yz * vec2(18.0, 55.0) * 0.0012 * wr;
    nn = normalize(n + tu * (fb.slope.x + wslope.x) + tv * (fb.slope.y + wslope.y));
    // 头枕套的包边：沿边缘一道暗线
    float hem = kind > 0.5 ? lineCov(abs(abs(wz) - (SEAT_HW - 0.035)), 0.0015, pix) + lineCov(abs(q.y - (SEAT_TOP - 0.25)), 0.0015, pix) * step(0.45, fr) : 0.0;
    albedo *= 1.0 - 0.3 * clamp(hem, 0.0, 1.0);
  }

  float ao = seatAO(p, n);
  float nv = max(dot(nn, v), 1e-3);
  float sunVis = sunThroughWindow(p, cl.sunC, shadeBottom) * step(0.0, cl.sunC.z);
  vec3 eWin = windowIrradiance(p, nn, cl.lWin);
  vec3 e = cabinIrradiance(p, nn, cl) * ao + eWin * sqrt(ao) + cl.eSunNormal * max(dot(nn, cl.sunC), 0.0) * sunVis;
  vec3 col = albedo / M_PI * e;

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
}
`;
