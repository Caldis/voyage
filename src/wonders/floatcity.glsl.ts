/**
 * 浮空古城（W03，致敬宫崎骏《天空之城》；原创造型，不用任何官方资产）。云间层奇观，接口见 wonder-cloud.glsl.ts / handoff/W00.md。
 * 设计依据 research/WONDERS.md §2.2（记忆点）、A1、§6.3。
 *
 * 画面：云海之上远处悬着一座古城——顶上一团墨绿的巨树树冠（像一朵不会动的「绿云」），树冠下层层收窄的圆形台地（外墙上是
 * 拱廊的暗带、几座残塔），最下面是倒扣的岩石半球 + 正中往下突出的岩锥，粗根从台地之间缠下来、绕过底座，在城下垂成根须
 * （粗根是表面，细根须是一道透光的「帘子」介质）；城边一两道细瀑布，落到一半就散成被风吹偏的雾；城身周围一层薄雾罩，
 * 逆光时穿过树冠缝隙的光在雾里成一道道光束，城的影子投在下方云海上（投影椭球，W00）。
 * 浮现：先是一团形状不太对劲的「云」（雾罩），约一分钟里雾变薄，台地和根须从雾里显出来；退场反过来被雾吞没。
 *
 * 坐标：奇观局部坐标（km，x 东、y 天顶、z 南，原点在台地底面 = 岩石半球的上沿，catalog 的 baseKm = 海拔 7.5 km），
 * 再按本次出现的随机种子（uWonderParams.z）绕 y 轴转一个角度 = 「城坐标」；台地的偏心、残塔、粗根、瀑布位置、
 * 树冠的团块也都由种子决定：每次出现都不一样（随机性造就真实）。
 *
 * 分工（各函数只有一个调用点，由 wonder-cloud.glsl.ts 的分派函数调用）：
 *  - flcSdf / flcShade：岩石底座 + 缠根的棱、台地与残塔、巨树树冠、垂下的粗根（表面）；
 *  - flcMedium：雾罩（含浮现时的「云」）、细根须的帘子、瀑布化雾。受光全部自己算（反照率返回 0，放进 emit）：
 *    要让雾里的光被**树冠的缝隙**切成光束，而标准受光只有一个平滑的投影椭球；
 *  - flcMediumSeg：介质只在雾罩椭球里步进；
 *  - flcRay：夜里底部岩锥里一点极淡的青色微光（致敬「飞行石」，白天完全看不见）。
 *
 * 亮度：全是受光的物体（反照率 5–25%，雾 / 瀑布 0.9 和云一样），和旁边的云同一套光照与相函数，不会比同条件下的云更亮；
 * 唯一的自发光（微光）按「无月夜天光的几十倍」定量、软封顶。
 */

