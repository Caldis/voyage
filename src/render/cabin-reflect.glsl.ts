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
 * 双层窗板的第二次反射（内层窗板和主窗板不严格平行，错开约 0.8°）：光点做成对的淡重影；T42 起行李架的长边也混一道淡重影，其余面状部分不做。
 * T42（去「舞台布景」）：对面舷窗的遮光板随机开合、行李架门分段且亮度不一、座椅区按列画参差的椅背 / 头顶 / 娱乐屏微光，边缘按距离放宽虚化。
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
// T42：行李架的长边从 0.35° 放宽到约 0.65°。T34 为了「认得出」把边收得太紧，开灯档读成满窗刀切的色带（美术总监第 6 波第 1 条）。
// 眼睛对焦在窗外时，4–6 m 外的行李架边缘本来就虚；物方虚化宽度 = 瞳孔 / 2 + 角度 × 虚像距离，所以越远的边越糊（按距离的景深）
const float RF_BLUR_EDGE = 0.0115;
const float RF_BLUR_PT = 0.0015;  // 光点：只剩窗板微起伏与瞳孔弥散（约 0.1°），另有 1 个像素的下限，不会闪
// 双层窗板的第二次反射（内层窗板与主窗板不严格平行）：射线方向偏 RF_GHOST_DY（约 0.6°，向下），强度为主像的一小部分。
// T42 起长边也做一道淡重影（只对行李架的几条水平边，按「主像 + 错位像」混合覆盖率，不重算整层）
const float RF_GHOST_DY = -0.011;
const float RF_GHOST_EDGE = 0.2;  // 长边重影的强度
const float RF_GHOST_PT = 0.12;   // 光点重影的强度：第二次反射比第一次暗得多（原来 0.3，两颗被色调映射压成一样亮，读成「双星」）

// 小哈希（T42：对面舷窗的遮光板、各排乘客、行李架门分段都按编号取随机数，位置固定、不随时间变，不闪）
float rfHash(vec2 p) {
  p = fract(p * vec2(0.1031, 0.1030));
  p += dot(p, p.yx + 33.33);
  return fract((p.x + p.y) * p.x);
}

