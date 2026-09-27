/**
 * 窗板里的舱内倒影（T24）：程序化的「舱内环境」，按反射方向给出辐亮度。
 *
 * 为什么要有：原来窗板反射舱内用的是一个均匀的侧壁亮度，夜里窗外很暗、曝光拉高时整扇窗蒙一层没有结构的灰纱。
 * 真实情况：夜里开灯时窗上确实有倒影，但它是有结构的——自己的头和肩膀（挡住背后的灯，是一块暗区）、
 * 过道对面的行李架和下沿的灯带、被洗亮的天花板、对面一排黑的舷窗、下方一排排暗的座椅靠背；
 * 眼睛聚焦在远处的城市时，倒影是虚的。窗外的灯光就从倒影的暗处（自己的影子、座椅、对面黑窗）透出来。
 *
 * 做法：从窗板上的点沿镜面反射方向发一条射线，和一个简化的舱内盒子（示例尺寸，大致按双通道宽体机，不是某机型实测）
 * 求交：背景是天花板 / 对面侧壁（带舷窗），前面按由远到近一层层盖上对面行李架、中间行李架、座椅、本侧行李架、自己的身体。
 * 每层的边缘都按「虚化宽度」做软过渡，所以不需要任何屏幕导数，可以在分支里调用。
 *
 * 虚化的物理依据：眼睛对焦在无穷远时，物方的弥散圆直径就等于瞳孔直径（与物距无关）——夜里瞳孔约 6–7 mm；
 * 再加上内层防刮板 / 亚克力的微小起伏造成的角度弥散（随虚像距离放大）。T34 起按层分开：大面 0.7°、边和亮线 0.35°、
 * 光点只剩 0.1° 和像素下限（原来一律 1.7°，倒影被抹成「天边的糊带」，认不出来）。
 * 双层窗板的第二次反射（内层窗板和主窗板不严格平行，错开约 0.8°）只对光点做（成对的淡重影），面状部分不做。
 * 服务面板上的阅读灯是一组小光点（T34），调用处单独拿出来，不进面状倒影的亮度上限。
 *
 * 能量：返回的是环境辐亮度（kcd/m²），调用处乘菲涅尔反射率；各表面的亮度 = 反照率 / π × 照度，照度来自
 * 主灯（uCabinLight × 主灯色）、氛围洗墙灯（线光源，klux·m）、满舱窗户的回弹（白天为主），没有凭空加亮。
 *
 * 依赖：VIEW_COMMON（sdRoundRect、BEZEL_HALF、BEZEL_RADIUS）、CABIN_SHADING_COMMON（WINDOW_PITCH、cabinMoodWash、
 * READING_LIGHT_COLOR），以及 uSeatSign。
 */
