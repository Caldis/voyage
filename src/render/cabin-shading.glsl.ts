/**
 * 舱内着色（GLSL）：侧壁、窗框（装饰边 + 窗洞内衬）、遮光板、相邻的舷窗。座椅在 seats.glsl.ts，织物在 fabric.glsl.ts。
 * 依赖 VIEW_COMMON、CABIN_COMMON、PANE_COMMON、WING_COMMON（ggxD / smithG）、LIGHTS_COMMON，
 * 以及 scene.ts 里声明的 uCabinLight / uShadeBottom / uSeatSign。
 *
 * 所有函数都在 main() 的分支里调用，所以这里一律不用屏幕导数：像素足迹 = 命中距离 × 像素张角 / |cos|（解析）。
 *
 * 光照（都是绝对量，照度 klux、辐亮度 kcd/m²）：
 * - 舱内环境光：顶灯 + 满舱窗户进来的光来回反射（scene.ts 里算的 eCabin），按法线朝向上方灯带的程度加权；
 * - 本窗的窗板当面光源（windowIrradiance，解析）；穿过窗板的直射光（sunThroughWindow，逐点判断）；
 * - 舱灯关掉时：一盏前排上方的阅读灯（示例设定：邻座有人开着阅读灯），暖白，照度只有几 lux。
 * 高光：塑料用 GGX；环境高光用一个粗略的「舱内环境」函数（上方灯带亮、过道对面一排窗户亮）。
 */
