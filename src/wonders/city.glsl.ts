/**
 * 雾海灯城（W02，致敬《银翼杀手》开场；原创造型，不用任何官方资产）。云间层奇观，接口见 wonder-cloud.glsl.ts / handoff/W00.md。
 * 设计依据 research/WONDERS.md §3.5、C6。
 *
 * 画面：夜里远方一片被灯海从下往上染橙的雾（发光介质，被前面的云挡、也挡住身后的云）；雾里若隐若现的两座巨型阶梯金字塔
 * 与几座阶梯塔的剪影（极简轮廓，顶上一点冷白的灯）；工业区的烟囱周期性喷火、把烟柱底部映红；几道缓慢扫动的探照光束
 * （穿过雾时最明显）；雾下隐约的车流灯带。白天只剩一团偏黄褐的污浊霾与巨塔淡灰的剪影（自动出现只在夜里，见 catalog.ts）。
 *
 * 坐标：奇观局部坐标（km，x 东、y 天顶、z 南），再按本次出现的随机种子（uWonderParams.z）绕 y 轴转一个角度 = 「城市坐标」，
 * 同一座城每次出现朝向、河道、雾的纹理都不一样（随机性造就真实）。
 *
 * 分工（各函数只有一个调用点，由 wonder-cloud.glsl.ts 的分派函数调用）：
 *  - fcSdf / fcShade：金字塔与阶梯塔（表面）；
 *  - fcMedium：雾（灯海从下往上照亮）+ 烟柱（火光映红烟底）；
 *  - fcMediumSeg：介质只在「雾层 y < FC_FOG_MAX」加「工业区烟柱的包围盒」里步进（整个包围盒高 7 km，光束要用，雾只有 2 km）；
 *  - fcRay：解析的发光——雾下的灯海与车流（与 y = 0 平面求交）、探照光束（光束与视线的最近点，单次散射线积分的闭式解）、
 *    点光（火球、塔顶灯、航空障碍灯），按像素足迹保持能量，远处自然平均成均匀亮度、不闪烁。
 *
 * 亮度量级（kcd/m²）：灯海地面平均约 3e-3（≈ 3 cd/m²，与 terrain-shading.glsl.ts 城市灯点市中心同一量级）；
 * 雾 ≈ 反照率 × 地面亮度 / 4 ≈ 5e-4；点光与光束按「雾最亮处的几倍」软封顶（W01b 的教训：远处发光体不截白、不像霓虹）。
 */

