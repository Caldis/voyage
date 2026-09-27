/**
 * 织物（GLSL）：座椅面料和头枕套的纱线级细节 + 布料的掠射光泽。依赖 CABIN_COMMON（hash12 / vnoise）、ATMOSPHERE_COMMON（M_PI）。
 * 只用于经济舱变体（T25，#define CABIN_CLASS_ECONOMY；T06 的版本从 git 历史取回）：整段包在 #ifdef 里，商务舱的程序里不出现。
 * T25 收敛（用户说过 T06「太脏」）：组织对比（经纬纱色差、纱间缝隙压暗、斜纹粗结构）压到约一半，起球减半；
 * 保留每根纱的混纺色差与几厘米尺度的绒面明暗——朴素、有点使用感，但不邋遢。
 *
 * - 组织结构：座椅面料是 2/2 斜纹，提花（jacquard）图案的地方换成 1/3 纬面组织——图案不是「印上去的颜色」，
 *   而是哪根纱浮在表面决定的：经纱深藏青、纬纱灰蓝，纬面区域就显出浅色小菱形。头枕套是细平纹。
 * - 纱线截面按圆柱算高度，高度的梯度给法线扰动；纱与纱之间的缝隙压暗（纱线级 AO）；每根纱颜色略有深浅（混纺）。
 * - 起球：稀疏的小绒球，比周围亮一点。
 * - 所有纱线级细节按像素足迹（米）淡出到平均值：纱线间距不到约 2 个像素时就不再画纹理，免得摩尔纹和闪烁。
 * - 光泽：Charlie sheen 分布（Estevez & Kulla 2017）+ Neubelt & Pettineo 2013 的可见性项，绒毛在掠射角发亮。
 */