// 乘客座位的列（离本侧内饰面的距离 z，米；示例布局）：对面 2 列、中间 3 列、本侧过道位 1 列（本侧靠窗那列就是自己这一排，不画）。
// 近的盖住远的（PERF-12 起由近到远做前后合成，见 cabinReflectEnv 开头）
const int RF_NCOL = 6;
const float RF_COLS[RF_NCOL] = float[RF_NCOL](-4.80, -4.30, -3.20, -2.75, -2.30, -1.10);

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

  // T42 座椅区的上沿：原来是一整条水平的暗区，和对面一排黑窗连在一起读成「城墙垛口」。
  // 现在按列画每排椅背的顶（各排后仰不同，高低差几厘米，两排之间露出一道低处）、
  // 参差的头顶（有人坐 / 没人、高矮、前后都随机）和娱乐屏照在椅背上的一点冷光（按排随机开，颜色不一）。
  // 都是按「这条射线在这一列的平面上落在哪」算的软覆盖，没有循环里的三角函数 / normalize（T41 的 FXC 坑）。示例布局
  // PERF-12：改成**由近到远**的前后合成（和原来由远到近逐层 mix 代数上完全相同）：每列 col' = T·col + A，
  // 累计 acc += T累计·A、T累计 *= T。好处是能早退——视线低、落在近处椅背上时（窗板下半的大部分像素），
  // 近的一两列就把后面全挡住（T累计 < 1e-4），远列和整个背景（对面侧壁、舷窗、天花板、行李架、座椅平面）都不用算；
  // 视线高过这一列能画的最高处（椅背 / 头顶 / 屏光，按哈希取上界）时这一列直接跳过（贡献严格为 0，只有屏光高斯 e^-16 量级的尾巴）。
  // 倒影在所有场景都要付（正午也是：对面舷窗亮，跳过条件不成立），原来的由远到近写法约 0.11 ms，其中这 6 列约 0.04 ms
  vec3 acc = vec3(0.0);
  float trans = 1.0;
  {
    float moodOn = step(1e-5, dot(L.moodI, vec3(1.0)));
    vec3 eSeat = L.eAmb + L.eMain * 0.4 + L.moodI * 0.03;
    float scrOn = max(moodOn, L.lit) * mix(0.3, 1.0, L.lit);
    // 上限写成「RF_NCOL + uLoopGuard」（恒为 RF_NCOL）：常量上限会被 FXC 展开成 6 份，舱内程序冷编译明显变慢
    for (int kr = 0; kr < RF_NCOL + uLoopGuard; kr++) {
      int k = RF_NCOL - 1 - kr;        // 由近到远
      float zk = RF_COLS[k];
      float tk = (zk - p.z) / rz;
      float yk = p.y + r.y * tk;
      float wk = max(RF_WID(tk), 0.02);
      float wc = min(wk, 0.07);
      // 这一列能画到的最高处：椅背顶 ≤ RF_SEAT_Y + 0.03（+ 虚化 wk）；头顶 ≤ 椅背顶 + 0.128（+ 1.36·wc）；屏光在椅背顶以下
      if (yk > RF_SEAT_Y + 0.17 + 2.0 * wk) continue;
      float fk = float(k);
      // 各列的排错开一点（座椅不是一条直线对齐的）
      float xk = (p.x + r.x * tk) * uSeatSign;
      float xr = xk / RF_ROW + 0.23 + 0.31 * fk;
      float n = floor(xr);
      float u = fract(xr) * RF_ROW;       // 这一排里的位置（米），椅背在 0.26–0.64，头在椅背前面（约 0.66）
      float h1 = rfHash(vec2(n, fk + 1.0));
      float h2 = rfHash(vec2(n + 17.0, fk + 5.0));
      float h3 = rfHash(vec2(n - 9.0, fk + 13.0));
      // 本侧过道位那一列：自己这一排（n 对应 x ≈ 0）不画，那是邻座，离得太近
      float skip = (k == RF_NCOL - 1) ? step(abs((n + 0.5 - 0.23 - 0.31 * fk) * RF_ROW), 0.6) : 0.0;
      // 一排之内的东西都放在格子中段，离格子边留出大于虚化宽度的余量：哈希在格子边上跳变，东西碰到格子边就会切出竖直的硬边
      float topB = RF_SEAT_Y + 0.06 * (h1 - 0.5);
      // 椅背（含头枕）的侧影：顶在 RF_SEAT_Y 上下 3 cm；排与排之间是低约 0.3 m 的坐垫 / 扶手（这一层不随排变，格子边上连续）
      float inBack = rfBand(u, 0.26, 0.64, wc) * (1.0 - skip);
      float cBack = clamp(1.0 - smoothstep(-wk, wk, yk - mix(RF_SEAT_Y - 0.33, topB, inBack)), 0.0, 1.0);
      vec3 backL = (0.05 + 0.04 * h2 * inBack) / M_PI * eSeat;
      // 娱乐屏在前一排椅背的背面（u ≈ 0.26 那一侧），从侧面只看到它照在椅背边、后排人脸上的一小团光，颜色不一
      float scr = step(0.45, h3) * scrOn * (1.0 - skip);
      vec3 scrCol = h3 > 0.8 ? vec3(0.45, 0.65, 1.0) : (h3 > 0.62 ? vec3(0.5, 0.95, 0.85) : vec3(1.0, 0.78, 0.55));
      vec2 sq = vec2(u - 0.24, yk - (topB - 0.12)) / (0.035 + 0.5 * wc);
      vec3 scrL = scr * scrCol * 0.03 * (0.35 + 0.65 * abs(r.x)) * exp(-dot(sq, sq));
      // 头：有人坐的约六成；头顶比头枕顶高 −4 到 +10 cm；前后位置差几厘米。头顶被顶灯照到一点，但整体是暗的（头发）
      float occ = step(0.4, h2) * (1.0 - skip);
      vec2 hq = vec2((u - (0.66 + 0.06 * (h1 - 0.5))) / 0.085, (yk - (topB + 0.03 + 0.14 * (h3 - 0.3) - 0.115)) / 0.115);
      float cHd = occ * (1.0 - smoothstep(1.0 - wc / 0.085, 1.0 + wc / 0.085, length(hq)));
      vec3 headL = (0.04 + 0.03 * clamp(hq.y, 0.0, 1.0)) / M_PI * eSeat + 0.5 * scrL;
      // 原来（由远到近）：col = mix(col, backL, cBack); col += scrL; col = mix(col, headL, cHd)
      // 即 col' = (1 − cHd)(1 − cBack)·col + (1 − cHd)(cBack·backL + scrL) + cHd·headL
      acc += trans * ((1.0 - cHd) * (cBack * backL + scrL) + cHd * headL);
      trans *= (1.0 - cHd) * (1.0 - cBack);
      if (trans < 1e-4) break;
    }
  }

  vec3 binL = RF_BIN_ALB / M_PI * (L.eAmb + L.eMain * 0.85 + L.moodI * 0.03);
  vec3 underL = 0.3 / M_PI * (L.eAmb * 0.5 + L.eMain * 0.3);
  // 行李架下沿灯带本身（灯头朝下朝侧壁，从过道对面只看到灯罩边一道亮线）
  vec3 lipL = L.wash * 0.12;
  vec3 col = vec3(0.0);
  if (trans >= 1e-4) {
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
  col = RF_WALL_ALB / M_PI * eWall;
  // 对面一排舷窗（夜里是黑的，白天是亮的），错开半个窗距。
  // T42：每扇窗的遮光板按窗号随机开合（全开 / 拉下三成 / 七成 / 全关，再加一点连续抖动）。原来 7 扇一模一样的黑窗
  // 在黑海上读成「城墙垛口」；真实夜航里对面的窗有的拉下（白色，被舱灯照亮）、有的开着（黑），偶尔一扇映出别人的阅读灯
  float winI = floor((hW.x + 0.5 * WINDOW_PITCH) / WINDOW_PITCH);
  float dWin = sdRoundRect(vec2(hW.x - winI * WINDOW_PITCH, hW.y), BEZEL_HALF * 0.8, BEZEL_RADIUS * 0.8);
  float hS1 = rfHash(vec2(winI, 7.0 + uSeatSign));
  float hS2 = rfHash(vec2(winI, 19.0 - uSeatSign));
  // 状态 0–3 = 全开 / 三成 / 七成 / 全关。纯随机会连出一串一样的（黄昏截图里连着五扇全开，又读成一排）；
  // 偶数号窗随便取，奇数号窗在「和两边都不一样」的状态里随机挑一个，保证相邻两扇不同
  float sE0 = floor(4.0 * rfHash(vec2(winI - 1.0, 7.0 + uSeatSign)));
  float sE1 = floor(4.0 * rfHash(vec2(winI + 1.0, 7.0 + uSeatSign)));
  float st = floor(4.0 * hS1);
  if (mod(winI, 2.0) > 0.5) {
    // 可选的个数：邻居相同时 3 个，不同时 2 个；挑第 pick 个，再依次跳过被占的两个值（先小后大）
    float sLo = min(sE0, sE1), sHi = max(sE0, sE1);
    st = floor(hS1 * (sLo == sHi ? 3.0 : 2.0));
    st += step(sLo, st);
    st += step(sLo + 0.5, sHi) * step(sHi, st);
  }
  float shadeF = st < 0.5 ? 0.0 : (st < 1.5 ? 0.3 : (st < 2.5 ? 0.7 : 1.0));
  shadeF = clamp(shadeF + 0.16 * (hS2 - 0.5) * step(0.01, shadeF) * step(shadeF, 0.99), 0.0, 1.0);
  float winH = 1.6 * BEZEL_HALF.y;
  // 遮光板从上往下拉：板的下沿在 winTop - shadeF · 窗高；板是浅色塑料，缩在窗洞里，比侧壁略暗
  float cShade = smoothstep(0.5 * winH - shadeF * winH - wW, 0.5 * winH - shadeF * winH + wW, hW.y) * step(0.01, shadeF);
  // 窗洞一圈是内凹的（窗框的阴影），拉下的遮光板靠边处更暗：全关的窗仍认得出是一扇窗，只是浅色的
  vec3 shadeL = col * (0.8 + 0.12 * hS2) * (1.0 - 0.3 * smoothstep(-0.08 - wW, 0.0, dWin));
  // 开着的窗里偶尔映出一盏暖色的阅读灯（很淡、很虚的一团，不是光点）
  vec2 gq = vec2(hW.x - winI * WINDOW_PITCH + 0.04 * (hS1 - 0.5), hW.y + 0.05);
  vec3 winL = L.lOppWin + L.lit * step(0.84, hS2) * READING_LIGHT_COLOR * dot(col, vec3(0.3333)) * 0.45 * exp(-dot(gq, gq) / 0.004);
  col = mix(col, mix(winL, shadeL, cShade), 1.0 - smoothstep(-wW, wW, dWin));
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

  // 对面行李架：门（竖直面）+ 下沿灯带 + 底面
  float zOB = -RF_W + RF_BIN_D;
  float tOB = (zOB - p.z) / rz;
  float yOB = p.y + r.y * tOB;
  float wOB = RF_WIDA(tOB, RF_BLUR_EDGE);
  // T42 淡重影：第二次反射的射线向下偏 RF_GHOST_DY，在这一层上落低 RF_GHOST_DY · t；覆盖率按「主像 + 错位像」混合
  float yOBg = yOB + RF_GHOST_DY * tOB;
  float cFace = mix(rfBand(yOB, RF_BIN_Y, RF_BIN_TOP, wOB), rfBand(yOBg, RF_BIN_Y, RF_BIN_TOP, wOB), RF_GHOST_EDGE);
  float cUnder = smoothstep(RF_BIN_Y - wWe, RF_BIN_Y + wWe, hW.y) * (1.0 - smoothstep(RF_BIN_Y - wOB, RF_BIN_Y + wOB, yOB));
  // T42 行李架门不再是均匀的一条：每 1.3–1.6 m 一扇门（门缝是一道暗线），各扇被顶灯洗亮的程度随机差 ±10%；
  // 门的上半离灯槽近，略亮（竖直方向 ±10% 的渐变）
  float xOB = (p.x + r.x * tOB) * uSeatSign;
  float dOB = xOB / 1.45 + 0.37;
  dOB += 0.12 * sin(dOB * 2.3); // 门宽不等（单调扭曲，1.3–1.6 m）
  float segOB = floor(dOB);
  float doorOB = (0.9 + 0.2 * rfHash(vec2(segOB, 3.0))) * mix(0.9, 1.1, clamp((yOB - RF_BIN_Y) / (RF_BIN_TOP - RF_BIN_Y), 0.0, 1.0))
               * (1.0 - 0.18 * (1.0 - smoothstep(0.0, 0.012 + wOB, (0.5 - abs(fract(dOB) - 0.5)) * 1.45)));
  vec3 obL = binL * doorOB + lipL * mix(rfBand(yOB, RF_BIN_Y, RF_BIN_Y + 0.025, wOB), rfBand(yOBg, RF_BIN_Y, RF_BIN_Y + 0.025, wOB), RF_GHOST_EDGE);
  col = mix(col, underL, clamp(cUnder, 0.0, 1.0));
  col = mix(col, obL, clamp(cFace, 0.0, 1.0));

  // 中间行李架（朝本侧的门 + 底面；门的上沿以上还能看到天花板）
  float tCB = (RF_CBIN_Z.y - p.z) / rz;
  float yCB = p.y + r.y * tCB;
  float wCB = RF_WIDA(tCB, RF_BLUR_EDGE);
  float yCBg = yCB + RF_GHOST_DY * tCB;
  float tCB2 = (RF_CBIN_Z.x - p.z) / rz;
  float yCB2 = p.y + r.y * tCB2;
  float yCB2g = yCB2 + RF_GHOST_DY * tCB2;
  float cCF = mix(rfBand(yCB, RF_CBIN_Y, RF_CBIN_TOP, wCB), rfBand(yCBg, RF_CBIN_Y, RF_CBIN_TOP, wCB), RF_GHOST_EDGE);
  float cCU = smoothstep(RF_CBIN_Y - wCB, RF_CBIN_Y + wCB, yCB2) * (1.0 - smoothstep(RF_CBIN_Y - wCB, RF_CBIN_Y + wCB, yCB)) * step(yCB2, RF_CBIN_TOP + 0.3);
  float cCUg = smoothstep(RF_CBIN_Y - wCB, RF_CBIN_Y + wCB, yCB2g) * (1.0 - smoothstep(RF_CBIN_Y - wCB, RF_CBIN_Y + wCB, yCBg)) * step(yCB2g, RF_CBIN_TOP + 0.3);
  float xCB = (p.x + r.x * tCB) * uSeatSign;
  float dCB = xCB / 1.52 + 0.81;
  dCB += 0.12 * sin(dCB * 1.7); // 门宽不等（单调扭曲，1.3–1.6 m）
  float segCB = floor(dCB);
  float doorCB = (0.9 + 0.2 * rfHash(vec2(segCB, 11.0))) * mix(0.9, 1.1, clamp((yCB - RF_CBIN_Y) / (RF_CBIN_TOP - RF_CBIN_Y), 0.0, 1.0))
               * (1.0 - 0.18 * (1.0 - smoothstep(0.0, 0.012 + wCB, (0.5 - abs(fract(dCB) - 0.5)) * 1.52)));
  vec3 cbL = binL * doorCB + lipL * mix(rfBand(yCB, RF_CBIN_Y, RF_CBIN_Y + 0.025, wCB), rfBand(yCBg, RF_CBIN_Y, RF_CBIN_Y + 0.025, wCB), RF_GHOST_EDGE);
  col = mix(col, underL, clamp(mix(cCU, cCUg, RF_GHOST_EDGE), 0.0, 1.0));
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

  // 由近到远合成的座位列盖在背景上（见函数开头）
  col = acc + trans * col;
  } else {
    col = acc;
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
// 光点重影强度 RF_GHOST_PT（T42 从 0.3 降到 0.12），在亮点旁边多一个淡得多的错位像
vec3 cabinReflectPoints(vec3 p, vec3 r, float d0, ReflLights L) {
  float moodOn = step(1e-5, dot(L.moodI, vec3(1.0))); // 睡眠档氛围灯亮着，全关档是 0
  // T41：全关档（主灯、氛围灯都关）不画光点。原来全关档还留两盏 + 邻座那盏，连同重影在所有夜景的同一屏幕位置
  // 读成一对「双亮星」（窗外怎么换它都在）；全关的意义是贴窗暗适应看星，零星的阅读灯按用手挡住计 0（和 stars.glsl.ts 的光幕一致）。
  // 睡眠档的光点在 scene.ts 按面状倒影的同一上限软限幅（极弱），开灯档照旧
  if (max(moodOn, L.lit) <= 0.0) return vec3(0.0);
  // PERF-12：灯都在行李架下沿（y ≥ 0.6 m），窗板上的点 y ≤ 0.2 m；朝下或水平的射线（及再往下偏的重影）离每盏灯都 ≥ 0.4 m，
  // 而高斯宽度 s ≤ 1.2 cm，exp(−d²/s²) 严格下溢成 0（邻座那盏另有 r.y > 0.6 的光锥）。窗板下半的像素整段不用算
  if (r.y <= 0.0) return vec3(0.0);
  vec3 rg = normalize(r + vec3(0.009 * uSeatSign, RF_GHOST_DY, 0.0));
  float frac = mix(mix(0.18, 0.35, moodOn), 0.56, L.lit);
  float acc = 0.0;
  // PERF-12：上限带 uLoopGuard（原来常量 10 次被 FXC 展开，20 份 rfPoint）
  for (int i = 0; i < RF_NPT + uLoopGuard; i++) {
    vec4 q = RF_PTS[i];
    if (q.w > frac) continue;
    vec3 c = vec3(q.x * uSeatSign, q.y, q.z);
    acc += rfPoint(p, r, c, 0.012, d0, L) + RF_GHOST_PT * rfPoint(p, rg, c, 0.012, d0, L);
  }
  vec3 pts = acc * 0.6 * READING_LIGHT_COLOR;
  // 自己这一排邻座的阅读灯（全关 / 睡眠时开着的那盏，离窗板不到一米）：灯头朝下，只有朝下出射的方向亮
  if (L.readOn > 0.0) {
    vec3 lp = vec3(0.30 * uSeatSign, 0.85, -0.70);
    float cone = smoothstep(0.6, 0.92, r.y);
    pts += L.readOn * READING_LIGHT_COLOR * 3.0 * cone * (rfPoint(p, r, lp, 0.008, d0, L) + RF_GHOST_PT * rfPoint(p, rg, lp, 0.008, d0, L));
  }
  return pts;
}

// 窗板的总反射：面状部分（返回值）+ 光点（pts，调用处不进亮度上限）。
// 双层窗板的第二次反射：光点见 cabinReflectPoints；面状部分只算一遍（T24 试过整层重影，开销翻倍），T42 只给行李架长边混一道错位覆盖率
vec3 cabinReflection(vec3 p, vec3 r, float d0, ReflLights L, out vec3 pts) {
  pts = cabinReflectPoints(p, r, d0, L);
  return cabinReflectEnv(p, r, d0, L);
}
`;