export const CITY_GLSL = /* glsl */ `
const float FC_R = 27.0;           // 城区椭圆的长半轴（km）；短半轴 × 0.8
const float FC_FOG_MAX = 2.2;      // 雾顶最高处（km）
const float FC_LG = 2.5e-3;        // 灯海的地面平均辐亮度基准（kcd/m²）；其余发光都按它的倍数定（自动曝光会把整体拉回来，要紧的是相对亮度）
const vec3 FC_IND = vec3(14.0, 0.0, -9.0);  // 工业区中心（城市坐标）：烟囱都在这附近
const float FC_IND_R = 8.5;        // 工业区（烟柱包围盒）半径
const float FC_PLUME_TOP = 5.6;    // 烟柱最高处
const float FC_CAP = 5.0 * FC_LG;  // 点光 / 光束的软封顶（约雾最亮处的 8 倍）：远处的火与灯是亮的橙 / 冷白，不截成白点
// 两座金字塔：中心 xz、底边半宽、高（km）
const vec4 FC_P1 = vec4(-4.5, 3.0, 3.0, 4.2);
const vec4 FC_P2 = vec4(5.5, -3.0, 2.5, 3.5);

// 钠灯橙与冷青（按 Rec.709 亮度归一）
const vec3 FC_SODIUM = vec3(1.0, 0.4, 0.08) / (0.2126 + 0.7152 * 0.4 + 0.0722 * 0.08);
const vec3 FC_CYAN = vec3(0.40, 0.82, 1.0) / (0.2126 * 0.40 + 0.7152 * 0.82 + 0.0722);

float fcHash(vec2 p) {
  vec3 p3 = fract(vec3(p.xyx) * 0.1031);
  p3 += dot(p3, p3.yzx + 33.33);
  return fract((p3.x + p3.y) * p3.z);
}
float fcLum(vec3 c) { return dot(c, vec3(0.2126, 0.7152, 0.0722)); }
float fcHg(float c, float g) {
  float g2 = g * g;
  return (1.0 - g2) / (4.0 * M_PI * pow(max(1.0 + g2 - 2.0 * g * c, 1e-4), 1.5));
}

// 局部坐标 → 城市坐标：绕 y 轴转种子角（方向、点都用它；旋转不改变视线参数 t）
vec3 fcToCity(vec3 q) {
  float a = uWonderParams.z * 6.2831853;
  float c = cos(a), s = sin(a);
  return vec3(c * q.x - s * q.z, q.y, s * q.x + c * q.z);
}

// 城区范围（0..1）：椭圆，边界按方位起伏（不是正圆），外缘 12 km 渐隐到 0；包围盒 ±36 km 盖得住
float fcMask(vec2 c) {
  vec2 e = c / vec2(FC_R, FC_R * 0.8);
  float r = length(e);
  float ang = atan(e.y, e.x);
  float sd = uWonderParams.z * 40.0;
  float wob = 0.12 * sin(ang * 3.0 + sd) + 0.07 * sin(ang * 7.0 + 1.3 * sd) + 0.04 * sin(ang * 13.0 + 2.1);
  return 1.0 - smoothstep(0.3, 1.0, r + wob);
}

// 城市里的河：沿 x 蜿蜒的一条带子。返回到河中心线的距离（km）
float fcRiver(vec2 c) {
  float sd = uWonderParams.z * 17.0;
  float rz = 3.5 + 5.0 * sin(c.x / 8.3 + sd) + 2.2 * sin(c.x / 3.1 + 1.7 * sd);
  return abs(c.y - rz);
}

// 灯海：地面平均辐亮度（kcd/m²，rgb 带颜色，a = 亮度）。lod 越大越模糊（照雾时用模糊版，光从下面照上来本来就是摊开的）。
// 一次纹理：R 街区明暗、G 公园 / 空地、B 冷青色片区、A 雾的疏密（fcMedium 也读它）
vec4 fcCarpetN(vec2 c, float lod) {
  return textureLod(uShapeNoise, vec3(c / 42.0 + uWonderParams.z * 3.7, 0.64), lod);
}
vec4 fcCarpet(vec2 c, vec4 n, float blur) {
  float m = fcMask(c);
  if (m <= 0.0) return vec4(0.0);
  float district = 0.45 + 1.0 * smoothstep(0.22, 0.8, n.r);
  float parks = mix(0.35, 1.0, smoothstep(0.28, 0.46, n.g));
  float riv = smoothstep(0.2 + 1.2 * blur, 0.55 + 1.8 * blur, fcRiver(c));
  // 两座金字塔脚下最亮（塔的剪影压在最亮的雾上），工业区暗（只有火光）
  vec2 d1 = c - FC_P1.xy, d2 = c - FC_P2.xy, di = c - FC_IND.xz;
  float hot = 1.0 + 0.7 * exp(-dot(d1, d1) / 12.0) + 0.6 * exp(-dot(d2, d2) / 9.0);
  float ind = mix(1.0, 0.3, exp(-dot(di, di) / 40.0));
  // 片区按 reveal 先后亮起来（亮的街区先亮）
  float on = smoothstep(0.0, 0.3, uWonderParams.x * 1.3 - (1.0 - n.r) * 0.6);
  float lum = FC_LG * m * district * parks * riv * hot * ind * on;
  vec3 col = mix(FC_SODIUM, FC_CYAN, 0.55 * smoothstep(0.6, 0.82, n.b));
  return vec4(col * lum, lum);
}

// 探照光束 / 雾的解析近似（不读纹理）：只按高度与城区范围，给光束的散射用
float fcFogApprox(vec3 c) {
  return 1.3 * fcMask(c.xz) * smoothstep(1.7, 0.8, c.y) * exp(-c.y / 1.5);
}

// ---------------- 表面：金字塔与阶梯塔 ----------------
// 四棱锥（iq）：底边 1×1（半宽 0.5）、中心在原点、尖在 y = h
float fcPyramidUnit(vec3 p, float h) {
  float m2 = h * h + 0.25;
  p.xz = abs(p.xz);
  p.xz = (p.z > p.x) ? p.zx : p.xz;
  p.xz -= 0.5;
  vec3 q = vec3(p.z, h * p.y - 0.5 * p.x, h * p.x + 0.5 * p.y);
  float s = max(-q.x, 0.0);
  float t = clamp((q.y - 0.5 * p.z) / (m2 + 0.25), 0.0, 1.0);
  float a = m2 * (q.x + s) * (q.x + s) + q.y * q.y;
  float b = m2 * (q.x + 0.5 * t) * (q.x + 0.5 * t) + (q.y - m2 * t) * (q.y - m2 * t);
  float d2 = min(q.y, -q.x * m2 - q.y * 0.5) > 0.0 ? 0.0 : min(a, b);
  return sqrt((d2 + q.z * q.z) / m2) * sign(max(q.z, -p.y));
}
// 阶梯金字塔：三段收分的截头四棱锥叠起来（每段顶上退进一圈平台），顶上一个小平台。p 相对塔心，半宽 w、高 h
float fcZiggurat(vec3 p, float w, float h) {
  // 包围球外直接返回下界（大多数视线离塔很远，省掉三段求值）
  float bound = length(p - vec3(0.0, 0.35 * h, 0.0)) - 1.05 * max(w * 1.42, 0.7 * h);
  if (bound > 0.5) return bound;
  float d = 1e9;
  float y0 = 0.0;
  float wk = w;
  float slope = h / w;   // 每一段斜面的坡度一样（高 / 半宽）
  for (int k = 0; k < 3 + min(uStormCount, 0); k++) {
    float y1 = h * (k == 0 ? 0.42 : k == 1 ? 0.74 : 0.95);
    // 这一段是一个「底在 y0、半宽 wk、同坡度」的四棱锥，截在 [y0, y1]
    float s = 2.0 * wk;
    float dk = fcPyramidUnit((p - vec3(0.0, y0, 0.0)) / s, slope * wk / s) * s;
    dk = max(dk, max(p.y - y1, y0 - p.y));
    d = min(d, dk);
    // 下一段从这一段顶上起、往里退一圈平台（半宽的 7%）
    wk = (wk - (y1 - y0) / slope) * 0.93;
    y0 = y1;
  }
  return d;
}
float fcBox(vec3 p, vec3 b) {
  vec3 q = abs(p) - b;
  return length(max(q, 0.0)) + min(max(q.x, max(q.y, q.z)), 0.0);
}
// 阶梯塔：三层方盒，逐层收小。p 相对塔底中心；w 底层半宽、h 总高
float fcTower(vec3 p, float w, float h) {
  float bound = length(p - vec3(0.0, 0.5 * h, 0.0)) - (0.5 * h + 1.5 * w);
  if (bound > 0.5) return bound;
  float a = fcBox(p - vec3(0.0, 0.28 * h, 0.0), vec3(w, 0.28 * h, w * 0.85));
  float b = fcBox(p - vec3(0.0, 0.68 * h, 0.0), vec3(0.7 * w, 0.12 * h, 0.6 * w));
  float c = fcBox(p - vec3(0.0, 0.9 * h, 0.0), vec3(0.42 * w, 0.1 * h, 0.36 * w));
  return min(a, min(b, c));
}
// 塔的列表（城市坐标 x、z、底层半宽、总高）
vec4 fcTowerDef(int i) {
  return i == 0 ? vec4(11.0, 6.0, 0.26, 3.6)
       : i == 1 ? vec4(-12.5, -4.5, 0.22, 2.9)
       : i == 2 ? vec4(1.0, 10.5, 0.25, 3.3)
       :          vec4(-8.5, 11.5, 0.2, 2.6);
}
float fcSdf(vec3 q) {
  vec3 c = fcToCity(q);
  float d1 = fcZiggurat(c - vec3(FC_P1.x, 0.0, FC_P1.y), FC_P1.z, FC_P1.w);
  float d2 = fcZiggurat(c - vec3(FC_P2.x, 0.0, FC_P2.y), FC_P2.z, FC_P2.w);
  float dp = min(d1, d2);
  float dt = 1e9;
  for (int i = 0; i < 4 + min(uStormCount, 0); i++) {
    vec4 td = fcTowerDef(i);
    dt = min(dt, fcTower(c - vec3(td.x, 0.0, td.y), td.z, td.w));
  }
  gWonderMat = dt < dp ? 1.0 : 0.0;
  return min(dp, dt);
}

// 表面着色：暗色的巨构（反照率 7%），白天 / 月光按标准受光；夜里被下方发光的雾从下面照亮一点（仍比雾暗得多，读成剪影）；
// 斜面上稀疏的横向暗橙灯带（大多数楼层是黑的：「几乎没有窗户」）
vec3 fcShade(vec3 q, vec3 n, vec3 pW, vec3 nW, vec3 rd) {
  vec3 c = fcToCity(q);
  vec3 alb = gWonderMat > 0.5 ? vec3(0.075, 0.072, 0.07) : vec3(0.07, 0.066, 0.06);
  vec3 L = wonderLitSurface(pW, nW, alb);
  // 下方雾的辉光：雾顶的亮度约 反照率 × 灯海 / 4 × 0.6；朝下的面看得到的比例 (1 − n_y) / 2
  vec4 cp = fcCarpet(c.xz, fcCarpetN(c.xz, 2.5), 1.0);
  float inFog = smoothstep(2.0, 0.6, c.y);
  L += alb * cp.rgb * 0.15 * (0.5 - 0.5 * n.y + 0.3 * inFog);
  // 灯带：每 130 m 一层，只有一成的格子（350 m 一格）亮着；按像素足迹做帐篷核覆盖，远处平均成一点点底光
  float t = length(pW - vec3(0.0, uCamR, 0.0));
  float fp = t * 2.0 * uTanHalfFov / uResolution.y;   // 全分辨率的像素足迹（uCloudResolution 在奇观 pass 里声明得更晚）
  float band = c.y / 0.13;
  float bi = floor(band + 0.5);
  float dy = abs(band - bi) * 0.13;
  float fy = max(fp * 1.3, 0.02);
  float cov = 0.02 / fy * max(0.0, 1.0 - dy / fy);
  cov = mix(cov, 0.02 / 0.13, smoothstep(0.035, 0.065, fy));
  float u = (abs(n.x) > abs(n.z) ? c.z : c.x) / (gWonderMat > 0.5 ? 0.12 : 0.35);
  float cell = floor(u);
  float lit = step(fcHash(vec2(bi * 1.37 + gWonderMat * 31.0 + uWonderParams.z * 13.0, cell)), 0.06);
  // 格子边缘按足迹渐变（免得亮格的两端在飞行中一格一格地爬）
  float fu = fract(u);
  lit *= clamp((min(fu, 1.0 - fu) * (gWonderMat > 0.5 ? 0.12 : 0.35)) / max(fp, 1e-3) + 0.5, 0.0, 1.0);
  lit = mix(lit, 0.06, smoothstep(0.1, 0.2, fp));
  float onW = smoothstep(0.3, 0.7, uWonderParams.x) * smoothstep(0.1, 0.25, c.y) * (1.0 - smoothstep(0.55, 0.85, n.y));
  L += FC_SODIUM * (1.6 * FC_LG) * cov * lit * onW;
  return L;
}

// ---------------- 介质：雾 + 烟柱 ----------------
// 烟囱：城市坐标 x、z、顶高（km），相对工业区中心
vec3 fcChimney(int i) {
  vec2 o = i == 0 ? vec2(-3.0, -2.0) : i == 1 ? vec2(0.5, -4.2) : i == 2 ? vec2(3.2, 1.0)
         : i == 3 ? vec2(-1.2, 2.6) : i == 4 ? vec2(4.3, -3.1) : vec2(-4.6, 1.4);
  float h = 1.05 + 0.5 * fract(float(i) * 0.618 + 0.3);
  return vec3(FC_IND.x + o.x, h, FC_IND.z + o.y);
}
// 火炬的亮度（0..1+）与本次喷发的年龄（秒）：每个烟囱 5–11 秒一个周期，0.25 秒冲起、约 1.2 秒衰减；
// 有的周期不喷（只剩常明的引火），喷的时候带两个频率的抖动
float fcFlare(int i, out float age) {
  float fi = float(i);
  float sd = uWonderParams.z * 91.0;
  float P = 5.0 + 6.0 * fract(fi * 0.754 + 0.21 + sd * 0.01);
  float x = uWonderParams.y / P + fract(fi * 0.371 + sd);
  float ph = fract(x);
  age = ph * P;
  float burst = smoothstep(0.0, 0.25, age) * exp(-age / 1.2);
  float go = step(0.3, fcHash(vec2(floor(x), fi + sd)));
  float flick = 0.85 + 0.15 * sin(uWonderParams.y * 23.0 + fi * 7.0) * sin(uWonderParams.y * 9.1 + fi);
  return (0.05 + burst * go) * flick * smoothstep(0.5, 0.8, uWonderParams.x);
}
// 顺风方向（城市坐标）：烟往这边斜
const vec2 FC_WIND = vec2(0.8, 0.6);

float fcMedium(vec3 q, out vec3 albedo, out vec3 emit) {
  vec3 c = fcToCity(q);
  albedo = vec3(0.0);
  emit = vec3(0.0);
  float m = fcMask(c.xz);
  vec2 di = c.xz - FC_IND.xz;
  bool inInd = dot(di, di) < FC_IND_R * FC_IND_R;
  if (m <= 0.0 && !inInd && dot(c.xz, c.xz) > 1600.0) return 0.0;
  float t = uWonderParams.y;
  // 雾：3D 噪声（云的形状噪声）一次；雾顶 0.9–1.8 km 起伏，塔脚下的热岛把雾顶顶高一点；A 通道给大块的疏处（能透见下面的灯带）
  vec4 nc = fcCarpetN(c.xz, 2.5);
  vec4 nf = textureLod(uShapeNoise, vec3(c.xz / 15.0 + vec2(t * 0.00025, 0.0), c.y / 5.0) + uWonderParams.z * 5.3, 1.0);
  vec2 d1 = c.xz - FC_P1.xy, d2 = c.xz - FC_P2.xy;
  // 标高：0.35–1.0 km 随地点起伏，塔脚下的热岛把雾顶起来一点
  float H = 0.35 + 0.65 * nf.g + 0.3 * exp(-dot(d1, d1) / 20.0) + 0.25 * exp(-dot(d2, d2) / 16.0);
  float billow = smoothstep(0.2, 0.8, nf.r);
  float holes = mix(0.25, 1.0, smoothstep(0.3, 0.55, nc.a));
  float reveal = mix(0.3, 1.0, smoothstep(0.0, 0.6, uWonderParams.x));
  // 城外一圈稀薄的霾裙（灯海的光漫出去，边缘不是一刀切）
  vec2 e = c.xz / vec2(FC_R, FC_R * 0.8);
  float wide = exp(-dot(e, e) * 1.1);
  float mf = max(m, 0.3 * wide);
  float col = (0.3 + 0.9 * billow) * holes;
  float sFog = 1.9 * mf * col * exp(-c.y / H) * smoothstep(FC_FOG_MAX, FC_FOG_MAX - 0.6, c.y) * reveal;
  // 灯海从下往上照：地面是亮度 Lg 的朗伯发光面，上方的照度 ≈ π·Lg，被下面的雾挡掉一部分（多次散射把光留在雾里，只挡一部分）：
  // 雾厚的地方（鼓起的雾团）顶上暗、薄处亮，雾因此有体积感；城外的霾裙由城里漫出来的光照亮
  vec4 cp = fcCarpet(c.xz, nc, 1.0);
  vec3 src = cp.rgb + FC_SODIUM * (0.35 * FC_LG) * wide * smoothstep(0.0, 0.5, uWonderParams.x);
  float tauBelow = 1.9 * mf * col * H * (1.0 - exp(-c.y / H)) * reveal;
  vec3 glow = src * (0.12 + 0.88 * exp(-0.8 * tauBelow)) * 0.25;   // σ·反照率·E/4π = σ·反照率·Lg/4
  vec3 albFog = vec3(0.72, 0.56, 0.33);                         // 城市霾：偏黄褐、略吸收（白天读成污浊的霾团）
  // 烟柱 + 火光：只在工业区里算
  float sSmoke = 0.0;
  vec3 fire = vec3(0.0);
  if (inInd) {
    for (int i = 0; i < 6 + min(uStormCount, 0); i++) {
      vec3 ch = fcChimney(i);
      float age;
      float fl = fcFlare(i, age);
      float h = c.y - ch.y;
      // 烟柱轴线顺风弯，半径随高度变粗；顶部 2–5 km 渐散
      vec2 ax = ch.xz + FC_WIND * (0.3 * max(h, 0.0) + 0.09 * h * h * step(0.0, h));
      float r = 0.09 + 0.3 * max(h, 0.0);
      vec2 dx = c.xz - ax;
      float g = exp(-dot(dx, dx) / (r * r));
      sSmoke += 2.4 * g * (0.1 / r + 0.25) * smoothstep(-0.05, 0.12, h) * smoothstep(FC_PLUME_TOP - ch.y, 1.8, h);
      // 火球在烟囱口上方 0.1–0.4 km：照亮周围的烟和雾（和闪电照云同一个形式：exp(−d/L) / (1 + d²)）
      vec3 fc = vec3(ch.x, ch.y + 0.1 + 0.25 * smoothstep(0.0, 1.5, age), ch.z);
      float dd = length(c - fc);
      fire += vec3(1.0, 0.42, 0.12) * (fl * (8.0 * FC_LG) * exp(-dd / 0.9) / (1.0 + dd * dd / 0.09));
    }
    sSmoke *= 0.45 + 0.9 * nf.r;
  }
  float sig = sFog + sSmoke;
  if (sig <= 1e-5) return 0.0;
  // 烟：暗灰褐（煤烟）
  albedo = (sFog * albFog + sSmoke * vec3(0.5, 0.46, 0.42)) / sig;
  emit = sFog * albFog * glow + sig * albedo * fire + sSmoke * vec3(0.5, 0.46, 0.42) * glow * 0.4;
  return sig;
}

// 介质的步进区间：雾层（y < FC_FOG_MAX）∪ 工业区烟柱的包围盒，取包络
vec2 fcSlab(float oy, float dy, float y0, float y1) {
  if (abs(dy) < 1e-6) return (oy >= y0 && oy <= y1) ? vec2(0.0, 1e9) : vec2(1e9, -1e9);
  float a = (y0 - oy) / dy, b = (y1 - oy) / dy;
  return vec2(max(min(a, b), 0.0), max(a, b));
}
vec2 fcMediumSeg(vec3 o, vec3 d, vec2 seg) {
  vec3 co = fcToCity(o), cd = fcToCity(d);
  vec2 s = fcSlab(co.y, cd.y, 0.0, FC_FOG_MAX);
  vec3 bmin = vec3(FC_IND.x - FC_IND_R, 0.0, FC_IND.z - FC_IND_R);
  vec3 bmax = vec3(FC_IND.x + FC_IND_R, FC_PLUME_TOP, FC_IND.z + FC_IND_R);
  vec3 inv = 1.0 / (cd + vec3(1e-9));
  vec3 ta = (bmin - co) * inv, tb = (bmax - co) * inv;
  vec3 tn = min(ta, tb), tf = max(ta, tb);
  vec2 b = vec2(max(max(tn.x, tn.y), max(tn.z, 0.0)), min(min(tf.x, tf.y), tf.z));
  vec2 r = s;
  if (b.y > b.x) r = s.y > s.x ? vec2(min(s.x, b.x), max(s.y, b.y)) : b;
  return vec2(max(r.x, seg.x), min(r.y, seg.y));
}

// ---------------- 解析的发光（事件）----------------
// 一族平行线（道路）：法向 n、间距 sp（km）、线宽 w；F：垂直于线的像素足迹。帐篷核覆盖（能量守恒），足迹大于半个间距后退回平均值
float fcLines(float u, float sp, float F, float w) {
  float dd = (fract(u / sp + 0.5) - 0.5) * sp;
  float ww = max(F, w);
  float cov = w / ww * max(0.0, 1.0 - abs(dd) / ww);
  return mix(cov, w / sp, smoothstep(0.12 * sp, 0.35 * sp, F));
}
// 足迹（地面上的像素椭圆：横向 fs、沿视线 fl，aL 是视线的水平方向）在方向 v 上的宽度
float fcFoot(vec2 v, vec2 aL, float fs, float fl) {
  float a = dot(v, aL), b = dot(v, vec2(-aL.y, aL.x));
  return sqrt(a * a * fl * fl + b * b * fs * fs);
}
// 雾下的地面：街区的颗粒（一次纹理，按像素足迹选 mip，远处自然平均）+ 几条蜿蜒的高架干道，车流沿线流动
// （亮度按足迹带限：远处平均成匀速流动的光带）。不画规则的街网——60 km 外斜看，棋盘格读成一张发光的地图
vec3 fcGround(vec2 g, float fs, float fl, vec2 aL) {
  vec4 n = fcCarpetN(g, 0.5);
  vec4 cp = fcCarpet(g, n, 0.0);
  if (cp.a <= 0.0) return vec3(0.0);
  float t = uWonderParams.y;
  // 颗粒：一个纹素约 55 m（与 60–100 km 外的像素相当），足迹更大时取更粗的 mip
  float lod = clamp(log2(sqrt(fs * fl) / 0.055), 0.0, 6.0);
  float grain = textureLod(uShapeNoise, vec3(g / 7.0 + uWonderParams.z * 9.1, 0.13), lod).g;
  float base = 0.55 + 0.9 * smoothstep(0.3, 0.8, grain);
  // 干道：三族平行的蜿蜒线，间距 6–9 km，线宽 80 m
  float hw = 0.0;
  for (int k = 0; k < 3 + min(uStormCount, 0); k++) {
    float fk = float(k);
    float a = 0.4 + 1.9 * fk + uWonderParams.z * 3.0;
    vec2 nd = vec2(cos(a), sin(a));
    vec2 td = vec2(-nd.y, nd.x);
    float along = dot(g, td);
    float sp = 6.0 + 1.5 * fk;
    float u = dot(g, nd) + 0.9 * sin(along / 9.0 + fk * 2.1) + 0.25 * sin(along / 3.7 + fk);
    float F = fcFoot(nd, aL, fs, fl);
    float cov = fcLines(u, sp, F, 0.08);
    // 不是每条干道每一段都亮（按段落 hash 断续）；车流：沿线的虚线图样随时间平移（约 70 km/h），足迹比周期长时振幅淡出
    float seg = smoothstep(0.25, 0.45, fcHash(vec2(floor(u / sp + 0.5) + fk * 17.0, floor(along / 3.0))));
    float fA = fcFoot(td, aL, fs, fl);
    const float LAM = 0.35;
    float flow = 1.0 + 0.85 * exp(-4.0 * (fA / LAM) * (fA / LAM)) * cos(6.2832 * (along - (fk == 1.0 ? -0.02 : 0.02) * t) / LAM);
    hw += cov * seg * flow;
  }
  return cp.rgb * (0.6 * base + 4.0 * hw);
}
// 光束 i：光源（城市坐标）与方向（缓慢扫动）
void fcBeam(int i, out vec3 a, out vec3 b) {
  float fi = float(i);
  float t = uWonderParams.y;
  a = i == 0 ? vec3(FC_P1.x + 2.9, 0.05, FC_P1.y - 1.2) : i == 1 ? vec3(FC_P2.x - 2.5, 0.05, FC_P2.y + 1.6) : vec3(-10.0, 0.05, 7.5);
  // 周期 60 / 90 / 120 s（整除 3600，时间回绕时不跳）
  float P = 60.0 + 30.0 * fi;
  float ph = fract(fi * 0.37 + uWonderParams.z * 7.0);
  float az = 6.2832 * ph + 0.9 * sin(6.2832 * (t / P + ph));
  float tilt = 0.32 + 0.12 * sin(6.2832 * (t / (2.0 * P) + 0.3 * fi));
  b = vec3(sin(tilt) * cos(az), cos(tilt), sin(tilt) * sin(az));
}
// 点光：离视线最近处的高斯斑，半径按像素足迹展宽、总能量不变（远处变暗成一个像素的小点，不闪）
vec3 fcPoint(vec3 co, vec3 cd, vec3 p, float r, vec3 L, float pixAng, vec2 seg, inout float wT, inout float wL) {
  float tc = dot(p - co, cd);
  if (tc < seg.x || tc > seg.y) return vec3(0.0);
  vec3 dv = co + cd * tc - p;
  // r < 0：竖长的火舌（竖直方向 2.2 倍长）
  if (r < 0.0) { r = -r; dv.y /= 2.2; }
  float fp = 0.7 * tc * pixAng;
  float re2 = r * r + fp * fp;
  vec3 c = L * (r * r / re2) * exp(-dot(dv, dv) / re2);
  float l = fcLum(c);
  wT += l * tc;
  wL += l;
  return c;
}
// 软封顶：亮度超过 cap 的部分压缩（保留色相），远处发光体不截成白点
vec3 fcSoftCap(vec3 c, float cap) {
  float l = fcLum(c);
  return c * (cap / (cap + l));
}

void fcRay(vec3 o, vec3 d, vec2 seg, float pixAng, out vec4 e0, out vec4 e1, out vec4 e2) {
  e0 = vec4(0.0, 0.0, 0.0, 1e9);
  e1 = e0;
  e2 = e0;
  vec3 co = fcToCity(o), cd = fcToCity(d);
  float rev = uWonderParams.x;
  // 1. 雾下的地面（y = 0 平面）
  if (cd.y < -1e-4) {
    float tg = -co.y / cd.y;
    if (tg > seg.x && tg < seg.y + 1.0) {
      vec2 g = co.xz + cd.xz * tg;
      float fs = tg * pixAng;
      float fl = fs / max(-cd.y, 0.03);
      vec2 aL = normalize(cd.xz + vec2(1e-6));
      e0 = vec4(fcGround(g, fs, fl, aL), tg);
    }
  }
  // 2. 光穹：城市上空 0.6–4.5 km 的霾被灯海从下面照亮（光污染），沿视线取 3 个点。事件放在这段的前部，
  //    所以会盖在塔身前面（塔的上半截蒙一层橙色的霾，远而朦胧）。霾的消光约 0.03 /km、往上变稀
  vec2 hs = fcSlab(co.y, cd.y, 0.6, 4.5);
  hs = vec2(max(hs.x, seg.x), min(hs.y, seg.y));
  if (hs.y > hs.x) {
    float dtH = (hs.y - hs.x) / 3.0;
    vec3 hz = vec3(0.0);
    for (int i = 0; i < 3 + min(uStormCount, 0); i++) {
      vec3 p = co + cd * (hs.x + (float(i) + 0.5) * dtH);
      vec2 e = p.xz / vec2(FC_R, FC_R * 0.8);
      vec4 hn = fcCarpetN(p.xz, 3.5);
      vec3 col = mix(FC_SODIUM, FC_CYAN, 0.35 * smoothstep(0.6, 0.82, hn.b));
      hz += col * (0.4 + 1.2 * hn.r) * exp(-dot(e, e) * 1.1) * 0.008 * exp(-(p.y - 0.6) / 1.4) * dtH;
    }
    // 散射：σ·反照率·E/4π，E ≈ π·Lg（城上空）
    e1 = vec4(hz * FC_LG * 0.9 * 0.25 * smoothstep(0.0, 0.5, rev), hs.x + 0.25 * (hs.y - hs.x));
  }
  float on = smoothstep(0.5, 0.8, rev);
  if (on <= 0.0) return;
  // 3. 探照光束：均匀雾里一束细光的单次散射线积分（Sun et al. 2005 的思路，这里光束比像素细，按高斯截面解析积分）：
  //    L = Φ·σ·p(θ)·exp(−r²/R²) / (√π·R·sinα)。R 按像素足迹展宽（能量守恒，不闪），光束在雾里被衰减一部分
  vec3 bsum = vec3(0.0);
  float bT = 0.0, bL = 0.0;
  for (int i = 0; i < 3 + min(uStormCount, 0); i++) {
    vec3 a, b;
    fcBeam(i, a, b);
    vec3 w0 = co - a;
    float B = dot(cd, b), D = dot(cd, w0), E = dot(b, w0);
    float den = max(1.0 - B * B, 1e-4);
    float tc = (B * E - D) / den;
    float sc = (E - B * D) / den;
    if (sc < 0.0 || tc < seg.x || tc > seg.y) continue;
    vec3 p = a + b * sc;
    vec3 dv = co + cd * tc - p;
    float R = 0.035 + 0.006 * sc;
    float fp = 0.6 * tc * pixAng;
    float Re = sqrt(R * R + fp * fp);
    float sinA = max(sqrt(den), 0.12);
    float fogS = fcFogApprox(p);
    // 雾顶以上是城市的霾（消光约 0.07 /km，往上变稀），光束在霾里淡、在雾里亮
    float sig = fogS + 0.07 * exp(-p.y / 2.5) * smoothstep(48.0, 30.0, length(p.xz));
    // 相函数：雾滴前向散射强，横看时取一半各向同性
    float ct = dot(b, -cd);
    float ph = 0.5 / (4.0 * M_PI) + 0.5 * fcHg(ct, 0.6);
    float tauB = 0.35 * 1.3 * 1.6 * (1.0 - exp(-min(p.y, 1.7) / 1.6)) * fcMask(p.xz);
    float fade = smoothstep(6.8, 2.5, p.y);
    float Lb = (4.0 * FC_LG) * sig * ph * exp(-dot(dv, dv) / (Re * Re)) / (1.7725 * Re * sinA) * exp(-tauB) * fade;
    vec3 cb = vec3(0.85, 0.93, 1.0) * Lb;
    bsum += cb;
    bT += fcLum(cb) * tc;
    bL += fcLum(cb);
  }
  // 4. 点光：火球、金字塔顶的冷白灯、阶梯塔顶的红色障碍灯（和光束合成一个事件：两者很少落在同一个像素上）
  vec3 psum = vec3(0.0);
  float pT = 0.0, pL = 0.0;
  float time = uWonderParams.y;
  for (int i = 0; i < 6 + min(uStormCount, 0); i++) {
    vec3 ch = fcChimney(i);
    float age;
    float fl = fcFlare(i, age);
    vec3 fc = vec3(ch.x, ch.y + 0.1 + 0.25 * smoothstep(0.0, 1.5, age), ch.z);
    float r = 0.035 + 0.1 * smoothstep(0.0, 0.6, age) * step(0.2, fl);
    vec3 colF = mix(vec3(1.0, 0.25, 0.04), vec3(1.0, 0.55, 0.2), smoothstep(0.3, 1.0, fl));
    psum += fcPoint(co, cd, fc + vec3(0.0, r, 0.0), -r, colF * (60.0 * FC_LG) * fl, pixAng, seg, pT, pL);
  }
  // 塔顶：冷白（慢呼吸），阶梯塔顶：红色障碍灯（2 秒一闪）
  float breathe = 0.85 + 0.15 * sin(time * 0.7);
  psum += fcPoint(co, cd, vec3(FC_P1.x, FC_P1.w * 0.95 + 0.03, FC_P1.y), 0.03, vec3(0.75, 0.88, 1.0) * (30.0 * FC_LG) * breathe, pixAng, seg, pT, pL);
  psum += fcPoint(co, cd, vec3(FC_P2.x, FC_P2.w * 0.95 + 0.03, FC_P2.y), 0.03, vec3(0.75, 0.88, 1.0) * (25.0 * FC_LG) * breathe, pixAng, seg, pT, pL);
  float blink = smoothstep(0.55, 0.7, fract(time * 0.5)) * (1.0 - smoothstep(0.85, 1.0, fract(time * 0.5)));
  for (int i = 0; i < 4 + min(uStormCount, 0); i++) {
    vec4 td = fcTowerDef(i);
    psum += fcPoint(co, cd, vec3(td.x, td.w + 0.02, td.y), 0.02, vec3(1.0, 0.08, 0.04) * (12.0 * FC_LG) * (0.15 + 0.85 * blink), pixAng, seg, pT, pL);
  }
  if (pL + bL > 0.0) e2 = vec4(fcSoftCap((psum + bsum) * on, FC_CAP), (pT + bT) / (pL + bL));
}
`;
