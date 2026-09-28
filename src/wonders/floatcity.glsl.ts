/**
 * 浮空古城（W03，致敬宫崎骏《天空之城》；原创造型，不用任何官方资产）。云间层奇观，接口见 wonder-cloud.glsl.ts / handoff/W00.md。
 * 设计依据 research/WONDERS.md §2.2（记忆点）、A1、§6.3；WS04 巨构化依据 research/WONDER_SCALE.md §3.4。
 *
 * 画面：云海之上远处悬着一座古城——顶上一团墨绿的巨树树冠（像一朵不会动的「绿云」），树冠下层层收窄的圆形台地（外墙上是
 * 拱廊的暗带、几座残塔），最下面是倒扣的岩石半球 + 正中往下突出的岩锥，粗根从台地之间缠下来、绕过底座，在城下垂成根须
 * （粗根是表面，细根须是一道透光的「帘子」介质）；城边一两道细瀑布，落到一半就散成被风吹偏的雾；城身周围一层薄雾罩，
 * 逆光时穿过树冠缝隙的光在雾里成一道道光束，城的影子投在下方云海上（投影椭球，W00）。
 * 浮现：先是一团形状不太对劲的「云」（雾罩），约一分钟里雾变薄，台地和根须从雾里显出来；退场反过来被雾吞没。
 *
 * 两个尺寸（WS04）：catalog 的 params[0]（uWonderParams.w）= 1 是「巨构」版（主），0 是 W03 的原尺寸小岛（低概率出现，代码路径与 W03 相同）。
 *  - 巨构版：同一套造型按种子放大——水平 ×4.2–5.8（直径 25–35 km），台地以上 ×0.82 倍、以下 ×0.75 倍（冠顶 25–32 km，
 *    岩锥尖不低于约 2.2 km）；台地底 12–16 km（局部原点在 FLC_BIG_BASE = 14 km，台地按种子上下挪 ±2 km）。
 *    放大以后另外改的：粗根有四五条一直垂进下方的云海（根尖 1.4–3 km），根尖在云顶搅起一团团云涡；瀑布 3–5 道、
 *    落差约 10 km，一路化成雾；台地墙面加第三级细节（石砌层 / 小窗，远处按足迹平均）、树冠加一级林冠纹理；
 *    高处的空气更稀薄、下段更朦胧（大气分层）；一架和我们同高度（10.9–11.7 km）的航班拖着航迹云从城下飞过（尺度参照）。
 *  - 放大用的是「模型坐标」：城坐标 c →（水平 / Kh，台地以上 / Ku，以下 / Kd）→ m，SDF 在 m 里求值后乘最小的放大倍数
 *    （分段线性、连续，Lipschitz 常数不超过 1 / min(K)，仍是距离下界）。
 *
 * 坐标：奇观局部坐标（km，x 东、y 天顶、z 南，原点在台地底面 = 岩石半球的上沿，catalog 的 baseKm = 海拔 7.5 km；巨构版 14 km），
 * 再按本次出现的随机种子（uWonderParams.z）绕 y 轴转一个角度 = 「城坐标」；台地的偏心、残塔、粗根、瀑布位置、
 * 树冠的团块也都由种子决定：每次出现都不一样（随机性造就真实）。
 *
 * 分工（各函数只有一个调用点，由 wonder-cloud.glsl.ts 的分派函数调用）：
 *  - flcSdf / flcShade：岩石底座 + 缠根的棱、台地与残塔、巨树树冠、垂下的粗根（表面）；
 *  - flcMedium：雾罩（含浮现时的「云」）、细根须的帘子、瀑布化雾、根尖的云涡。受光全部自己算（反照率返回 0，放进 emit）：
 *    要让雾里的光被**树冠的缝隙**切成光束，而标准受光只有一个平滑的投影椭球；
 *  - flcMediumSeg：介质只在雾罩椭球里步进（巨构版：整个包围盒）；
 *  - flcRay：夜里底部岩锥里一点极淡的青色微光（致敬「飞行石」，白天完全看不见）；巨构版的航迹云（线积分闭式解）。
 *
 * 亮度：全是受光的物体（反照率 5–25%，雾 / 瀑布 0.9 和云一样），和旁边的云同一套光照与相函数，不会比同条件下的云更亮；
 * 唯一的自发光（微光）按「无月夜天光的几十倍」定量、软封顶。
 */

