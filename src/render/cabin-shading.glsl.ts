/**
 * 舱内着色（GLSL）：侧壁、窗框（装饰边 + 窗洞内衬）、遮光板、相邻的舷窗、舱内灯光（主灯 + 氛围洗墙灯 + 阅读灯）。
 * 座椅在 seats.glsl.ts，皮革 / 木饰 / 金属饰条在 cabin-leather.glsl.ts。
 * 依赖 VIEW_COMMON、CABIN_COMMON、PANE_COMMON、WING_COMMON（ggxD / smithG）、LIGHTS_COMMON，
 * 以及 scene.ts 里声明的 uCabinLight / uShadeBottom / uSeatSign / uDebug。
 *
 * 审美定位（用户 2026-09-26 定）：「高级、先进、奢华」的真实感，不要「廉价」的真实感——
 * 对标 787 / A350 宽体机与商务舱套间：暖白的柔光饰面带极细压纹、香槟色阳极氧化的拉丝金属收边、精密均匀的接缝、
 * 行李架下的 LED 洗墙氛围灯。痕迹只留「刚清洁过的高端机舱」会有的：亮面上只在掠射角看得见的淡指纹、极少的浮尘。
 *
 * 舱等（T25，用户 2026-09-26：「高端化可以跟之前的廉航风格并存，让用户切换」）：上面是商务舱（默认）。
 * 经济舱是着色器变体 #define CABIN_CLASS_ECONOMY（scene.ts 的 CabinClassVariant 按需后台编译，只编当前选中的一套）：
 * 浅灰塑料侧壁（橘皮纹）与窗罩、缎面铝收边条 + 小螺丝、冷白主灯、没有氛围洗墙灯（睡眠档只有一点冷蓝的夜灯）；
 * 使用痕迹取 T06 的做法但收敛到约一半（用户说过 T06「太脏」）：朴素、有点磨损，不邋遢。胡桃木 / 香槟金属不出现。
 *
 * 所有函数都在 main() 的分支里调用，所以这里一律不用屏幕导数：像素足迹 = 命中距离 × 像素张角 / |cos|（解析）。
 *
 * 光照（都是绝对量，照度 klux、辐亮度 kcd/m²）：
 * - 舱内环境光：主灯 + 满舱窗户进来的光来回反射（scene.ts 里算的 eCabin），按法线朝向上方灯带的程度加权；
 * - 氛围洗墙灯：行李架下沿一条沿机身的 LED 线光源，斜向下打在侧壁上（掠射，压纹在它里面显形），也照到座椅与窗罩；
 *   色温随场景变：白天中性白，夜里开灯暖琥珀，关灯（睡眠）时 787 式的淡紫蓝、照度只有几 lux；
 * - 本窗的窗板当面光源（windowIrradiance，解析）；穿过窗板的直射光（sunThroughWindow，逐点判断）；
 * - 舱灯关掉时：一盏前排上方的阅读灯（示例设定：邻座有人开着阅读灯），暖白，照度只有几 lux。
 * 高光：塑料 / 金属用 GGX；环境高光用一个粗略的「舱内环境」函数（上方灯带与被洗亮的上墙亮、过道对面一排窗户亮）。
 */