export const CABIN_SHADING_COMMON = /* glsl */ `
const float WINDOW_PITCH = 0.533;                 // 舷窗间距 ≈ A320 的框距（21 英寸）
const vec3 CABIN_LIGHT_DIR = vec3(0.0, 0.8, -0.6); // 行李架下 / 舱顶灯带大致在上方、偏过道一侧
const vec3 LINING_ALBEDO = vec3(0.80, 0.78, 0.73);  // 侧壁内饰板：偏暖的米白
const vec3 REVEAL_ALBEDO = vec3(0.80, 0.79, 0.76);  // 窗罩（单独的注塑件，比侧壁略白、略亮）
const vec3 DUST_ALBEDO = vec3(0.40, 0.37, 0.32);
const vec3 GASKET_ALBEDO = vec3(0.06, 0.055, 0.045); // 老化略泛黄的灰黑橡胶
const vec3 READING_LIGHT_COLOR = vec3(1.0, 0.8, 0.58);
// 相邻的舷窗：遮光板拉到底（窗外那一路只为本窗算，云也只算了本窗附近，所以邻窗不开）。下沿的把手还露在窗洞里
const float NB_SHADE = -0.178;

struct CabinLights {
  vec3 sunC;        // 座舱系里的直射主光源方向
  vec3 eSunNormal;  // 穿过窗板后的直射照度（垂直于光线）
  vec3 lWin;        // 窗板当面光源时的平均辐亮度
  vec3 eCabin;      // 舱内环境照度
  vec3 lGlow;       // 相邻舷窗（遮光板放下）透过来的辐亮度
  float readOn;     // 阅读灯 0..1（舱灯关掉时才亮）
};

// 值噪声及其解析梯度：x = 值，yz = 对 p 的偏导
vec3 vnoiseD(vec2 p) {
  vec2 i = floor(p);
  vec2 f = fract(p);
  vec2 u = f * f * (3.0 - 2.0 * f);
  vec2 du = 6.0 * f * (1.0 - f);
  float a = hash12(i), b = hash12(i + vec2(1.0, 0.0)), c = hash12(i + vec2(0.0, 1.0)), d = hash12(i + vec2(1.0, 1.0));
  float k = a - b - c + d;
  return vec3(a + (b - a) * u.x + (c - a) * u.y + k * u.x * u.y,
              du * vec2(b - a + k * u.y, c - a + k * u.x));
}

// 环境光的方向性：朝上方灯带的表面更亮。按竖直侧壁（法线 −z）归一化，侧壁的亮度和改前一致
float hemiCabin(vec3 n) {
  return (0.35 + 0.65 * max(dot(n, normalize(CABIN_LIGHT_DIR)), 0.0)) / 0.74;
}

// 阅读灯：前排上方的服务面板，光锥朝下。示例设定，不是实测
vec3 readingLight(vec3 p, vec3 n, float on) {
  if (on <= 0.0) return vec3(0.0);
  vec3 d = vec3(0.30 * uSeatSign, 0.85, -0.70) - p;
  float r2 = dot(d, d);
  vec3 l = d * inversesqrt(r2);
  float cone = smoothstep(0.6, 0.92, l.y);
  return on * READING_LIGHT_COLOR * 0.004 * cone * max(dot(n, l), 0.0) / r2; // 1 m 处约 4 lux
}

vec3 cabinIrradiance(vec3 p, vec3 n, CabinLights cl) {
  return cl.eCabin * hemiCabin(n) + readingLight(p, n, cl.readOn);
}

// 舱内环境的辐亮度（给光滑表面的反射用）：上方灯带亮，过道对面同一高度有一排窗户
vec3 cabinEnv(vec3 r, CabinLights cl) {
  vec3 base = cl.eCabin / M_PI * (0.45 + 0.9 * smoothstep(-0.3, 0.9, dot(r, normalize(CABIN_LIGHT_DIR))));
  float opp = step(r.z, 0.0) * exp(-r.y * r.y / 0.02) * 0.3; // 对面窗户约占那一条的 30%
  return base + opp * cl.lWin;
}

float fresnelRough(float nv, float f0, float rough) {
  return f0 + (max(1.0 - rough, f0) - f0) * pow(1.0 - clamp(nv, 0.0, 1.0), 5.0);
}

// 直射光在光滑塑料上的高光（GGX）
vec3 keySpec(vec3 n, vec3 v, vec3 l, float a, float f0, vec3 e) {
  float nl = dot(n, l);
  if (nl <= 0.0) return vec3(0.0);
  vec3 hv = normalize(l + v);
  float nv = max(dot(n, v), 1e-3);
  float nh = max(dot(n, hv), 0.0);
  float f = f0 + (1.0 - f0) * pow(1.0 - max(dot(hv, v), 0.0), 5.0);
  return e * nl * f * ggxD(nh, a) * smithG(nv, nl, a) / (4.0 * nv * nl);
}

// ---- 侧壁轮廓 ----
// 窗口一带是平的（z = 0，窗洞内衬从这里开始）；往上朝行李架内收，往下略微内收（机身截面是圆的）
float wallZ(float y) {
  float u = max(y - 0.30, 0.0), l = max(-0.30 - y, 0.0);
  return -0.5 * u * u - 0.15 * l * l;
}
float wallSlope(float y) { return -max(y - 0.30, 0.0) + 0.3 * max(-0.30 - y, 0.0); }

// 视线与侧壁的交点（牛顿迭代；轮廓是凸的，从平面交点出发单调收敛）
float traceWall(vec3 ro, vec3 rd) {
  float t = -ro.z / rd.z;
  for (int i = 0; i < 3; i++) {
    vec3 p = ro + rd * t;
    float f = p.z - wallZ(p.y);
    t -= f / max(rd.z - wallSlope(p.y) * rd.y, 1e-3);
  }
  return t;
}

// 圆角矩形距离场的梯度方向（2D）
vec2 roundRectDir(vec2 p, vec2 b, float r) {
  vec2 q = abs(p) - b + r;
  vec2 g = (q.x > 0.0 && q.y > 0.0) ? normalize(q) : (q.x > q.y ? vec2(1.0, 0.0) : vec2(0.0, 1.0));
  return g * vec2(p.x < 0.0 ? -1.0 : 1.0, p.y < 0.0 ? -1.0 : 1.0);
}

// 细线（接缝、槽）的覆盖率：线宽 w、像素足迹 pix，按面积守恒抗锯齿
float lineCov(float d, float w, float pix) {
  float ww = max(w, pix);
  return (w / ww) * (1.0 - smoothstep(0.0, ww, d));
}

// ---- 侧壁 ----
// p：命中点；wq：相对最近那扇窗中心的坐标；dBez：到那扇窗装饰边开口的距离；seed：每扇窗不同的随机种子；
// seatAO：座椅对侧壁的遮挡（接触阴影）
vec3 shadeWall(vec3 p, vec3 rd, float t, float pixAng, vec2 wq, float dBez, float seed, float seatAO, CabinLights cl) {
  vec3 n0 = normalize(vec3(0.0, wallSlope(p.y), -1.0));
  float pix = t * pixAng / max(-dot(n0, rd), 0.2);
  vec3 albedo = LINING_ALBEDO;
  float rough = 0.55;
  float ao = seatAO;

  // 1. 橘皮纹：约 1 mm 的起伏、十几微米高，主要在高光里看得出；比像素细时淡出
  float fPeel = 1.0 - smoothstep(0.0003, 0.001, pix);
  vec3 nA = vnoiseD(p.xy * 700.0);
  vec3 nB = vnoiseD(p.xy * 1600.0 + 3.1);
  vec2 slope = (nA.yz * 700.0 + 0.5 * nB.yz * 1600.0) * 0.00003 * fPeel;
  albedo *= 1.0 + 0.035 * (nA.x - 0.5) * fPeel;

  // 2. 装饰边：窗罩的翻边压在侧壁上，宽约 1.8 cm、高约 2 mm，外沿是圆角——窗框的「厚度」主要靠它
  const float FL = 0.018;
  vec2 gB = roundRectDir(wq, BEZEL_HALF, BEZEL_RADIUS);
  float flange = 1.0 - smoothstep(FL - 0.001, FL + 0.001, dBez);
  float edge = clamp((dBez - (FL - 0.006)) / 0.006, 0.0, 1.0);         // 圆角外沿 0..1
  float tilt = sin(edge * M_PI) * 0.85 * step(dBez, FL);               // 外沿法线朝外翻
  slope += gB * tilt;
  albedo = mix(albedo, REVEAL_ALBEDO, flange);
  rough = mix(rough, 0.35, flange);
  // 翻边外侧贴着侧壁的一圈窄阴影
  ao *= 1.0 - 0.35 * (1.0 - smoothstep(FL, FL + 0.005, dBez)) * step(FL - 0.0005, dBez);

  // 翻边与侧壁的接缝：一圈约 2.5 mm 的缎面铝收边条（截面是圆的，上沿迎着灯带发亮），外侧一道细阴影线。
  // 下半圈被手蹭得更亮（粗糙度低）。数值是示意，不是某个机型的实测
  float trimU = (dBez - FL) / 0.0025;                                  // 0..1 横跨收边条
  float trim = lineCov(abs(dBez - (FL + 0.00125)), 0.00125, pix);
  float trimTilt = (trimU - 0.5) * 1.6 * step(0.0, trimU) * step(trimU, 1.0);
  float shadowLine = lineCov(abs(dBez - (FL + 0.0031)), 0.0004, pix);
  ao *= 1.0 - 0.5 * shadowLine;
  // 卡扣螺丝：沿翻边一圈 6 颗，直径约 5 mm 的圆头，中间十字槽
  float screw = 0.0;
  float screwSlot = 0.0;
  vec2 screwN = vec2(0.0);
  {
    float ang = atan(wq.y * BEZEL_HALF.x / BEZEL_HALF.y, wq.x);
    float k = floor(ang / (M_PI / 3.0)) + 0.5;
    float a = k * (M_PI / 3.0);
    vec2 dir = normalize(vec2(cos(a) * BEZEL_HALF.x, sin(a) * BEZEL_HALF.y));
    float r = length(BEZEL_HALF);
    for (int i = 0; i < 3; i++) r += (FL - 0.009) - sdRoundRect(dir * r, BEZEL_HALF, BEZEL_RADIUS);
    vec2 d = wq - dir * r;
    float rr = length(d);
    screw = 1.0 - smoothstep(0.0025 - pix * 0.5, 0.0025 + pix * 0.5, rr);
    vec2 dr = mat2(0.7071, 0.7071, -0.7071, 0.7071) * d; // 十字槽转 45°
    screwSlot = max(lineCov(abs(dr.x), 0.00025, pix) * step(abs(dr.y), 0.0017),
                    lineCov(abs(dr.y), 0.00025, pix) * step(abs(dr.x), 0.0017)) * screw;
    screwN = d / 0.0025 * 0.9 * screw;                                   // 圆头的法线
  }
  slope += gB * trimTilt * trim + screwN;
  // 凹角积灰：窗下半圈、收边条外侧那道缝里
  float cornerDust = lineCov(abs(dBez - (FL + 0.0035)), 0.0012, pix) * smoothstep(-0.12, -0.2, wq.y)
                   * (0.6 + 0.4 * vnoise(p.xy * 300.0 + seed));

  // 3. 面板接缝：每两扇窗一块板，竖缝在两窗之间；上方一道横缝接行李架下的面板
  float sx = abs(fract((p.x + 0.2665) / (2.0 * WINDOW_PITCH) + 0.5) - 0.5) * 2.0 * WINDOW_PITCH;
  float sy = abs(p.y - 0.42);
  float groove = max(lineCov(sx, 0.0012, pix), lineCov(sy, 0.0012, pix));
  // 接缝上沿有一道被灯带照亮的倒角
  float bevel = lineCov(abs(p.y - 0.4222), 0.0008, pix) * step(0.42, p.y);
  ao *= 1.0 - 0.6 * groove;

  // 4. 脏污：大尺度的斑驳 + 窗下沿一带手经常扶的地方（发暗、发油光）+ 零星的鞋印 / 包蹭出的污痕
  float mottle = fbm2(p.xy * 5.0 + seed * 7.0);
  albedo *= 1.0 - 0.07 * smoothstep(0.35, 0.8, mottle);
  float hand = exp(-pow((wq.y + 0.25) / 0.07, 2.0)) * exp(-pow(wq.x / 0.17, 2.0));
  hand += 0.6 * exp(-pow((wq.y + 0.05) / 0.12, 2.0)) * exp(-pow((abs(wq.x) - 0.21) / 0.035, 2.0)); // 两侧推墙探头看的位置
  float oil = hand * smoothstep(0.3, 0.7, fbm2(p.xy * 40.0 + seed));
  albedo *= 1.0 - 0.16 * oil;
  albedo = mix(albedo, DUST_ALBEDO, cornerDust * 0.8);
  albedo = mix(albedo, albedo * vec3(0.97, 0.95, 0.90), hand * 0.6);
  rough = mix(rough, 0.25, clamp(oil * 1.4, 0.0, 1.0));
  // 蹭痕：约 5 cm 一格，稀疏；越往下越多
  vec2 sc = floor(p.xy / 0.05);
  vec2 sh = hash22(sc + seed * 3.1);
  if (sh.x < 0.10 * smoothstep(0.1, -0.35, p.y) + 0.02) {
    vec2 c = (sc + 0.2 + 0.6 * hash22(sc + 1.7)) * 0.05;
    float ang = sh.y * 3.0;
    vec2 d = mat2(cos(ang), sin(ang), -sin(ang), cos(ang)) * (p.xy - c);
    float len = mix(0.004, 0.02, fract(sh.y * 13.0));
    float s = 1.0 - smoothstep(0.0, 1.0, length(d / vec2(len, 0.0012 + pix)));
    albedo *= 1.0 - 0.25 * s * (1.0 - smoothstep(0.002, 0.01, pix));
  }

  // 5. 细划痕：窗下方、清洁时擦出的横向细纹，只在高光里闪
  float scr = 0.0;
  {
    vec2 q = p.xy;
    float row = floor(q.y / 0.004);
    float h = hash12(vec2(row, seed));
    float along = q.x + h * 3.0;
    float segId = floor(along / 0.03);
    float present = step(hash12(vec2(segId, row + seed)), 0.25) * smoothstep(-0.1, -0.3, wq.y);
    float dy = abs(fract(q.y / 0.004) - 0.2 - 0.6 * fract(h * 17.0)) * 0.004;
    scr = present * lineCov(dy, 0.00005, pix) * smoothstep(0.0, 0.2, fract(along / 0.03)) * (1.0 - smoothstep(0.7, 1.0, fract(along / 0.03)));
  }

  vec3 n = normalize(n0 + vec3(slope, 0.0));
  vec3 v = -rd;
  float nv = max(dot(n, v), 1e-3);
  // 上亮下暗：顶灯和行李架下的灯带从上方照下来（和改前一致）
  float grad = 1.0 + 0.35 * clamp(p.y / 0.4, -1.0, 1.0);
  vec3 e = cabinIrradiance(p, n, cl) * grad * ao;
  vec3 col = albedo / M_PI * e;
  col += albedo / M_PI * e * 0.8 * bevel;
  // 环境反射（油光、橘皮纹、翻边的圆角都靠它显形）
  float F = fresnelRough(nv, 0.04, rough);
  col += F * cabinEnv(reflect(rd, n), cl) * ao * (1.0 - 0.5 * rough) * grad;
  col += scr * 0.25 * cabinEnv(reflect(rd, n0), cl) * ao;
  // 金属件（收边条、螺丝）：暗的漫反射 + 强的环境反射；下半圈手常摸的地方被磨亮
  float metal = clamp(trim + screw, 0.0, 1.0);
  if (metal > 0.0) {
    float worn = smoothstep(-0.1, -0.22, wq.y);
    float mr = mix(0.32, 0.18, worn);
    vec3 mcol = vec3(0.62, 0.62, 0.64);
    float Fm = fresnelRough(nv, 0.55, mr);
    vec3 metalCol = mcol * 0.15 / M_PI * e + Fm * mcol * cabinEnv(reflect(rd, n), cl) * ao * mix(1.0, 1.5, worn);
    metalCol *= 1.0 - 0.8 * screwSlot;
    col = mix(col, metalCol, metal);
  }
  return col;
}

// ---- 窗洞内衬（漏斗） ----
// h：命中点（窗口局部坐标）；lAperture：窗口本身的辐亮度（本窗 = 窗外的光，邻窗 = 遮光板透过来的光）；
// sunOn：是否算直射光（邻窗的遮光板放下了，不算）
vec3 shadeReveal(vec3 h, vec3 n, vec3 rd, float t, float pixAng, CabinLights cl, vec3 lAperture, float sunOn, float shadeBottom, float seed) {
  float pix = t * pixAng / max(abs(dot(n, rd)), 0.25);
  float depth01 = clamp(h.z / PANE_DEPTH, 0.0, 1.0);
  float ao = mix(1.0, 0.45, sqrt(depth01)); // 越深，看到的舱内越少
  vec3 albedo = REVEAL_ALBEDO * (1.0 + 0.04 * (vnoise(h.xy * 900.0 + h.z * 500.0) - 0.5) * (1.0 - smoothstep(0.0003, 0.001, pix)));
  float rough = 0.3;

  // 遮光板的导轨槽：两侧、遮光板所在的深度上一道约 3 mm 的暗槽
  float side = smoothstep(0.55, 0.85, abs(n.x));
  float slot = lineCov(abs(h.z - SHADE_DEPTH), 0.0016, pix) * side;
  ao *= 1.0 - 0.75 * slot;

  // 积灰：朝上的面（漏斗下半圈）、越深越多，窗板边角和导轨槽里最多；带细小颗粒
  float up = smoothstep(0.15, 0.7, n.y);
  float grit = vnoise(h.xy * 2500.0 + seed) * (1.0 - smoothstep(0.0002, 0.0008, pix)) + 0.5 * smoothstep(0.0002, 0.0008, pix);
  float dust = up * (0.2 + 0.8 * smoothstep(0.35, 0.95, depth01)) * (0.55 + 0.45 * fbm2(h.xy * 60.0 + seed));
  dust = clamp(dust * (0.7 + 0.6 * grit) + slot * 0.5, 0.0, 1.0);
  albedo = mix(albedo, DUST_ALBEDO, dust * 0.7);
  rough = mix(rough, 0.85, dust);

  // 窗口下沿靠近舱内的地方：手指油污（发暗、更亮的油光）
  float lip = (1.0 - smoothstep(0.0, 0.35, depth01)) * smoothstep(-0.1, -0.2, h.y);
  float oil = lip * smoothstep(0.35, 0.7, fbm2(h.xy * 50.0 + seed * 2.0));
  albedo *= 1.0 - 0.1 * oil;
  rough = mix(rough, 0.18, oil);

  // 密封条：窗板四周最深的那约 1 cm（正面看约 3 mm 宽），老化的橡胶，颜色沿一圈略有变化
  float gasket = smoothstep(PANE_DEPTH - 0.0085, PANE_DEPTH - 0.0065, h.z);
  float age = vnoise(vec2(atan(h.y, h.x) * 12.0, seed));
  albedo = mix(albedo, GASKET_ALBEDO * (0.85 + 0.35 * age), gasket);
  rough = mix(rough, 0.6, gasket);

  vec3 v = -rd;
  float nv = max(dot(n, v), 1e-3);
  float sunVis = sunOn * sunThroughWindow(h, cl.sunC, shadeBottom);
  vec3 e = cabinIrradiance(h, n, cl) * ao + windowIrradiance(h, n, lAperture)
         + cl.eSunNormal * max(dot(n, cl.sunC), 0.0) * sunVis;
  vec3 col = albedo / M_PI * e;

  // 光滑塑料反射窗口：掠射角下窗框内侧有一圈亮边。反射方向能不能穿过窗口（且没被遮光板挡住）用 sunThroughWindow 判断
  vec3 r = reflect(rd, n);
  float F = fresnelRough(nv, 0.04, rough);
  float winVis = sunThroughWindow(h, r, shadeBottom);
  col += F * mix(cabinEnv(r, cl) * ao, lAperture, winVis) * (1.0 - 0.6 * dust);
  // 太阳的高光
  col += keySpec(n, v, cl.sunC, rough * rough, 0.04, cl.eSunNormal) * sunVis * (1.0 - dust);
  return col;
}

// ---- 遮光板 ----
// p：视线与遮光板平面的交点（窗口局部坐标）
vec3 shadeShade(vec3 p, vec3 rd, float pix, CabinLights cl, float shadeBottom, float seed) {
  float yb = p.y - shadeBottom;             // 离下沿的距离
  // 下沿的把手：约 1.4 cm 高的圆棱，向舱内凸出；截面从朝下转到朝上
  const float HB = 0.014;
  float k = clamp(yb / HB, 0.0, 1.0);
  float th = mix(-1.25, 1.1, k);
  vec3 n = normalize(vec3(0.0, sin(th), -cos(th)));
  float onHandle = 1.0 - smoothstep(HB - 0.0015, HB + 0.0015, yb);
  n = normalize(mix(vec3(0.0, 0.0, -1.0), n, onHandle));
  // 把手上方一道窄阴影
  float ao = 1.0 - 0.3 * (1.0 - smoothstep(0.0, 0.004, yb - HB)) * step(HB, yb);

  // 细磨砂纹理 + 很浅的横向注塑流痕
  float fine = 1.0 - smoothstep(0.0003, 0.001, pix);
  vec3 nd = vnoiseD(p.xy * vec2(1400.0, 1100.0) + seed);
  n = normalize(n + vec3(nd.yz * vec2(1400.0, 1100.0) * 0.00002 * fine, 0.0));
  vec3 albedo = PLASTIC_ALBEDO * (1.0 + 0.03 * (nd.x - 0.5) * fine + 0.02 * sin(p.y * 900.0 + vnoise(p.xy * 40.0) * 3.0) * fine);

  // 手拉的地方：把手中间一片发灰、发亮；下沿两角磨得发白
  float grip = exp(-pow(p.x / 0.035, 2.0)) * (1.0 - smoothstep(0.0, 0.035, yb));
  float gOil = grip * (0.5 + 0.5 * fbm2(p.xy * 60.0 + seed));
  albedo *= 1.0 - 0.18 * gOil;
  float rough = mix(0.45, 0.22, gOil);
  float cornerWear = smoothstep(0.08, 0.11, abs(p.x)) * (1.0 - smoothstep(0.0, 0.004, yb));
  albedo = mix(albedo, vec3(0.86, 0.85, 0.83), cornerWear * 0.5);

  vec3 v = -rd;
  float nv = max(dot(n, v), 1e-3);
  vec3 e = cabinIrradiance(p, n, cl) * 0.8 * ao;
  // 把手朝下的面被下面露出来的那截窗口照亮
  float openFrac = clamp((shadeBottom + PANE_HALF.y) / (2.0 * PANE_HALF.y), 0.0, 1.0);
  e += M_PI * cl.lWin * 0.35 * max(-n.y, 0.0) * sqrt(openFrac);
  vec3 col = albedo / M_PI * e;
  // 透光：半透的白色塑料，外面的光透进来一点；把手更厚，透得少
  // 遮光板外侧只有正对窗板开口的那一块被照亮（窗板比窗洞小，隔着 1.5 cm 的间隙，边缘是半影）：
  // 从舱内看，透光的是一块窗板形状的亮区，四周压暗。直射光的亮区沿阳光方向平移
  float dLit = sdRoundRect(p.xy, PANE_HALF, PANE_RADIUS);
  float litSky = 1.0 - smoothstep(-0.006, 0.012, dLit);
  vec2 sunShift = cl.sunC.xy / max(cl.sunC.z, 0.05) * (PANE_DEPTH - SHADE_DEPTH);
  float litSun = 1.0 - smoothstep(-0.002, 0.004, sdRoundRect(p.xy + sunShift, PANE_HALF, PANE_RADIUS));
  vec3 eOuter = M_PI * cl.lWin * mix(0.25, 1.0, litSky) + cl.eSunNormal * max(cl.sunC.z, 0.0) * litSun;
  col += PLASTIC_ALBEDO / M_PI * 0.08 * eOuter * mix(1.0, 0.3, onHandle) * (0.92 + 0.16 * vnoise(p.xy * 25.0 + seed));
  float F = fresnelRough(nv, 0.04, rough);
  col += F * cabinEnv(reflect(rd, n), cl) * ao;
  // 把手上沿的圆棱迎着上方的灯带
  col += albedo / M_PI * cabinIrradiance(p, vec3(0.0, 1.0, 0.0), cl) * 0.5 * smoothstep(0.6, 1.0, n.y) * onHandle;
  return col;
}
`;
