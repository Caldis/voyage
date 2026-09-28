/**
 * 雾海灯城（W02，致敬《银翼杀手》开场；原创造型，不用任何官方资产）。云间层奇观，接口见 wonder-cloud.glsl.ts / handoff/W00.md。
 * 设计依据 research/WONDERS.md §3.5、C6；WS02 巨构化依据 research/WONDER_SCALE.md §3.2。
 *
 * 画面：夜里远方一片被灯海从下往上染橙的雾（发光介质，被前面的云挡、也挡住身后的云），雾海只是巨构脚下的纹理；
 * 从雾里拔起两座 14–16 km 高、6–8 级退台的巨型阶梯金字塔（每级台缘一圈灯，描出层数）、1–2 座 20–24 km 的三段收分尖塔
 * （塔顶冷白灯 + 红色障碍灯，塔身角上分段的红灯），塔顶高过巡航高度、衬在星空和光穹上（WS02：从 10.7 km 高处要「仰视」）；
 * 8–15 座 5–10 km 的退台高塔作为中间尺度层；城市上空被灯海照亮的霾与空气（光穹）在塔后面，把塔身勾成剪影；
 * 几架绕尖塔盘旋的航班（航行灯 + 频闪），就在我们这个高度：60 m 的飞机旁边是 20 km 的塔（已知尺度的参照物）。
 * 工业区的烟囱周期性喷火、把烟柱底部映红；几道缓慢扫动的探照光束（穿过雾时最明显）；雾下隐约的车流灯带。
 * 白天只剩一团偏黄褐的污浊霾与巨塔淡灰的剪影（自动出现只在夜里，见 catalog.ts）。
 *
 * 坐标：奇观局部坐标（km，x 东、y 天顶、z 南），再按本次出现的随机种子（uWonderParams.z）绕 y 轴转一个角度 = 「城市坐标」，
 * 同一座城每次出现朝向、河道、雾的纹理、金字塔的高度与级数、尖塔的座数与高度、高塔的数量与高度都不一样（随机性造就真实）。
 *
 * 分工（各函数只有一个调用点，由 wonder-cloud.glsl.ts 的分派函数调用）：
 *  - fcSdf / fcShade：金字塔、尖塔与退台高塔（表面）；
 *  - fcMedium：雾（灯海从下往上照亮）+ 烟柱（火光映红烟底）；
 *  - fcMediumSeg：介质只在「雾层 y < FC_FOG_MAX」加「工业区烟柱的包围盒」里步进（包围盒高 25 km 要装尖塔，雾只有 2 km）；
 *  - fcRay：解析的发光——雾下的灯海与车流（与 y = 0 平面求交）、光穹（塔前 / 塔后两段，塔后的一段才能勾出剪影）、
 *    探照光束（光束与视线的最近点，单次散射线积分的闭式解）、点光（火球、塔顶灯、障碍灯、航班），
 *    按像素足迹保持能量，远处自然平均成均匀亮度、不闪烁。
 *
 * 亮度量级（kcd/m²）：灯海地面平均约 3e-3（≈ 3 cd/m²，与 terrain-shading.glsl.ts 城市灯点市中心同一量级）；
 * 雾 ≈ 反照率 × 地面亮度 / 4 ≈ 5e-4；点光与光束按「雾最亮处的几倍」软封顶（W01b 的教训：远处发光体不截白、不像霓虹）。
 */