export const CABIN_SHADING_COMMON = /* glsl */ `
const float WINDOW_PITCH = 0.533;                 // 舷窗间距 ≈ A320 的框距（21 英寸）
const vec3 CABIN_LIGHT_DIR = vec3(0.0, 0.8, -0.6); // 行李架下 / 舱顶灯带大致在上方、偏过道一侧
// 反照率按真实饰面取（暖白涂层约 0.6–0.75）；不为当前曝光补偿亮度（曝光另有任务）。
// 改侧壁反照率时同步 main.ts 的 CABIN_REF_ALBEDO（曝光的舱内色适应按它把「饰面本色」从光源色里除掉，T28）
#ifdef CABIN_CLASS_ECONOMY
const vec3 LINING_ALBEDO = vec3(0.70, 0.70, 0.68);  // 侧壁内饰板：浅灰的注塑 / 覆膜塑料（略偏冷）
const vec3 REVEAL_ALBEDO = vec3(0.74, 0.74, 0.725); // 窗罩：同色系的浅灰注塑件，略亮
const vec3 GASKET_ALBEDO = vec3(0.06, 0.058, 0.055); // 用了几年的灰黑橡胶密封条
const vec3 CHAMPAGNE_F0 = vec3(0.82, 0.83, 0.85);   // 经济舱没有香槟金属：收边条是缎面铝（沿用同一个着色函数，只换镜面色）
const vec3 DUST_ALBEDO = vec3(0.45, 0.43, 0.40);
#else
const vec3 LINING_ALBEDO = vec3(0.74, 0.70, 0.635); // 侧壁内饰板：暖白柔光饰面（略带香槟调）
const vec3 REVEAL_ALBEDO = vec3(0.77, 0.755, 0.72); // 窗罩（单独的注塑件，珍珠白，比侧壁略冷、略亮）
const vec3 GASKET_ALBEDO = vec3(0.045, 0.045, 0.048); // 新的石墨色硅胶密封条
const vec3 CHAMPAGNE_F0 = vec3(0.90, 0.80, 0.63);   // 香槟色阳极氧化铝的镜面反射色（示意值）
#endif
const vec3 READING_LIGHT_COLOR = vec3(1.0, 0.8, 0.58);
// 氛围洗墙灯：行李架下沿的线光源（座舱系 y、z，米），灯头朝下、略朝侧壁
const vec2 MOOD_POS = vec2(0.62, -0.08);
const vec3 MOOD_AIM = vec3(0.0, -0.553, 0.833);
// 相邻的舷窗：遮光板拉到底（窗外那一路只为本窗算，云也只算了本窗附近，所以邻窗不开）。下沿的把手还露在窗洞里
const float NB_SHADE = -0.178;

struct CabinLights {
  vec3 sunC;        // 座舱系里的直射主光源方向
  vec3 eSunNormal;  // 穿过窗板后的直射照度（垂直于光线）
  vec3 lWin;        // 窗板当面光源时的平均辐亮度
  vec3 eCabin;      // 舱内环境照度
  vec3 lGlow;       // 相邻舷窗（遮光板放下）透过来的辐亮度
  vec3 moodI;       // 氛围洗墙灯的线强度（klux·m，带颜色）
  float readOn;     // 阅读灯 0..1（舱灯关掉时才亮）
};

// 灯光场景：返回主灯的颜色（亮度归一）和氛围灯的线强度。sunY：太阳高度角的正弦；moodOn：面板开关 0..1。
// 白天中性白（约 4300 K）；夜里开灯暖琥珀；关灯是睡眠模式：787 式淡紫蓝的低照度洗墙光。数值是示意，不是某航司的实测
// 经济舱（T25）：主灯是冷白（约 5500 K 的 LED / 荧光灯带，昼夜一样），没有氛围洗墙灯；
// 睡眠档（主灯关、面板「氛围灯」开）只剩一点冷蓝的夜灯，照度约睡眠氛围光的一半
void cabinMoodScene(float cabinLight, float sunY, float moodOn, out vec3 mainTint, out vec3 moodI) {
  float dayF = smoothstep(-0.06, 0.08, sunY);
  float on = smoothstep(0.005, 0.05, cabinLight);
#ifdef CABIN_CLASS_ECONOMY
  mainTint = vec3(0.97, 0.995, 1.07);
  moodI = vec3(0.8, 0.92, 1.35) * 0.018 * (1.0 - on) * moodOn;
  return;
#endif
  mainTint = mix(vec3(1.08, 0.89, 0.65), vec3(0.95, 0.91, 0.85), dayF);
  vec3 moodCol = mix(vec3(1.0, 0.9, 1.5), mix(vec3(1.35, 0.94, 0.54), vec3(1.0, 0.955, 0.89), dayF), on);
  moodI = moodCol * mix(0.035, mix(0.3, 0.45, dayF), on) * moodOn;
}

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

// 环境光的方向性：朝上方灯带的表面更亮。按竖直侧壁（法线 −z）归一化
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

// 氛围洗墙灯到 p 的方向（yz 平面内；线光源沿 x 无限长）
vec3 cabinMoodDir(vec3 p, out float r) {
  vec2 d = MOOD_POS - p.yz;
  r = max(length(d), 0.05);
  return vec3(0.0, d / r);
}

// 线光源的照度 ∝ 强度 · cos / r；灯头有朝向（带遮光格栅），往上方和过道一侧几乎不出光
vec3 cabinMoodWash(vec3 p, vec3 n, vec3 moodI) {
  float r;
  vec3 l = cabinMoodDir(p, r);
  float lobe = pow(max(dot(-l, MOOD_AIM), 0.0), 1.5);
  // 高过灯的地方（行李架里）照不到
  return moodI * max(dot(n, l), 0.0) * lobe / r * step(p.y, MOOD_POS.x - 0.02);
}

vec3 cabinIrradiance(vec3 p, vec3 n, CabinLights cl) {
  return cl.eCabin * hemiCabin(n) + readingLight(p, n, cl.readOn) + cabinMoodWash(p, n, cl.moodI);
}

// 舱内环境的辐亮度（给光滑表面的反射用）：上方灯带亮、被洗墙灯照亮的上墙发着氛围灯的颜色，过道对面同一高度有一排窗户
vec3 cabinEnv(vec3 r, CabinLights cl) {
  vec3 base = cl.eCabin / M_PI * (0.45 + 0.9 * smoothstep(-0.3, 0.9, dot(r, normalize(CABIN_LIGHT_DIR))));
  float opp = step(r.z, 0.0) * exp(-r.y * r.y / 0.02) * 0.3; // 对面窗户约占那一条的 30%
  return base + opp * cl.lWin + cl.moodI * 0.13 * smoothstep(0.1, 0.75, r.y);
}

float fresnelRough(float nv, float f0, float rough) {
  return f0 + (max(1.0 - rough, f0) - f0) * pow(1.0 - clamp(nv, 0.0, 1.0), 5.0);
}

// 直射光在光滑表面上的高光（GGX）
vec3 keySpec(vec3 n, vec3 v, vec3 l, float a, float f0, vec3 e) {
  float nl = dot(n, l);
  if (nl <= 0.0) return vec3(0.0);
  vec3 hv = normalize(l + v);
  float nv = max(dot(n, v), 1e-3);
  float nh = max(dot(n, hv), 0.0);
  float f = f0 + (1.0 - f0) * pow(1.0 - max(dot(hv, v), 0.0), 5.0);
  return e * nl * f * ggxD(nh, a) * smithG(nv, nl, a) / (4.0 * nv * nl);
}

// 氛围洗墙灯在光滑表面上的高光（当成方向光，照度取垂直于光线方向的量）
vec3 cabinMoodSpec(vec3 p, vec3 n, vec3 v, float a, float f0, vec3 moodI) {
  float r;
  vec3 l = cabinMoodDir(p, r);
  float lobe = pow(max(dot(-l, MOOD_AIM), 0.0), 1.5);
  return keySpec(n, v, l, a, f0, moodI * lobe / r);
}

// 金属件的着色（香槟色阳极氧化铝，缎面 / 拉丝）：暗的漫反射 + 带颜色的镜面反射
vec3 cabinChampagne(vec3 p, vec3 n, vec3 rd, float mr, float ao, vec3 e, CabinLights cl) {
  float nv = max(dot(n, -rd), 1e-3);
  vec3 F = CHAMPAGNE_F0 + (vec3(max(1.0 - mr, 0.9)) - CHAMPAGNE_F0) * pow(1.0 - nv, 5.0);
  // 金属靠反射的明暗对比读出来（T35：收边条原来读成白塑料）：朝下反射到的是深色的座椅、地毯，远比 cabinEnv 的均匀近似暗；
  // 朝上是灯带和被洗亮的上墙。只在金属上加这层对比，漆面 / 皮面的粗糙反射仍用原来的均匀近似
  vec3 rm = reflect(rd, n);
  float envK = mix(0.28, 1.2, smoothstep(-0.35, 0.45, rm.y));
  vec3 col = CHAMPAGNE_F0 * 0.12 / M_PI * e + F * cabinEnv(rm, cl) * envK * ao;
  // 金属的颜色只乘一次：keySpec 的 f0 取 1（菲涅尔 ≡ 1），颜色由 CHAMPAGNE_F0 给
  col += CHAMPAGNE_F0 * keySpec(n, -rd, normalize(CABIN_LIGHT_DIR), mr * mr, 1.0, cl.eCabin * 1.5) * ao;
  col += CHAMPAGNE_F0 * cabinMoodSpec(p, n, -rd, mr * mr, 1.0, cl.moodI);
  return col;
}

// 淡指纹：只改变光泽（油膜让亮面在掠射角发雾），正面看几乎看不见。脊线约 0.45 mm，比像素细时淡成一层均匀的薄油膜
float cabinPrint(vec2 q, vec2 c, float ang, float pix) {
  vec2 d = mat2(cos(ang), sin(ang), -sin(ang), cos(ang)) * (q - c) * vec2(1.0, 1.35);
  float r = length(d);
  float mask = 1.0 - smoothstep(0.0045, 0.0085, r);
  if (mask <= 0.0) return 0.0;
  float ridges = 0.5 + 0.5 * sin(r * 14000.0 + vnoise(q * 900.0) * 5.0);
  float fr = 1.0 - smoothstep(0.00012, 0.0003, pix);
  return mask * mix(0.5, ridges, fr) * (0.6 + 0.4 * vnoise(q * 1500.0 + c * 50.0));
}

// 极少量的浮尘：约 9 mm 一格，百分之几的格子里有一粒 0.1–0.2 mm 的灰点；按面积摊薄，远处不闪
float cabinSpeck(vec2 q, float seed, float pix) {
  vec2 cell = floor(q / 0.009);
  vec2 h = hash22(cell + seed * 5.3 + 0.7);
  if (h.x > 0.035) return 0.0;
  vec2 c = (cell + 0.2 + 0.6 * hash22(cell + 9.1)) * 0.009;
  float r = mix(0.00005, 0.0001, h.y);
  return (1.0 - smoothstep(r - pix * 0.5, r + pix * 0.5, length(q - c))) * min(1.0, r * r / max(pix * pix, 1e-12));
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
  float cosV = max(-dot(n0, rd), 0.02);
  float pix = t * pixAng / max(cosV, 0.2);
  // 各向异性的像素足迹（T35）：「看前方 / 看后方」时视线几乎贴着侧壁，像素沿视线在墙面上的投影方向被拉长 1/cos，
  // 垂直于它的方向不拉长。沿 x、沿 y 变化的纹理各按自己方向上的足迹淡出，横向的细纹在掠射时就不会被一起抹平
  float pix0 = t * pixAng;
  vec2 vp = rd.xy;
  vp = dot(vp, vp) > 1e-8 ? normalize(vp) : vec2(1.0, 0.0);
  float pixX = pix0 * length(vec2(vp.x / cosV, vp.y));   // 沿 x 方向的足迹（竖缝、竖纹用）
  float pixY = pix0 * length(vec2(vp.y / cosV, vp.x));   // 沿 y 方向的足迹（横缝、横纹用）
  vec3 albedo = LINING_ALBEDO;
  float ao = seatAO;

#ifdef CABIN_CLASS_ECONOMY
  float rough = 0.55;
#else
  float rough = 0.62;
#endif
  // 1. 柔光饰面的细压纹：约 2.4 mm 的柔和颗粒 + 0.9 mm 的细颗粒（软触感涂层压纹），起伏只有几微米，
  //    主要在掠射的洗墙光里显形；网格转一个角度，免得值噪声的轴向痕迹；比像素细时逐级淡出
  float fA = 1.0 - smoothstep(0.0006, 0.0012, pix);
  float fB = 1.0 - smoothstep(0.00025, 0.0005, pix);
  vec2 slope = vec2(0.0);
#ifndef CABIN_CLASS_ECONOMY
  // 1b. 亚麻压纹的装饰膜（T35）：高端侧壁常见的做法，纬向约 1.9 mm、经向约 2.1 mm 的细棱，每根棱沿长度方向有 1–2 cm 的粗细起伏，
  //     互相不对齐（铁律 4）。只有几微米高：正面看几乎看不出，掠射的洗墙光和掠射反射里显出 2–4% 的明暗。
  //     纬棱（沿 y 变化）按 pixY 淡出、经棱按 pixX 淡出：「看前方」时纬棱留下、经棱先淡掉，远处两者都淡成均匀的缎面
  float fWeft = (1.0 - smoothstep(0.0007, 0.0016, pixY)) * (1.0 - smoothstep(0.005, 0.009, pixX));
  float fWarp = (1.0 - smoothstep(0.0008, 0.0017, pixX)) * (1.0 - smoothstep(0.004, 0.008, pixY));
  if (fWeft + fWarp > 0.0) {
    vec3 we = vnoiseD(vec2(p.x * 60.0 + seed, p.y * 540.0));
    vec3 wa = vnoiseD(vec2(p.x * 470.0, p.y * 70.0 + seed * 1.7) + 13.1);
    slope += vec2(we.y * 60.0, we.z * 540.0) * 0.00006 * fWeft + vec2(wa.y * 470.0, wa.z * 70.0) * 0.00004 * fWarp;
    // T47：0.035 → 0.05。正对侧壁（默认坐姿）时压纹的明暗只剩反照率这一路（洗墙光不掠射），原来高通后的起伏只有 0.3%，读成光面白板
    albedo *= 1.0 + 0.05 * ((we.x - 0.5) * fWeft + 0.7 * (wa.x - 0.5) * fWarp);
  }
  // 淡出的压纹折算成粗糙度（Toksvig 思路）：远处 / 掠射时高光变宽变柔，不闪
  rough += 0.05 * (1.0 - 0.5 * (fWeft + fWarp));
#endif
#ifdef CABIN_CLASS_ECONOMY
  // 经济舱：塑料板的橘皮纹（约 1 mm 的起伏、十几微米高，主要在高光里看得出；T06），比像素细时淡出
  float fPeel = 1.0 - smoothstep(0.00025, 0.0005, pix);
  if (fPeel > 0.0) {
    vec3 nA = vnoiseD(p.xy * 700.0);
    vec3 nB = vnoiseD(p.xy * 1600.0 + 3.1);
    slope = (nA.yz * 700.0 + 0.5 * nB.yz * 1600.0) * 0.00004 * fPeel;
    albedo *= 1.0 + 0.04 * (nA.x - 0.5) * fPeel;
  }
#else
  if (fA > 0.0) {
    vec2 pr = mat2(0.8, 0.6, -0.6, 0.8) * p.xy;
    vec3 nA = vnoiseD(pr * 420.0);
    vec3 nB = vnoiseD(pr * 1100.0 + 3.1);
    // T47：原来是 slope = …，把上面 1b 的亚麻压纹整个覆盖掉了（fA > 0 时总是如此），正对侧壁时压纹的起伏一点不剩
    slope += mat2(0.8, -0.6, 0.6, 0.8) * (nA.yz * 420.0 * 0.00002 * fA + nB.yz * 1100.0 * 0.000007 * fB);
    albedo *= 1.0 + 0.02 * (nA.x - 0.5) * fA;
  }
#endif

  // 1c. 大尺度的起伏（T47，美术总监 wave6 第 12 条：默认坐姿正对侧壁，画面 60% 是一片均匀的白，读成光面白板）。
  //     模压 / 覆膜的大板并不是绝对平的：几厘米到几十厘米尺度上有零点几毫米的缓起伏（板面的「枕感」），
  //     在上方灯带和窗光下是 1–2% 的明暗；饰面本身有很淡的大块色差。两级非整数比的噪声，每块板（seed）不同；
  //     尺度远大于像素，不需要按足迹淡出
  {
    vec3 u1 = vnoiseD(p.xy * 4.3 + seed * 0.37 + 5.3);    // 约 23 cm
    vec3 u2 = vnoiseD(mat2(0.8, 0.6, -0.6, 0.8) * p.xy * 11.7 + seed * 1.1 + 9.1);   // 约 9 cm
    slope += u1.yz * 4.3 * 0.0022 + mat2(0.8, -0.6, 0.6, 0.8) * u2.yz * 11.7 * 0.0005;
    albedo *= 1.0 + 0.016 * (u1.x - 0.5) + 0.01 * (u2.x - 0.5);
  }

  // 2. 装饰边：窗罩的翻边压在侧壁上，宽约 1.8 cm、高约 2 mm，外沿是圆角——窗框的「厚度」主要靠它
  const float FL = 0.018;
  vec2 gB = roundRectDir(wq, BEZEL_HALF, BEZEL_RADIUS);
  float flange = 1.0 - smoothstep(FL - 0.001, FL + 0.001, dBez);
  float edge = clamp((dBez - (FL - 0.006)) / 0.006, 0.0, 1.0);         // 圆角外沿 0..1
  float tilt = sin(edge * M_PI) * 0.85 * step(dBez, FL);               // 外沿法线朝外翻
  slope += gB * tilt;
  albedo = mix(albedo, REVEAL_ALBEDO, flange);
  rough = mix(rough, 0.38, flange);
  // 翻边外侧贴着侧壁的一圈窄阴影
  ao *= 1.0 - 0.3 * (1.0 - smoothstep(FL, FL + 0.005, dBez)) * step(FL - 0.0005, dBez);

  // 翻边与侧壁的接缝：一圈约 2.5 mm 的香槟色阳极氧化收边条（截面是圆的，上沿迎着灯带发亮），外侧一道精密的细阴影线。
  // 暗装卡扣，看不到螺丝。数值是示意，不是某个机型的实测
  float trimU = (dBez - FL) / 0.0025;                                  // 0..1 横跨收边条
  float trim = lineCov(abs(dBez - (FL + 0.00125)), 0.00125, pix);
  float trimTilt = (trimU - 0.5) * 1.6 * step(0.0, trimU) * step(trimU, 1.0);
  float shadowLine = lineCov(abs(dBez - (FL + 0.0031)), 0.00035, pix);
  ao *= 1.0 - 0.45 * shadowLine;
  slope += gB * trimTilt * trim;
#ifdef CABIN_CLASS_ECONOMY
  // 经济舱：翻边上一圈 6 颗卡扣螺丝（直径约 2 mm 的圆头 + 十字槽；T06，用户：看不清才真实，大了会糊）
  float screw = 0.0;
  float screwSlot = 0.0;
  // 螺丝在翻边上离开口约 9 mm 的那一圈；离这圈远的像素（侧壁大部分）直接跳过
  if (abs(dBez - (FL - 0.009)) < 0.0015 + pix) {
    float ang = atan(wq.y * BEZEL_HALF.x / BEZEL_HALF.y, wq.x);
    float k = floor(ang / (M_PI / 3.0)) + 0.5;
    float a = k * (M_PI / 3.0);
    vec2 dir = normalize(vec2(cos(a) * BEZEL_HALF.x, sin(a) * BEZEL_HALF.y));
    float r = length(BEZEL_HALF);
    for (int i = 0; i < 3 + uLoopGuard; i++) r += (FL - 0.009) - sdRoundRect(dir * r, BEZEL_HALF, BEZEL_RADIUS);
    vec2 d = wq - dir * r;
    float rr = length(d);
    screw = (1.0 - smoothstep(0.001 - pix * 0.5, 0.001 + pix * 0.5, rr)) * min(1.0, 0.001 * 0.001 / max(pix * pix, 1e-12) + 0.3);
    vec2 dr = mat2(0.7071, 0.7071, -0.7071, 0.7071) * d; // 十字槽转 45°
    screwSlot = max(lineCov(abs(dr.x), 0.0001, pix) * step(abs(dr.y), 0.0007),
                    lineCov(abs(dr.y), 0.0001, pix) * step(abs(dr.x), 0.0007)) * screw;
    slope += d / 0.001 * 0.9 * screw;
  }
#endif

  // 3. 面板分块（T35）：每两扇窗一块板，竖缝在两窗之间；上方一道横缝接行李架下的面板；
  //    窗下沿再往下（侧壁开始内收的地方）一道横缝分出下侧壁。缝都是约 2.5 mm 的阴影缝：缝里暗，
  //    朝上的那道棱边迎着上方的灯带发亮、朝下的棱边在自己的阴影里。宽度按各自方向上的像素足迹做面积守恒的抗锯齿
  float sxs = (fract((p.x + 0.2665) / (2.0 * WINDOW_PITCH) + 0.5) - 0.5) * 2.0 * WINDOW_PITCH;
  float sx = abs(sxs);
  float sy = abs(p.y - 0.42);
  const float DADO_Y = -0.30;
  float sd = p.y - DADO_Y;
  float grooveDado = lineCov(abs(sd), 0.00125, pixY);
#ifndef CABIN_CLASS_ECONOMY
  // 商务舱：分界缝里嵌一道 4 mm 高的香槟色金属饰条（上下各留 0.8 mm 的阴影缝），这一段缝由饰条自己着色
  float dadoTrim = lineCov(abs(sd), 0.002, pixY);
  grooveDado = 0.8 * lineCov(abs(abs(sd) - 0.0028), 0.0004, pixY);
#endif
  float groove = max(max(lineCov(sx, 0.00125, pixX), lineCov(sy, 0.00125, pixY)), grooveDado);
  // 缝的深处更暗（接缝阴影），缝边的棱：下沿（缝上方那块板的底棱）朝下、在阴影里；上沿（缝下方那块板的顶棱）朝上迎光
  float bevel = lineCov(abs(p.y - 0.4218), 0.0006, pixY) * step(0.42, p.y)
              + lineCov(abs(sd + 0.0018), 0.0006, pixY);
  float lipDark = lineCov(abs(sd - 0.0018), 0.0006, pixY) + lineCov(abs(p.y - 0.4182), 0.0006, pixY);
  // 竖缝两侧的棱：面向窗（受窗光）的那侧略亮，另一侧略暗；沿 x 的足迹一大就一起淡掉
  float vEdge = lineCov(abs(sx - 0.0018), 0.0006, pixX);
  slope.x += sign(sxs) * 0.35 * vEdge;
  ao *= 1.0 - 0.8 * groove;
  ao *= 1.0 - 0.25 * lipDark;
  // 下侧壁：比窗带一圈略深一点的同色系饰面（商务舱是暖灰褐的软触感面，经济舱是同一种塑料、略灰），
  //    分界按像素足迹过渡；再往下贴近地板有一条回风格栅（横向百叶，约 7 mm 一片）
  float lower = 1.0 - smoothstep(-pixY, pixY, sd + 0.0013);
#ifdef CABIN_CLASS_ECONOMY
  albedo *= mix(1.0, 0.9, lower);
#else
  albedo = mix(albedo, vec3(0.52, 0.475, 0.415), lower);
  rough = mix(rough, 0.7, lower);
#endif
  float gy = p.y + 0.72;                                  // 格栅高 6 cm，中心在 y = −0.72
  float grilleBox = (1.0 - smoothstep(0.03 - pixY, 0.03 + pixY, abs(gy)))
                  * smoothstep(-pixX, pixX, sx - 0.06);    // 离竖缝 6 cm 以内不开格栅
  if (grilleBox > 0.0) {
    // 百叶：每片 7 mm，片间暗缝 3 mm；足迹比片距大时淡成平均的暗度
    float ph = fract(gy / 0.007);
    float slat = lineCov(abs(ph - 0.5) * 0.007, 0.0015, pixY);
    float fS = 1.0 - smoothstep(0.0025, 0.005, pixY);
    float dark = mix(0.43, slat, fS);
    ao *= 1.0 - 0.85 * dark * grilleBox;
    slope.y += 0.4 * (ph - 0.5) * fS * grilleBox;          // 百叶片朝下斜
  }
#ifdef CABIN_CLASS_ECONOMY
  // 4. 经济舱的使用痕迹（T06 的做法，强度收敛到约一半，蹭痕更稀）：大尺度的轻微斑驳、越往下越灰一点、
  //    窗下沿手常扶的地方略暗略油亮、零星的鞋 / 包蹭痕、收边条外侧凹角里一点积灰
  float mottle = 0.65 * vnoise(p.xy * 5.0 + seed * 7.0) + 0.35 * vnoise(p.xy * 23.0 + seed);
  albedo *= 1.0 - 0.05 * smoothstep(0.35, 0.8, mottle);
  albedo *= 1.0 - 0.035 * smoothstep(-0.1, -0.45, p.y) * (0.6 + 0.4 * vnoise(p.xy * 9.0 + seed));
  float hand = exp(-pow((wq.y + 0.25) / 0.07, 2.0)) * exp(-pow(wq.x / 0.17, 2.0));
  float oil = hand > 0.02 ? hand * smoothstep(0.35, 0.75, 0.6 * vnoise(p.xy * 40.0 + seed) + 0.4 * vnoise(p.xy * 110.0 + seed)) : 0.0;
  albedo *= 1.0 - 0.08 * oil;
  rough = mix(rough, 0.3, clamp(oil * 1.2, 0.0, 1.0));
  float cornerDust = lineCov(abs(dBez - (FL + 0.0035)), 0.0012, pix) * smoothstep(-0.12, -0.2, wq.y);
  if (cornerDust > 0.0) cornerDust *= 0.6 + 0.4 * vnoise(p.xy * 300.0 + seed);
  albedo = mix(albedo, DUST_ALBEDO, cornerDust * 0.4);
  // 蹭痕：约 5 cm 一格，稀疏（T06 的一半）；越往下越多
  vec2 sc = floor(p.xy / 0.05);
  vec2 sh = hash22(sc + seed * 3.1);
  if (sh.x < 0.05 * smoothstep(0.1, -0.35, p.y) + 0.008) {
    vec2 c = (sc + 0.2 + 0.6 * hash22(sc + 1.7)) * 0.05;
    float ang = sh.y * 3.0;
    vec2 d = mat2(cos(ang), sin(ang), -sin(ang), cos(ang)) * (p.xy - c);
    float len = mix(0.004, 0.02, fract(sh.y * 13.0));
    float s = 1.0 - smoothstep(0.0, 1.0, length(d / vec2(len, 0.0012 + pix)));
    albedo *= 1.0 - 0.14 * s * (1.0 - smoothstep(0.002, 0.01, pix));
  }
#endif

  vec3 n = normalize(n0 + vec3(slope, 0.0));
  vec3 v = -rd;
  float nv = max(dot(n, v), 1e-3);
  // 上亮下暗：顶灯和行李架下的灯带从上方照下来
  float grad = 1.0 + 0.35 * clamp(p.y / 0.4, -1.0, 1.0);
  vec3 e = cabinIrradiance(p, n, cl) * grad * ao;
  // 窗光的回弹（T35）：从窗户进来的光落在窗下的扶手、座椅和地板上再弹回侧壁，窗下方一大块柔和的亮区（半径约 30 cm）。
  // 本窗按窗板面光源的照度（加上照进来的直射光），邻窗遮光板放下，只有透过来的那一点。经验系数，不是辐射度解
  float wiB = floor(p.x / WINDOW_PITCH + 0.5);
  vec3 eThrough = wiB == 0.0 ? M_PI * cl.lWin + 0.35 * cl.eSunNormal * max(cl.sunC.z, 0.0) : M_PI * cl.lGlow;
  float winPatch = exp(-wq.x * wq.x / 0.1) * exp(-(wq.y + 0.33) * (wq.y + 0.33) / 0.07);
  e += 0.08 * eThrough * winPatch * seatAO;
  vec3 col = albedo / M_PI * e;
  col += albedo / M_PI * e * 0.8 * bevel;
  // 环境反射（柔光饰面只有很弱的光泽；翻边的圆角靠它显形）
  float F = fresnelRough(nv, 0.04, rough);
  col += F * cabinEnv(reflect(rd, n), cl) * ao * (1.0 - 0.5 * rough) * grad;
  // 金属：窗罩一圈的收边条（拉丝的细纹沿着收边条走，同心，按像素足迹淡出成均匀的缎面）；
  // 商务舱还有下侧壁分界缝里的香槟色饰条（沿机身方向拉丝，截面微凸）。两处合成一次调用（FXC 按调用点内联）
  float metalCov = trim;
#ifndef CABIN_CLASS_ECONOMY
  metalCov = max(metalCov, dadoTrim);
#endif
  if (metalCov > 0.0) {
    float fBr = 1.0 - smoothstep(0.00012, 0.0003, pix);
    float brush = vnoise(vec2(dBez * 7000.0, (wq.x + wq.y) * 30.0 + seed));
    vec3 nm = n;
#ifndef CABIN_CLASS_ECONOMY
    if (dadoTrim > trim) {
      float fBd = 1.0 - smoothstep(0.00012, 0.0003, pixY);
      brush = vnoise(vec2(p.x * 30.0 + seed, p.y * 7000.0));
      fBr = fBd;
      nm = normalize(n0 + vec3(0.0, clamp(sd / 0.002, -1.0, 1.0) * 0.5, 0.0));
    }
#endif
    float mr = 0.26 + 0.08 * (brush - 0.5) * fBr;
    vec3 metalCol = cabinChampagne(p, nm, rd, mr, ao, e, cl) * (1.0 + 0.12 * (brush - 0.5) * fBr);
    col = mix(col, metalCol, metalCov);
  }
#ifdef CABIN_CLASS_ECONOMY
  if (screw > 0.0) col = mix(col, cabinChampagne(p, n, rd, 0.3, ao, e, cl) * (1.0 - 0.8 * screwSlot), screw);
#endif
  return col;
}

// ---- 窗洞内衬（漏斗） ----
// h：命中点（窗口局部坐标）；lAperture：窗口本身的辐亮度（本窗 = 窗外的光，邻窗 = 遮光板透过来的光）；
// sunOn：是否算直射光（邻窗的遮光板放下了，不算）
vec3 shadeReveal(vec3 h, vec3 n, vec3 rd, float t, float pixAng, CabinLights cl, vec3 lAperture, float sunOn, float shadeBottom, float seed) {
  float pix = t * pixAng / max(abs(dot(n, rd)), 0.25);
  float depth01 = clamp(h.z / PANE_DEPTH, 0.0, 1.0);
  float ao = mix(1.0, 0.5, sqrt(depth01)); // 越深，看到的舱内越少
  // 珍珠白的细腻注塑面：只有极轻的颗粒，比像素细时淡出
  vec3 albedo = REVEAL_ALBEDO * (1.0 + 0.02 * (vnoise(h.xy * 900.0 + h.z * 500.0) - 0.5) * (1.0 - smoothstep(0.0003, 0.001, pix)));
  float rough = 0.28;

  // 遮光板的导轨槽：两侧、遮光板所在的深度上一道约 3 mm 的暗槽
  float side = smoothstep(0.55, 0.85, abs(n.x));
  float slot = lineCov(abs(h.z - SHADE_DEPTH), 0.0014, pix) * side;
  ao *= 1.0 - 0.7 * slot;

  float up = smoothstep(0.15, 0.7, n.y);
#ifdef CABIN_CLASS_ECONOMY
  // 经济舱：朝上的面（漏斗下半圈）越深越有一点积灰，窗板边角和导轨槽里多一些（T06 的约一半）
  float dust = up * (0.1 + 0.5 * smoothstep(0.35, 0.95, depth01)) * (0.55 + 0.45 * vnoise(h.xy * 60.0 + seed));
  dust = clamp(dust + slot * 0.3, 0.0, 1.0) * 0.5;
  albedo = mix(albedo, DUST_ALBEDO, dust);
  rough = mix(rough, 0.7, dust);
  // 窗口下沿靠近舱内的地方：手指蹭的一点油光
  float lip = (1.0 - smoothstep(0.0, 0.35, depth01)) * smoothstep(-0.1, -0.2, h.y);
  float oil = lip * smoothstep(0.4, 0.75, vnoise(h.xy * 50.0 + seed * 2.0));
  albedo *= 1.0 - 0.05 * oil;
  rough = mix(rough, 0.2, oil);
#else
  // 刚清洁过：朝上的面只有极少的浮尘颗粒
  float speck = up * cabinSpeck(h.xz * vec2(1.0, 1.6) + h.y, seed, pix);
  albedo = mix(albedo, vec3(0.42, 0.40, 0.37), speck * 0.8);
#endif

  // 窗口下沿靠近舱内的地方：一枚淡指纹（位置每扇窗不同），只改光泽
  vec2 fc = vec2((hash12(vec2(seed, 2.3)) - 0.5) * 0.16, -0.19);
  float print = cabinPrint(vec2(h.x, h.y + h.z * 0.6), fc, hash12(vec2(seed, 7.7)) * 3.0, pix) * (1.0 - smoothstep(0.0, 0.4, depth01));
  rough = mix(rough, 0.5, print * 0.8);

  // 密封条：窗板四周最深的那约 1 cm（正面看约 3 mm 宽），新的石墨色硅胶，缎面（经济舱：旧一些的橡胶，颜色沿一圈略有变化）
  float gasket = smoothstep(PANE_DEPTH - 0.0085, PANE_DEPTH - 0.0065, h.z);
#ifdef CABIN_CLASS_ECONOMY
  albedo = mix(albedo, GASKET_ALBEDO * (0.9 + 0.2 * vnoise(vec2(atan(h.y, h.x) * 12.0, seed))), gasket);
  rough = mix(rough, 0.6, gasket);
#else
  albedo = mix(albedo, GASKET_ALBEDO, gasket);
  rough = mix(rough, 0.45, gasket);
#endif

  vec3 v = -rd;
  float nv = max(dot(n, v), 1e-3);
  float sunVis = sunOn * sunThroughWindow(h, cl.sunC, shadeBottom);
  vec3 eWin = windowIrradiance(h, n, lAperture);
  // 调试 3：只看窗板这块面光源给内衬的照度。放在这里而不是 scene.ts 里再调一次 windowIrradiance，免得多内联一份（SC-3b）
  if (uDebug == 3) return eWin;
  vec3 e = cabinIrradiance(h, n, cl) * ao + eWin
         + cl.eSunNormal * max(dot(n, cl.sunC), 0.0) * sunVis;
  vec3 col = albedo / M_PI * e;

  // 光滑塑料反射窗口：掠射角下窗框内侧有一圈亮边。反射方向能不能穿过窗口（且没被遮光板挡住）用 sunThroughWindow 判断
  vec3 r = reflect(rd, n);
  float F = fresnelRough(nv, 0.04, rough) * (1.0 - 0.35 * print);
  float winVis = 0.0;
  if (r.z > 1e-3) {
    vec3 qr = h + r * ((PANE_DEPTH - h.z) / r.z);
    float soft = 0.004 + rough * rough * length(qr - h) * 2.0;
    winVis = 1.0 - smoothstep(-soft, soft, sdRoundRect(qr.xy, PANE_HALF, PANE_RADIUS));
    vec3 qs = h + r * ((SHADE_DEPTH - h.z) / r.z);
    if (h.z < SHADE_DEPTH) winVis *= 1.0 - smoothstep(-soft, soft, qs.y - shadeBottom);
  }
  col += F * mix(cabinEnv(r, cl) * ao, lAperture * 0.6, winVis);
  // 太阳的高光
  col += keySpec(n, v, cl.sunC, rough * rough, 0.04, cl.eSunNormal) * sunVis;
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

  // 细磨砂纹理（柔光的哑光面）
  float fine = 1.0 - smoothstep(0.0003, 0.001, pix);
  vec3 nd = vnoiseD(p.xy * vec2(1400.0, 1100.0) + seed);
  n = normalize(n + vec3(nd.yz * vec2(1400.0, 1100.0) * 0.000015 * fine, 0.0));
  vec3 albedo = PLASTIC_ALBEDO * (1.0 + 0.02 * (nd.x - 0.5) * fine);
  float rough = 0.42;
#ifdef CABIN_CLASS_ECONOMY
  // 经济舱：没有金属拉手；手拉的地方（把手中间）略灰、略亮光，下沿两角有一点磨白（T06 的约一半）
  float pull = 0.0;
  float grip = exp(-pow(p.x / 0.035, 2.0)) * (1.0 - smoothstep(0.0, 0.035, yb));
  float gOil = grip * (0.5 + 0.5 * fbm2(p.xy * 60.0 + seed));
  albedo *= 1.0 - 0.08 * gOil;
  rough = mix(rough, 0.3, gOil);
  float cornerWear = smoothstep(0.08, 0.11, abs(p.x)) * (1.0 - smoothstep(0.0, 0.004, yb));
  albedo = mix(albedo, vec3(0.86, 0.85, 0.83), cornerWear * 0.25);
#else
  // 把手中间一条嵌入的香槟色金属拉手（宽约 7 cm、高约 5 mm，两端圆头）
  float pull = 1.0 - smoothstep(-pix * 0.5, pix * 0.5, sdRoundRect(vec2(p.x, yb - 0.0068), vec2(0.035, 0.0025), 0.0025));
#endif
  // 拉手旁边一枚淡指纹：只改光泽
  float print = cabinPrint(p.xy, vec2(0.012 + 0.02 * (hash12(vec2(seed, 4.1)) - 0.5), shadeBottom + 0.011), 0.4, pix);
  rough = mix(rough, 0.55, print * 0.8);

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
  col += PLASTIC_ALBEDO / M_PI * 0.08 * eOuter * mix(1.0, 0.3, onHandle) * (1.0 - pull) * (0.95 + 0.1 * vnoise(p.xy * 25.0 + seed));
  float F = fresnelRough(nv, 0.04, rough) * (1.0 - 0.3 * print);
  col += F * cabinEnv(reflect(rd, n), cl) * ao;
  // 把手上沿的圆棱迎着上方的灯带
  col += albedo / M_PI * cabinIrradiance(p, vec3(0.0, 1.0, 0.0), cl) * 0.5 * smoothstep(0.6, 1.0, n.y) * onHandle;
  if (pull > 0.0) col = mix(col, cabinChampagne(p, n, rd, 0.3, ao, e, cl), pull);
  return col;
}
`;
