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
 */
export const OPTICS_COMMON = /* glsl */ `
uniform vec4 uOpticsGlory;   // x 宝光强度（0 = 不出现）, y 云滴有效半径（µm）, z 粒径相对离散度, w 未用
uniform vec4 uOpticsShadow;  // x 本机到云顶（影子落点）的高度差 km（≤ 0：下面没有云，不算）, y 影子处云辐亮度最多压暗多少
uniform vec4 uOpticsHalo;    // x 幻日 A（太阳方位 + 侧）份额, y 幻日 B（− 侧）份额, z 22° 晕份额, w 片状冰晶倾斜的标准差（弧度）
uniform vec4 uOpticsFlash;   // x 地平线附近的蜃景竖直放大倍数（1 = 标准大气，随机）, y 色散开关（1 开 0 关）
uniform float uSeatSign;     // 右侧 +1，左侧 −1（wing.glsl.ts 在机翼程序里声明同名 uniform，两个程序各自声明、共用一个值）

// 代表波长（µm）：红 / 绿 / 蓝三个通道各用一个
const vec3 OPTICS_LAMBDA_UM = vec3(0.65, 0.55, 0.45);
// 冰的折射率（同上三个波长；Warren 1984 的实部，取两位有效数字以后的量级）
const vec3 OPTICS_ICE_N = vec3(1.3075, 1.3110, 1.3165);
// 空气色散：各通道的折射量相对红光多出的比例 (n_λ − n_red)/(n − 1)，Edlén 1966 公式算出（绿 0.55%、蓝 1.52%）
const vec3 OPTICS_AIR_DISPERSION = vec3(0.0, 0.00549, 0.0152);
// 从 10 km 看海平线时，贴着海面擦过的光线的总折射量（弧度）：地面观测者的地平折射约 35 角分，这里入射、出射两段各一次，
// 取约 60 角分（估算）。只用来乘色散比例，得到三色日像在地平线处的上下错开量
const float OPTICS_HORIZON_REFRACTION = 0.01745;

// ---- 贝塞尔函数 J0 / J1（Abramowitz & Stegun 9.4.1–9.4.6 的多项式近似，误差 < 1e-7 量级，x ≥ 0） ----
float opticsJ0(float x) {
  if (x < 3.0) {
    float y = x * x / 9.0;
    return 1.0 + y * (-2.2499997 + y * (1.2656208 + y * (-0.3163866 + y * (0.0444479 + y * (-0.0039444 + y * 0.00021)))));
  }
  float z = 3.0 / x;
  float f = 0.79788456 + z * (-0.00000077 + z * (-0.0055274 + z * (-0.00009512 + z * (0.00137237 + z * (-0.00072805 + z * 0.00014476)))));
  float t = x - 0.78539816 + z * (-0.04166397 + z * (-0.00003954 + z * (0.00262573 + z * (-0.00054125 + z * (-0.00029333 + z * 0.00013558)))));
  return f * cos(t) / sqrt(x);
}
float opticsJ1(float x) {
  if (x < 3.0) {
    float y = x * x / 9.0;
    return x * (0.5 + y * (-0.56249985 + y * (0.21093573 + y * (-0.03954289 + y * (0.00443319 + y * (-0.00031761 + y * 0.00001109))))));
  }
  float z = 3.0 / x;
  float f = 0.79788456 + z * (0.00000156 + z * (0.01659667 + z * (0.00017105 + z * (-0.00249511 + z * (0.00113653 - z * 0.00020033)))));
  float t = x - 2.35619449 + z * (0.12499612 + z * (0.0000565 + z * (-0.00637879 + z * (0.00074348 + z * (0.00079824 - z * 0.00029166)))));
  return f * cos(t) / sqrt(x);
}
// 单一粒径、单一波长的宝光角分布（非偏振）：|S1|² + |S2|² ∝ J0²(u) + J2²(u)，u = k·a·θ（Nussenzveig 的后向 glory 近似）。
// u = 0 处为 1；第一个亮环在 u ≈ 3.8（a = 10 µm 的红光约 2.3°），短波的环更靠里：内蓝外红
float opticsGloryTerm(float u) {
  float j0 = opticsJ0(u);
  float j2 = u > 1e-3 ? 2.0 * opticsJ1(u) / u - j0 : 0.0;
  return j0 * j0 + j2 * j2;
}

// 宝光：粒径分布按 (1 − s, 1, 1 + s) 三点、权 (1, 2, 1) / 4 平均（离散度越大，外圈越糊，只剩一两圈）。
// 循环上限「3 + uLoopGuard」：常量上限会被 FXC 展开成 3 份
vec3 opticsGlory(float theta) {
  vec3 g = vec3(0.0);
  for (int i = 0; i < 3 + uLoopGuard; i++) {
    float fi = float(i) - 1.0;
    float a = uOpticsGlory.y * (1.0 + uOpticsGlory.z * fi);
    float w = fi == 0.0 ? 0.5 : 0.25;
    vec3 u = 6.2831853 * a * theta / OPTICS_LAMBDA_UM;
    g += w * vec3(opticsGloryTerm(u.x), opticsGloryTerm(u.y), opticsGloryTerm(u.z));
  }
  return g;
}

// ---- 本机影子 ----
// 2D 多边形有向距离的一条边（Inigo Quilez 的 sdPolygon 拆成逐边）
void opticsEdge(vec2 p, vec2 vi, vec2 vj, inout float d, inout float s) {
  vec2 e = vj - vi;
  vec2 w = p - vi;
  vec2 b = w - e * clamp(dot(w, e) / max(dot(e, e), 1e-6), 0.0, 1.0);
  d = min(d, dot(b, b));
  bvec3 c = bvec3(p.y >= vi.y, p.y < vj.y, e.x * w.y > e.y * w.x);
  if (all(c) || all(not(c))) s = -s;
}
float opticsQuad(vec2 p, vec2 a, vec2 b, vec2 c, vec2 d) {
  float dd = dot(p - a, p - a);
  float s = 1.0;
  opticsEdge(p, a, b, dd, s);
  opticsEdge(p, b, c, dd, s);
  opticsEdge(p, c, d, dd, s);
  opticsEdge(p, d, a, dd, s);
  return s * sqrt(dd);
}
// 圆盘里「坐标 < x」那一部分的面积比例（x 以圆盘半径为单位）：太阳圆盘被一条带子挡住多少
float opticsDiskCdf(float x) {
  x = clamp(x, -1.0, 1.0);
  return 0.5 + (x * sqrt(1.0 - x * x) + asin(x)) / M_PI;
}
// 一个部件挡住太阳圆盘的比例：sd 有向距离（m），w 投影后的半厚度（m），len 投影后的长度（m），b 半影半径（m）
float opticsPartCover(float sd, float w, float len, float b) {
  float m = sd + w; // 到部件中线的距离
  float cov = opticsDiskCdf((w - m) / b) - opticsDiskCdf((-w - m) / b);
  return cov * min(1.0, len / (2.0 * b));
}
// 本机影子：从云上一点朝太阳看，机体挡住了太阳圆盘的多少（0..1）。
// 在垂直于阳光的平面里做：影子点相对本机的横向偏移 = t·rd 去掉沿阳光的分量；机体（A320 量级的尺寸，估算）投影到同一平面。
// 半影半径 b = 距离 × 太阳角半径：巡航 10 km、云顶 2 km、太阳高 20° 时 t ≈ 23 km、b ≈ 110 m，
// 机身才 38 m——整架飞机只挡住太阳的 1% 左右，影子实际上看不见；云顶就在机腹下几百米时才是清楚的十字形
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
  vec2 F = vec2(dot(fw, e1), dot(fw, e2));
  vec2 R = vec2(dot(rt, e1), dot(rt, e2));
  vec2 U = vec2(dot(up, e1), dot(up, e2));
  float sUp = abs(dot(s, up));
  float sRt = abs(dot(s, rt));
  // 机身：长 38 m、半径 2 m 的胶囊
  vec2 fa = F * 19.0;
  vec2 pa = p + fa;
  vec2 ba = -2.0 * fa;
  float hh = clamp(dot(pa, ba) / max(dot(ba, ba), 1e-6), 0.0, 1.0);
  float sdF = length(pa - ba * hh) - 2.0;
  float cover = opticsPartCover(sdF, 2.0, length(ba) + 4.0, b);
  // 机翼（后掠约 25°，翼展 34 m，根弦 7 m），平尾，垂尾：都是平板，投影后的半厚度 = 弦长 × |阳光·板法线| / 2
  float wWing = max(2.2 * sUp, 0.25);
  float wTail = max(1.1 * sUp, 0.2);
  float wFin = max(1.6 * sRt, 0.2);
  float keep = 1.0 - cover;
  for (int k = 0; k < 2; k++) {
    float y = k == 0 ? 1.0 : -1.0;
    float sdW = opticsQuad(p, F * 3.0 + R * 2.0 * y, F * -5.5 + R * 17.0 * y, F * -7.0 + R * 17.0 * y, F * -4.0 + R * 2.0 * y);
    keep *= 1.0 - opticsPartCover(sdW, wWing, 15.0 * length(R) + 1.0, b);
    float sdT = opticsQuad(p, F * -14.5 + R * y, F * -18.0 + R * 6.3 * y, F * -19.3 + R * 6.3 * y, F * -18.5 + R * y);
    keep *= 1.0 - opticsPartCover(sdT, wTail, 5.3 * length(R) + 1.0, b);
  }
  float sdV = opticsQuad(p, F * -13.0 + U * 2.0, F * -17.5 + U * 8.0, F * -19.0 + U * 8.0, F * -18.5 + U * 2.0);
  keep *= 1.0 - opticsPartCover(sdV, wFin, 6.0 * length(U) + 1.0, b);
  return 1.0 - keep;
}

// 乘在云辐亮度上的因子（宝光 + 本机影子）。cloudOpacity = 1 − 云的透射率。只在反日点 12° 以内算
vec3 opticsCloudFactor(vec3 rd, float cloudOpacity) {
  vec3 f = vec3(1.0);
  if (cloudOpacity < 0.02 || (uOpticsGlory.x <= 0.0 && uOpticsShadow.x <= 0.0)) return f;
  vec3 anti = -uSunDir;
  float c = dot(rd, anti);
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
  for (int k = 0; k < 3; k++) {
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

// 窗外最后的合成：背景 × 云透射率 + 云自身的光（乘宝光 / 影子）+ 卷云里的晕
vec3 opticsComposite(vec3 L, vec4 cloud, vec3 rd) {
  return L * cloud.a + cloud.rgb * opticsCloudFactor(rd, 1.0 - cloud.a) + opticsHaloRadiance(rd, cloud.a);
}
`;