export const CITY_GLSL = /* glsl */ `
const float FC_R = 33.0;           // 城区椭圆的长半轴（km）；短半轴 × 0.8
const float FC_FOG_MAX = 2.4;      // 雾顶最高处（km）
const float FC_LG = 2.5e-3;        // 灯海的地面平均辐亮度基准（kcd/m²）；其余发光都按它的倍数定（自动曝光会把整体拉回来，要紧的是相对亮度）
const vec3 FC_IND = vec3(19.0, 0.0, 9.0);   // 工业区中心（城市坐标）：烟囱都在这附近
const float FC_IND_R = 8.5;        // 工业区（烟柱包围盒）半径
const float FC_PLUME_TOP = 5.6;    // 烟柱最高处
const float FC_CAP = 5.0 * FC_LG;  // 点光 / 光束的软封顶（约雾最亮处的 8 倍）：远处的火与灯是亮的橙 / 冷白，不截成白点
const float FC_EDGE = 43.5;        // 雾与光穹在这个半径（km）以内衰减到 0；包围盒 ±46 km（盒边不能切出硬边，WS02）
// 两座金字塔：中心 xz、底边半宽（km）；高 14–16 km、级数 6–8 按种子取（fcZigDef）
const vec3 FC_P1 = vec3(-7.0, 4.5, 6.0);
const vec3 FC_P2 = vec3(8.5, -5.0, 5.0);

// 钠灯橙与冷青（按 Rec.709 亮度归一）
const vec3 FC_SODIUM = vec3(1.0, 0.4, 0.08) / (0.2126 + 0.7152 * 0.4 + 0.0722 * 0.08);
const vec3 FC_CYAN = vec3(0.40, 0.82, 1.0) / (0.2126 * 0.40 + 0.7152 * 0.82 + 0.0722);

float fcHash(vec2 p) {
  vec3 p3 = fract(vec3(p.xyx) * 0.1031);
  p3 += dot(p3, p3.yzx + 33.33);
  return fract((p3.x + p3.y) * p3.z);
}
// 本次出现的随机数（按种子）
float fcRnd(float x) { return fcHash(vec2(x, uWonderParams.z * 97.31 + 3.7)); }
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

// 城区范围（0..1）：椭圆，边界按方位起伏（不是正圆），从 0.1 R 起一路渐隐到 1.25 R（市中心密、郊区稀；
// WS02：原来 0.3–1.0 R，近边在屏幕上只有十几像素的过渡，雾盘读成一只有硬边的盘子）
float fcMask(vec2 c) {
  vec2 e = c / vec2(FC_R, FC_R * 0.8);
  float r = length(e);
  float ang = atan(e.y, e.x);
  float sd = uWonderParams.z * 40.0;
  float wob = 0.12 * sin(ang * 3.0 + sd) + 0.07 * sin(ang * 7.0 + 1.3 * sd) + 0.04 * sin(ang * 13.0 + 2.1);
  return (1.0 - smoothstep(0.1, 1.25, r + wob)) * smoothstep(FC_EDGE, FC_EDGE - 6.0, length(c));
}
// 城外的霾裙（0..1）：灯海的光漫出去，外缘 15–20 km 渐隐、被低频噪声打散（WS02：去掉「一盘发光液体」的硬边），
// FC_EDGE 以外为 0（包围盒不切边）。nLow：低频噪声（0..1）
float fcSkirt(vec2 c, float nLow) {
  vec2 e = c / vec2(FC_R, FC_R * 0.8);
  float r = length(e) + 0.45 * (nLow - 0.5);
  return exp(-r * r * 1.1) * smoothstep(1.35, 0.7, r) * smoothstep(FC_EDGE, FC_EDGE - 8.0, length(c));
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
  // 城区边缘被低频噪声吃掉一些（与 fcMedium 的雾同一个通道 G，灯与雾一起收）：边界不是一条光滑的椭圆
  m *= mix(1.0, smoothstep(0.1, 0.6, n.g), 1.0 - m);
  float district = 0.45 + 1.0 * smoothstep(0.22, 0.8, n.r);
  float parks = mix(0.35, 1.0, smoothstep(0.28, 0.46, n.g));
  float riv = mix(0.2, 1.0, smoothstep(0.15 + 1.2 * blur, 0.7 + 1.8 * blur, fcRiver(c)));
  // 两座金字塔脚下最亮（塔的剪影压在最亮的雾上），工业区暗（只有火光）
  vec2 d1 = c - FC_P1.xy, d2 = c - FC_P2.xy, di = c - FC_IND.xz;
  float hot = 1.0 + 0.7 * exp(-dot(d1, d1) / 40.0) + 0.6 * exp(-dot(d2, d2) / 30.0);
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

// ---------------- 表面：金字塔、尖塔与退台高塔 ----------------
// 方截锥的一段：底在 y0、高 h、底半宽 wb、每升高 1 km 半宽收 k km。返回到表面距离的下界
// （斜面按水平偏离 × 斜面法线的水平分量；段外的点用段端的宽度，拐角按 Chebyshev——都只会偏小，球面追踪安全）
float fcFrustum(vec3 p, float y0, float h, float wb, float k) {
  float w = wb - k * clamp(p.y - y0, 0.0, h);
  vec2 q = abs(p.xz) - w;
  float dh = length(max(q, 0.0)) + min(max(q.x, q.y), 0.0);
  return max(dh * inversesqrt(1.0 + k * k), max(p.y - y0 - h, y0 - p.y));
}
// 金字塔 i 的形状（按种子）：x 总高 H（14–16 km）、y 级数 N（6–8）、z 每级斜面的水平收进 a、w 每级高 hk。
// 每级是同坡度的截锥，顶上往里退一圈台面（宽 0.6a）；顶台半宽 0.12 W
vec4 fcZigDef(int i) {
  float fi = float(i);
  float W = i == 0 ? FC_P1.z : FC_P2.z;
  float H = (i == 0 ? 14.5 : 14.0) + (i == 0 ? 1.5 : 1.3) * fcRnd(fi + 1.3);
  float N = 6.0 + floor(2.999 * fcRnd(fi + 7.1));
  float a = W * 0.88 / (1.6 * N - 0.6);
  return vec4(H, N, a, H / N);
}
// 阶梯金字塔：p 相对塔底中心，W 底边半宽，zd = fcZigDef
float fcZiggurat(vec3 p, float W, vec4 zd) {
  float H = zd.x, N = zd.y, a = zd.z, hk = zd.w;
  // 包围球外直接返回下界（大多数视线离塔很远）
  float bound = length(p - vec3(0.0, 0.45 * H, 0.0)) - length(vec2(1.42 * W, 0.55 * H));
  if (bound > 1.0) return bound;
  // 包络截锥（底半宽 W + 0.6a、顶半宽 0.12W + a：装得下每一级的台缘，推导见 handoff/WS02.md），离得远时用它
  float we0 = W + 0.6 * a, weT = 0.12 * W + a;
  float dEnv = fcFrustum(p, 0.0, H, we0, (we0 - weT) / H);
  if (dEnv > 0.6) return dEnv;
  // 近处：只算点所在的一级和上下相邻的两级
  float k = a / hk;
  float kc = clamp(floor(p.y / hk), 0.0, N - 1.0);
  float k0 = max(kc - 1.0, 0.0), k1 = kc, k2 = min(kc + 1.0, N - 1.0);
  float d = fcFrustum(p, k0 * hk, hk, W - 1.6 * a * k0, k);
  d = min(d, fcFrustum(p, k1 * hk, hk, W - 1.6 * a * k1, k));
  d = min(d, fcFrustum(p, k2 * hk, hk, W - 1.6 * a * k2, k));
  return d;
}
// 尖塔 i（1–2 座，第二座按种子有无）：城市坐标 x、z、底半宽（1.5–2 km）、总高（20–24 km，含顶上的桅杆）
vec4 fcSpireDef(int i) {
  float fi = float(i);
  vec2 pos = i == 0 ? vec2(1.0, 1.0) : vec2(-2.5, -11.0);
  float H = (i == 0 ? 21.0 : 20.0) + (i == 0 ? 3.0 : 2.0) * fcRnd(fi + 21.7);
  float w = 1.5 + 0.5 * fcRnd(fi + 3.9);
  return vec4(pos, w, H);
}
float fcSpireCount() { return fcRnd(11.3) > 0.4 ? 2.0 : 1.0; }
// 三段收分的方塔（每段之间退进一圈），顶上一根细桅杆。p 相对塔底中心
float fcSpire(vec3 p, float w, float H) {
  float bound = length(p - vec3(0.0, 0.5 * H, 0.0)) - length(vec2(1.42 * w, 0.5 * H));
  if (bound > 1.0) return bound;
  float h1 = 0.46 * H, h2 = 0.29 * H, h3 = 0.17 * H;
  float d = fcFrustum(p, 0.0, h1, w, 0.2 * w / h1);
  d = min(d, fcFrustum(p, h1, h2, 0.7 * w, 0.2 * w / h2));
  d = min(d, fcFrustum(p, h1 + h2, h3, 0.42 * w, 0.2 * w / h3));
  float y3 = h1 + h2 + h3;
  float mast = max(length(p.xz) - 0.05, abs(p.y - 0.5 * (y3 + H)) - 0.5 * (H - y3));
  return min(d, mast);
}
float fcBox(vec3 p, vec3 b) {
  vec3 q = abs(p) - b;
  return length(max(q, 0.0)) + min(max(q.x, max(q.y, q.z)), 0.0);
}
// 退台高塔：三层方盒，逐层收小。p 相对塔底中心；w 底层半宽、h 总高
float fcTower(vec3 p, float w, float h) {
  float bound = length(p - vec3(0.0, 0.5 * h, 0.0)) - (0.5 * h + 1.5 * w);
  if (bound > 0.5) return bound;
  float a = fcBox(p - vec3(0.0, 0.28 * h, 0.0), vec3(w, 0.28 * h, w * 0.85));
  float b = fcBox(p - vec3(0.0, 0.68 * h, 0.0), vec3(0.7 * w, 0.12 * h, 0.6 * w));
  float c = fcBox(p - vec3(0.0, 0.9 * h, 0.0), vec3(0.42 * w, 0.1 * h, 0.36 * w));
  return min(a, min(b, c));
}
// 高塔的位置表（城市坐标，手工避开金字塔、尖塔与工业区；整体随城市一起按种子转）。本次出现取前 8–15 座
const int FC_TOWERS = 15;
vec2 fcTowerPos(int i) {
  return i == 0 ? vec2(-20.0, -6.0) : i == 1 ? vec2(-16.0, 14.0) : i == 2 ? vec2(-4.0, 17.0) : i == 3 ? vec2(6.0, 13.0)
       : i == 4 ? vec2(13.5, 4.0) : i == 5 ? vec2(-11.0, -9.0) : i == 6 ? vec2(-19.0, 3.0) : i == 7 ? vec2(3.0, -17.0)
       : i == 8 ? vec2(15.0, -15.0) : i == 9 ? vec2(23.0, -4.0) : i == 10 ? vec2(-25.0, 9.0) : i == 11 ? vec2(-8.0, 22.0)
       : i == 12 ? vec2(9.0, 21.0) : i == 13 ? vec2(-15.0, -17.0) : vec2(26.0, 16.0);
}
float fcTowerCount() { return 8.0 + floor(7.999 * fcRnd(5.5)); }
// 塔 i：城市坐标 x、z、底层半宽（0.45–0.8 km）、总高（5–10 km）
vec4 fcTowerDef(int i) {
  float fi = float(i);
  float h = fcRnd(fi * 1.37 + 31.0);
  return vec4(fcTowerPos(i), 0.45 + 0.35 * fcRnd(fi * 2.11 + 17.0), 5.0 + 5.0 * h * h);
}
float fcSdf(vec3 q) {
  vec3 c = fcToCity(q);
  float d1 = fcZiggurat(c - vec3(FC_P1.x, 0.0, FC_P1.y), FC_P1.z, fcZigDef(0));
  float d2 = fcZiggurat(c - vec3(FC_P2.x, 0.0, FC_P2.y), FC_P2.z, fcZigDef(1));
  float dp = min(d1, d2);
  float ds = 1e9;
  float ns = fcSpireCount();
  for (int i = 0; i < 2 + min(uStormCount, 0); i++) {
    if (float(i) >= ns) break;
    vec4 sd = fcSpireDef(i);
    ds = min(ds, fcSpire(c - vec3(sd.x, 0.0, sd.y), sd.z, sd.w));
  }
  // 高塔群：先对整片塔群的包围柱（半径 28、高 10.5）早退
  float dt = max(length(c.xz) - 28.5, c.y - 10.5);
  if (dt < 1.0) {
    dt = 1e9;
    float nt = fcTowerCount();
    for (int i = 0; i < FC_TOWERS + min(uStormCount, 0); i++) {
      if (float(i) >= nt) break;
      vec4 td = fcTowerDef(i);
      dt = min(dt, fcTower(c - vec3(td.x, 0.0, td.y), td.z, td.w));
    }
  }
  gWonderMat = dt < min(dp, ds) ? 1.0 : ds < dp ? 2.0 : 0.0;
  return min(dp, min(ds, dt));
}

// 一串灯（沿 u 每 sp 一盏、灯宽 w）在足迹 F 下的覆盖率，归一到平均 1（远处平均成一条均匀的光线，不闪）
float fcLamps(float u, float sp, float F, float w) {
  float dd = (fract(u / sp + 0.5) - 0.5) * sp;
  float ww = max(F, w);
  float cov = w / ww * max(0.0, 1.0 - abs(dd) / ww);
  return mix(cov, w / sp, smoothstep(0.12 * sp, 0.35 * sp, F)) * (sp / w);
}

// 表面着色：暗色的巨构（反照率 7%），白天 / 月光按标准受光；夜里被下方发光的雾从下面照亮一点（仍比雾暗得多，读成剪影）；
// 斜面上稀疏的横向暗橙灯带（大多数楼层是黑的：「几乎没有窗户」）；金字塔每级台缘一圈灯、尖塔角上分段的红色障碍灯（WS02）
vec3 fcShade(vec3 q, vec3 nq, vec3 pW, vec3 nW, vec3 rd) {
  vec3 c = fcToCity(q);
  // 法线也转到城市坐标（塔都按城市坐标轴摆，判断「哪一面」要用城市坐标的法线；W02 原来用局部坐标的法线，窗格沿错的轴拉长）
  vec3 n = fcToCity(nq);
  float mat = gWonderMat;
  vec3 alb = mat > 1.5 ? vec3(0.08, 0.08, 0.085) : mat > 0.5 ? vec3(0.075, 0.072, 0.07) : vec3(0.07, 0.066, 0.06);
  vec3 L = wonderLitSurface(pW, nW, alb); if (uWonderParams.w > 0.5 && uWonderParams.w < 1.5) return vec3(0.0); if (abs(uWonderParams.w - 3.0) < 0.5) return L; // WS02DBG
  // 下方雾的辉光：雾顶的亮度约 反照率 × 灯海 / 4 ≈ 0.15 × 灯海，竖直面看到的是半个下半球（π·Lf/2），反照 alb/π：
  // ≈ alb × 灯海 × 0.05 × 朝下的比例；越高看到的发光雾盘张角越小（城区半径约 30 km）。WS02：原来 0.15 偏亮 3 倍，塔面比身后的光穹还亮、剪影没了
  vec4 cp = fcCarpet(c.xz, fcCarpetN(c.xz, 2.5), 1.0);
  float inFog = smoothstep(2.0, 0.6, c.y);
  float hg = 1.0 / (1.0 + (c.y / 24.0) * (c.y / 24.0));
  L += alb * cp.rgb * 0.05 * (0.5 - 0.5 * n.y + 0.3 * inFog) * hg * (0.4 + 0.6 * exp(-c.y / 3.0)); if (abs(uWonderParams.w - 4.0) < 0.5) return L; // WS02DBG
  // 像素足迹（全分辨率；uCloudResolution 在奇观 pass 里声明得更晚）；掠射时按入射角放大
  float t = length(pW - vec3(0.0, uCamR, 0.0));
  float fp = t * 2.0 * uTanHalfFov / uResolution.y;
  float fpS = fp / max(abs(dot(nW, rd)), 0.25);
  float onW = smoothstep(0.3, 0.7, uWonderParams.x);
  // 窗：楼层 130 m 一层（层线按像素足迹做帐篷核，远处平均），亮不亮按「2 层 × 一格」的窗块取（金字塔一格 260 m、塔 240 m），
  // 只有 5–8% 的窗块亮着（「几乎没有窗户」）：110 km 外一个窗块约 3 × 3 像素，读成稀疏的暖色窗格而不是一层均匀的底光（WS02）；
  // 窗块边缘按足迹软收，足迹大过半个窗块才退回平均值（不闪）
  float band = c.y / 0.13;
  float dy = abs(band - floor(band + 0.5)) * 0.13;
  float fy = max(fp * 1.3, 0.02);
  float cov = 0.02 / fy * max(0.0, 1.0 - dy / fy);
  cov = mix(cov, 0.02 / 0.13, smoothstep(0.035, 0.065, fy));
  float cw = mat > 0.5 ? 0.24 : 0.26;
  float u = (abs(n.x) > abs(n.z) ? c.z : c.x) / cw;
  float v = c.y / 0.26;
  float litFrac = mat > 0.5 ? 0.08 : 0.05;
  float lit = step(fcHash(vec2(floor(v) * 1.37 + mat * 31.0 + uWonderParams.z * 13.0, floor(u))), litFrac);
  float fu = fract(u), fv = fract(v);
  lit *= clamp(min(fu, 1.0 - fu) * cw / max(fp, 1e-3) + 0.5, 0.0, 1.0) * clamp(min(fv, 1.0 - fv) * 0.26 / max(fp, 1e-3) + 0.5, 0.0, 1.0);
  lit = mix(lit, litFrac, smoothstep(0.35 * cw, 0.6 * cw, fp));
  float side = 1.0 - smoothstep(0.55, 0.85, n.y);
  L += FC_SODIUM * (0.7 * FC_LG) * cov * lit * onW * smoothstep(0.1, 0.25, c.y) * side; if (abs(uWonderParams.w - 5.0) < 0.5) return L; // WS02DBG
  float fpp = max(fpS, 0.012);
  if (mat < 0.5) {
    // 金字塔：每一级斜面顶端（台缘下 20 m）一圈暖白的灯，每 180 m 一盏
    bool first = dot(c.xz - FC_P1.xy, c.xz - FC_P1.xy) < dot(c.xz - FC_P2.xy, c.xz - FC_P2.xy);
    vec3 pc = c - (first ? vec3(FC_P1.x, 0.0, FC_P1.y) : vec3(FC_P2.x, 0.0, FC_P2.y));
    vec4 zd = fcZigDef(first ? 0 : 1);
    float kb = floor(pc.y / zd.w + 0.5);
    float yb = kb * zd.w - 0.02;
    float ring = 0.03 / max(fpp, 0.03) * max(0.0, 1.0 - abs(pc.y - yb) / max(fpp, 0.03));
    float pu = abs(pc.x) > abs(pc.z) ? pc.z : pc.x;
    ring *= fcLamps(pu, 0.18, fpS, 0.05) * step(0.5, kb) * step(kb, zd.y + 0.5) * side;
    // 灯圈按 1.1 km 一段随机缺一些（约三成暗着），段端按足迹软收，足迹大于段长的一半后退回平均值
    float sg = pu / 1.1;
    float sgOn = step(0.3, fcHash(vec2(floor(sg) + 17.0 * kb, zd.x + (first ? 0.0 : 7.0))));
    float sgF = fract(sg);
    sgOn *= clamp(min(sgF, 1.0 - sgF) * 1.1 / max(fpS, 1e-3) + 0.5, 0.0, 1.0);
    ring *= mix(sgOn, 0.7, smoothstep(0.25, 0.55, fpS / 1.1));
    L += vec3(1.0, 0.72, 0.45) * (1.8 * FC_LG) * ring * onW;
  } else if (mat > 1.5) {
    // 尖塔：四角在 30% / 55% / 80% 高处各一盏红色障碍灯（和塔顶的红灯同步 2 秒一闪）；竖向的肋（远处平均掉）
    float ns = fcSpireCount();
    vec4 sd = fcSpireDef(0);
    if (ns > 1.5) {
      vec4 s2 = fcSpireDef(1);
      if (dot(c.xz - s2.xy, c.xz - s2.xy) < dot(c.xz - sd.xy, c.xz - sd.xy)) sd = s2;
    }
    vec3 pc = c - vec3(sd.x, 0.0, sd.y);
    float ya = pc.y / sd.w;
    float yj = ya < 0.425 ? 0.3 : ya < 0.675 ? 0.55 : 0.8;
    float cd = abs(abs(pc.x) - abs(pc.z));   // 到竖直棱线的距离（在面上）
    float ob = max(fpp, 0.04);
    float lamp = (0.04 / ob) * (0.04 / ob) * max(0.0, 1.0 - length(vec2(cd, pc.y - yj * sd.w)) / ob);
    float time = uWonderParams.y;
    float blink = smoothstep(0.55, 0.7, fract(time * 0.5)) * (1.0 - smoothstep(0.85, 1.0, fract(time * 0.5)));
    L += vec3(1.0, 0.08, 0.04) * (40.0 * FC_LG) * lamp * (0.15 + 0.85 * blink) * onW;
    // 肋：每 60 m 一道浅缝，足迹大于 40 m 时平均掉
    float rib = abs(fract((abs(n.x) > abs(n.z) ? pc.z : pc.x) / 0.06) - 0.5);
    L *= mix(0.85 + 0.3 * smoothstep(0.15, 0.35, rib), 1.0, smoothstep(0.02, 0.04, fp));
  }
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
  if (m <= 0.0 && !inInd && dot(c.xz, c.xz) > FC_EDGE * FC_EDGE) return 0.0;
  float t = uWonderParams.y;
  // 雾：3D 噪声（云的形状噪声）一次；A 通道给大块的疏处（能透见下面的灯带）
  vec4 nc = fcCarpetN(c.xz, 2.5);
  vec4 nf = textureLod(uShapeNoise, vec3(c.xz / 15.0 + vec2(t * 0.00025, 0.0), c.y / 5.0) + uWonderParams.z * 5.3, 1.0);
  vec2 d1 = c.xz - FC_P1.xy, d2 = c.xz - FC_P2.xy;
  // 标高：0.35–1.0 km 随地点起伏，塔脚下的热岛把雾顶起来一点
  float H = 0.35 + 0.65 * nf.g + 0.3 * exp(-dot(d1, d1) / 45.0) + 0.25 * exp(-dot(d2, d2) / 35.0);
  float billow = smoothstep(0.2, 0.8, nf.r);
  float holes = mix(0.25, 1.0, smoothstep(0.3, 0.55, nc.a));
  float reveal = mix(0.3, 1.0, smoothstep(0.0, 0.6, uWonderParams.x));
  // 城外一圈稀薄的霾裙（灯海的光漫出去）：外缘 15–20 km 渐隐、低频噪声打散边界；城区的雾也按同一低频噪声吃掉一部分边缘
  float sk = fcSkirt(c.xz, nc.g);
  float mf = max(m * mix(1.0, smoothstep(0.1, 0.6, nc.g), 1.0 - m), 0.3 * sk);
  float col = (0.3 + 0.9 * billow) * holes;
  float sFog = 1.9 * mf * col * exp(-c.y / H) * smoothstep(FC_FOG_MAX, FC_FOG_MAX - 0.8, c.y) * reveal;
  // 灯海从下往上照：地面是亮度 Lg 的朗伯发光面，上方的照度 ≈ π·Lg，被下面的雾挡掉一部分（多次散射把光留在雾里，只挡一部分）：
  // 雾厚的地方（鼓起的雾团）顶上暗、薄处亮，雾因此有体积感；城外的霾裙由城里漫出来的光照亮
  vec4 cp = fcCarpet(c.xz, nc, 1.0);
  vec3 src = cp.rgb + FC_SODIUM * (0.35 * FC_LG) * sk * smoothstep(0.0, 0.5, uWonderParams.x);
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
vec3 fcGround(vec2 g, float fs, float fl, vec2 aL, float tg) {
  vec4 n = fcCarpetN(g, 0.5);
  vec4 cp = fcCarpet(g, n, 0.0);
  if (cp.a <= 0.0) return vec3(0.0);
  float t = uWonderParams.y;
  // 颗粒：一个纹素约 55 m（与 60–100 km 外的像素相当），足迹更大时取更粗的 mip
  float lod = clamp(log2(sqrt(fs * fl) / 0.055), 0.0, 6.0);
  float grain = textureLod(uShapeNoise, vec3(g / 7.0 + uWonderParams.z * 9.1, 0.13), lod).g;
  float base = 0.55 + 0.9 * smoothstep(0.3, 0.8, grain);
  // 车流光痕（协调者返工）：被雾吃掉，只在雾的疏处（与 fcMedium 的 holes 同一个通道 A）、城区里面露出来；
  // 一段 1.4 km 左右、按段随机亮一半、两端软收，线形略弯，横向用 120 m 的软核（能量不变，只是边缘软）；
  // 离得越远越淡（90 km 外基本没有），不画贯穿画面的长直线
  float thin = 1.0 - smoothstep(0.3, 0.5, n.a);
  float far = 1.0 - smoothstep(60.0, 95.0, tg);
  float gate = thin * thin * smoothstep(0.35, 0.8, fcMask(g)) * far;
  float hw = 0.0;
  if (gate > 0.0) {
    for (int k = 0; k < 3 + min(uStormCount, 0); k++) {
      float fk = float(k);
      float a = 0.4 + 1.9 * fk + uWonderParams.z * 3.0;
      vec2 nd = vec2(cos(a), sin(a));
      vec2 td = vec2(-nd.y, nd.x);
      float along = dot(g, td);
      float sp = 4.0 + 1.3 * fk;
      float u = dot(g, nd) + 0.9 * sin(along / 9.0 + fk * 2.1) + 0.3 * sin(along / 1.9 + fk * 3.3);
      float F = fcFoot(nd, aL, fs, fl);
      float cov = fcLines(u, sp, max(F, 0.12), 0.06);
      // 分段：每段约 1.4 km，一半亮，两端 0.3 段长软收；足迹比段长大时退回平均值（不闪）
      const float SEGL = 1.4;
      float sx = along / SEGL + fcHash(vec2(floor(u / sp + 0.5), fk)) * 7.0;
      float si = floor(sx), sf = fract(sx);
      float on = step(0.5, fcHash(vec2(si + fk * 31.0, floor(u / sp + 0.5))));
      float fA = fcFoot(td, aL, fs, fl);
      float segOn = mix(on * smoothstep(0.0, 0.3, sf) * smoothstep(1.0, 0.7, sf), 0.35, smoothstep(0.2, 0.6, fA / SEGL));
      const float LAM = 0.35;
      float flow = 1.0 + 0.85 * exp(-4.0 * (fA / LAM) * (fA / LAM)) * cos(6.2832 * (along - (fk == 1.0 ? -0.02 : 0.02) * t) / LAM);
      hw += cov * segOn * flow;
    }
  }
  hw *= gate;
  // WS02：城边的雾变薄，郊区的灯更稀：地面按城区范围再收一次（亮度 ∝ m²，雾 ∝ m），不在雾盘近边露出一条亮带
  return cp.rgb * (0.6 * base + 4.0 * hw) * smoothstep(0.0, 0.55, fcMask(g));
}
// 光束 i：光源（城市坐标）与方向（缓慢扫动）。光源在金字塔第一级台缘的角上（WS02：塔顶已高到 14 km，光束只在低空的霾里亮）
void fcBeam(int i, out vec3 a, out vec3 b) {
  float fi = float(i);
  float t = uWonderParams.y;
  if (i < 2) {
    vec3 P = i == 0 ? FC_P1 : FC_P2;
    vec4 zd = fcZigDef(i);
    float wl = P.z - zd.z - 0.15;
    a = vec3(P.x + (i == 0 ? wl : -wl), zd.w, P.y + wl);
  } else {
    a = vec3(-20.0, 0.05, 12.0);
  }
  // 周期 60 / 90 / 120 s（整除 3600，时间回绕时不跳）
  float P = 60.0 + 30.0 * fi;
  float ph = fract(fi * 0.37 + uWonderParams.z * 7.0);
  float az = 6.2832 * ph + 0.9 * sin(6.2832 * (t / P + ph));
  float tilt = 0.72 + 0.12 * sin(6.2832 * (t / (2.0 * P) + 0.3 * fi));
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
  vec3 co = fcToCity(o), cd = fcToCity(d); if (abs(uWonderParams.w - 6.0) < 0.5) return; // WS02DBG
  float rev = uWonderParams.x;
  // 1. 雾下的地面（y = 0 平面）
  bool ground = false;
  if (cd.y < -1e-4) {
    float tg = -co.y / cd.y;
    if (tg > seg.x && tg < seg.y + 1.0) {
      vec2 g = co.xz + cd.xz * tg;
      float fs = tg * pixAng;
      float fl = fs / max(-cd.y, 0.03);
      vec2 aL = normalize(cd.xz + vec2(1e-6));
      e0 = vec4(fcGround(g, fs, fl, aL, tg), tg);
      ground = true;
    }
  }
  // 2. 光穹：城市上空被灯海从下面照亮的霾（0.4–4.5 km，消光约 0.008 /km）与空气（标高 6 km，约 0.0025 /km，
  //    瑞利 + 薄气溶胶），沿视线取 6 个点。WS02：分成塔前 / 塔后两段（以视线离城心最近处为界）——塔后的一段在塔身后面，
  //    把高出雾海的塔身勾成剪影；塔前的一段给塔蒙一层远而朦胧的橙霾。上方被照亮的程度按雾盘张角随高度衰减
  vec2 hs = fcSlab(co.y, cd.y, 0.4, 16.0);
  hs = vec2(max(hs.x, seg.x), min(hs.y, seg.y));
  if (hs.y > hs.x) {
    float dtH = (hs.y - hs.x) / 6.0;
    vec2 hd = cd.xz;
    float tMid = -dot(co.xz, hd) / max(dot(hd, hd), 1e-6);
    vec3 hzF = vec3(0.0), hzB = vec3(0.0);
    float tF = 0.0, wF = 0.0, tB = 0.0, wB = 0.0;
    for (int i = 0; i < 6 + min(uStormCount, 0); i++) {
      float ts = hs.x + (float(i) + 0.5) * dtH;
      vec3 p = co + cd * ts;
      vec4 hn = fcCarpetN(p.xz, 3.5);
      vec3 col = mix(FC_SODIUM, FC_CYAN, 0.35 * smoothstep(0.6, 0.82, hn.b));
      float haze = 0.008 * (0.4 + 1.2 * hn.r) * exp(-max(p.y - 0.6, 0.0) / 1.4);
      // 空气一项在 slab 顶（16 km）以前平滑收到 0（不然光穹在 slab 顶有一道横边），并向城心集中（光穹是个穹，不是一堵墙）
      vec2 ec = p.xz / vec2(FC_R, FC_R * 0.8);
      float air = 0.005 * exp(-p.y / 3.5) * smoothstep(16.0, 8.0, p.y) * exp(-dot(ec, ec) * 1.2);
      float irr = 1.0 / (1.0 + (p.y / 26.0) * (p.y / 26.0));
      vec3 s = col * (haze + air) * fcSkirt(p.xz, hn.g) * irr * dtH;
      float l = fcLum(s);
      if (ts < tMid) { hzF += s; tF += l * ts; wF += l; }
      else { hzB += s; tB += l * ts; wB += l; }
    }
    // 散射：σ·反照率·E/4π，E ≈ π·Lg（城上空）
    float k = FC_LG * 0.9 * 0.25 * smoothstep(0.0, 0.5, rev);
    if (wF > 0.0 && abs(uWonderParams.w - 2.0) > 0.5) e1 = vec4(hzF * k, tF / wF); // WS02DBG
    // 塔后的一段放进地面事件：有地面时插在地面处（被雾挡掉，雾里本来就看不出它），没有地面时插在它自己的深度
    if (wB > 0.0) e0 = vec4(e0.rgb + hzB * k, ground ? e0.w : tB / wB);
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
    float R = 0.05 + 0.021 * sc;   // 锥形：半角约 1.2°
    float fp = 1.5 * tc * pixAng;
    float Re = sqrt(R * R + fp * fp);
    float sinA = max(sqrt(den), 0.4);
    float fogS = fcFogApprox(p);
    // 雾顶以上是城市的霾（消光约 0.07 /km，往上变稀），光束在霾里淡、在雾里亮
    float sig = fogS + 0.07 * exp(-p.y / 2.5) * smoothstep(48.0, 30.0, length(p.xz));
    // 相函数：雾滴前向散射强，横看时取一半各向同性
    float ct = dot(b, -cd);
    float ph = 0.6 / (4.0 * M_PI) + 0.4 * fcHg(ct, 0.3);
    float tauB = 0.35 * 1.3 * 1.6 * (1.0 - exp(-min(p.y, 1.7) / 1.6)) * fcMask(p.xz);
    // 水平方向上朝相机这一侧打的光束，在画面上是从塔往下的一根亮线（近处的点在画面更低处）：扫到这一侧时渐隐
    float toCam = dot(normalize(b.xz + vec2(1e-6)), -normalize(cd.xz + vec2(1e-6)));
    float fade = smoothstep(6.8, 2.5, p.y) * smoothstep(0.0, 0.4, sc) * (1.0 - smoothstep(0.35, 0.75, ct)) * (1.0 - smoothstep(0.0, 0.45, toCam));
    float Lb = (4.0 * FC_LG) * sig * ph * exp(-dot(dv, dv) / (Re * Re)) / (1.7725 * Re * sinA) * exp(-tauB) * fade;
    vec3 cb = vec3(0.92, 0.9, 0.84) * Lb;
    bsum += cb;
    bT += fcLum(cb) * tc;
    bL += fcLum(cb);
  }
  // 4. 点光：火球、金字塔顶的冷白灯、尖塔顶的冷白灯 + 红灯、高塔顶的红色障碍灯、绕塔的航班（和光束合成一个事件：两者很少落在同一个像素上）
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
  // 塔顶：冷白（慢呼吸）；障碍灯：红色（2 秒一闪）
  float breathe = 0.85 + 0.15 * sin(time * 0.7);
  float blink = smoothstep(0.55, 0.7, fract(time * 0.5)) * (1.0 - smoothstep(0.85, 1.0, fract(time * 0.5)));
  vec3 cold = vec3(0.75, 0.88, 1.0);
  vec3 red = vec3(1.0, 0.08, 0.04);
  psum += fcPoint(co, cd, vec3(FC_P1.x, fcZigDef(0).x + 0.04, FC_P1.y), 0.04, cold * (30.0 * FC_LG) * breathe, pixAng, seg, pT, pL);
  psum += fcPoint(co, cd, vec3(FC_P2.x, fcZigDef(1).x + 0.04, FC_P2.y), 0.04, cold * (25.0 * FC_LG) * breathe, pixAng, seg, pT, pL);
  float ns = fcSpireCount();
  for (int i = 0; i < 2 + min(uStormCount, 0); i++) {
    if (float(i) >= ns) break;
    vec4 sd = fcSpireDef(i);
    psum += fcPoint(co, cd, vec3(sd.x, sd.w + 0.03, sd.y), 0.03, cold * (40.0 * FC_LG) * breathe, pixAng, seg, pT, pL);
    psum += fcPoint(co, cd, vec3(sd.x, 0.95 * sd.w, sd.y), 0.03, red * (20.0 * FC_LG) * (0.15 + 0.85 * blink), pixAng, seg, pT, pL);
  }
  float nt = fcTowerCount();
  for (int i = 0; i < FC_TOWERS + min(uStormCount, 0); i++) {
    if (float(i) >= nt) break;
    vec4 td = fcTowerDef(i);
    psum += fcPoint(co, cd, vec3(td.x, td.w + 0.02, td.y), 0.02, red * (12.0 * FC_LG) * (0.15 + 0.85 * blink), pixAng, seg, pT, pL);
  }
  // 绕主尖塔盘旋的航班（WS02 参照物）：8–12 km 高、半径 13 / 19 / 22 km、约 230 m/s（每小时整圈数，时间回绕不跳）。
  // 迎着我们的一侧翼尖航行灯（右绿左红）常亮，机腹红色信标 1 Hz，白色频闪 1.3 秒一闪
  vec4 s0 = fcSpireDef(0);
  for (int i = 0; i < 3 + min(uStormCount, 0); i++) {
    float fi = float(i);
    float laps = i == 0 ? 10.0 : i == 1 ? 7.0 : 6.0;
    float w = 6.2832 * laps / 3600.0 * (i == 1 ? -1.0 : 1.0);
    float rad = 0.23 / abs(w);
    float ph = 6.2832 * fcRnd(fi + 40.0) + w * time;
    vec3 pos = vec3(s0.x + rad * cos(ph), 8.0 + 1.6 * fi + 1.0 * fcRnd(fi + 44.0), s0.y + rad * sin(ph));
    vec3 fwd = vec3(-sin(ph), 0.0, cos(ph)) * sign(w);
    vec3 right = cross(fwd, vec3(0.0, 1.0, 0.0));
    float sideC = dot(right, normalize(co - pos));
    vec3 nav = mix(vec3(1.0, 0.06, 0.04), vec3(0.15, 1.0, 0.4), smoothstep(-0.25, 0.25, sideC));
    float st = fract(time / 1.3 + fcRnd(fi + 50.0));
    float strobe = exp(-st * 40.0);
    float bcn = fract(time + 0.5 * fi);
    float beacon = smoothstep(0.0, 0.05, bcn) * (1.0 - smoothstep(0.12, 0.25, bcn));
    vec3 La = nav * 3.0 + vec3(1.0) * 30.0 * strobe + red * 5.0 * beacon;
    psum += fcPoint(co, cd, pos, 0.015, La * FC_LG, pixAng, seg, pT, pL);
  }
  if (pL + bL > 0.0) e2 = vec4(fcSoftCap((psum + bsum) * on, FC_CAP), (pT + bT) / (pL + bL));
}
`;
