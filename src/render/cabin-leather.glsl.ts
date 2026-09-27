/**
 * 座椅的高端材质（GLSL）：细纹皮革（荔枝纹 + 泡棉起伏 + 天然的色差；不画褶线——细暗线读成「皮面开裂」，显旧）、精密的双明线缝线、胡桃木饰条。
 * 依赖 CABIN_COMMON（hash12 / vnoise）、PANE_COMMON（hash22）、CABIN_SHADING_COMMON（vnoiseD / lineCov）。
 *
 * 对标商务舱 / 头等舱套间（卡塔尔 Qsuite、达美 Delta One、新航 A350 商务舱）的做法：软包皮革 + 精密缝线 + 木饰 / 金属饰条。
 * 颜色、尺寸都是示意值，不对应任何航司的实际配色。
 * 只用于商务舱（T25：经济舱变体 #define CABIN_CLASS_ECONOMY 时整段不编译，座椅换成 fabric.glsl.ts 的织物）。
 *
 * 抗锯齿：皮纹、缝线、木纹都按解析的像素足迹（米）淡出；皮纹淡出后把「看不见的起伏」折算成更高的粗糙度（Toksvig 思路），
 * 远处的高光变宽变柔，不会闪。所有随机都用多尺度、非整数比、带旋转的噪声（铁律 4：不要规整重复）。
 */