export const FABRIC_COMMON = /* glsl */ `
#ifdef CABIN_CLASS_ECONOMY
struct Fabric {
  vec3 albedo;
  vec2 slope;     // 高度对 uv（米）的梯度，调用方按切线方向合成法线
  vec3 sheen;     // 光泽颜色
  float sheenRough;
};

float yarnProfile(float x) {
  float c = 2.0 * x - 1.0;
  return sqrt(max(1.0 - c * c, 0.0));
}

// u：以纱线间距为单位的坐标（x 沿纬纱，y 沿经纱）。twill：1 斜纹 / 0 平纹；motif：1 = 纬面提花区
// 返回 x = 表面高度（0..1），y = 表面露出的是经纱（1）还是纬纱（0）
vec2 weaveAt(vec2 u, float twill, float motif) {
  vec2 cell = floor(u);
  vec2 f = fract(u);
  float warpUp;
  if (twill > 0.5) {
    float k = mod(cell.x + cell.y, 4.0);
    warpUp = step(k, mix(1.5, 0.5, motif)); // 2/2 斜纹：一半经纱在上；提花区 1/3：只有四分之一
  } else {
    warpUp = mod(cell.x + cell.y, 2.0);
  }
  // 经纱沿 y 走：截面在 x 方向；在上时沿走向中间最高（绕过纬纱的弯曲）
  float hWarp = yarnProfile(f.x) * mix(0.55, 0.8 + 0.2 * sin(M_PI * f.y), warpUp);
  float hWeft = yarnProfile(f.y) * mix(0.8 + 0.2 * sin(M_PI * f.x), 0.55, warpUp);
  // 纱线的捻度：斜向的细纹
  float twist = 0.06 * sin(2.0 * M_PI * (f.y * 3.0 + f.x * 1.2)) * warpUp + 0.06 * sin(2.0 * M_PI * (f.x * 3.0 + f.y * 1.2)) * (1.0 - warpUp);
  float h = max(hWarp, hWeft) + twist;
  return vec2(h, step(hWeft, hWarp));
}

// 提花图案：小菱形点阵（示例图案，不对应任何航司的面料）。aa：图案周期里一个像素的宽度（0..1）
float jacquardMotif(vec2 uv, float aa) {
  const float M = 0.013;
  vec2 g = fract(uv / M) - 0.5;
  float d = abs(g.x) + abs(g.y);
  // 菱形里再嵌一个小空心，图案更像织出来的
  float diamond = 1.0 - smoothstep(0.20 - aa, 0.20 + aa, d);
  float hole = 1.0 - smoothstep(0.07 - aa, 0.07 + aa, d);
  float m = diamond - hole;
  // 远处淡出到面积占比（2·0.2² − 2·0.07² ≈ 0.07）
  return mix(m, 0.07, smoothstep(0.08, 0.3, aa));
}

// kind：0 座椅面料（提花斜纹），1 头枕套（细平纹）。pix：像素足迹（米）
Fabric fabricSample(vec2 uv, float pix, float kind) {
  Fabric fb;
  float pitch = kind < 0.5 ? 0.0011 : 0.0009;
  vec3 warpC = kind < 0.5 ? vec3(0.050, 0.058, 0.095) : vec3(0.60, 0.60, 0.58);
  vec3 weftC = kind < 0.5 ? vec3(0.068, 0.077, 0.115) : vec3(0.57, 0.578, 0.57); // 经纬纱对比压到 T06 的一半
  float motif = kind < 0.5 ? jacquardMotif(uv, pix / 0.013 * 1.5) : 0.0;
  float twill = kind < 0.5 ? 1.0 : 0.0;

  vec2 u = uv / pitch;
  vec2 w = weaveAt(u, twill, motif);
  const float e = 0.12;
  float hx = weaveAt(u + vec2(e, 0.0), twill, motif).x;
  float hy = weaveAt(u + vec2(0.0, e), twill, motif).x;
  // 纱线起伏高度约为间距的 0.35 倍
  vec2 slope = vec2(hx - w.x, hy - w.x) / e * (kind < 0.5 ? 0.13 : 0.09); // 头枕套的细平纹再弱一些，近看不像网格

  // 混纺：每根纱颜色略有深浅
  vec2 cell = floor(u);
  float jWarp = hash12(vec2(cell.x, 3.7)) - 0.5;
  float jWeft = hash12(vec2(11.3, cell.y)) - 0.5;
  // 每根纱整体的深浅 + 沿纱线的一段段色差（混纺纤维）
  float along = w.y > 0.5 ? u.y : u.x;
  float seg = hash12(vec2(floor(along * 0.7), w.y > 0.5 ? cell.x : cell.y + 71.0)) - 0.5;
  vec3 yarn = w.y > 0.5 ? warpC * (1.0 + 0.22 * jWarp + 0.14 * seg) : weftC * (1.0 + 0.22 * jWeft + 0.14 * seg);
  vec3 detailed = yarn * (0.91 + 0.09 * clamp(w.x, 0.0, 1.0));

  // 平均值：露出经纱的面积占比 × 颜色，再乘上纱间缝隙的平均压暗
  float warpFrac = twill > 0.5 ? mix(0.5, 0.25, motif) : 0.5;
  vec3 avg = mix(weftC, warpC, warpFrac) * 0.95;

  // 纱线一个周期要占约 3 个像素以上才画：少于这个数，斜纹的斜线和像素网格会拍出大尺度的斜向波纹（摩尔纹）
  float detail = 1.0 - smoothstep(0.12, 0.4, pix / pitch);
  // 纱线分辨不出来时仍保留一级粗结构：斜纹的斜向纹路（沿 u.x + u.y 方向、周期 4 根纱，平纹是 2 根纱的格子），
  // 用单一频率的正弦表示，本身是带限的；周期不到约 3 个像素时再淡出，所以不会拍出摩尔纹
  float period = twill > 0.5 ? 4.0 : 2.0;
  float rph = 2.0 * M_PI * (twill > 0.5 ? (u.x + u.y) : u.x) / period;
  float rph2 = 2.0 * M_PI * u.y / period;
  float rib = twill > 0.5 ? sin(rph) : 0.5 * (sin(rph) + sin(rph2));
  float ribPeriodM = pitch * period * (twill > 0.5 ? 0.7071 : 1.0);
  float coarse = (1.0 - detail) * (1.0 - smoothstep(0.15, 0.35, pix / ribPeriodM));
  vec3 ribAlbedo = avg * (1.0 + 0.05 * rib);
  vec2 ribSlope = (twill > 0.5 ? vec2(1.0, 1.0) * cos(rph) : vec2(cos(rph), cos(rph2)) * 0.5) * (2.0 * M_PI / period) * 0.35 * 0.5;
  fb.albedo = mix(mix(avg, ribAlbedo, coarse), detailed, detail);
  fb.slope = slope * detail + ribSlope * coarse;

  // 更粗一级的纱线粗细不匀（条干），几毫米尺度，在更远处才淡出
  float slub = vnoise(uv * vec2(90.0, 700.0)) - 0.5;
  fb.albedo *= 1.0 + 0.07 * slub * (1.0 - smoothstep(0.0008, 0.003, pix));
  // 几厘米尺度的绒面明暗：绒毛倒向不一、坐久了压出来的发亮 / 发暗块（不随像素足迹淡出，本身就是低频）
  float nap = 0.6 * vnoise(uv * 35.0 + kind * 9.0) + 0.4 * vnoise(uv * 90.0 + 3.0);
  fb.albedo *= 0.93 + 0.14 * nap;

  // 起球：约 4 mm 一格，少数格子里有一个 0.4–0.8 mm 的小绒球；按面积摊薄，远处自然变成极轻的提亮
  vec2 pc = floor(uv / 0.004);
  vec2 ph = hash22(pc + kind * 17.0);
  if (ph.x < 0.035) {
    vec2 c = (pc + 0.2 + 0.6 * hash22(pc + 5.3)) * 0.004;
    float r = mix(0.0002, 0.0004, ph.y);
    float cov = (1.0 - smoothstep(r - pix * 0.5, r + pix * 0.5, length(uv - c))) * min(1.0, r * r / max(pix * pix, 1e-12));
    fb.albedo = mix(fb.albedo, weftC * 1.5 + 0.02, cov * 0.8);
  }

  fb.sheen = (kind < 0.5 ? vec3(0.11, 0.12, 0.15) : vec3(0.30, 0.30, 0.29)) * (0.75 + 0.5 * nap);
  fb.sheenRough = kind < 0.5 ? 0.45 : 0.5;
  return fb;
}

// Charlie sheen：D = (2 + 1/α) sin(θh)^(1/α) / 2π；可见性 V = 1 / (4(NL + NV − NL·NV))
float sheenBrdf(float nl, float nv, float nh, float a) {
  float inv = 1.0 / a;
  float s2 = max(1.0 - nh * nh, 1e-4);
  float D = (2.0 + inv) * pow(s2, 0.5 * inv) / (2.0 * M_PI);
  float V = 1.0 / max(4.0 * (nl + nv - nl * nv), 1e-3);
  return D * V;
}
#endif
`;