export const FLOATCITY_GLSL = /* glsl */ `
const float FLC_A = 3.0;          // 岩石半球的水平半径（km）
const float FLC_B = 1.45;         // 岩石半球的深度
const vec3 FLC_MIST_C = vec3(0.0, -0.1, 0.0);   // 雾罩椭球（局部 / 城坐标都一样：绕 y 轴对称）
const vec3 FLC_MIST_R = vec3(6.2, 5.6, 6.2);
const vec3 FLC_CROWN_C = vec3(1.0, 2.2, 0.35);  // 主冠层中心（城坐标，偏向 +x）；冠层的大致椭球（光束、叶层用）
const vec3 FLC_CROWN_R = vec3(2.9, 1.3, 2.0);
const vec3 FLC_BODY_C = vec3(0.0, -0.2, 0.0);   // 台地 + 底座的大致椭球（光束用）
const vec3 FLC_BODY_R = vec3(3.0, 1.7, 3.0);

float flcHash(float p) {
  p = fract(p * 0.1031);
  p *= p + 33.33;
  p *= p + p;
  return fract(p);
}
float flcSeed() { return uWonderParams.z; }
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
// 离相机的距离对应的像素足迹（km，全分辨率）
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
  }
  // 主干：从台地顶上斜着长向冠层
  float trunk = flcCone(c - vec3(0.75 + 0.25 * (c.y - 1.5), 1.55, 0.3), 0.55, 0.55, 0.3);
  return min(d * 0.6, trunk);
}
// 垂下的粗根：7 条从底座下面垂下来的竖根，越往下越细，轻微摆动
float flcHangRoots(vec3 c) {
  float d = 1e9;
  float S = flcSeed();
  for (int i = 0; i < 7 + min(uStormCount, 0); i++) {
    float fi = float(i);
    float a = 6.2831853 * (fi / 7.0 + 0.1 * flcHash(fi + S * 3.7)) + S * 50.0;
    float rh = 0.3 + 1.55 * flcHash(fi * 2.7 + S * 9.0);
    float tip = -2.3 - 1.5 * flcHash(fi * 5.3 + S * 4.0) - 0.4 * smoothstep(1.5, 0.3, rh);
    float top = -FLC_B * sqrt(max(1.0 - rh * rh / (FLC_A * FLC_A), 0.0)) + 0.1;
    vec2 ctr = rh * vec2(cos(a), sin(a));
    ctr += 0.06 * vec2(sin(c.y * 1.7 + fi * 2.0), cos(c.y * 1.3 + fi)) * (top - c.y);
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
  vec3 c = flcToC(q);
  float bound = length(c - vec3(0.0, 0.1, 0.0)) - 5.1;
  if (bound > 0.3) return bound;
  float fp = flcFoot(c);
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
      float dh = flcHangRoots(c);
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
  return d;
}

// 光路上被城挡住多少（0 = 全挡，1 = 不挡）：底座 + 台地按一个实心的椭球；树冠按椭球，里面有稀疏的缝隙
// （缝隙的图案投在「垂直于光线、过树冠中心」的平面上，所以沿光线不变：雾里就成了一道道光束）。
// withBody = false：只算树冠（表面着色用：点在台地上时自己就在「实心椭球」里面）
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

// 表面着色：岩石（灰褐、带层理）、台地石（浅灰，顶面长满植被）、树冠（墨绿，逆光时边缘透光）、根（深褐）、残塔
vec3 flcShade(vec3 q, vec3 n, vec3 pW, vec3 nW, vec3 rd) {
  vec3 c = flcToC(q);
  vec3 nc = flcToC(n);
  float fp = flcFoot(c);
  float mat = gWonderMat;
  vec3 alb;
  if (mat < 0.5) {
    // 岩石：层理的明暗（按足迹淡掉），朝下的面偏暗
    float band = 0.5 + 0.5 * sin(c.y * 21.0 + 1.5 * sin(atan(c.z, c.x) * 2.0 + flcSeed() * 9.0));
    alb = vec3(0.17, 0.15, 0.13) * mix(0.8 + 0.35 * band, 0.97, smoothstep(0.03, 0.07, fp));
  } else if (mat < 1.5 || mat > 3.5) {
    // 台地 / 残塔的石头：顶面长满植被；外墙上拱廊的暗带（每层墙高的 30–75%），足迹大于拱距时取平均
    alb = vec3(0.26, 0.25, 0.22);
    float y = c.y;
    float y0 = y < 0.33 ? -0.05 : y < 0.68 ? 0.33 : y < 1.02 ? 0.68 : 1.02;
    float v = (y - y0) / 0.35;
    float wall = 1.0 - smoothstep(0.35, 0.65, abs(nc.y));
    float arch = 0.0;
    if (mat < 1.5) {
      float u = atan(c.z, c.x) * length(c.xz) / 0.09;
      float fu = abs(fract(u) - 0.5);
      float open = step(fu, 0.28) * step(v, 0.72 - 0.25 * (0.28 - fu) * (0.28 - fu) * 12.0);
      open *= step(0.3, v);
      arch = mix(open, 0.45 * step(0.3, v) * step(v, 0.72), smoothstep(0.03, 0.06, fp));
    }
    alb *= 1.0 - 0.7 * arch * wall;
    float moss = smoothstep(0.45, 0.75, nc.y) + 0.35 * wall * smoothstep(0.55, 0.8, textureLod(uShapeNoise, c * 1.3, 1.0).b);
    alb = mix(alb, vec3(0.07, 0.1, 0.05), clamp(moss, 0.0, 1.0));
  } else if (mat < 2.5) {
    // 树冠：墨绿（植被反照率约 0.1，比云暗得多，远看也能和云分开）；团块之间的凹处更暗
    alb = vec3(0.05, 0.085, 0.045);
  } else {
    alb = vec3(0.09, 0.075, 0.06);
  }
  float r = length(pW);
  vec3 up = pW / r;
  float cl = r - BOTTOM > uShellTop ? 1.0 : cloudShadow(pW, uKeyDir);
  vec3 key = keyLight(r, up) * cl;
  vec3 Lc = flcToC(uWonderToLocal * uKeyDir);
  float vis = flcOccl(c + nc * 0.06, Lc, false);
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
  // 步进最后还会统一加空气透视；这里补的是「城周围湿空气」的那一层，按距离 1 − e^(−d/70 km) 取 0..0.5
  float dist = length(q - uWonderCam);
  // 往下看的视线（底座下面）不能直接查天空 LUT 的地平线以下（给出的是一团偏橙的错色）：抬到地平线（巡航高度约 −3.3°）上方一点，取地平线的霾色
  vec3 rdH = normalize(vec3(rd.x, max(rd.y, -0.045), rd.z));
  L = mix(L, skyRadiance(rdH, false), 0.5 * (1.0 - exp(-dist / 70.0)));
  return L;
}

// ---------------- 介质：雾罩、根须帘子、瀑布 ----------------
// 视线穿过雾罩椭球的区间（局部坐标里算：椭球绕 y 轴对称，不用转）
vec2 flcMediumSeg(vec3 o, vec3 d, vec2 seg) {
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

// 瀑布 i：从岩石半球上沿落下（方位、有没有这一道都按种子），被风吹偏、越落越宽、落到一半散成雾
float flcFall(vec3 c, int i, float fp, float t) {
  float fi = float(i);
  float S = flcSeed();
  if (i == 1 && flcHash(S * 61.0) < 0.35) return 0.0;   // 大约三分之一的时候只有一道
  float a = 6.2831853 * (flcHash(fi * 9.1 + S * 33.0) + fi * 0.37);
  vec2 dir = vec2(cos(a), sin(a));
  a = atan(dir.y, dir.x);   // 折回 (−π, π]：和底座上沿按方位分段的算法同一个角度（否则水从岩石里面落下来）
  float r0 = FLC_A * flcRimScale(a) + 0.04;
  float drop = -c.y + 0.05;
  if (drop < 0.0 || drop > 3.6) return 0.0;
  // 抛出去一点 + 顺风吹偏（风向随种子）
  float wa = S * 17.0;
  vec2 wind = vec2(cos(wa), sin(wa));
  vec2 ax = dir * (r0 + 0.12 * sqrt(drop)) + wind * (0.09 * drop * drop);
  float w = 0.05 + 0.12 * drop + 0.07 * drop * drop;
  float we = max(w, 1.5 * fp);
  vec2 dx = c.xz - ax;
  float g = exp(-dot(dx, dx) / (we * we));
  if (g < 1e-3) return 0.0;
  // 水量守恒：截面越宽越稀；落下去一路蒸发成雾（1.2 km 以后很快淡掉）
  float sig = 30.0 * (0.05 * 0.05) / (we * we) * exp(-drop / 1.3);
  // 雾化的部分：比守恒的多一团（水花被风打散成的雾），在 0.6–2.5 km 处
  sig += 0.5 * smoothstep(0.3, 1.0, drop) * smoothstep(3.2, 1.6, drop) * (0.35 / we);
  // 下落的水团：纹理沿 y 往下流（周期整除 3600 s，时间回绕不跳）
  vec4 nz = textureLod(uShapeNoise, vec3(c.x * 0.9, c.y * 0.6 + t * (72.0 / 3600.0), c.z * 0.9) + fi * 0.37, 1.0);
  sig *= 0.45 + 1.1 * nz.r;
  return sig * g;
}

float flcMedium(vec3 q, out vec3 albedo, out vec3 emit) {
  albedo = vec3(0.0);
  emit = vec3(0.0);
  vec3 e = (q - FLC_MIST_C) / FLC_MIST_R;
  float pr = 1.0 - dot(e, e);           // 雾罩里：中心 1、边缘 0
  if (pr <= 0.0) return 0.0;
  vec3 c = flcToC(q);
  float S = flcSeed();
  float rev = uWonderParams.x;
  float t = uWonderParams.y;
  float fp = flcFoot(c);
  // 雾：一次形状噪声（缓慢飘移，周期整除 3600 s）
  vec4 n = textureLod(uShapeNoise, c * 0.16 + vec3(t * (2.0 / 3600.0), 0.0, 0.0) + S * 3.1, 0.0);
  // 整个雾罩里极薄的一层（逆光时被城挡出暗的楔形、从树冠缝隙漏下的光成一道道光束），往边缘平滑地淡到 0（不留圆盘的边）
  float sVeil = 0.025 * pr * pr * (0.3 + 1.4 * n.g);
  // 贴在底座下面的云团（像城底下挂着的一圈云，不是一圈竖直的雾墙）：底座下方的椭球里，按一次较细的噪声成团
  vec3 es = (c - vec3(-1.3, -1.3, 0.9)) / vec3(3.0, 1.3, 2.6);
  float hs = 1.0 - dot(es, es);
  float sSkirt = 0.0;
  if (hs > 0.0) {
    vec4 ns = textureLod(uShapeNoise, c * 0.42 + vec3(t * (4.0 / 3600.0), 0.0, 0.0) + S * 7.7, 0.0);
    sSkirt = 0.45 * smoothstep(0.66, 0.9, 0.55 * hs + 0.55 * ns.r + 0.25 * ns.g);
  }
  // 树冠外沿的叶层：离树冠表面 0–0.18 km 的一层稀疏「叶雾」（远看轮廓毛茸茸的，逆光时被照透成一圈亮边）
  float sLeaf = 0.0;
  vec3 ec = (c - FLC_CROWN_C) / FLC_CROWN_R;
  float mc = length(ec);
  if (mc > 0.6 && mc < 1.2 && c.y > 1.0) {
    float dcw = flcCrown(c, fp);
    if (dcw > -0.05 && dcw < 0.2) {
      vec4 nl = textureLod(uShapeNoise, c * 0.6 + vec3(0.5, S * 4.0, 0.2), 1.0);
      sLeaf = 2.5 * smoothstep(0.2, 0.02, dcw) * smoothstep(0.2, 0.9, nl.g);
    }
  }
  sVeil += sSkirt;
  // 浮现：一团形状不太对劲的云，先从中心长出来（reveal 0 → 0.1），再在 0.15 → 0.85 里散掉；退场反过来
  float grow = smoothstep(0.0, 0.1, rev);
  float fade = 1.0 - smoothstep(0.2, 0.7, rev);
  // 云的形状：包住整座城的球（半径约 4.8 km）+ 噪声，噪声只在外沿起作用（里面一定是实的，城被整个裹住），外沿成团、不是光滑的蛋
  // 外形再加一次很低频的起伏（整团云歪向一边、底部偏平），免得是一个正圆的球
  float sThick = 0.0;
  if (fade > 0.0) {
    vec4 nb = textureLod(uShapeNoise, c * 0.06 + vec3(S * 2.9, 0.4, 0.1), 0.0);
    vec3 ei = (c - vec3(0.0, 0.3, 0.0)) / vec3(5.3 + 1.2 * (nb.g - 0.5), 4.6, 5.0 + 1.2 * (nb.b - 0.5));
    ei.y *= c.y < 0.0 ? 1.12 : 1.0;
    float pi = 1.0 - dot(ei, ei) + 0.35 * (nb.r - 0.5);
    float C = (pi + (0.6 * (n.r - 0.5) + 0.45 * (n.g - 0.5)) * (1.2 - pi)) * smoothstep(-0.25, 0.1, pi);
    float thr = mix(1.05, 0.05, grow);
    sThick = 6.0 * smoothstep(thr, thr + 0.15, C) * fade;
  }
  // 根须的帘子：底座下面、按水平位置的一次纹理立起来的一根根细柱（纹理与 y 无关），长短不齐
  float sRoot = 0.0;
  float rr = length(c.xz);
  if (rr < FLC_A * 0.97 && c.y < 0.0) {
    float yd = -FLC_B * sqrt(max(1.0 - rr * rr / (FLC_A * FLC_A), 0.0));
    vec4 nr = textureLod(uShapeNoise, vec3(c.x * 1.1, 0.21 + S, c.z * 1.1), clamp(log2(max(fp, 1e-3) / 0.008), 0.0, 4.0));
    float len = 0.25 + 1.1 * nr.a * smoothstep(3.0, 0.8, rr);
    float strands = smoothstep(0.45, 0.72, nr.b);
    sRoot = 2.2 * strands * smoothstep(yd - len, yd - 0.6 * len, c.y) * step(c.y, yd + 0.02);
  }
  // 瀑布
  float sFall = 0.0;
  if (rev > 0.2) {
    for (int i = 0; i < 2 + min(uStormCount, 0); i++) sFall += flcFall(c, i, fp, t);
    sFall *= smoothstep(0.2, 0.45, rev);
  }
  float sig = sVeil + sThick + sRoot + sFall + sLeaf;
  if (sig <= 1e-5) return 0.0;
  vec3 alb = (0.92 * (sVeil + sThick) + vec3(0.1, 0.085, 0.07) * sRoot + 0.96 * sFall + vec3(0.16, 0.22, 0.08) * sLeaf) / sig;

  // 受光（自己算，见文件头）：主光源 × 被城挡掉的部分（树冠缝隙成光束）× 雾罩自己的影子（多次散射近似）+ 天光 + 云海反光
  vec3 pW = transpose(uWonderToLocal) * (q - uWonderCam) + vec3(0.0, uCamR, 0.0);
  float r = length(pW);
  vec3 up = pW / r;
  vec3 Ll = uWonderToLocal * uKeyDir;
  vec3 Lc = flcToC(Ll);
  // 城挡光：城还没出现（reveal < 0.12）时不挡；浮现时那团厚云里多次散射把影子抹平（按这一点厚云的消光淡掉）
  float vis = rev < 0.12 ? 1.0 : mix(1.0, flcOccl(c, Lc, true), exp(-0.6 * sThick));
  // 雾罩自己的影子：到雾罩边缘（朝光源）的弦长 × 这一点的「云」的消光（薄雾的那部分忽略）
  vec3 dd = Ll / FLC_MIST_R;
  float a2 = dot(dd, dd), b2 = dot(e, dd);
  float chord = (-b2 + sqrt(max(b2 * b2 + a2 * pr, 0.0))) / a2;
  float tau = (sThick + 0.3 * sVeil) * chord * 0.5;
  float cosT = dot(normalize(q - uWonderCam), Ll);
  float ph = 0.0, aa = 1.0, cg = 1.0, bt = 1.0;
  for (int k = 0; k < 3 + min(uStormCount, 0); k++) {
    ph += aa * exp(-bt * tau) * mix(flcHg(cosT, -0.25 * cg), flcHg(cosT, 0.8 * cg), 0.7);
    aa *= 0.6; cg *= 0.5; bt *= 0.25;
  }
  vec3 key = keyLight(r, up);
  vec3 light = key * vis * ph + skyIrradiance(r, up) / (2.0 * M_PI)
             + key * max(dot(up, uKeyDir), 0.0) * (0.06 + 0.5 * uCoverage) / (2.0 * M_PI);
  emit = sig * alb * light;
  return sig;
}

// 夜里岩锥尖上一点极淡的青色微光（致敬「飞行石」）：点光，半径按像素足迹展宽、总能量不变；
// 亮度约无月夜天光的几十倍（2e-6 kcd/m² 量级），白天完全淹没在天光里
void flcRay(vec3 o, vec3 d, vec2 seg, float pixAng, out vec4 e0, out vec4 e1, out vec4 e2) {
  e0 = vec4(0.0, 0.0, 0.0, 1e9);
  e1 = e0;
  e2 = e0;
  if (uWonderParams.x < 0.8) return;
  vec3 co = flcToC(o), cd = flcToC(d);
  vec3 p = vec3(0.0, -2.72, 0.0);
  float tc = dot(p - co, cd);
  if (tc < seg.x || tc > seg.y) return;
  vec3 dv = co + cd * tc - p;
  float r = 0.06;
  float fpx = 0.7 * tc * pixAng;
  float re2 = r * r + fpx * fpx;
  float pulse = 0.75 + 0.25 * sin(uWonderParams.y * (6.2831853 * 3.0 / 3600.0) * 20.0);
  vec3 L = vec3(0.3, 0.75, 1.0) * 4e-6 * pulse * (r * r / re2) * exp(-dot(dv, dv) / re2);
  // 软封顶：只有夜里才看得见，别在任何时候截成白点
  float l = dot(L, vec3(0.2126, 0.7152, 0.0722));
  e0 = vec4(L * (1e-5 / (1e-5 + l)), tc);
}
`;