export const LEATHER_COMMON = /* glsl */ `
#ifndef CABIN_CLASS_ECONOMY
struct Leather {
  vec3 albedo;
  vec2 slope;   // 高度对 uv（米）的梯度，调用方按切线方向合成法线
  float rough;
};

// 皮面：kind 0 = 靠背主体（深石板灰），1 = 头枕（暖灰白的纳帕皮），中间值是两块皮交界处的抗锯齿过渡。seed：每张座椅不同
Leather leatherSample(vec2 uv, float pix, float kind, float seed) {
  Leather lt;
  vec3 base = mix(vec3(0.085, 0.09, 0.10), vec3(0.42, 0.395, 0.355), kind);
  // 荔枝纹：约 0.7 mm 和 0.3 mm 两级的圆润颗粒，网格各自转一个角度
  vec2 ua = mat2(0.866, 0.5, -0.5, 0.866) * uv;
  vec2 ub = mat2(0.6, -0.8, 0.8, 0.6) * uv;
  float fA = 1.0 - smoothstep(0.00022, 0.0005, pix);
  float fB = 1.0 - smoothstep(0.0001, 0.00022, pix);
  vec2 slope = vec2(0.0);
  float valley = 0.0;
  if (fA > 0.0) {
    vec3 g1 = vnoiseD(ua * 1450.0 + seed * 11.0);
    vec3 g2 = vnoiseD(ub * 3300.0 + seed * 5.0);
    slope = mat2(0.866, -0.5, 0.5, 0.866) * g1.yz * 1450.0 * 0.00005 * fA
          + mat2(0.6, 0.8, -0.8, 0.6) * g2.yz * 3300.0 * 0.000014 * fB;
    valley = (1.0 - smoothstep(0.2, 0.45, g1.x)) * fA;
  }
  // 软包下的泡棉起伏：几厘米尺度的缓慢波动（皮面不是塑料那样的死平）
  vec3 wv = vnoiseD(ub * 22.0 + seed * 1.7);
  slope += wv.yz * 22.0 * mix(0.0018, 0.003, kind);
  // 天然色差：厘米级的轻微深浅，每张皮不同
  float hide = 0.6 * vnoise(ua * 14.0 + seed * 9.0) + 0.4 * vnoise(ub * 47.0 + seed);
  lt.albedo = base * (0.94 + 0.12 * hide) * (1.0 - 0.08 * valley);
  lt.slope = slope;
  // 皮纹淡出后，没画出来的起伏折算成粗糙度，远处高光变宽而不是闪
  lt.rough = mix(0.36, 0.44, kind) + 0.06 * valley + 0.08 * (1.0 - fA);
  return lt;
}

// 一道缝：across = 离缝中心线的距离（带符号），along = 沿缝的坐标（米）。
// 缝本身是一道被拉紧的凹槽（两侧软包鼓起），两侧 4 mm 各一行明线（double topstitch）；single = 1 只在凹槽里走一行。
// 返回 x = 线的覆盖率，y = 凹槽的压暗，zw = 法线扰动（across 方向的斜率，已按像素淡出）
vec4 leatherSeam(float across, float along, float pix, float single) {
  // 凹槽：高度 −0.9 mm·exp(−(a/2.2mm)²) 的斜率
  float a = across / 0.0022;
  float g = exp(-a * a);
  float fG = 1.0 - smoothstep(0.0012, 0.003, pix);
  float slopeA = 0.0009 * 2.0 * a / 0.0022 * g * fG;
  float dark = g * mix(0.25, 0.45, 1.0 - fG);
  // 明线：针距约 3.6 mm，线段占 75%；线宽约 0.55 mm
  float off = single > 0.5 ? 0.0 : 0.004;
  float dRow = abs(abs(across) - off);
  float st = fract(along / 0.0036 + 0.37 * step(0.0, across));
  float aa = min(pix / 0.0036, 0.5);
  float dash = smoothstep(0.08 - aa, 0.08 + aa, st) * (1.0 - smoothstep(0.83 - aa, 0.83 + aa, st));
  dash = mix(dash, 0.75, smoothstep(0.0008, 0.0018, pix));
  float thread = lineCov(dRow, 0.000275, pix) * dash;
  // 线是鼓起的：截面上的斜率给一点点高光，按像素淡出
  float tu = clamp((abs(across) - off) / 0.000275, -1.0, 1.0) * sign(across + 1e-6);
  float slopeT = -tu * 0.9 * thread * (1.0 - smoothstep(0.0002, 0.0005, pix));
  return vec4(thread, dark, slopeA + slopeT, 0.0);
}

// 胡桃木饰条：纹理沿 u 方向走，年轮线被多尺度噪声扭曲（不规整），有细长的导管纹；开放漆面、缎光。
// 返回反照率；rough 输出粗糙度
vec3 leatherWalnut(vec2 uv, float pix, float seed, out float rough) {
  // 扭曲：大尺度的波动让年轮互不平行（否则读成等距的格栅 / 出风口），小尺度的抖动，加一处节疤附近年轮绕开的鼓包
  float warp = 0.55 * vnoise(vec2(uv.x * 7.0, uv.y * 55.0) + seed) + 0.3 * vnoise(vec2(uv.x * 23.0, uv.y * 140.0) + seed * 3.0);
  float wave = vnoise(vec2(uv.x * 11.0, uv.y * 8.0) + seed * 1.3) + 0.5 * vnoise(vec2(uv.x * 31.0, uv.y * 20.0) + seed * 2.1);
  vec2 kc = vec2(0.12 * (hash12(vec2(seed, 1.7)) - 0.5), 0.0);
  vec2 kd = (uv - kc) * vec2(1.0, 2.5);
  float knot = exp(-dot(kd, kd) / 0.0006);
  float ph = uv.y * 230.0 + warp * 4.0 + wave * 9.0 + knot * 6.0 * sign(uv.y - kc.y + 1e-5);
  float per = 1.0 / 230.0;                          // 约 4.3 mm 一条
  float fl = 1.0 - smoothstep(per * 0.15, per * 0.4, pix);
  float ring = smoothstep(0.1, 0.9, abs(fract(ph) - 0.5) * 2.0);
  float rings = mix(0.5, ring, fl);
  // 导管纹：沿纹理方向拉长的细暗点
  float fp = 1.0 - smoothstep(0.00015, 0.0004, pix);
  float pores = smoothstep(0.62, 0.8, vnoise(vec2(uv.x * 90.0, uv.y * 2600.0) + seed * 7.0)) * fp;
  // 大尺度的色块（一整张薄木皮里颜色也不均匀）
  float blotch = vnoise(uv * vec2(9.0, 30.0) + seed * 2.0);
  // T25（美术总监 wave3）：原来 (0.32,0.19,0.10)–(0.10,0.056,0.03) 在新曝光下读成深棕色块、不像木头，两端都提亮
  vec3 dark = vec3(0.14, 0.08, 0.045), light = vec3(0.40, 0.25, 0.13);
  vec3 col = mix(light, dark, rings * 0.35 + 0.2 * blotch + 0.25 * knot) * (1.0 - 0.3 * pores);
  rough = 0.3 + 0.08 * pores; // 开放漆面、缎光（T25：0.2 → 0.3，掠射时漆面反射不再把木色冲成一片灰白）
  return col;
}
#endif
`;
