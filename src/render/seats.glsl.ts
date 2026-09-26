/**
 * 座椅（GLSL）：靠窗座位看出去，画面边缘的本排靠背（头枕侧翼）和前排靠背（背壳、木饰条、熄屏的娱乐屏、包过顶的头枕）。
 * 依赖 CABIN_SHADING_COMMON、LEATHER_COMMON、CABIN_COMMON（windowIrradiance / sunThroughWindow）。
 *
 * 几何沿用经济舱量级的估计（不是某个型号的实测）：排距 0.78 m（约 31 英寸），靠背后仰约 16°，
 * 座椅外侧离侧壁约 8 cm，靠背顶离地约 1.07 m；座舱系原点是窗洞中心，眼睛默认正对窗口，头枕在眼睛后方约 20 cm。
 * 材质按高端舱位做（T20，用户定「高级、先进、奢华」）：深石板灰皮革的靠背 + 暖灰白纳帕皮头枕（绗缝通道、撞色包边、双明线），
 * 背壳是珍珠灰缎面漆、胡桃木饰条、香槟色金属细线。配色是示意，不对应任何航司。
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
  float r = mix(0.025, 0.034, smoothstep(SEAT_TOP - 0.12, SEAT_TOP, q.y));
  float coverPuff = 0.003 * smoothstep(SEAT_TOP - 0.26, SEAT_TOP - 0.22, q.y) * (1.0 - wz * wz);
  vec2 w = vec2(d2 + r, abs(q.x) - th - bulge - coverPuff + r);
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
  for (int i = 0; i < 32 + uLoopGuard; i++) {
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

vec3 seatNormal(vec3 p, float e, float row) {
  const vec2 k = vec2(1.0, -1.0);
  return normalize(k.xyy * sdSeatBack(seatFrame(p + k.xyy * e, row)) + k.yyx * sdSeatBack(seatFrame(p + k.yyx * e, row))
                 + k.yxy * sdSeatBack(seatFrame(p + k.yxy * e, row)) + k.xxx * sdSeatBack(seatFrame(p + k.xxx * e, row)));
}

// 距离场 AO：沿法线取两个点，看离别的表面（另一排座椅、侧壁）有多近
float seatAO(vec3 p, vec3 n) {
  const float h = 0.08;
  vec3 x = p + n * h;
  float d = min(sdSeats(x), wallZ(x.y) - x.z);
  return clamp(1.0 - 0.6 * (h - d) / h, 0.25, 1.0);
}

// 皮面上的缝：横缝（头枕的绗缝通道、头枕与靠背的接缝、背面头枕包边）+ 竖缝（头枕两侧的撞色包边、靠背正面的分片缝）。
// 返回 x = 线覆盖率、y = 凹槽压暗、z = 横缝斜率（沿靠背向上）、w = 竖缝斜率（沿 |z| 向外）
vec4 seatSeams(vec3 q, float fr, float wz, float pix, float coverZone) {
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
  return vec4(max(h.x, v.x), max(h.y, v.y), h.z, v.z);
}

vec3 shadeSeat(vec3 ro, vec3 rd, SeatHit sh, float pixAng, CabinLights cl, float shadeBottom) {
  vec3 p = ro + rd * sh.t;
  float pixRaw = sh.t * pixAng;
  // 哪一排、局部坐标
  vec3 q0 = seatFrame(p, 0.0), q1 = seatFrame(p, 1.0);
  bool front = sdSeatBack(q1) < sdSeatBack(q0);
  vec3 q = front ? q1 : q0;
  vec3 n = seatNormal(p, max(0.0006, pixRaw * 0.7), front ? 1.0 : 0.0);
  vec3 v = -rd;
  float nvGeo = max(dot(n, v), 0.0);
  float pix = pixRaw / max(nvGeo, 0.25);
  float th = seatHalfThick(q.y);
  float fr = (q.x + th) / (2.0 * th);                 // 0 背面 … 1 正面
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
  float seatId = front ? 1.0 : 0.0;

  vec3 albedo;
  vec3 nn = n;
  float rough;
  float metal = 0.0;   // 香槟色金属饰条的覆盖率
  float glass = 0.0;   // 屏幕玻璃
  if (shell > 0.5) {
    // 背壳：珍珠灰的缎面漆，极细的磨砂；上沿一条胡桃木饰条（上下各一道金属细线），中间一块熄屏的娱乐屏（黑玻璃 + 金属细框）
    albedo = vec3(0.60, 0.585, 0.56);
    rough = 0.32;
    vec3 nd = vnoiseD(uv * 1200.0 + seatId * 7.0);
    float fine = 1.0 - smoothstep(0.0003, 0.001, pix);
    nn = normalize(n + (tu * nd.y + tv * nd.z) * 1200.0 * 0.00001 * fine);
    float inW = step(abs(wz), SEAT_HW - 0.035);
    // 木饰条：宽 2.4 cm，在头枕包边下方 2 cm
    float yb = q.y - (SEAT_TOP - 0.10);
    float band = (1.0 - smoothstep(0.012 - pix * 0.5, 0.012 + pix * 0.5, abs(yb))) * inW;
    if (band > 0.0) {
      float wr;
      vec3 wood = leatherWalnut(vec2(wz, yb) + seatId * 0.31, pix, seatId * 5.0 + 2.0, wr);
      albedo = mix(albedo, wood, band);
      rough = mix(rough, wr, band);
    }
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
    vec4 sm = seatSeams(q, fr, wz, pix, coverZone);
    // 缝线：深色皮上是暖灰的撞色线，浅色皮上是同色系略深的线
    vec3 threadC = mix(vec3(0.36, 0.33, 0.28), vec3(0.30, 0.265, 0.22), kind);
    albedo = mix(albedo * (1.0 - sm.y), threadC, sm.x);
    rough = mix(rough, 0.55, sm.x);
    vec3 up = seatDirToCabin(vec3(0.0, 1.0, 0.0));
    vec3 side = vec3(0.0, 0.0, wz < 0.0 ? -1.0 : 1.0);
    nn = normalize(n + tu * lt.slope.x + tv * lt.slope.y - up * sm.z - side * sm.w);
  }

  float ao = seatAO(p, n);
  float nv = max(dot(nn, v), 1e-3);
  float sunVis = sunThroughWindow(p, cl.sunC, shadeBottom) * step(0.0, cl.sunC.z);
  vec3 eWin = windowIrradiance(p, nn, cl.lWin);
  vec3 e = cabinIrradiance(p, nn, cl) * ao + eWin * sqrt(ao) + cl.eSunNormal * max(dot(nn, cl.sunC), 0.0) * sunVis;
  vec3 col = albedo / M_PI * e;

  // 高光：窗户（当成从窗中心来的光，面光源把高光撑宽）、直射光、氛围灯、舱内环境。皮革和漆面都是电介质（F0 = 4%）
  vec3 r = reflect(rd, nn);
  float a2 = rough * rough;
  vec3 lw = normalize(vec3(0.0, 0.0, PANE_DEPTH) - p);
  col += keySpec(nn, v, lw, max(a2, 0.12), 0.04, eWin) * sqrt(ao);
  col += keySpec(nn, v, cl.sunC, a2, 0.04, cl.eSunNormal) * sunVis;
  col += cabinMoodSpec(p, nn, v, max(a2, 0.08), 0.04, cl.moodI) * ao;
  float F = fresnelRough(nv, 0.04, rough);
  // 光滑的面（漆面、木饰、屏幕玻璃）能照出窗户；皮面太粗，只取舱内环境
  float mirror = 1.0 - smoothstep(0.15, 0.35, rough);
  vec3 envR = cabinEnv(r, cl);
  if (mirror > 0.0) envR = mix(envR, cl.lWin, sunThroughWindow(p, r, shadeBottom) * mirror);
  col += F * envR * ao;
  if (metal > 0.0) col = mix(col, cabinChampagne(p, nn, rd, 0.28, ao, e, cl), metal);
  return col;
}
`;
