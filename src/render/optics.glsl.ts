/**
 * 罕见光学现象（T17，GLSL）：宝光、本机影子、日落绿闪、幻日与 22° 晕。只进窗外程序（outside-pass.ts）。
 * 依赖 ATMOSPHERE_COMMON、VIEW_COMMON、LIGHTS_COMMON、NOISE_COMMON（uLoopGuard）。不采样任何新纹理（窗外程序 sampler 已接近 16 的上限）。
 * 什么时候出现、多强由 CPU 端 render/optics.ts 按条件 + 随机性决定，这里只按 uniform 画出角分布。
 * 物理依据与参数来源见 handoff/T17.md；标「估算」的数字不是测量值。
 *
 * 三个入口，各只有一个调用点（FXC 会把每个调用点整份内联）：
 * - opticsSunDisk：太阳圆盘（取代原来窗外 pass 里的圆盘代码）。地平线按海平面球解析地裁切，RGB 三个通道的日像
 *   按大气色散错开一点（绿比红高约 20 角秒，估算），太阳上缘沉到地平线时最后一丝是绿的——这就是绿闪；
 *   平时错开量远小于一个像素（1600×1200 下一个像素约 2.7 角分），看不出任何变化。
 * - opticsCloudFactor：乘在云的辐亮度上：反日点周围的宝光彩环（Mie 后向的「glory」项，(J0² + J2²)(ka·θ)，
 *   按粒径分布三点平均）和本机投在云顶上的影子（按太阳圆盘的半影算，远了就只剩几乎看不见的一点暗）。
 * - opticsHaloRadiance：卷云里的冰晶：水平取向的六角片状冰晶产生的幻日（与太阳同高、方位差 = Bravais 等效折射率下的
 *   最小偏向角，红色在内缘），随机取向的冰晶产生 22° 晕。按「这一像素里卷云的光学厚度 × 单次散射」算辐亮度。
 *
 * PERF-13：宝光 / 本机影子 / 幻日 / 晕只编进 `#ifdef OUTSIDE_OPTICS` 变体（窗外程序的按需变体，启动后后台预编），
 * 默认程序只有太阳圆盘 + 绿闪。新加的「平时不出现」的光学现象一律写进这个宏里，并让 render/optics.ts 的 opticsWanted 认得它。
 */