export const FLOATCITY_GLSL = /* glsl */ `
const float FLC_A = 3.0;          // 岩石半球的水平半径（km，模型坐标）
const float FLC_B = 1.45;         // 岩石半球的深度
const vec3 FLC_MIST_C = vec3(0.0, -0.1, 0.0);   // 雾罩椭球（小岛版；局部 / 城坐标都一样：绕 y 轴对称）
const vec3 FLC_MIST_R = vec3(6.2, 5.6, 6.2);
const vec3 FLC_CROWN_C = vec3(1.0, 2.2, 0.35);  // 主冠层中心（模型坐标，偏向 +x）；冠层的大致椭球（光束、叶层用）
const vec3 FLC_CROWN_R = vec3(2.9, 1.3, 2.0);
const vec3 FLC_BODY_C = vec3(0.0, -0.2, 0.0);   // 台地 + 底座的大致椭球（光束用）
const vec3 FLC_BODY_R = vec3(3.0, 1.7, 3.0);
const float FLC_BIG_BASE = 14.0;  // 巨构版局部原点的海拔（km），与 catalog 的 baseKm 一致
const float FLC_BIG_MR = 4.0;     // 巨构版的雾罩（模型坐标里的球，中心 y = 0.2）

float flcHash(float p) {
  p = fract(p * 0.1031);
  p *= p + 33.33;
  p *= p + p;
  return fract(p);
}
float flcSeed() { return uWonderParams.z; }
bool flcBig() { return uWonderParams.w > 0.5; }
// 尺度：x 水平放大倍数 Kh，y 台地以上 Ku，z 台地以下 Kd，w 台地底面在局部坐标里的高度 Y0（km）。小岛版 = (1, 1, 1, 0)
vec4 flcK() {
  if (!flcBig()) return vec4(1.0, 1.0, 1.0, 0.0);
  float S = flcSeed();
  float kh = mix(4.2, 5.8, flcHash(S * 83.0 + 1.3));
  float y0 = (flcHash(S * 47.0 + 2.9) - 0.5) * 4.0;
  // 岩锥尖（模型 y = −2.75）不低于约 2.2 km：刚好扎进层积云顶，不插到海里
  float kd = min(0.75 * kh, (FLC_BIG_BASE + y0 - 2.2) / 2.75);
  return vec4(kh, 0.82 * kh, kd, y0);
}
// 城坐标 → 模型坐标（K.z 总是最小的放大倍数：Kd ≤ 0.75 Kh < Ku）
vec3 flcToM(vec3 c, vec4 K) {
  float y = c.y - K.w;
  return vec3(c.x / K.x, y / (y > 0.0 ? K.y : K.z), c.z / K.x);
}
// 局部坐标 → 城坐标：绕 y 轴转种子角（点、方向都用它）
vec3 flcToC(vec3 q) {
  float a = flcSeed() * 6.2831853;
  float c = cos(a), s = sin(a);
  return vec3(c * q.x - s * q.z, q.y, s * q.x + c * q.z);
}
float flcSmin(float a, float b, float k) {
  float h = clamp(0.5 + 0.5 * (b - a) / k, 0.0, 1.0);
  return mix(b, a, h) - k * h * (1.0 - h);
}
// 椭球的近似距离（iq），在远处是下界
float flcEllipsoid(vec3 p, vec3 r) {
  float k0 = length(p / r);
  float k1 = length(p / (r * r));
  return k0 * (k0 - 1.0) / max(k1, 1e-6);
}
float flcCyl(vec3 p, float r, float h) {
  vec2 d = abs(vec2(length(p.xz), p.y)) - vec2(r, h);
  return min(max(d.x, d.y), 0.0) + length(max(d, 0.0));
}
// 圆台（iq）：中心在原点、半高 h，底（y−）半径 r1、顶半径 r2
float flcCone(vec3 p, float h, float r1, float r2) {
  vec2 q = vec2(length(p.xz), p.y);
  vec2 k1 = vec2(r2, h);
  vec2 k2 = vec2(r2 - r1, 2.0 * h);
  vec2 ca = vec2(q.x - min(q.x, q.y < 0.0 ? r1 : r2), abs(q.y) - h);
  vec2 cb = q - k1 + k2 * clamp(dot(k1 - q, k2) / dot(k2, k2), 0.0, 1.0);
  float s = (cb.x < 0.0 && ca.y < 0.0) ? -1.0 : 1.0;
  return s * sqrt(min(dot(ca, ca), dot(cb, cb)));
}
// 离相机的距离对应的像素足迹（km，全分辨率，城坐标）
float flcFoot(vec3 c) {
  return length(c - flcToC(uWonderCam)) * 2.0 * uTanHalfFov / uResolution.y;
}

// 岩石半球的上沿：按方位分成 9 段崩塌面（每段半径不同、段间短过渡）——崩塌面是平的，不是各向同性的噪声
float flcRimScale(float ang) {
  float sec = ang / 6.2831853 * 9.0 + flcSeed() * 37.0;
  float si = floor(sec), sf = fract(sec);
  float a = flcHash(si + 11.0), b = flcHash(si + 12.0);
  return 0.9 + 0.1 * mix(a, b, smoothstep(0.3, 0.7, sf));
}
// 缠在底座和台地外墙上的粗根：绕着城螺旋往下的 7 条棱（方位按种子扭一扭，不等距）。返回 0..1
float flcRootRidge(vec3 c, float twist) {
  float ang = atan(c.z, c.x);
  float ph = 7.0 * (ang - twist * c.y) + 0.9 * sin(2.0 * ang + flcSeed() * 23.0) + flcSeed() * 50.0;
  float r = pow(0.5 + 0.5 * cos(ph), 10.0);
  // 有的根断在半路（按方位 + 高度的一次低频噪声开关）
  return r * step(0.3, flcHash(floor(ph / 6.2831853 + 0.5) * 1.37 + flcSeed() * 7.0));
}

// 底座：岩石半球（上沿崩塌）+ 正中往下突出的岩锥；水平层理往里刻；缠根的棱鼓出来
float flcRock(vec3 c) {
  float ang = atan(c.z, c.x);
  float A = FLC_A * flcRimScale(ang);
  float dome = flcEllipsoid(c, vec3(A, FLC_B, A));
  dome = max(dome, c.y);
  float spike = flcCone(c - vec3(0.0, -1.7, 0.0), 1.05, 0.07, 1.35);
  float d = flcSmin(dome, spike, 0.35);
  // 层理：0.3 km 一层的浅槽（沿方位有轻微起伏）
  d += 0.03 * (0.5 + 0.5 * sin(c.y * 21.0 + 1.5 * sin(ang * 2.0 + flcSeed() * 9.0)));
  // 缠根：底座上的根棱，靠近岩锥（半径小）的地方收细
  float rr = length(c.xz);
  d -= 0.08 * flcRootRidge(c, 0.55) * smoothstep(0.35, 1.1, rr);
  return d * 0.7;
}

// 台地：4 层收窄的圆台（按种子偏心，不是正的婚礼蛋糕），墙头按方位残缺；外墙上有粗根爬上来
// k：层号；返回这一层的 y0、y1、半径、中心偏移
vec4 flcTier(int k, out vec2 off) {
  float fk = float(k);
  float S = flcSeed();
  off = (vec2(flcHash(fk * 3.1 + S * 17.0), flcHash(fk * 5.7 + S * 29.0)) - 0.5) * (0.12 + 0.12 * fk);
  float y0 = k == 0 ? -0.05 : k == 1 ? 0.32 : k == 2 ? 0.66 : 1.0;
  float y1 = k == 0 ? 0.32 : k == 1 ? 0.66 : k == 2 ? 1.0 : 1.36;
  float R = (k == 0 ? 2.85 : k == 1 ? 2.4 : k == 2 ? 1.95 : 1.5) * (0.96 + 0.07 * flcHash(fk + S * 71.0));
  return vec4(y0, y1, R, 0.0);
}
float flcTerraces(vec3 c) {
  float d = 1e9;
  float ang = atan(c.z, c.x);
  for (int k = 0; k < 4 + min(uStormCount, 0); k++) {
    vec2 off;
    vec4 t = flcTier(k, off);
    // 墙头残缺：24 段里约三成矮一截（塌掉的一段墙）
    float seg = floor(ang / 6.2831853 * 24.0 + float(k) * 0.37);
    float ruin = step(0.68, flcHash(seg * 1.7 + float(k) * 13.0 + flcSeed() * 91.0)) * 0.09;
    float hh = 0.5 * (t.y - t.x);
    float dk = flcCyl(c - vec3(off.x, t.x + hh, off.y), t.z, hh);
    dk = max(dk, c.y - (t.y - ruin));
    d = min(d, dk);
  }
  // 爬上外墙的根
  d -= 0.05 * flcRootRidge(c, 0.3) * smoothstep(1.4, 0.2, c.y);
  return d * 0.8;
}
// 残塔：4 座，立在不同层的外沿，细高、顶部斜着断掉
float flcTowers(vec3 c) {
  float d = 1e9;
  float S = flcSeed();
  for (int i = 0; i < 4 + min(uStormCount, 0); i++) {
    float fi = float(i);
    int k = i == 0 ? 0 : i == 1 ? 1 : i == 2 ? 1 : 2;
    vec2 off;
    vec4 t = flcTier(k, off);
    // 放在冠层的另一侧（−x 方向 ±80°），从冠层旁边露出来
    float a = 3.14159 + 1.4 * (fi / 3.0 - 0.5) + 0.3 * (flcHash(fi * 7.3 + S * 13.0) - 0.5);
    vec2 p = off + (t.z - 0.14) * vec2(cos(a), sin(a));
    float r = 0.07 + 0.05 * flcHash(fi + S * 5.0);
    float h = 0.5 + 0.8 * flcHash(fi * 2.3 + S * 19.0);
    vec3 lp = c - vec3(p.x, t.y, p.y);
    float dt = flcCyl(lp - vec3(0.0, 0.5 * h, 0.0), r, 0.5 * h);
    // 斜断面
    vec2 tilt = vec2(cos(a * 3.0 + fi), sin(a * 3.0 + fi));
    dt = max(dt, lp.y - h + 0.9 * dot(lp.xz, tilt));
    d = min(d, dt);
  }
  return d;
}
// 巨树：主树偏向城的一侧（+x），冠层横向宽、扁，顶面是高低起伏的团块（像一片抬起来的林冠，不是一个圆球）；
// 另一侧（−x）是一丛低矮的次冠，中间露出台地、城墙和残塔——远看读成「城 + 树」，不是「云柱 + 云帽」（协调者返工）
float flcCrown(vec3 c, float fp) {
  float S = flcSeed();
  float d = flcEllipsoid(c - FLC_CROWN_C, vec3(2.3, 0.85, 1.6));
  for (int j = 0; j < 8 + min(uStormCount, 0); j++) {
    float fj = float(j);
    // 沿主轴（x）从 −0.7 排到 2.9，前后错开，高低不一：顶面起伏
    float x = -0.7 + 3.6 * (fj + 0.5 * flcHash(fj + S * 41.0)) / 8.0;
    float z = 0.35 + 1.5 * (flcHash(fj * 3.3 + S * 7.0) - 0.5);
    float y = 2.1 + 0.55 * flcHash(fj * 1.9 + S * 3.0) - 0.25 * max(x - 2.0, 0.0);
    float r = 0.5 + 0.3 * flcHash(fj * 4.1 + S * 2.0);
    d = flcSmin(d, length(c - vec3(x, y, z)) - r, 0.35);
  }
  // 次冠：城的另一侧一丛低矮的树
  d = flcSmin(d, flcEllipsoid(c - vec3(-1.75, 1.3, -0.8), vec3(0.95, 0.5, 0.85)), 0.2);
  // 菜花状的团块：一次纹理的两级 Worley（按足迹选 mip，远处不闪）
  if (d < 0.6) {
    float lod = clamp(log2(max(fp, 1e-3) / 0.02), 0.0, 5.0);
    vec4 n = textureLod(uShapeNoise, c * 0.5 + vec3(S * 5.1, 0.3, S * 2.3), lod);
    d -= 0.22 * (n.g - 0.45) + 0.12 * (n.b - 0.5);
    // 巨构版：再加一级小团块（模型 0.25，真实约 1.2 km 一丛），受光时林冠才有起伏，不是一整块光滑的面
    if (flcBig() && d < 0.25) {
      vec4 n2 = textureLod(uShapeNoise, c * 2.1 + vec3(0.71, S * 3.3, 0.37), clamp(log2(max(fp, 1e-3) / 0.006), 0.0, 5.0));
      d -= 0.08 * (n2.g - 0.45);
    }
  }
  // 主干：从台地顶上斜着长向冠层
  float trunk = flcCone(c - vec3(0.75 + 0.25 * (c.y - 1.5), 1.55, 0.3), 0.55, 0.55, 0.3);
  return min(d * 0.6, trunk);
}
// 垂根 i 的形状：xy = 在底座下面的水平位置（模型坐标），z = 顶（贴着岩石底面），w = 根尖（模型 y）。
// 巨构版：约三分之二的粗根一直垂进下方的云海（根尖海拔 1.4–3 km），其余的在半空断掉
vec4 flcRootDef(int i, vec4 K) {
  float fi = float(i);
  float S = flcSeed();
  float a = 6.2831853 * (fi / 7.0 + 0.1 * flcHash(fi + S * 3.7)) + S * 50.0;
  float rh = 0.3 + 1.55 * flcHash(fi * 2.7 + S * 9.0);
  float tip = -2.3 - 1.5 * flcHash(fi * 5.3 + S * 4.0) - 0.4 * smoothstep(1.5, 0.3, rh);
  float top = -FLC_B * sqrt(max(1.0 - rh * rh / (FLC_A * FLC_A), 0.0)) + 0.1;
  if (flcBig()) {
    // 放大后原来的根长会插到海里：断在半空的根尖放在海拔 4.5–8.5 km，垂进云海的放在 1.4–3 km
    bool reach = flcHash(fi * 7.9 + S * 13.0) > 0.33;
    float alt = reach ? 1.4 + 1.6 * flcHash(fi * 3.9 + S * 5.0) : 4.5 + 4.0 * flcHash(fi * 3.9 + S * 5.0);
    tip = min((alt - FLC_BIG_BASE - K.w) / K.z, top - 0.8);
  }
  return vec4(rh * vec2(cos(a), sin(a)), top, tip);
}
// 垂下的粗根：7 条从底座下面垂下来的竖根，越往下越细，轻微摆动
float flcHangRoots(vec3 c, vec4 K) {
  float d = 1e9;
  for (int i = 0; i < 7 + min(uStormCount, 0); i++) {
    float fi = float(i);
    vec4 R = flcRootDef(i, K);
    float top = R.z, tip = R.w;
    vec2 ctr = R.xy + (flcBig() ? 0.1 : 0.06) * vec2(sin(c.y * 1.7 + fi * 2.0), cos(c.y * 1.3 + fi)) * (top - c.y);
    float u = clamp((top - c.y) / (top - tip), 0.0, 1.0);
    float th = mix(0.075 + 0.04 * flcHash(fi + 3.0), 0.02, u);
    float dx = length(c.xz - ctr) - th;
    float dr = c.y < tip ? length(vec2(max(dx + th, 0.0), tip - c.y)) - 0.02 : dx;
    d = min(d, max(dr, c.y - top));
  }
  return d * 0.85;
}

float flcSdf(vec3 q) {
  // 浮现的前段（reveal < 0.12）只有雾罩在「长」成一团云，城本身还不出现（被那团云完全裹着之后才加进来）
  if (uWonderParams.x < 0.12) return 1e3;
  vec4 K = flcK();
  vec3 cc = flcToC(q);
  vec3 c = flcToM(cc, K);
  // 模型坐标里的距离 × 最小的放大倍数 = 真实距离的下界
  float bound = length(c - vec3(0.0, 0.1, 0.0)) - (flcBig() ? 5.6 : 5.1);
  if (bound > 0.3) return bound * K.z;
  float fp = flcFoot(cc) / K.z;
  float d = 1e9;
  float mat = 0.0;
  // 各部件只在自己的高度范围附近求值；范围外给「到部件内容真实范围」的距离（不能给到区域边界的距离：
  // 那在边界上趋于 0，追踪会把它当成命中，画出一道贯穿的水平线——v1 踩过）
  // 底座（内容在 y < 0.08：缠根的棱鼓出上沿一点）
  if (c.y < 0.35) {
    float dr = flcRock(c);
    if (dr < d) { d = dr; mat = 0.0; }
    float rr = length(c.xz);
    if (rr < 2.4) {
      float dh = flcHangRoots(c, K);
      if (dh < d) { d = dh; mat = 3.0; }
    } else d = min(d, rr - 2.25);
  } else d = c.y - 0.09;
  // 台地与残塔（内容在 y −0.05..1.95）
  if (c.y > -0.25 && c.y < 2.2) {
    float dt = flcTerraces(c);
    if (dt < d) { d = dt; mat = 1.0; }
    float dw = flcTowers(c);
    if (dw < d) { d = dw; mat = 4.0; }
  } else d = min(d, c.y < 0.0 ? -0.06 - c.y : c.y - 1.95);
  // 树冠（最低的团块约在 y = 0.4）
  if (c.y > 0.25) {
    float dc = flcCrown(c, fp);
    if (dc < d) { d = dc; mat = 2.0; }
  } else d = min(d, 0.35 - c.y);
  gWonderMat = mat;
  return d * K.z;
}

// 光路上被城挡住多少（0 = 全挡，1 = 不挡）：底座 + 台地按一个实心的椭球；树冠按椭球，里面有稀疏的缝隙
// （缝隙的图案投在「垂直于光线、过树冠中心」的平面上，所以沿光线不变：雾里就成了一道道光束）。
// withBody = false：只算树冠（表面着色用：点在台地上时自己就在「实心椭球」里面）。c、Lc 都在模型坐标里（Lc 归一化）
float flcOccl(vec3 c, vec3 Lc, bool withBody) {
  float vis = 1.0;
  if (withBody) {
    vec3 o = (c - FLC_BODY_C) / FLC_BODY_R;
    vec3 dd = Lc / FLC_BODY_R;
    float s = max(-dot(o, dd) / dot(dd, dd), 0.0);
    vis = smoothstep(0.8, 1.05, length(o + dd * s));
  }
  vec3 o = (c - FLC_CROWN_C) / FLC_CROWN_R;
  vec3 dd = Lc / FLC_CROWN_R;
  float s = max(-dot(o, dd) / dot(dd, dd), 0.0);
  float m = length(o + dd * s);
  if (m < 1.08) {
    vec3 pp = c - Lc * dot(c - FLC_CROWN_C, Lc);
    float g = textureLod(uShapeNoise, pp * 0.36 + vec3(flcSeed() * 3.3, 0.71, 0.0), 1.0).g;
    // 缝隙：中间稀、边缘多（树冠边缘的枝叶本来就疏）
    float gap = smoothstep(0.66 - 0.2 * smoothstep(0.5, 1.0, m), 0.8 - 0.2 * smoothstep(0.5, 1.0, m), g);
    vis *= mix(0.03 + 0.97 * gap, 1.0, smoothstep(0.88, 1.08, m));
  }
  return vis;
}
// 城坐标里的方向 → 模型坐标里的方向（归一化）；台地以上 / 以下的竖直倍数不同，按点在哪一侧取
vec3 flcDirToM(vec3 v, vec4 K, float my) {
  return normalize(v / vec3(K.x, my > 0.0 ? K.y : K.z, K.x));
}

// 表面着色：岩石（灰褐、带层理）、台地石（浅灰，顶面长满植被）、树冠（墨绿，逆光时边缘透光）、根（深褐）、残塔
vec3 flcShade(vec3 q, vec3 n, vec3 pW, vec3 nW, vec3 rd) {
  vec4 K = flcK();
  bool big = flcBig();
  vec3 cc = flcToC(q);
  vec3 c = flcToM(cc, K);
  vec3 nc = flcToC(n);
  float fp = flcFoot(cc) / K.z;
  float mat = gWonderMat;
  vec3 alb;
  if (mat < 0.5) {
    // 岩石：层理的明暗（按足迹淡掉），朝下的面偏暗
    float band = 0.5 + 0.5 * sin(c.y * 21.0 + 1.5 * sin(atan(c.z, c.x) * 2.0 + flcSeed() * 9.0));
    alb = vec3(0.17, 0.15, 0.13) * mix(0.8 + 0.35 * band, 0.97, smoothstep(0.03, 0.07, fp));
    // 巨构版第三级：岩面上的大块风化斑（一次纹理按足迹选 mip）
    if (big) alb *= 0.8 + 0.45 * textureLod(uShapeNoise, c * vec3(1.6, 3.0, 1.6) + 0.37, clamp(log2(max(fp, 1e-4) / 0.012), 0.0, 5.0)).g;
  } else if (mat < 1.5 || mat > 3.5) {
    // 台地 / 残塔的石头：顶面长满植被；外墙上拱廊的暗带（每层墙高的 30–75%），足迹大于拱距时取平均
    alb = vec3(0.26, 0.25, 0.22);
    float y = c.y;
    float y0 = y < 0.33 ? -0.05 : y < 0.68 ? 0.33 : y < 1.02 ? 0.68 : 1.02;
    float v = (y - y0) / 0.35;
    float wall = 1.0 - smoothstep(0.35, 0.65, abs(nc.y));
    float arch = 0.0;
    float u = atan(c.z, c.x) * length(c.xz);
    if (mat < 1.5) {
      float fu = abs(fract(u / 0.09) - 0.5);
      float open = step(fu, 0.28) * step(v, 0.72 - 0.25 * (0.28 - fu) * (0.28 - fu) * 12.0);
      open *= step(0.3, v);
      arch = mix(open, 0.45 * step(0.3, v) * step(v, 0.72), smoothstep(0.03, 0.06, fp));
    }
    alb *= 1.0 - 0.7 * arch * wall;
    if (big) {
      // 巨构版第三级：拱廊以外的墙面上一排排小窗 + 石砌层（模型 0.02 × 0.03，真实约 100 × 110 m），
      // 足迹超过约四分之一个周期就退回面积平均（远处是均匀的一层灰，不闪）
      float fu3 = abs(fract(u / 0.02) - 0.5), fv3 = abs(fract(y / 0.03) - 0.5);
      float win = step(fu3, 0.17) * step(fv3, 0.2);
      float win3 = mix(win, 0.34 * 0.4, smoothstep(0.004, 0.009, fp));
      alb *= 1.0 - 0.55 * win3 * wall * (1.0 - arch);
      // 墙面的雨痕与苔斑（中尺度纹理，远处也看得出斑驳）
      float st = textureLod(uShapeNoise, vec3(c.x * 2.2, c.y * 0.7, c.z * 2.2) + 0.61, clamp(log2(max(fp, 1e-4) / 0.012), 0.0, 5.0)).r;
      alb *= 0.78 + 0.4 * st;
    }
    float moss = smoothstep(0.45, 0.75, nc.y) + 0.35 * wall * smoothstep(0.55, 0.8, textureLod(uShapeNoise, c * 1.3, 1.0).b);
    alb = mix(alb, vec3(0.07, 0.1, 0.05), clamp(moss, 0.0, 1.0));
  } else if (mat < 2.5) {
    // 树冠：墨绿（植被反照率约 0.1，比云暗得多，远看也能和云分开）；团块之间的凹处更暗
    alb = vec3(0.05, 0.085, 0.045);
    // 巨构版第三级：一棵棵树冠的林冠纹理（模型约 0.05，真实约 250 m）按足迹选 mip，远处平均成均匀的墨绿
    if (big) {
      float tr = textureLod(uShapeNoise, c * 4.0 + vec3(0.13, 0.5, 0.29), clamp(log2(max(fp, 1e-4) / 0.006), 0.0, 5.0)).g;
      alb *= 0.6 + 0.8 * tr;
    }
  } else {
    alb = vec3(0.09, 0.075, 0.06);
  }
  float r = length(pW);
  vec3 up = pW / r;
  float cl = r - BOTTOM > uShellTop ? 1.0 : cloudShadow(pW, uKeyDir);
  vec3 key = keyLight(r, up) * cl;
  vec3 Lc = flcDirToM(flcToC(uWonderToLocal * uKeyDir), K, c.y);
  // 法线按逆转置变换：模型坐标里的法线 ∝ 城坐标法线 × K
  vec3 nm = normalize(nc * vec3(K.x, c.y > 0.0 ? K.y : K.z, K.x));
  float vis = flcOccl(c + nm * 0.06, Lc, false);
  float ndl = dot(nW, uKeyDir);
  // 树冠的枝叶层把光「包」过去一点（wrap），岩石 / 石头是朗伯
  float diff = mat > 1.5 && mat < 2.5 ? max(ndl + 0.3, 0.0) / 1.3 : max(ndl, 0.0);
  float upness = dot(nW, up);
  vec3 sky = skyIrradiance(r, up) * (0.5 + 0.5 * upness);
  // 朝下的面看到的是被照亮的云海（反照率按云量粗估，和 wonderLitSurface 同一量级）
  vec3 below = key * max(dot(up, uKeyDir), 0.0) * (0.06 + 0.5 * uCoverage) * (0.5 - 0.5 * upness);
  vec3 L = alb / M_PI * (key * vis * diff + sky + below);
  // 逆光：树冠边缘的叶子透光（亮边）。只在轮廓附近（法线接近垂直于视线）、太阳在它身后时
  if (mat > 1.5 && mat < 2.5) {
    float back = pow(max(dot(rd, uKeyDir), 0.0), 6.0);
    float edge = pow(1.0 - abs(dot(nW, rd)), 3.0);
    L += key * vis * back * edge * vec3(0.10, 0.13, 0.05) * 0.5;
  }
  // 远处再往同方向的天空色靠一些（协调者返工：80 km 外白天比周围天空暗、饱和太多，像贴上去的）。
  // 步进最后还会统一加空气透视；这里补的是「城周围湿空气」的那一层，按距离 1 − e^(−d/70 km) 取 0..0.5。
  // 巨构版按海拔分层（WONDER_SCALE §1 手法 2）：湿空气在低处，8 km 以上越往上越稀薄——冠顶比底座清楚得多
  float dist = length(q - uWonderCam);
  float haze = 0.5 * (1.0 - exp(-dist / 70.0));
  if (big) haze *= mix(0.75, 0.12, smoothstep(6.0, 26.0, q.y + FLC_BIG_BASE));
  // 往下看的视线（底座下面）不能直接查天空 LUT 的地平线以下（给出的是一团偏橙的错色）：抬到地平线（巡航高度约 −3.3°）上方一点，取地平线的霾色
  vec3 rdH = normalize(vec3(rd.x, max(rd.y, -0.045), rd.z));
  L = mix(L, skyRadiance(rdH, false), min(haze, 0.75));
  return L;
}

// ---------------- 介质：雾罩、根须帘子、瀑布、根尖云涡 ----------------
// 视线穿过雾罩椭球的区间（局部坐标里算：椭球绕 y 轴对称，不用转）。巨构版的介质散在整个包围盒里（瀑布、根尖的云涡、叶层），不收窄
vec2 flcMediumSeg(vec3 o, vec3 d, vec2 seg) {
  if (flcBig()) return seg;
  vec3 oo = (o - FLC_MIST_C) / FLC_MIST_R;
  vec3 dd = d / FLC_MIST_R;
  float a = dot(dd, dd), b = dot(oo, dd), cc = dot(oo, oo) - 1.0;
  float disc = b * b - a * cc;
  if (disc <= 0.0) return vec2(1e9, -1e9);
  float sq = sqrt(disc);
  return vec2(max((-b - sq) / a, seg.x), min((-b + sq) / a, seg.y));
}

float flcHg(float c, float g) {
  float g2 = g * g;
  return (1.0 - g2) / (4.0 * M_PI * pow(max(1.0 + g2 - 2.0 * g * c, 1e-4), 1.5));
}

// 瀑布 i：从岩石半球上沿落下（方位、有没有这一道都按种子），被风吹偏、越落越宽、落到一半散成雾。
// c 是城坐标（真实 km）；巨构版整道瀑布按 s = 2.8 放大（落差约 10 km、出水口宽约 0.3 km），3–5 道
float flcFall(vec3 c, int i, float fp, float t, vec4 K) {
  float fi = float(i);
  float S = flcSeed();
  bool big = flcBig();
  float s = big ? 2.8 : 1.0;
  float a;
  if (big) {
    if (fi >= 3.0 + floor(2.99 * flcHash(S * 61.0))) return 0.0;
    a = 6.2831853 * (fi / 5.0 + 0.12 * flcHash(fi * 9.1 + S * 33.0) + S * 3.0);
  } else {
    if (i == 1 && flcHash(S * 61.0) < 0.35) return 0.0;   // 大约三分之一的时候只有一道
    if (i > 1) return 0.0;
    a = 6.2831853 * (flcHash(fi * 9.1 + S * 33.0) + fi * 0.37);
  }
  vec2 dir = vec2(cos(a), sin(a));
  a = atan(dir.y, dir.x);   // 折回 (−π, π]：和底座上沿按方位分段的算法同一个角度（否则水从岩石里面落下来）
  float r0 = FLC_A * flcRimScale(a) * K.x + 0.04 * s;
  float drop = K.w - c.y + 0.05 * s;
  if (drop < 0.0 || drop > 3.6 * s) return 0.0;
  float dn = drop / s;
  // 抛出去一点 + 顺风吹偏（风向随种子）
  float wa = S * 17.0;
  vec2 wind = vec2(cos(wa), sin(wa));
  vec2 ax = dir * (r0 + s * 0.12 * sqrt(dn)) + wind * (s * 0.09 * dn * dn);
  float w = s * (0.05 + 0.12 * dn + 0.07 * dn * dn);
  float we = max(w, 1.5 * fp);
  vec2 dx = c.xz - ax;
  float g = exp(-dot(dx, dx) / (we * we));
  if (g < 1e-3) return 0.0;
  // 水量守恒：截面越宽越稀；落下去一路蒸发成雾（1.2 km 以后很快淡掉）
  // 巨构版蒸发慢一些、雾团淡一半：十公里的水柱要从头到尾看得出是一道「水」，化雾的部分不能成一朵遮住半座城的积云（v1 截图）
  float sig = 30.0 * (0.05 * 0.05) * s / (we * we) * exp(-dn / (big ? 2.0 : 1.3));
  // 雾化的部分：比守恒的多一团（水花被风打散成的雾），在 0.6–2.5 km 处
  sig += (big ? 0.25 : 0.5) * smoothstep(0.3, 1.0, dn) * smoothstep(3.2, 1.6, dn) * (0.35 / we);
  // 下落的水团：纹理沿 y 往下流（周期整除 3600 s，时间回绕不跳）
  vec4 nz = textureLod(uShapeNoise, vec3(c.x * 0.9 / s, (c.y - K.w) * 0.6 / s + t * (72.0 / 3600.0), c.z * 0.9 / s) + fi * 0.37, 1.0);
  sig *= 0.45 + 1.1 * nz.r;
  return sig * g;
}

// 巨构版：垂进云海的粗根在根尖搅起的云涡（扁的一团，顺风拖长；按一次纹理成团）。c 城坐标，返回消光（1/km）
float flcRootWisp(vec3 c, vec4 K, float t) {
  float S = flcSeed();
  float wa = S * 17.0;
  vec2 wind = vec2(cos(wa), sin(wa));
  float sig = 0.0;
  for (int i = 0; i < 7 + min(uStormCount, 0); i++) {
    vec4 R = flcRootDef(i, K);
    float tipY = K.w + R.w * K.z;
    if (tipY + FLC_BIG_BASE > 3.2) continue;   // 在半空断掉的根没有云涡
    vec2 ctr = R.xy * K.x;
    vec3 e = c - vec3(ctr.x, tipY + 0.35, ctr.y);
    // 顺风拖出去：下风一侧拉长
    float along = dot(e.xz, wind);
    e.xz -= wind * (0.55 * max(along, 0.0));
    vec3 en = e / vec3(1.9, 0.75, 1.9);
    float h = 1.0 - dot(en, en);
    if (h <= 0.0) continue;
    vec4 n = textureLod(uShapeNoise, c * 0.35 + vec3(t * (6.0 / 3600.0), 0.0, float(i) * 0.31) + S * 2.3, 0.0);
    sig += 1.1 * smoothstep(0.5, 0.85, 0.6 * h + 0.55 * n.r + 0.3 * n.g);
  }
  return sig;
}

float flcMedium(vec3 q, out vec3 albedo, out vec3 emit) {
  albedo = vec3(0.0);
  emit = vec3(0.0);
  vec4 K = flcK();
  bool big = flcBig();
  vec3 c = flcToC(q);
  vec3 m = flcToM(c, K);
  // 雾罩：小岛版是局部坐标里的椭球；巨构版是模型坐标里的球（中心 y = 0.2、半径 4）
  vec3 e = big ? (m - vec3(0.0, 0.2, 0.0)) / FLC_BIG_MR : (q - FLC_MIST_C) / FLC_MIST_R;
  float pr = 1.0 - dot(e, e);           // 雾罩里：中心 1、边缘 0
  float S = flcSeed();
  float rev = uWonderParams.x;
  float t = uWonderParams.y;
  float fpR = flcFoot(c);
  float fp = fpR / K.z;
  // 根尖的云涡在雾罩以外（云海顶上），先算
  float sWisp = 0.0;
  if (big && c.y + FLC_BIG_BASE < 5.2 && rev > 0.2) sWisp = flcRootWisp(c, K, t) * smoothstep(0.2, 0.5, rev);
  // 巨构版不按雾罩早退：瀑布雾顺风吹出去可能出了雾罩球，按球截会切出硬边；各部件自己都有解析的范围判断
  if (pr <= 0.0 && !big) return 0.0;
  pr = max(pr, 0.0);
  float fade = 1.0 - smoothstep(0.2, 0.7, rev);
  // 雾：一次形状噪声（缓慢飘移，周期整除 3600 s）
  vec4 n = vec4(0.5);
  if (!big || fade > 0.0) n = textureLod(uShapeNoise, m * 0.16 + vec3(t * (2.0 / 3600.0), 0.0, 0.0) + S * 3.1, 0.0);
  // 整个雾罩里极薄的一层（逆光时被城挡出暗的楔形、从树冠缝隙漏下的光成一道道光束），往边缘平滑地淡到 0（不留圆盘的边）。
  // 巨构版不要：40 km 宽的雾罩逆光时是一圈光晕、把整座城蒙成蓝灰（v1 截图），城周围的空气交给大气本身的空气透视；
  // 光束在 100 km 外本来就只有十来像素（README 坑点），省下的是每一步一次纹理
  float sVeil = big ? 0.0 : 0.025 * pr * pr * (0.3 + 1.4 * n.g);
  // 贴在底座下面的云团（像城底下挂着的一圈云，不是一圈竖直的雾墙）：底座下方的椭球里，按一次较细的噪声成团
  vec3 es = (m - vec3(-1.3, -1.3, 0.9)) / vec3(3.0, 1.3, 2.6);
  float hs = 1.0 - dot(es, es);
  float sSkirt = 0.0;
  if (hs > 0.0) {
    vec4 ns = textureLod(uShapeNoise, m * 0.42 + vec3(t * (4.0 / 3600.0), 0.0, 0.0) + S * 7.7, 0.0);
    sSkirt = 0.45 * smoothstep(0.66, 0.9, 0.55 * hs + 0.55 * ns.r + 0.25 * ns.g);
  }
  // 树冠外沿的叶层：离树冠表面 0–0.18 km 的一层稀疏「叶雾」（远看轮廓毛茸茸的，逆光时被照透成一圈亮边）
  float sLeaf = 0.0;
  vec3 ec = (m - FLC_CROWN_C) / FLC_CROWN_R;
  float mc = length(ec);
  // 巨构版不要：放大 5 倍后叶层厚约 0.8 km、噪声斑块几 km，远看是树冠上一块块发亮的霉斑（v1 截图）；林冠的细节改在表面着色里
  if (!big && mc > 0.6 && mc < 1.2 && m.y > 1.0) {
    float dcw = flcCrown(m, fp);
    if (dcw > -0.05 && dcw < 0.2) {
      vec4 nl = textureLod(uShapeNoise, m * 0.6 + vec3(0.5, S * 4.0, 0.2), 1.0);
      sLeaf = 2.5 * smoothstep(0.2, 0.02, dcw) * smoothstep(0.2, 0.9, nl.g);
    }
  }
  sVeil += sSkirt;
  // 浮现：一团形状不太对劲的云，先从中心长出来（reveal 0 → 0.1），再在 0.15 → 0.85 里散掉；退场反过来
  float grow = smoothstep(0.0, 0.1, rev);
  // 云的形状：包住整座城的球（半径约 4.8 km）+ 噪声，噪声只在外沿起作用（里面一定是实的，城被整个裹住），外沿成团、不是光滑的蛋
  // 外形再加一次很低频的起伏（整团云歪向一边、底部偏平），免得是一个正圆的球。巨构版收小一点，装进包围盒
  float sThick = 0.0;
  if (fade > 0.0) {
    vec4 nb = textureLod(uShapeNoise, m * 0.06 + vec3(S * 2.9, 0.4, 0.1), 0.0);
    vec3 er = big ? vec3(3.7, 3.7, 3.6) : vec3(5.3, 4.6, 5.0);
    vec3 ei = (m - vec3(0.0, 0.3, 0.0)) / vec3(er.x + 1.2 * (nb.g - 0.5), er.y, er.z + 1.2 * (nb.b - 0.5));
    ei.y *= m.y < 0.0 ? 1.12 : 1.0;
    float pi = 1.0 - dot(ei, ei) + 0.35 * (nb.r - 0.5);
    float C = (pi + (0.6 * (n.r - 0.5) + 0.45 * (n.g - 0.5)) * (1.2 - pi)) * smoothstep(-0.25, 0.1, pi);
    float thr = mix(1.05, 0.05, grow);
    sThick = 6.0 * smoothstep(thr, thr + 0.15, C) * fade;
  }
  // 根须的帘子：底座下面、按水平位置的一次纹理立起来的一根根细柱（纹理与 y 无关），长短不齐
  float sRoot = 0.0;
  float rr = length(m.xz);
  if (rr < FLC_A * 0.97 && m.y < 0.0) {
    float yd = -FLC_B * sqrt(max(1.0 - rr * rr / (FLC_A * FLC_A), 0.0));
    vec4 nr = textureLod(uShapeNoise, vec3(m.x * 1.1, 0.21 + S, m.z * 1.1), clamp(log2(max(fp, 1e-3) / 0.008), 0.0, 4.0));
    float len = 0.25 + 1.1 * nr.a * smoothstep(3.0, 0.8, rr);
    float strands = smoothstep(0.45, 0.72, nr.b);
    sRoot = 2.2 * strands * smoothstep(yd - len, yd - 0.6 * len, m.y) * step(m.y, yd + 0.02) / (big ? 2.0 : 1.0);
  }
  // 瀑布
  float sFall = 0.0;
  if (rev > 0.2) {
    for (int i = 0; i < 5 + min(uStormCount, 0); i++) sFall += flcFall(c, i, fpR, t, K);
    sFall *= smoothstep(0.2, 0.45, rev);
  }
  float sig = sVeil + sThick + sRoot + sFall + sLeaf + sWisp;
  if (sig <= 1e-5) return 0.0;
  vec3 alb = (0.92 * (sVeil + sThick + sWisp) + vec3(0.1, 0.085, 0.07) * sRoot + 0.96 * sFall + vec3(0.16, 0.22, 0.08) * sLeaf) / sig;

  // 受光（自己算，见文件头）：主光源 × 被城挡掉的部分（树冠缝隙成光束）× 雾罩自己的影子（多次散射近似）+ 天光 + 云海反光
  vec3 pW = transpose(uWonderToLocal) * (q - uWonderCam) + vec3(0.0, uCamR, 0.0);
  float r = length(pW);
  vec3 up = pW / r;
  vec3 Ll = uWonderToLocal * uKeyDir;
  vec3 Lm = flcDirToM(flcToC(Ll), K, m.y);
  // 城挡光：城还没出现（reveal < 0.12）时不挡；浮现时那团厚云里多次散射把影子抹平（按这一点厚云的消光淡掉）
  float vis = rev < 0.12 ? 1.0 : mix(1.0, flcOccl(m, Lm, true), exp(-0.6 * sThick));
  // 雾罩自己的影子：到雾罩边缘（朝光源）的弦长 × 这一点的「云」的消光（薄雾的那部分忽略）。巨构版的弦长按模型坐标算再乘放大倍数
  vec3 dd = big ? Lm / FLC_BIG_MR : Ll / FLC_MIST_R;
  float a2 = dot(dd, dd), b2 = dot(e, dd);
  float chord = (-b2 + sqrt(max(b2 * b2 + a2 * pr, 0.0))) / a2 * (big ? K.y : 1.0);
  float tau = (sThick + 0.3 * sVeil) * chord * 0.5 + sWisp * 0.6;
  float cosT = dot(normalize(q - uWonderCam), Ll);
  float ph = 0.0, aa = 1.0, cg = 1.0, bt = 1.0;
  for (int k = 0; k < 3 + min(uStormCount, 0); k++) {
    ph += aa * exp(-bt * tau) * mix(flcHg(cosT, -0.25 * cg), flcHg(cosT, 0.8 * cg), 0.7);
    aa *= 0.6; cg *= 0.5; bt *= 0.25;
  }
  vec3 key = keyLight(r, up);
  // 根尖的云涡在云海顶上：也受云影（和云海同一套），不然在阴天的云海上是一团团发亮的棉花
  if (sWisp > 0.0) key *= r - BOTTOM > uShellTop ? 1.0 : cloudShadow(pW, uKeyDir);
  vec3 light = key * vis * ph + skyIrradiance(r, up) / (2.0 * M_PI)
             + key * max(dot(up, uKeyDir), 0.0) * (0.06 + 0.5 * uCoverage) / (2.0 * M_PI);
  emit = sig * alb * light;
  return sig;
}

// 巨构版的尺度参照：一架和我们同高度（10.9–11.7 km）的航班从城下飞过，拖着一道航迹云。
// 航迹云 = 沿直线的高斯管，视线与它的最近点处按闭式线积分给光学厚度（τ ≈ τ⊥ · e^(−r²/w²) / sinθ），
// 宽度随「离飞机的时间」变宽（0.04 km + 3.5 m/s），足迹比管细时按能量守恒展宽（远处不闪）。
// 450 s 一趟（周期整除 3600 s），在包围盒边缘 17–23 km 淡出，一趟快结束时整道淡掉（下一趟从另一头重新出现）
vec4 flcContrail(vec3 o, vec3 d, vec2 seg, float pixAng) {
  float S = flcSeed();
  float t = uWonderParams.y;
  float ca = 6.2831853 * flcHash(S * 91.0 + 0.7);
  vec3 A = vec3(cos(ca), 0.0, sin(ca));
  vec3 N = vec3(-A.z, 0.0, A.x);
  vec4 K = flcK();
  float off = (0.25 + 0.45 * flcHash(S * 53.0 + 1.1)) * 3.0 * K.x * (flcHash(S * 29.0 + 4.4) > 0.5 ? 1.0 : -1.0);
  vec3 P0 = N * off + vec3(0.0, 10.9 + 0.8 * flcHash(S * 67.0 + 2.2) - FLC_BIG_BASE, 0.0);
  float ph = fract(t / 450.0 + flcHash(S * 11.0 + 0.3));
  float sPlane = -60.0 + 120.0 * ph;
  float v = 120.0 / 450.0;
  vec3 w0 = o - P0;
  float b = dot(d, A);
  float den = max(1.0 - b * b, 1e-4);
  float dw = dot(d, w0), ew = dot(A, w0);
  float tr = (b * ew - dw) / den;
  float sl = (ew - b * dw) / den;
  if (tr < seg.x || tr > seg.y) return vec4(0.0, 0.0, 0.0, 1e9);
  float age = (sPlane - sl) / v;
  if (age < 2.0) return vec4(0.0, 0.0, 0.0, 1e9);
  vec3 X = o + d * tr, Y = P0 + A * sl;
  vec3 dv = X - Y;
  float wd = 0.04 + 0.0035 * age;
  float fpx = tr * pixAng;
  float we2 = wd * wd + fpx * fpx;
  float sinT = max(sqrt(den), 0.2);
  // 断续：真实的航迹云在干湿不均的空气里一段浓一段淡
  float patchy = 0.55 + 0.45 * sin(sl * 0.37 + S * 40.0) * sin(sl * 0.11 + 1.3);
  float tau = 0.35 * patchy * exp(-age / 420.0) * smoothstep(2.0, 12.0, age) * (wd / sqrt(we2)) * exp(-dot(dv, dv) / we2) / sinT;
  tau *= smoothstep(23.0, 17.0, length(Y.xz)) * smoothstep(60.0, 45.0, sPlane) * smoothstep(0.5, 0.8, uWonderParams.x);
  if (tau < 1e-4) return vec4(0.0, 0.0, 0.0, 1e9);
  vec3 pW = transpose(uWonderToLocal) * (X - uWonderCam) + vec3(0.0, uCamR, 0.0);
  float r = length(pW);
  vec3 up = pW / r;
  vec3 Ll = uWonderToLocal * uKeyDir;
  float cosT = dot(d, Ll);
  // 冰晶：强前向散射；天光 + 云海反光
  vec3 light = keyLight(r, up) * mix(flcHg(cosT, -0.2), flcHg(cosT, 0.85), 0.6) + skyIrradiance(r, up) / (2.0 * M_PI)
             + keyLight(r, up) * max(dot(up, uKeyDir), 0.0) * (0.06 + 0.5 * uCoverage) / (2.0 * M_PI);
  return vec4(0.95 * (1.0 - exp(-tau)) * light, tr);
}

// 夜里岩锥尖上一点极淡的青色微光（致敬「飞行石」）：点光，半径按像素足迹展宽、总能量不变；
// 亮度约无月夜天光的几十倍（2e-6 kcd/m² 量级），白天完全淹没在天光里
void flcRay(vec3 o, vec3 d, vec2 seg, float pixAng, out vec4 e0, out vec4 e1, out vec4 e2) {
  e0 = vec4(0.0, 0.0, 0.0, 1e9);
  e1 = e0;
  e2 = e0;
  if (flcBig()) e1 = flcContrail(o, d, seg, pixAng);
  if (uWonderParams.x < 0.8) return;
  vec4 K = flcK();
  vec3 co = flcToC(o), cd = flcToC(d);
  vec3 p = vec3(0.0, K.w - 2.72 * K.z, 0.0);
  float tc = dot(p - co, cd);
  if (tc < seg.x || tc > seg.y) return;
  vec3 dv = co + cd * tc - p;
  float r = 0.06 * K.x;
  float fpx = 0.7 * tc * pixAng;
  float re2 = r * r + fpx * fpx;
  float pulse = 0.75 + 0.25 * sin(uWonderParams.y * (6.2831853 * 3.0 / 3600.0) * 20.0);
  vec3 L = vec3(0.3, 0.75, 1.0) * 4e-6 * pulse * (r * r / re2) * exp(-dot(dv, dv) / re2);
  // 软封顶：只有夜里才看得见，别在任何时候截成白点
  float l = dot(L, vec3(0.2126, 0.7152, 0.0722));
  e0 = vec4(L * (1e-5 / (1e-5 + l)), tc);
}
`;