export const CABIN_REFLECT_COMMON = /* glsl */ `
// ---- 舱内盒子（座舱系，米；原点在本窗窗洞中心，z 朝窗外，舱内是 z < 0）。示例尺寸 ----
const float RF_W = 5.5;          // 对面侧壁（窗高处）离本侧内饰面的距离
const float RF_CEIL = 1.42;      // 天花板（过道上方）
const float RF_BIN_Y = 0.62;     // 侧行李架下沿（和氛围灯 MOOD_POS 同高）
const float RF_BIN_TOP = 1.16;   // 侧行李架门的上沿
const float RF_BIN_D = 0.64;     // 侧行李架进深
const vec2 RF_CBIN_Z = vec2(-3.45, -2.05); // 中间行李架的 z 范围
const float RF_CBIN_Y = 0.74;    // 中间行李架下沿
const float RF_CBIN_TOP = 1.28;
const float RF_SEAT_Y = -0.06;   // 座椅头枕顶（窗中心以下约 5 cm，和 seats.glsl.ts 一致）
const vec2 RF_AISLE1 = vec2(-2.02, -1.52); // 两条过道的 z 范围
const vec2 RF_AISLE2 = vec2(-3.98, -3.48);
const float RF_ROW = 0.96;       // 排距（示例）
// 对面侧壁、行李架门的反照率：跟本侧饰面同一套（T25：经济舱是浅灰塑料，商务舱是暖白柔光饰面）
#ifdef CABIN_CLASS_ECONOMY
const vec3 RF_WALL_ALB = vec3(0.68, 0.68, 0.66);
const vec3 RF_BIN_ALB = vec3(0.72, 0.72, 0.70);
#else
const vec3 RF_WALL_ALB = vec3(0.72, 0.69, 0.64);
const vec3 RF_BIN_ALB = vec3(0.76, 0.73, 0.68);
#endif
// 角度弥散（弧度）按层分开（T34）：原来一刀切 1.7°，灯带边缘、阅读灯都被抹成宽带，只剩「亮 / 暗」两种大块，
// 认不出是倒影。真实夜航看窗，最先认出来的正是小而亮的东西（行李架边的亮线、阅读灯光点），整片暗区反而读不出。
// 窗板起伏造成的角度弥散对所有层一样，但低对比的大面（侧壁、天花板、座椅）虚一点无所谓，高对比的边和线要清楚：
const float RF_BLUR_SOFT = 0.012; // 大面（对面侧壁、天花板、对面舷窗的轮廓）约 0.7°
const float RF_BLUR_EDGE = 0.006; // 行李架的边、下沿灯带亮线约 0.35°
const float RF_BLUR_PT = 0.0015;  // 光点：只剩窗板微起伏与瞳孔弥散（约 0.1°），另有 1 个像素的下限，不会闪

struct ReflLights {
  vec3 eMain;    // 主灯照度（klux，带颜色）
  vec3 eAmb;     // 满舱窗户的回弹（klux；白天为主）
  vec3 moodI;    // 氛围洗墙灯的线强度（klux·m）
  vec3 wash;     // 行李架下沿灯带的总线强度（氛围灯 + 主灯的洗墙部分，klux·m）
  vec3 lOppWin;  // 对面舷窗的辐亮度（kcd/m²）
  float readOn;  // 阅读灯
  float pupil;   // 瞳孔直径（米）
  float lit;     // 主灯开着的程度（0 = 睡眠 / 全关，1 = 开灯）：头只在开灯时画（T34）
  float pixAng;  // 一个像素的张角（弧度）：虚化宽度的下限，光点不小于一个像素
};

float rfBand(float x, float a, float b, float w) {
  return smoothstep(a - w, a + w, x) - smoothstep(b - w, b + w, x);
}

// 射线到球面的软覆盖率：最近距离与半径比较，边缘宽 w
float rfBlob(vec3 p, vec3 r, vec3 c, vec3 rad, float d0, float blurA, float pupil, out float tHit) {
  vec3 q = (c - p) / rad;           // 椭球缩放成单位球
  vec3 rs = r / rad;
  float rl = length(rs);
  vec3 rn = rs / rl;
  float tq = dot(q, rn);
  float dist = length(q - rn * tq); // 缩放空间里的最近距离
  tHit = max(tq / rl, 0.0);
  float w = (0.5 * pupil + blurA * (d0 + tHit)) / min(min(rad.x, rad.y), rad.z);
  return (1.0 - smoothstep(1.0 - w, 1.0 + w, dist)) * step(0.0, tq);
}

// 沿方向 r 从窗板上的点 p 看出去的舱内辐亮度。d0：眼睛到 p 的距离（虚像距离 = d0 + 射线长度）
vec3 cabinReflectEnv(vec3 p, vec3 r, float d0, ReflLights L) {
  float rz = min(r.z, -1e-3);
  float ry = abs(r.y) < 1e-4 ? 1e-4 : r.y;
  // 虚化宽度（物方，米）：瞳孔的一半 + 角度弥散 × 虚像距离；角度不小于 1.5 个像素（再细就会在头部晃动时闪）
  #define RF_WIDA(t, a) (0.5 * L.pupil + max(a, 1.5 * L.pixAng) * (d0 + (t)))
  #define RF_WID(t) RF_WIDA(t, RF_BLUR_SOFT)

  // ---- 背景：对面侧壁或天花板 ----
  float tW = (-RF_W - p.z) / rz;
  vec2 hW = p.xy + r.xy * tW;
  float wW = RF_WID(tW);
  float wWe = RF_WIDA(tW, RF_BLUR_EDGE);
  // 对面侧壁：上部被行李架下沿的灯带洗亮（和本侧同一套线光源，在对面侧壁的局部坐标里算）
  // cabinMoodWash 在灯的高度上是硬截断（step），灯下紧挨着的地方按 1/r 有一条很窄的热线；倒影是虚的，
  // 热线应当被摊平在虚化宽度里，所以取值点至少离灯一个虚化宽度，再按虚化宽度软截断
  vec3 washW = cabinMoodWash(vec3(hW.x, min(hW.y, RF_BIN_Y - 0.03 - 0.7 * wWe), 0.0), vec3(0.0, 0.0, -1.0), L.wash)
             * (1.0 - smoothstep(RF_BIN_Y - 0.03 - wWe, RF_BIN_Y - 0.03 + wWe, hW.y));
  vec3 eWall = L.eAmb + L.eMain * 0.45 + washW;
  vec3 col = RF_WALL_ALB / M_PI * eWall;
  // 对面一排舷窗（夜里是黑的，白天是亮的），错开半个窗距
  float dWin = sdRoundRect(vec2(mod(hW.x + 0.5 * WINDOW_PITCH, WINDOW_PITCH) - 0.5 * WINDOW_PITCH, hW.y), BEZEL_HALF * 0.8, BEZEL_RADIUS * 0.8);
  col = mix(col, L.lOppWin, 1.0 - smoothstep(-wW, wW, dWin));
  // 天花板：靠行李架上沿的地方被向上打的灯带洗得最亮，往过道中间渐暗
  float tC = (RF_CEIL - p.y) / max(ry, 1e-4);
  vec2 hC = p.xz + r.xz * tC;
  float zc = hC.y;
  float cove = exp(-abs(zc + RF_BIN_D) / 0.45) + exp(-abs(zc + RF_W - RF_BIN_D) / 0.45)
             + 0.8 * (exp(-abs(zc - RF_CBIN_Z.y) / 0.35) + exp(-abs(zc - RF_CBIN_Z.x) / 0.35));
  // 顶板接缝：沿机身约每 1.5 m 一道（虚化后只剩一点明暗起伏）
  float seam = 1.0 - 0.12 * (1.0 - smoothstep(0.0, 0.06 + RF_WID(tC), abs(fract(hC.x / 1.52) - 0.5) * 1.52));
  // 睡眠模式下行李架上的向上灯槽是关的，天花板只有洗墙光的一点回弹
  vec3 ceilL = 0.8 / M_PI * (L.eAmb * 0.8 + L.eMain * (0.5 + 1.0 * cove) + L.moodI * 0.04) * seam;
  col = mix(col, ceilL, smoothstep(RF_CEIL - wW, RF_CEIL + wW, hW.y));

  // ---- 由远到近一层层盖上去 ----
  vec3 binL = RF_BIN_ALB / M_PI * (L.eAmb + L.eMain * 0.85 + L.moodI * 0.03);
  vec3 underL = 0.3 / M_PI * (L.eAmb * 0.5 + L.eMain * 0.3);
  // 行李架下沿灯带本身（灯头朝下朝侧壁，从过道对面只看到灯罩边一道亮线）
  vec3 lipL = L.wash * 0.12;

  // 对面行李架：门（竖直面）+ 下沿灯带 + 底面
  float zOB = -RF_W + RF_BIN_D;
  float tOB = (zOB - p.z) / rz;
  float yOB = p.y + r.y * tOB;
  float wOB = RF_WIDA(tOB, RF_BLUR_EDGE);
  float cFace = rfBand(yOB, RF_BIN_Y, RF_BIN_TOP, wOB);
  float cUnder = smoothstep(RF_BIN_Y - wWe, RF_BIN_Y + wWe, hW.y) * (1.0 - smoothstep(RF_BIN_Y - wOB, RF_BIN_Y + wOB, yOB));
  vec3 obL = binL + lipL * rfBand(yOB, RF_BIN_Y, RF_BIN_Y + 0.025, wOB);
  col = mix(col, underL, clamp(cUnder, 0.0, 1.0));
  col = mix(col, obL, clamp(cFace, 0.0, 1.0));

  // 中间行李架（朝本侧的门 + 底面；门的上沿以上还能看到天花板）
  float tCB = (RF_CBIN_Z.y - p.z) / rz;
  float yCB = p.y + r.y * tCB;
  float wCB = RF_WIDA(tCB, RF_BLUR_EDGE);
  float yCB2 = p.y + r.y * ((RF_CBIN_Z.x - p.z) / rz);
  float cCF = rfBand(yCB, RF_CBIN_Y, RF_CBIN_TOP, wCB);
  float cCU = smoothstep(RF_CBIN_Y - wCB, RF_CBIN_Y + wCB, yCB2) * (1.0 - smoothstep(RF_CBIN_Y - wCB, RF_CBIN_Y + wCB, yCB)) * step(yCB2, RF_CBIN_TOP + 0.3);
  vec3 cbL = binL + lipL * rfBand(yCB, RF_CBIN_Y, RF_CBIN_Y + 0.025, wCB);
  col = mix(col, underL, clamp(cCU, 0.0, 1.0));
  col = mix(col, cbL, clamp(cCF, 0.0, 1.0));

  // 座椅：视线低过头枕顶就落在一排排座椅上（过道处是更暗的地板）。头枕套是浅色皮革，按排距起伏
  if (r.y < 0.0) {
    float tS = (RF_SEAT_Y - p.y) / ry;
    vec2 hS = p.xz + r.xz * tS;
    // 近处的座椅（邻座扶手、坐垫）离窗板不到一米，按平面算虚化宽度太小、会出硬边：这些都是暗面，
    // 只要一片低对比的暗区，所以虚化宽度给个下限；远处的头枕顶按排距有一点起伏
    float wS = max(RF_WID(tS), 0.25);
    float cov = 1.0 - smoothstep(RF_SEAT_Y - wW, RF_SEAT_Y + wW, hW.y);
    float aisle = rfBand(hS.y, RF_AISLE1.x, RF_AISLE1.y, wS) + rfBand(hS.y, RF_AISLE2.x, RF_AISLE2.y, wS);
    float rowF = fract((hS.x * uSeatSign + 0.35) / RF_ROW) * RF_ROW;
    float cap = rfBand(rowF, 0.2, 0.36, wS) * smoothstep(1.5, 3.0, -hS.y);
    // 看到的是靠背的竖直面（深色皮革 / 织物），主灯在头顶，照到靠背上的不到一半
    vec3 eSeat = L.eAmb + L.eMain * 0.4 + L.moodI * 0.03;
    vec3 seatL = (0.06 + 0.12 * cap - 0.025 * clamp(aisle, 0.0, 1.0)) / M_PI * eSeat;
    col = mix(col, seatL, cov);
  }

  // 本侧行李架的底面（服务面板，只有抬头贴窗时才看得到）
  if (r.y > 0.0) {
    float tN = (RF_BIN_Y - p.y) / ry;
    float zN = p.z + r.z * tN;
    float wN = RF_WIDA(tN, RF_BLUR_EDGE);
    float cov = smoothstep(-RF_BIN_D - wN, -RF_BIN_D + wN, zN);
    vec3 nL = underL + lipL * rfBand(zN, MOOD_POS.y - 0.02, MOOD_POS.y + 0.02, wN);
    col = mix(col, nL, cov);
  }

  // 自己：头（中心在眼睛后面约 8 cm）和肩膀 / 上身（T34 改）。
  // 原来画成深色剪影，倒影正中是一个上窄下宽的黑洞；T34 第一版画成被照亮的脸，又读成发亮的浅色椭圆「蛋」（T24 的老坑）。
  // 实际上脸的反照率低、顶灯在头顶偏后被自己挡住，倒影里的头肩只是比背后略暗的一片，边缘很虚：
  // 所以开灯时只把背后的倒影压暗 13%（与周围的亮度差 ≤ 15%），边缘按 3 倍大面虚化，不画椭圆轮廓、不画五官；
  // 睡眠 / 全关不画头（那时它本来就和背景一样暗，画出来只会是洞），上身照旧是和座椅一样暗的一片（在暗处看不出）
  float tH, tB;
  float blurHB = max(3.0 * RF_BLUR_SOFT, 1.5 * L.pixAng);
  float cBody = rfBlob(p, r, uHead + vec3(0.0, -0.42, -0.12), vec3(0.21, 0.30, 0.16), d0, blurHB, L.pupil, tB);
  float cHead = rfBlob(p, r, uHead + vec3(0.0, 0.01, -0.08), vec3(0.085, 0.11, 0.10), d0, blurHB, L.pupil, tH);
  vec3 bodyDark = 0.07 / M_PI * (L.eAmb + L.eMain * 0.35 + L.moodI * 0.03);
  col = mix(col, bodyDark, cBody * (1.0 - L.lit));
  col *= 1.0 - 0.13 * L.lit * max(cBody, cHead);
  #undef RF_WID
  #undef RF_WIDA
  return col;
}

// 光点的覆盖：从 p 沿 r 看点 c（半径 rad 的发光面），最近距离按高斯摊开，峰值 = (rad / s)²（能量守恒）。
// s 取瞳孔弥散、窗板微起伏、一个像素三者的较大者（物方，米）
float rfPoint(vec3 p, vec3 r, vec3 c, float rad, float d0, ReflLights L) {
  vec3 dl = c - p;
  float tl = dot(dl, r);
  float d2 = dot(dl, dl) - tl * tl;
  float dist = d0 + max(tl, 0.0);
  float s = max(max(0.5 * L.pupil + RF_BLUR_PT * dist, 1.0 * L.pixAng * dist), rad);
  return (rad * rad) / (s * s) * exp(-d2 / (s * s)) * step(0.0, tl);
}

// 服务面板上的阅读灯（T34）：过道对面行李架下沿、中间行李架下沿，每排一盏。示例布局，不是某机型实测。
// 从过道对面只看得到灯罩发亮的那一小圈（灯头朝下），是倒影里最先认得出的东西。
// 开着的盏数随档位：开灯时约一半、睡眠档少几盏（有人在看书，且在 scene.ts 限到极弱）、全关不画（T41）；开关按位置固定，不闪
const int RF_NPT = 10;
const vec4 RF_PTS[RF_NPT] = vec4[RF_NPT](
  // xyz = 位置（座舱系，米），w = 「开着」的门限（档位的开灯比例高过它才亮）
  vec4(-2.35, 0.60, -5.20, 0.15), vec4(-1.38, 0.60, -5.20, 0.62), vec4(-0.42, 0.60, -5.20, 0.40),
  vec4(0.55, 0.60, -5.20, 0.08), vec4(1.52, 0.60, -5.20, 0.55), vec4(2.47, 0.60, -5.20, 0.33),
  vec4(-1.85, 0.72, -2.30, 0.48), vec4(-0.90, 0.72, -2.30, 0.26), vec4(0.08, 0.72, -2.30, 0.70),
  vec4(1.03, 0.72, -2.30, 0.20)
);

// 倒影里的光点（辐亮度，kcd/m²；调用处乘菲涅尔与增益，但不进面状倒影的亮度上限——灯本来就比墙亮）。
// 双层窗板的第二次反射（内层窗板与主窗板不严格平行，错开约 0.8°）：整层重影开销翻倍（T24 试过），
// 只对光点做，强度 0.3，在亮点旁边多一个淡的错位像——夜航时窗上灯的倒影常见这种成对的点
vec3 cabinReflectPoints(vec3 p, vec3 r, float d0, ReflLights L) {
  float moodOn = step(1e-5, dot(L.moodI, vec3(1.0))); // 睡眠档氛围灯亮着，全关档是 0
  // T41：全关档（主灯、氛围灯都关）不画光点。原来全关档还留两盏 + 邻座那盏，连同重影在所有夜景的同一屏幕位置
  // 读成一对「双亮星」（窗外怎么换它都在）；全关的意义是贴窗暗适应看星，零星的阅读灯按用手挡住计 0（和 stars.glsl.ts 的光幕一致）。
  // 睡眠档的光点在 scene.ts 按面状倒影的同一上限软限幅（极弱），开灯档照旧
  if (max(moodOn, L.lit) <= 0.0) return vec3(0.0);
  vec3 rg = normalize(r + vec3(0.009 * uSeatSign, -0.011, 0.0));
  float frac = mix(mix(0.18, 0.35, moodOn), 0.56, L.lit);
  float acc = 0.0;
  for (int i = 0; i < RF_NPT; i++) {
    vec4 q = RF_PTS[i];
    if (q.w > frac) continue;
    vec3 c = vec3(q.x * uSeatSign, q.y, q.z);
    acc += rfPoint(p, r, c, 0.012, d0, L) + 0.3 * rfPoint(p, rg, c, 0.012, d0, L);
  }
  vec3 pts = acc * 0.6 * READING_LIGHT_COLOR;
  // 自己这一排邻座的阅读灯（全关 / 睡眠时开着的那盏，离窗板不到一米）：灯头朝下，只有朝下出射的方向亮
  if (L.readOn > 0.0) {
    vec3 lp = vec3(0.30 * uSeatSign, 0.85, -0.70);
    float cone = smoothstep(0.6, 0.92, r.y);
    pts += L.readOn * READING_LIGHT_COLOR * 3.0 * cone * (rfPoint(p, r, lp, 0.008, d0, L) + 0.3 * rfPoint(p, rg, lp, 0.008, d0, L));
  }
  return pts;
}

// 窗板的总反射：面状部分（返回值）+ 光点（pts，调用处不进亮度上限）。
// 双层窗板的第二次反射只对光点做（见 cabinReflectPoints），面状部分只算一遍——T24 试过整层重影，开销翻倍
vec3 cabinReflection(vec3 p, vec3 r, float d0, ReflLights L, out vec3 pts) {
  pts = cabinReflectPoints(p, r, d0, L);
  return cabinReflectEnv(p, r, d0, L);
}
`;