export const OPTICS_COMMON = /* glsl */ `
#ifdef OUTSIDE_OPTICS
// ---- 各 #ifdef OUTSIDE_OPTICS 段：宝光 / 本机影子 / 幻日 / 22° 晕，只编进 OUTSIDE_OPTICS 变体（PERF-13；选变体见 outside-pass.ts 的 wantedOutsideKey，
// 「这一帧有没有看得出的贡献」见 render/optics.ts 的 opticsWanted）。默认程序（冷启动关键路径）预处理后不含这些代码。
// 声明顺序保持改动前的样子（变体预处理后与改动前的程序逐字相同，handoff/PERF-13-parity.mjs 核对）
uniform vec4 uOpticsGlory;   // x 宝光强度（0 = 不出现）, y 云滴有效半径（µm）, z 粒径相对离散度, w 未用
uniform vec4 uOpticsShadow;  // x 本机到云顶（影子落点）的高度差 km（≤ 0：下面没有云，不算）, y 影子处云辐亮度最多压暗多少
uniform vec4 uOpticsHalo;    // x 幻日 A（太阳方位 + 侧）份额, y 幻日 B（− 侧）份额, z 22° 晕份额, w 片状冰晶倾斜的标准差（弧度）
#endif
uniform vec4 uOpticsFlash;   // x 地平线附近的蜃景竖直放大倍数（1 = 标准大气，随机）, y 色散开关（1 开 0 关）
#ifdef OUTSIDE_OPTICS
uniform float uSeatSign;     // 右侧 +1，左侧 −1（wing.glsl.ts 在机翼程序里声明同名 uniform，两个程序各自声明、共用一个值）

// 代表波长（µm）：红 / 绿 / 蓝三个通道各用一个
const vec3 OPTICS_LAMBDA_UM = vec3(0.65, 0.55, 0.45);
// 冰的折射率（同上三个波长；Warren 1984 的实部，取两位有效数字以后的量级）
const vec3 OPTICS_ICE_N = vec3(1.3075, 1.3110, 1.3165);

// ---- SPEC-BOW：虹 / 云虹 / 环地平弧 / 日柱（也只在 OUTSIDE_OPTICS 变体里；CPU 端在 render/optics.ts） ----
uniform vec4 uBowRain[4];    // 雨区（高斯雨柱）：(云坐标 x, z km, 高斯半径 km, 中心消光 /km)；w = 0 这一格空着
uniform vec4 uBowRainB[4];   // 同上：(雨顶高度 km, 1 = 阵雨雨区、雨幕由这里画 / 0 = 雷暴雨幡、云步进已画, 雨丝噪声的种子, 未用)
uniform vec4 uBowOn;         // x 雨虹（雨区的光学）总开关（0 = 不算）, y 云虹强度（0 = 不出现）, z 未用, w 未用
uniform vec4 uBowCloudC;     // 云虹：xyz 各通道的角半径（弧度，相对对日点）, w 虹内平台 b_in − p_ref（/sr）
uniform vec4 uBowCloudS;     // 云虹：xyz 各通道的宽度（弧度）, w 虹外平台 b_out − p_ref（/sr）
uniform vec4 uBowCloudP;     // 云虹：xyz 各通道的峰值（/sr）, w 未用
uniform vec4 uOpticsArc;     // x 环地平弧份额, y 日柱份额, z 日柱的片状冰晶倾斜标准差（弧度）, w 未用
#endif
// 空气色散：各通道的折射量相对红光多出的比例 (n_λ − n_red)/(n − 1)，Edlén 1966 公式算出（绿 0.55%、蓝 1.52%）
const vec3 OPTICS_AIR_DISPERSION = vec3(0.0, 0.00549, 0.0152);
// 从 10 km 看海平线时，贴着海面擦过的光线的总折射量（弧度）：地面观测者的地平折射约 35 角分，这里入射、出射两段各一次，
// 取约 60 角分（估算）。只用来乘色散比例，得到三色日像在地平线处的上下错开量
const float OPTICS_HORIZON_REFRACTION = 0.01745;

#ifdef OUTSIDE_OPTICS
// ---- 贝塞尔函数 J0 / J1（Abramowitz & Stegun 9.4.1–9.4.6 的多项式近似，误差 < 1e-7 量级，x ≥ 0） ----
// 三个波长一起算（vec3），小宗量 / 大宗量两套式子都算完再按 x < 3 选：没有分支，FXC 只内联一份向量代码
// （写成标量函数、每个波长调一次时，窗外程序的离线 FXC 编译时间多出三成多）
vec3 opticsJ0(vec3 x) {
  vec3 y = x * x / 9.0;
  vec3 small = 1.0 + y * (-2.2499997 + y * (1.2656208 + y * (-0.3163866 + y * (0.0444479 + y * (-0.0039444 + y * 0.00021)))));
  vec3 xl = max(x, vec3(3.0));
  vec3 z = 3.0 / xl;
  vec3 f = 0.79788456 + z * (-0.00000077 + z * (-0.0055274 + z * (-0.00009512 + z * (0.00137237 + z * (-0.00072805 + z * 0.00014476)))));
  vec3 t = xl - 0.78539816 + z * (-0.04166397 + z * (-0.00003954 + z * (0.00262573 + z * (-0.00054125 + z * (-0.00029333 + z * 0.00013558)))));
  return mix(small, f * cos(t) / sqrt(xl), step(3.0, x));
}
vec3 opticsJ1(vec3 x) {
  vec3 y = x * x / 9.0;
  vec3 small = x * (0.5 + y * (-0.56249985 + y * (0.21093573 + y * (-0.03954289 + y * (0.00443319 + y * (-0.00031761 + y * 0.00001109))))));
  vec3 xl = max(x, vec3(3.0));
  vec3 z = 3.0 / xl;
  vec3 f = 0.79788456 + z * (0.00000156 + z * (0.01659667 + z * (0.00017105 + z * (-0.00249511 + z * (0.00113653 - z * 0.00020033)))));
  vec3 t = xl - 2.35619449 + z * (0.12499612 + z * (0.0000565 + z * (-0.00637879 + z * (0.00074348 + z * (0.00079824 - z * 0.00029166)))));
  return mix(small, f * cos(t) / sqrt(xl), step(3.0, x));
}

// 宝光：单一粒径、单一波长的角分布（非偏振）|S1|² + |S2|² ∝ J0²(u) + J2²(u)，u = k·a·θ（Nussenzveig 的后向 glory 近似），
// J2 = 2·J1/u − J0。u = 0 处为 1；第一个亮环在 u ≈ 3.8（a = 10 µm 的红光约 2.3°），短波的环更靠里：内蓝外红。
// 粒径分布按 (1 − s, 1, 1 + s) 三点、权 (1, 2, 1) / 4 平均（离散度越大，外圈越糊，只剩一两圈）。
// 循环上限「3 + uLoopGuard」：常量上限会被 FXC 展开成 3 份
vec3 opticsGlory(float theta) {
  vec3 g = vec3(0.0);
  for (int i = 0; i < 3 + uLoopGuard; i++) {
    float fi = float(i) - 1.0;
    float a = uOpticsGlory.y * (1.0 + uOpticsGlory.z * fi);
    float w = fi == 0.0 ? 0.5 : 0.25;
    vec3 u = max(6.2831853 * a * theta / OPTICS_LAMBDA_UM, vec3(1e-3));
    vec3 j0 = opticsJ0(u);
    vec3 j2 = 2.0 * opticsJ1(u) / u - j0;
    g += w * (j0 * j0 + j2 * j2);
  }
  return g;
}

// ---- 本机影子 ----
// 从云上一点朝太阳看，机体挡住了太阳圆盘的多少（0..1）。
// 在垂直于阳光的平面里做：影子点相对本机的横向偏移 = t·rd 去掉沿阳光的分量；机体投影到同一平面。
// 机体（A320 量级的尺寸，估算）拆成 6 段「带厚度的线段」：机身、左右机翼、左右平尾、垂尾。平板（翼面）投影后的半厚度
// = 平均弦长 / 2 × |阳光·板法线|（太阳低时翼面几乎侧对阳光，影子里的翼只剩细线）。
// 每段挡住的比例：太阳圆盘（半影半径 b = 距离 × 太阳角半径）被一条宽 2w 的带子遮住的面积，带子比圆盘短时再按长度折算。
// 巡航 10 km、云顶 2 km、太阳高 20° 时 t ≈ 23 km、b ≈ 110 m，机身才 38 m——整架飞机只挡住太阳的 1% 左右，影子实际上看不见；
// 云顶就在机腹下几百米时才是清楚的十字形。
// 写成一个循环（上限「6 + uLoopGuard」）而不是 6 份展开的多边形距离场：后者让窗外程序的离线 FXC 编译多出约 1 秒
float opticsPlaneShadow(vec3 rd) {
  float t = uOpticsShadow.x / max(-rd.y, 0.02) * 1000.0; // m
  float b = t * SUN_ANGULAR_RADIUS;
  vec3 s = uSunDir;
  vec3 e1 = normalize(cross(s, abs(s.y) < 0.99 ? vec3(0.0, 1.0, 0.0) : vec3(1.0, 0.0, 0.0)));
  vec3 e2 = cross(s, e1);
  vec2 p = vec2(dot(rd, e1), dot(rd, e2)) * t;
  if (length(p) > 45.0 + 1.5 * b) return 0.0;
  // 机体轴（窗外系）：座舱 x 轴在左侧座位是朝机尾的（main.ts 的 cabinToWorld）
  vec3 fw = uCabinToWorld[0] * uSeatSign;
  vec3 up = uCabinToWorld[1];
  vec3 rt = uCabinToWorld[2] * uSeatSign;
  // 机体系（前、右、上）→ 投影平面
  mat3x2 P = mat3x2(dot(fw, e1), dot(fw, e2), dot(rt, e1), dot(rt, e2), dot(up, e1), dot(up, e2));
  float sUp = abs(dot(s, up));
  float sRt = abs(dot(s, rt));
  float keep = 1.0;
  for (int k = 0; k < 6 + uLoopGuard; k++) {
    // 端点（机体系，m）和半厚度（m）
    vec3 A = vec3(19.0, 0.0, 0.0);
    vec3 B = vec3(-19.0, 0.0, 0.0);
    float w = 2.0; // 机身半径
    float side = (k == 2 || k == 4) ? -1.0 : 1.0;
    if (k == 1 || k == 2) { A = vec3(-0.5, 2.0 * side, 0.0); B = vec3(-6.2, 17.0 * side, 0.0); w = max(1.75 * sUp, 0.25); }      // 机翼：后掠约 25°，平均弦长 3.5 m
    else if (k == 3 || k == 4) { A = vec3(-16.5, 1.0 * side, 0.0); B = vec3(-18.7, 6.3 * side, 0.0); w = max(0.9 * sUp, 0.2); } // 平尾
    else if (k == 5) { A = vec3(-15.5, 0.0, 2.0); B = vec3(-18.2, 0.0, 8.0); w = max(1.2 * sRt, 0.2); }                        // 垂尾
    vec2 a = P * A;
    vec2 ba = P * B - a;
    vec2 pa = p - a;
    float len = length(ba);
    float h = clamp(dot(pa, ba) / max(len * len, 1e-6), 0.0, 1.0);
    float m = length(pa - ba * h); // 到这一段中线的距离
    // 圆盘被带子 [−w, w] 挡住的面积比例：圆盘「坐标 < x」部分的面积比例用 smoothstep 近似（误差几个百分点）
    float cov = smoothstep(-1.0, 1.0, (w - m) / b) - smoothstep(-1.0, 1.0, (-w - m) / b);
    keep *= 1.0 - cov * min(1.0, (len + 2.0 * w) / (2.0 * b));
  }
  return 1.0 - keep;
}

// ---- 云虹 / 雾虹（SPEC-BOW）----
// 云滴（半径 5–20 µm）的 Mie 相函数在对日点外约 36–40° 有一圈宽的亮带：粒子小，Airy 衍射把各色的虹抹宽、叠在一起，
// 几乎是白的，只剩外缘一点红、内缘一点蓝（handoff/SPEC-BOW-optics.py 用 BHMIE 算伽马分布云滴谱后拟合：
// 每个通道 p(θ) = b_out + (b_in − b_out)·σ((θc − θ)/s) + P·exp(−((θ − θc)/s)²)，CPU 按宝光同一次的云滴半径插值给 uBowCloud*）。
// 厚云顶的辐亮度大部分是多次散射，单次散射只占一小份：L_ss / L ≈ π·(p − p_ref) / (R·(μ0 + μ))（R ≈ 0.75 的云顶反照率，
// μ0、μ 是太阳、视线与竖直的夹角余弦），乘到云的辐亮度上就是亮带只比周围亮百分之几到十几——真实照片里云虹也是一道淡淡的白弧。
// p_ref 取虹内外两个平台的平均，所以整体不改变云海的平均亮度，只是虹内略亮、虹外略暗、虹上一道亮弧
vec3 opticsCloudBow(vec3 rd, float c, float cloudOpacity) {
  float sinH = BOTTOM / uCamR;
  float below = smoothstep(-sqrt(1.0 - sinH * sinH) + 0.01, -sqrt(1.0 - sinH * sinH) - 0.02, rd.y);
  float theta = acos(c);
  // 在 25° / 53° 的取值窗边缘淡出（平台项在那里还不为 0）
  float win = smoothstep(0.4363, 0.5236, theta) * (1.0 - smoothstep(0.8378, 0.9250, theta));
  vec3 x = (theta - uBowCloudC.xyz) / uBowCloudS.xyz;
  vec3 inner = 1.0 / (1.0 + exp(x));
  vec3 m = uBowCloudP.xyz * exp(-x * x) + uBowCloudC.w * inner + uBowCloudS.w * (1.0 - inner);
  float k = min(3.1416 / (0.75 * (max(uSunDir.y, 0.05) + max(-rd.y, 0.05))), 5.0);
  return 1.0 + uBowOn.y * k * m * win * below * smoothstep(0.3, 0.85, cloudOpacity);
}

// 乘在云辐亮度上的因子（宝光 + 本机影子）。cloudOpacity = 1 − 云的透射率。只在反日点 12° 以内算
vec3 opticsCloudFactor(vec3 rd, float cloudOpacity) {
  vec3 f = vec3(1.0);
  if (cloudOpacity < 0.02 || (uOpticsGlory.x <= 0.0 && uOpticsShadow.x <= 0.0 && uBowOn.y <= 0.0)) return f;
  vec3 anti = -uSunDir;
  float c = dot(rd, anti);
  // 云虹 / 雾虹（SPEC-BOW）：对日点外 25°–53° 的一圈，只画在海平线以下的云上（反日点那一侧的云海）
  if (uBowOn.y > 0.0 && c < 0.9063 && c > 0.6018) f *= opticsCloudBow(rd, c, cloudOpacity);
  if (c < 0.978) return f;
  // 小角度用 asin(|叉积|)，acos 在 1 附近精度不够
  float theta = asin(min(length(cross(rd, anti)), 1.0));
  if (uOpticsGlory.x > 0.0) {
    // 宝光是云顶一薄层里云滴的单次后向散射；云要够「实」（背景是均匀亮白的云顶）才看得出彩环
    float w = uOpticsGlory.x * smoothstep(0.3, 0.85, cloudOpacity) * smoothstep(0.209, 0.14, theta);
    // 中心的峰被云里多次散射的光冲淡得比环多（环在更大的立体角上、对比更稳），把峰压一点：g → 1.6g / (1 + 0.6g)（估算）
    vec3 g = opticsGlory(theta);
    f += w * 1.6 * g / (1.0 + 0.6 * g);
  }
  if (uOpticsShadow.x > 0.0) f *= 1.0 - uOpticsShadow.y * opticsPlaneShadow(rd) * smoothstep(0.2, 0.8, cloudOpacity);
  return f;
}
#endif

// ---- 太阳圆盘 + 绿闪 ----
// 按列解析地算覆盖率：这个像素竖直方向 [e − p/2, e + p/2] 里，每个颜色的日像（中心高度 eS + δc）在海平线以上的那一段占多少。
// 原来的圆盘只在像素中心打不到地面时才画，太阳落到地平线时是一行一行地消失；这里按亚像素算，最后那一丝能留在一个像素里。
// hitGround：像素中心打到了地面 / 海面。真实地形高出海平线的地方（离海平线超过一个像素）直接挡住。
// 绿闪能不能被肉眼看见，靠的是近地逆温层的蜃景（Young 的「mock mirage」）：它把地平线上方很窄一带（这里取 4 角分，估算）
// 在竖直方向放大 m 倍。放大的是角尺寸，不是时间——绿边仍只持续「色散量 ÷ 太阳下沉速度」约 1–2 秒，只是从亚像素变成一两个像素高。
// 做法：把像素的视高度换回「真」高度（放大带里除以 m，带以上连续平移），在真高度上算覆盖，再按像素在真高度上的跨度归一
float opticsTrueHeight(float a, float m) {
  const float Z = 0.00116; // 放大带的视高度（4 角分，估算）
  return a < Z ? a / m : Z / m + (a - Z);
}
vec3 opticsSunDisk(vec3 rd, bool hitGround) {
  float pix = 2.0 * uTanHalfFov / uResolution.y;
  float c = dot(rd, uSunDir);
  float m = max(uOpticsFlash.x, 1.0);
  float reach = SUN_ANGULAR_RADIUS * 1.2 + OPTICS_HORIZON_REFRACTION * 0.0152 + 0.00116 + 2.0 * pix;
  if (c < cos(reach)) return vec3(0.0);
  float sinH = BOTTOM / uCamR;
  float eH = -acos(sinH); // 海平线的仰角（负数，巡航高度约 −3.3°）
  float e = asin(clamp(rd.y, -1.0, 1.0));
  if (hitGround && e - eH > pix) return vec3(0.0);
  float eS = asin(clamp(uSunDir.y, -1.0, 1.0));
  // 水平方向：像素与太阳的方位差（换成角距离）
  vec2 sh = normalize(uSunDir.xz + vec2(1e-9, 0.0));
  vec2 rh = normalize(rd.xz + vec2(1e-9, 0.0));
  float dx = abs(atan(sh.x * rh.y - sh.y * rh.x, dot(sh, rh))) * cos(e);
  float R = SUN_ANGULAR_RADIUS;
  float hc = clamp((R - dx) / pix + 0.5, 0.0, 1.0);
  if (hc <= 0.0) return vec3(0.0);
  float dx2 = max(dx - 0.5 * pix, 0.0);
  float halfChord = sqrt(max(R * R - dx2 * dx2, 0.0));
  // 像素的竖直跨度换到真高度（相对海平线）
  float tLo = opticsTrueHeight(e - eH - 0.5 * pix, m);
  float tHi = opticsTrueHeight(e - eH + 0.5 * pix, m);
  float tMid = opticsTrueHeight(e - eH, m);
  // 色散：折射量随太阳离地平线的高度很快变小（估算：高出地平线 0.8° 时减半）；uOpticsFlash.y = 0 时关掉
  float lift = max(eS - eH, 0.0);
  vec3 delta = OPTICS_AIR_DISPERSION * OPTICS_HORIZON_REFRACTION * uOpticsFlash.y / (1.0 + lift / 0.014);
  vec3 L = vec3(0.0);
  vec3 disk = uSunIlluminance / (M_PI * R * R);
  for (int k = 0; k < 3 + uLoopGuard; k++) {
    float ec = eS + delta[k] - eH; // 这个颜色日像中心的真高度（相对海平线）
    float lo = max(max(ec - halfChord, 0.0), tLo);
    float hi = min(ec + halfChord, tHi);
    float cover = max(hi - lo, 0.0) / max(tHi - tLo, 1e-9) * hc;
    if (cover <= 0.0) continue;
    // 临边昏暗（与原来的圆盘一致），按像素中心到这个颜色日像中心的距离
    float x = min(length(vec2(dx, tMid - ec)) / R, 1.0);
    float mu = sqrt(max(0.0, 1.0 - x * x));
    float limb = (1.0 - 0.6 * (1.0 - mu)) / (1.0 - 0.6 / 3.0);
    // 透射率取看得见的那一段的中点方向（贴着海平线时变化极快，不能用像素中心）
    float mid = eH + max(0.5 * (lo + hi), 1e-5);
    L[k] = disk[k] * limb * cover * transmittanceToTop(uCamR, sin(mid))[k];
  }
  return L;
}

#ifdef OUTSIDE_OPTICS
// ---- 幻日与 22° 晕 ----
// 卷云的单次散射：L = E☉ · T☉ · τ · f · p，p 是归一化（∫p dΩ = 1）的角分布，f 是这部分冰晶散射的份额（CPU 给，随机）。
// τ 用这一像素的云透射率反推（地平线以上看到的只有卷云）
vec3 opticsHaloRadiance(vec3 rd, float cloudT) {
  if (uOpticsHalo.x + uOpticsHalo.y + uOpticsHalo.z <= 0.0) return vec3(0.0);
  // 太厚的卷层云里多次散射把晕冲散，τ 只取到 1.5
  float tau = min(-log(max(cloudT, 0.05)), 1.5);
  if (tau < 1e-3) return vec3(0.0);
  float sinH = BOTTOM / uCamR;
  if (rd.y < -sqrt(1.0 - sinH * sinH) + 0.002) return vec3(0.0);
  vec3 s = uSunDir;
  float cosToSun = dot(rd, s);
  if (cosToSun < 0.5) return vec3(0.0); // 60° 以外没有
  float h = asin(clamp(s.y, -1.0, 1.0));
  float e = asin(clamp(rd.y, -1.0, 1.0));
  float pix = 2.0 * uTanHalfFov / uResolution.y;
  float edge = 1.5 * SUN_ANGULAR_RADIUS + pix; // 内缘被太阳圆盘的大小（和冰晶的不完美）抹开
  vec3 sunT = sunTransmittance(uCamR, s.y); // 太阳落下去以后自然没有
  vec3 L = vec3(0.0);
  // 22° 晕：随机取向的柱状 / 片状冰晶，最小偏向角 D = 2·asin(n·sin30°) − 60°，内缘锐、外侧拖尾（估算 2°）
  if (uOpticsHalo.z > 0.0) {
    float th = acos(clamp(cosToSun, -1.0, 1.0));
    vec3 D = 2.0 * asin(OPTICS_ICE_N * 0.5) - 1.0472;
    // 三个通道各代表一段波长，真实的晕是连续光谱叠起来的，颜色远没有三原色阶梯那么纯：各通道的内缘往中间收一半（估算），
    // 只剩红色内缘、往外发黄发白
    D = mix(vec3(D.y), D, 0.5);
    vec3 x = th - D;
    vec3 ring = smoothstep(-edge, edge, x) * exp(-max(x, 0.0) / 0.035);
    L += uOpticsHalo.z * ring / (6.2832 * sin(th) * 0.035);
  }
  // 幻日：水平取向的片状冰晶。Bravais：与太阳同高度时等效折射率 n' = √(n² − sin²h) / cos h，
  // 方位差 = 以 n' 算的 60° 棱镜最小偏向角（太阳越高离得越远；n'·sin30° ≥ 1 即太阳高于约 61° 时消失）
  if (uOpticsHalo.x + uOpticsHalo.y > 0.0) {
    float sh = sin(h);
    vec3 np = sqrt(OPTICS_ICE_N * OPTICS_ICE_N - sh * sh) / max(cos(h), 0.05);
    vec3 arg = np * 0.5;
    vec3 D = 2.0 * asin(min(arg, vec3(0.999))) - 1.0472;
    D = mix(vec3(D.y), D, 0.75); // 同上（幻日的颜色比晕更分明，只收四分之一）
    vec3 valid = step(arg, vec3(0.999));
    vec2 sd = normalize(s.xz + vec2(1e-9, 0.0));
    vec2 rh = normalize(rd.xz + vec2(1e-9, 0.0));
    float dAz = atan(sd.x * rh.y - sd.y * rh.x, dot(sd, rh)); // 带符号的方位差
    // 竖直方向：冰晶倾斜 + 太阳圆盘，高斯；方位方向：内缘锐、外侧拖尾（倾斜越大拖得越长，估算）
    float sig = sqrt(uOpticsHalo.w * uOpticsHalo.w + SUN_ANGULAR_RADIUS * SUN_ANGULAR_RADIUS);
    float tail = 0.012 + 0.8 * uOpticsHalo.w;
    float ve = exp(-0.5 * (e - h) * (e - h) / (sig * sig));
    float ce = cos(e);
    float norm = 1.0 / (2.5066 * sig * tail);
    vec3 xa = (dAz - D) * ce;
    vec3 xb = (-dAz - D) * ce;
    vec3 pa = smoothstep(-edge, edge, xa) * exp(-max(xa, 0.0) / tail);
    vec3 pb = smoothstep(-edge, edge, xb) * exp(-max(xb, 0.0) / tail);
    L += (uOpticsHalo.x * pa + uOpticsHalo.y * pb) * valid * ve * norm;
  }
  return uSunIlluminance * sunT * tau * L;
}

// ---- 雨虹（SPEC-BOW）----
// 雨滴（半径约 0.5 mm，几何光学）的相函数：10 个代表波长（400–700 nm 等分），每个波长两族光线——
// 一次内反射（主虹，Descartes 角 40.76°–42.39°，亮侧在内）、两次内反射（副虹，50.32°–53.28°，亮侧在外，色序相反）。
// 焦散用 Re[(x − i·w)^(−1/2)]（1/√x 被洛伦兹抹开；w = 0.26° 是太阳圆盘 + Airy 展宽 + 雨滴谱的综合，拟合值），
// 亮侧再加一段填充（主虹里面是亮的，副虹外面较亮；两者之间只有外反射——亚历山大暗带）。
// 参数由 handoff/SPEC-BOW-optics.py 对几何光学数值解拟合（折射率 Daimon & Masumura 2007，Fresnel 分偏振），
// 5°–70° 内 RGB 相对误差约 6%；各波长的 RGB 权重是 CIE 1931 色匹配函数（Wyman 2013 解析近似）→ 线性 sRGB 按段积分、等能白归一。
// 单位：/sr（∫p dΩ = 1，含衍射峰那一半）
const float BOW_A1 = 0.00511;
const vec3 BOW_F1 = vec3(-0.00030, -0.01188, 0.01064);
const float BOW_A2 = 0.00093;
const vec3 BOW_F2 = vec3(-0.00099, -0.00390, 0.00580);
const float BOW_W = 0.004538; // 0.26°
// 各代表波长（415, 445, … 685 nm）的主虹 / 副虹 Descartes 角（度）
const vec2 BOW_ANG[10] = vec2[10](vec2(40.757, 53.277), vec2(41.079, 52.694), vec2(41.343, 52.217), vec2(41.563, 51.819), vec2(41.750, 51.482),
                                  vec2(41.912, 51.191), vec2(42.053, 50.936), vec2(42.178, 50.711), vec2(42.290, 50.508), vec2(42.393, 50.324));
// 各代表波长的 RGB 权重（负值是 sRGB 色域外的光谱色，合起来再截到 ≥ 0）
const vec3 BOW_RGB[10] = vec3[10](vec3(0.0199, -0.0221, 0.1726), vec3(0.0426, -0.0588, 0.5619), vec3(-0.0534, 0.0362, 0.3418), vec3(-0.1645, 0.2327, 0.0486),
                                  vec3(-0.1528, 0.4313, -0.0409), vec3(0.1727, 0.3370, -0.0479), vec3(0.5215, 0.0942, -0.0263), vec3(0.4512, -0.0348, -0.0075),
                                  vec3(0.1445, -0.0159, -0.0018), vec3(0.0182, 0.0003, -0.0005));

float opticsCaustic(float x) {
  float m = sqrt(x * x + BOW_W * BOW_W);
  float c = sqrt(max(m + x, 0.0) * 0.5) / m;
  return x < 0.0 ? c * exp(-x * x / (4.84 * BOW_W * BOW_W)) : c;
}

// 相对对日点的角距 theta（弧度）上雨滴的相函数（主虹 + 副虹两族，RGB，/sr；外反射的常数底 0.0008 不在这里）
vec3 opticsBowPhase(float theta) {
  vec3 p = vec3(0.0);
  for (int i = 0; i < 10 + uLoopGuard; i++) {
    vec2 a = BOW_ANG[i] * 0.01745329;
    float x1 = min(a.x - theta, 0.70);        // 主虹：亮侧在内（拟合区间到里面 40°）
    float x2 = min(theta - a.y, 0.35);        // 副虹：亮侧在外（到外面 20°）
    float p1 = BOW_A1 * opticsCaustic(x1) + (x1 > 0.0 ? BOW_F1.x + x1 * (BOW_F1.y + x1 * BOW_F1.z) : 0.0);
    float p2 = BOW_A2 * opticsCaustic(x2) + (x2 > 0.0 ? BOW_F2.x + x2 * (BOW_F2.y + x2 * BOW_F2.z) : 0.0);
    p += BOW_RGB[i] * (max(p1, 0.0) + max(p2, 0.0));
  }
  // 副虹外 20° 以后（θ > 70°）缓慢归零，免得截断成一道边
  return max(p, vec3(0.0)) * (1.0 - smoothstep(1.22, 1.57, theta));
}

// 误差函数（Winitzki 近似，误差 < 2e-4）
float opticsErf(float x) {
  float x2 = x * x;
  return sign(x) * sqrt(1.0 - exp(-x2 * (1.2732395 + 0.147 * x2) / (1.0 + 0.147 * x2)));
}

// 雨区：一组高斯雨柱（CPU 给 uBowRain*）。雷暴雨幡与 clouds.glsl.ts 的 rainDensity 同形（中心、半径、消光按那边的式子折算），
// 云步进已经画了它的雨幕，这里只加虹；阵雨雨区（浓积云下的一片阵雨）云步进不画，这里连雨幕（消光 + 漫散射）一起画。
// 每个雨柱沿视线的光学厚度解析地积：视线在 [地面, 雨顶] 这一段里，水平投影上的高斯积分 = σ0·e^(−q²/R²)·R/h·(√π/2)·[erf]。
// 返回 rgb = 雨自身的光（要乘云的透射率：雨在云后面）、a = 阵雨雨幕的透射率
vec4 opticsRain(vec3 rd) {
  if (uBowOn.x <= 0.0) return vec4(0.0, 0.0, 0.0, 1.0);
  vec3 ro = vec3(0.0, uCamR, 0.0);
  float tb = raySphere(ro, rd, BOTTOM);
  if (tb < 0.0) return vec4(0.0, 0.0, 0.0, 1.0); // 打不到地面的视线（地平线以上）不穿过雨区
  vec2 hd = rd.xz;
  float hs = max(length(hd), 1e-4);
  float tauV = 0.0;   // 阵雨雨幕（这里画）
  float tauS = 0.0;   // 雷暴雨幡（云步进已画）
  float best = 0.0;
  float tLit = tb;
  float streak = 1.0;
  for (int i = 0; i < 4 + uLoopGuard; i++) {
    vec4 c = uBowRain[i];
    if (c.w <= 0.0) continue;
    vec4 cb = uBowRainB[i];
    float ta = uCamR - BOTTOM > cb.x ? raySphere(ro, rd, BOTTOM + cb.x) : 0.0;
    if (ta < 0.0 || ta >= tb) continue;
    vec2 dxz = c.xy - uCloudOffset;
    float tc = dot(dxz, hd) / (hs * hs);
    vec2 q = dxz - hd * tc;
    float g = exp(-dot(q, q) / (c.z * c.z));
    if (g < 1e-4) continue;
    float k = hs / c.z;
    float ti = c.w * g * 0.8862269 / k * (opticsErf(k * (tb - tc)) - opticsErf(k * (ta - tc)));
    float tm = clamp(tc, ta, tb);
    if (cb.y > 0.5) {
      // 雨丝：雨是一道道竖直的雨线，按视线最接近雨柱轴线那一点的水平位置取一个平滑噪声（约 0.7 km 一条），不随高度变
      vec2 pw = (ro.xz + hd * tm) + uCloudOffset;
      float n = vnoise(pw / 0.7 + cb.z) * 0.6 + vnoise(pw / 2.3 - cb.z) * 0.4;
      ti *= 0.35 + 1.3 * n;
      tauV += ti;
    } else tauS += ti;
    if (ti > best) { best = ti; tLit = tm; }
  }
  float tau = tauV + tauS;
  if (tau < 1e-3) return vec4(0.0, 0.0, 0.0, 1.0);
  // 雨里的受光：取光学厚度最大的那个雨柱里、视线离轴线最近的一点。太阳透射率 × 云影（雨在云底下，常被自己的云挡住）
  vec3 P = ro + rd * tLit;
  float rP = length(P);
  vec3 nP = P / rP;
  vec3 sunT = sunTransmittance(rP, dot(nP, uSunDir)) * cloudShadow(P, uSunDir);
  // 相机到雨的大气透射率（与开阔海面同一写法：两段都朝上）
  vec3 viewT = min(transmittanceToTop(rP, dot(nP, -rd)) / max(transmittanceToTop(uCamR, -rd.y), vec3(1e-6)), vec3(1.0));
  float cosA = dot(rd, -uSunDir);
  float theta = acos(clamp(cosA, -1.0, 1.0));
  vec3 bow = theta < 1.57 ? opticsBowPhase(theta) : vec3(0.0);
  // 单次散射 + 自遮挡：阳光进雨、散射出来各走一段，约 (1 − e^(−2τ)) / 2（太阳在背后时两段差不多长）
  vec3 eSun = uSunIlluminance * sunT * viewT;
  // 雷暴雨幡：只加虹（它的雨幕由云步进画，云缓冲的透射率里已含它自己的消光，乘回来，免得虹被它自己挡两次）
  vec3 rgb = eSun * (0.5 - 0.5 * exp(-2.0 * tauS)) * bow * exp(min(tauS, 3.0));
  float Tv = 1.0;
  if (tauV > 0.0) {
    // 阵雨雨幕：除了虹，还有雨滴的其余散射——外反射的常数底（0.0008 /sr）+ 前向的透射 / 衍射（HG g = 0.88，约占 43%，估算）；
    // 天空光按各向同性的一半漫射（估算）
    float g = 0.88;
    float hg = (1.0 - g * g) / (12.566 * pow(1.0 + g * g + 2.0 * g * cosA, 1.5));
    vec3 pV = bow + 0.0008 + 0.43 * hg;
    Tv = exp(-tauV);
    rgb += eSun * (0.5 - 0.5 * exp(-2.0 * tauV)) * pV + (1.0 - Tv) * viewT * skyIrradiance(rP, nP) * 0.08;
  }
  return vec4(uBowOn.x * rgb, Tv);
}

// ---- 环地平弧与日柱（SPEC-BOW，卷云里水平取向的片状冰晶；和幻日同一群冰晶，份额 CPU 给）----
// 环地平弧：光从竖直的侧面进、从水平的底面出（90° 棱镜）。按矢量折射：侧面保持竖直分量、底面保持水平分量，
// 出射光线的水平分量平方 = cos²h + n² − 1，所以弧的仰角 e = acos(√(cos²h + n² − 1))，与方位无关——一道与地平线平行的彩带，
// 红在上。n = 1.31 时太阳高于 57.8° 才有（cos²h + n² − 1 < 1），弧在太阳下方 46° 以上。方位上以太阳方位为中心、两侧各伸几十度（估算宽 0.6 rad）。
// 日柱：片状冰晶的上下底面像一面面微微倾斜的镜子，把低太阳的光反射成太阳上下的一道竖直光柱，倾斜越大柱越长（估算：长度尺度 2.5 × 倾斜）。
vec3 opticsArcRadiance(vec3 rd, float cloudT) {
  if (uOpticsArc.x + uOpticsArc.y <= 0.0) return vec3(0.0);
  float tau = min(-log(max(cloudT, 0.05)), 1.5);
  if (tau < 1e-3) return vec3(0.0);
  float sinH = BOTTOM / uCamR;
  if (rd.y < -sqrt(1.0 - sinH * sinH) + 0.002) return vec3(0.0);
  vec3 s = uSunDir;
  float h = asin(clamp(s.y, -1.0, 1.0));
  float e = asin(clamp(rd.y, -1.0, 1.0));
  vec2 sd = normalize(s.xz + vec2(1e-9, 0.0));
  vec2 rh = normalize(rd.xz + vec2(1e-9, 0.0));
  float dAz = atan(sd.x * rh.y - sd.y * rh.x, dot(sd, rh));
  float pix = 2.0 * uTanHalfFov / uResolution.y;
  vec3 L = vec3(0.0);
  if (uOpticsArc.x > 0.0) {
    float ch = cos(h);
    vec3 q = ch * ch + OPTICS_ICE_N * OPTICS_ICE_N - 1.0;
    // 太阳刚过门槛时弧贴着地平线、很暗（出射光线掠过底面，Fresnel 透射很小），按离门槛的余量淡入（估算）
    vec3 ok = smoothstep(vec3(0.0), vec3(0.06), 1.0 - q);
    vec3 eA = acos(sqrt(min(q, vec3(1.0))));
    eA = mix(vec3(eA.y), eA, 0.8); // 三通道色阶比连续光谱纯，往中间收一点（同幻日）
    float sig = sqrt(1.4 * uOpticsHalo.w * 1.4 * uOpticsHalo.w + SUN_ANGULAR_RADIUS * SUN_ANGULAR_RADIUS) + pix;
    vec3 v = (e - eA) / sig;
    float az = exp(-0.5 * dAz * dAz / 0.36);
    L += uOpticsArc.x * ok * exp(-0.5 * v * v) * az / (6.2832 * sig * 0.6 * max(cos(e), 0.2));
  }
  if (uOpticsArc.y > 0.0) {
    float sigA = SUN_ANGULAR_RADIUS + 0.003 + pix;
    float lv = max(2.5 * uOpticsArc.z, 0.01);
    float xa = dAz * cos(e) / sigA;
    L += uOpticsArc.y * exp(-abs(e - h) / lv) * exp(-0.5 * xa * xa) / (2.5066 * sigA * 2.0 * lv);
  }
  return uSunIlluminance * sunTransmittance(uCamR, s.y) * tau * L;
}
#endif

// 窗外最后的合成：背景 × 云透射率 + 云自身的光（乘宝光 / 影子）+ 卷云里的晕。
// 默认程序没有后两项：宝光 / 影子因子为 1、晕为 0 时 OUTSIDE_OPTICS 变体算出的也正好是 L·a + rgb（×1、+0 在浮点上精确），
// 所以「罕见光学没有贡献」时两个程序逐像素相同。在函数体里分 #ifdef（check:glsl 的重名检查不展开条件编译，见 README 坑点）
// SPEC-BOW：雨区（阵雨雨幕 + 雨虹）在云后面：背景先过雨幕（× rain.a、+ rain.rgb）再被云挡；环地平弧 / 日柱和晕一样加在最后。
// 这些都没有时 rain = (0, 0, 0, 1)、弧 = 0，(L·1 + 0)·a 与 L·a 逐位相同，OUTSIDE_OPTICS 变体的输出与改动前一样
vec3 opticsComposite(vec3 L, vec4 cloud, vec3 rd) {
#ifdef OUTSIDE_OPTICS
  vec4 rain = opticsRain(rd);
  return (L * rain.a + rain.rgb) * cloud.a + cloud.rgb * opticsCloudFactor(rd, 1.0 - cloud.a) + opticsHaloRadiance(rd, cloud.a) + opticsArcRadiance(rd, cloud.a);
#else
  return L * cloud.a + cloud.rgb;
#endif
}
`;
