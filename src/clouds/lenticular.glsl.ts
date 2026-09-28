/**
 * 富士山的笠云（笠雲）与下风的吊し雲（山地波荚状云）（SPEC-FUJI）。
 *
 * 只编进云步进的 CLOUD_LENTICULAR 变体（clouds.ts 的 MARCH_FEATURES "L"）：默认云程序预处理后不含这里的任何代码
 * （check:glsl 断言，README 坑点「着色器编译」PERF-10 同类：云步进里加「平时不走」的分支也会让步进整体慢一档）。
 *
 * 形状是解析的「透镜盘」而不是噪声云：荚状云是稳定层结里的空气被山地波抬到凝结高度、过了波峰又下沉蒸发，
 * 云体只存在于波峰那一小段里，所以边缘干净、表面光滑、整体静止在山的上空 / 下风方，空气从云里穿过去
 * （[FAA AC 00-6B, Aviation Weather, 山地波一章]；[Durran 2003, Lee waves and mountain waves, Encyclopedia of Atmospheric Sciences]）。
 *  - 笠云：扣在山顶上的一顶斗笠——最常见的是贴着山顶的「接地笠」（Kusaka et al. 2025, Weather, doi:10.1002/wea.7774），
 *    主盘把山顶包在里面，迎风一侧圆钝、背风一侧压低变尖；有时上面再叠 1–2 片薄盘（二重笠 / 三重笠）。
 *  - 吊し雲：下风方按波长排开的一串透镜（主型是「椭圆型」，Kusaka 2025），横风方向长、顺风方向短，
 *    少数是几片薄盘叠成的「一摞盘子」。越往下风越小（波在衰减）。
 * 云本身不动（天气侧固定在山上），细微的表面纹理沿风向流过（uLensWind.w 是气流累计位移），形状不闪、不漂。
 *
 * 坐标：xz = p.xz + uCloudOffset（本地世界坐标 km，x 东 z 南），和雷暴 uStorms 同一套；高度 = length(p) − BOTTOM。
 * 局部坐标 q = (顺风, 横风) km，原点在山顶。
 */
export const LENTICULAR_GLSL = /* glsl */ `
uniform vec4 uLens;       // (山顶 x, 山顶 z：本地世界坐标 km, 山顶海拔 km, 总开关 0 / 1)
uniform vec4 uLensWind;   // (下风方向 x, z（单位向量）, 山地波波长 km, 气流穿过云的累计位移 km)
uniform vec4 uLensCap;    // (笠云强度 0..1（生消：盘从中心长大）, 主盘中心海拔 km, 叠盘片数 1..3, 形态随机数 0..1)
uniform vec4 uLensChain;  // (吊し雲强度 0..1, 个数 0..5, 基准海拔 km, 形态随机数 0..1)

// cloudDensity 的副产物（最近一次求值的点）：是否来自笠云 / 吊し雲，以及它在所属那片盘里的相对高度（环境光：盘底暗、盘顶亮）
float gLensW = 0.0;
float gLensH01 = 1.0;
float gLensPlateH = 0.0;
float gLensProf = 0.0;   // 最近一次 lensPlateDepth 的厚度剖面值（盘心 1、边缘 0）：边缘更稀、半透明
float gLensUx = 0.0;     // 同上，这一点在盘里的顺风位置（−1 迎风边 … 1 背风边）：背风边在蒸发，更淡

// 一片透镜盘：q =（顺风, 横风）km（相对盘心），dh = 高度 − 盘心高度 km。
// R：两个水平半轴；tUp / tDn：盘心处上表面 / 下表面离中面多高；sag：盘边相对盘心下垂多少（碟形）；tilt：顺风每 km 中面降多少。
// 厚度剖面 (1 − r²)^0.65：中间饱满、边缘收成一道锐利的刀口（荚状云的轮廓是干净的一条线）。
// 返回离表面还有多深（km，> 0 在盘里）
float lensPlateDepth(vec2 q, float dh, vec2 R, float tUp, float tDn, float sag, float tilt, vec3 wob) {
  vec2 u = q / R;
  float r2 = dot(u, u);
  // 轮廓不是正椭圆：按方位角叠 2、3 阶的起伏（±约 10%，每片盘各不相同，wob 是随机数 −0.5..0.5）
  vec2 nd = u * inversesqrt(max(r2, 1e-6));
  float w = 1.0 + 0.2 * (wob.x * (nd.x * nd.x - nd.y * nd.y) + wob.y * 2.0 * nd.x * nd.y) + 0.14 * wob.z * nd.x * (nd.x * nd.x - 3.0 * nd.y * nd.y);
  r2 /= w * w;
  if (r2 >= 1.0) return -1.0;
  gLensUx = u.x / w;
  float prof = pow(1.0 - r2, 0.65);
  float c = dh + sag * r2 + tilt * q.x;
  gLensPlateH = clamp((c + tDn * prof) / max((tUp + tDn) * prof, 1e-3), 0.0, 1.0);
  gLensProf = prof;
  return min(tUp * prof - c, c + tDn * prof);
}

// 盘面上随风流过的细纹（只挪表面几十米，不改轮廓）：低频、振幅小，保持「丝滑」。
// 取形状噪声的低频一级，按气流位移平移：纹理在动、云不动（空气穿过荚状云）
float lensFlow(vec2 q, float alt, float lod) {
  vec4 n = textureLod(uShapeNoise, vec3((q.x - uLensWind.w) / 9.0, alt / 2.2, q.y / 14.0) + 0.31, max(lod, 1.5));
  return n.g - 0.5 + 0.5 * (n.b - 0.5);
}

// 笠云：返回离表面的深度（km）。形状是一顶「笠」（斗笠）：主盘的中面从中心往外往下弯（sag），顶面是圆鼓的穹顶，
// 帽檐比山顶低、罩着山的上半截（从侧面看是扣在山顶上的一顶帽子，不是一块浮在山顶上的平盘）；中心下表面落到山顶附近（接地笠）
float lensCapDepth(vec2 q, float alt, float flow) {
  float s = uLensCap.x;
  if (s <= 0.0) return -1.0;
  vec3 h = cloudHash3(ivec3(int(uLensCap.w * 4096.0), 11, 3));
  vec3 wob = cloudHash3(ivec3(int(uLensCap.w * 4096.0), 12, 5)) - 0.5;
  // 生消：盘从山顶上空长出来 / 缩回去（水平尺寸按 √强度，厚度按强度）
  float grow = sqrt(s);
  // 主盘：半轴 1.7–2.3 × 2.0–2.8 km（顶部锥体的尺度，富士山 3 km 高处的山体半径约 2 km），中心略偏下风
  vec2 R = vec2(1.7 + 0.6 * h.x, 2.0 + 0.8 * h.y) * mix(0.35, 1.0, grow);
  vec2 qc = q - vec2(0.3 + 0.4 * h.z, 0.0);
  float tUp = (0.42 + 0.2 * h.y) * s;
  float tDn = (0.38 + 0.12 * h.x) * s;
  float sag = (0.55 + 0.3 * h.z) * s;
  float d = lensPlateDepth(qc, alt - uLensCap.y, R, tUp, tDn, sag, 0.04, wob);
  float hMain = gLensPlateH;
  float pMain = gLensProf;
  float uMain = gLensUx;
  // 叠盘（二重笠 / 三重笠）：主盘之上隔一道缝的薄盘，同样弯成笠形，越往上越小、越往下风错开；只算离这一点最近的那一片
  float nUp = uLensCap.z - 1.0;
  if (nUp > 0.5) {
    float gap = 0.24 + 0.08 * h.z;
    float base = uLensCap.y + tUp + 0.12;
    float k = clamp(floor((alt - base) / gap + 0.5), 0.0, nUp - 1.0);
    vec2 Rk = R * (0.95 - 0.12 * k);
    float dk = lensPlateDepth(qc - vec2(0.3 * (k + 1.0), 0.0), alt - (base + gap * k), Rk, 0.08 * s, 0.06 * s, sag * 0.8, 0.03, wob.yzx);
    if (dk > d) d = dk;
    else {
      gLensPlateH = hMain;
      gLensProf = pMain;
      gLensUx = uMain;
    }
  }
  return d + 0.08 * s * flow;
}

// 吊し雲：下风方按波长排开的一串透镜，只算离这一点最近的那一个（相邻两个的轮廓互不重叠，见半轴上限）
float lensChainDepth(vec2 q, float alt, float flow) {
  float s = uLensChain.x;
  float n = uLensChain.y;
  if (s <= 0.0 || n < 0.5) return -1.0;
  float lam = uLensWind.z;
  float fi = clamp(floor(q.x / lam + 0.5), 1.0, n);
  int seed = int(uLensChain.w * 4096.0);
  vec3 h1 = cloudHash3(ivec3(int(fi), seed, 23));
  vec3 h2 = cloudHash3(ivec3(int(fi), seed, 29));
  vec3 wob = cloudHash3(ivec3(int(fi), seed, 31)) - 0.5;
  // 越往下风波越弱：盘越小越薄（波在衰减）
  float amp = 1.0 - 0.13 * (fi - 1.0);
  float grow = sqrt(s);
  // 盘心：顺风 ±10% 波长，横风随机偏开（孤立山峰的背风波是船行波一样的弧形，不是一条直线）
  vec2 c = vec2((fi + 0.2 * (h1.x - 0.5)) * lam, (h1.y - 0.5) * 0.45 * lam);
  float hc = uLensChain.z + 1.1 * (h1.z - 0.5) + 0.12 * fi;
  // 半轴：顺风 0.15–0.25 倍波长（加上轮廓起伏 ≤ 0.3 倍，相邻两个不会相交），横风是它的 1.3–2.3 倍（椭圆型）
  float ra = lam * (0.15 + 0.1 * h2.x) * amp * mix(0.35, 1.0, grow);
  vec2 R = vec2(ra, ra * (1.3 + 1.0 * h2.y));
  float tUp = (0.2 + 0.22 * h2.z) * amp * s;
  float tDn = tUp * 0.55;
  vec2 qc = q - c;
  float d;
  if (h2.x > 0.62) {
    // 一摞盘子（约三成）：2–3 片薄盘，缝 0.2–0.3 km，越往上越小
    float np = h2.y > 0.5 ? 3.0 : 2.0;
    float gap = 0.2 + 0.1 * h1.x;
    float k = clamp(floor((alt - hc) / gap + 0.5), 0.0, np - 1.0);
    d = lensPlateDepth(qc - vec2(0.2 * k, 0.0), alt - (hc + gap * k), R * (1.0 - 0.16 * k), 0.07 * amp * s, 0.05 * amp * s, 0.12, 0.0, wob);
  } else {
    d = lensPlateDepth(qc, alt - hc, R, tUp, tDn, 0.16, 0.0, wob);
  }
  return d + 0.06 * s * flow;
}

// 笠云 + 吊し雲的密度（0..1）。withFlow = false：受光步进用，不取纹理（形状一样，只少了几十米的表面细纹）
float lensDensity(vec3 p, float lod, bool withFlow) {
  gLensW = 0.0;
  if (uLens.w < 0.5) return 0.0;
  float alt = length(p) - BOTTOM;
  vec2 rel = p.xz + uCloudOffset - uLens.xy;
  vec2 wd = uLensWind.xy;
  vec2 q = vec2(dot(rel, wd), dot(rel, vec2(-wd.y, wd.x)));
  // 包围盒（与 lensRayInterval 一致）
  float xMax = uLensChain.x > 0.0 ? uLensWind.z * (uLensChain.y + 0.6) : 6.0;
  if (q.x < -6.0 || q.x > xMax || abs(q.y) > max(6.5, 0.72 * uLensWind.z)) return 0.0;
  if (alt < uLens.z - 1.6 || alt > max(uLensCap.y + 2.0, uLensChain.z + 2.4)) return 0.0;
  float flow = withFlow ? lensFlow(q, alt, lod) : 0.0;
  float dc = lensCapDepth(q, alt, flow);
  float hCap = gLensPlateH;
  float pCap = gLensProf;
  float uCap = gLensUx;
  float dl = q.x > 3.0 ? lensChainDepth(q, alt, flow) : -1.0;
  float d = max(dc, dl);
  if (d <= 0.0) return 0.0;
  bool cap = dc >= dl;
  gLensH01 = cap ? hCap : gLensPlateH;
  float prof = cap ? pCap : gLensProf;
  float ux = cap ? uCap : gLensUx;
  gLensW = 1.0;
  // 表皮：近处约 40 m 内密度升满（边缘干脆），远处按步长放宽（lod = log2(步长 / 55 m)）——比一步还薄的表皮在 1 spp 下是「全中或全空」的颗粒
  float skin = max(0.04, 0.03 * exp2(lod));
  // 消光：盘心约 33 /km（光学上仍厚），往边缘降到约 11 /km——荚状云的边是锐利的，但最外一圈是半透明的（逆光时发亮的就是这一圈）；
  // 背风的半边在下沉、蒸发，越往背风边越淡（迎风边干脆、背风边柔）；盘里的浓淡随气流纹理起伏（顺风拉长的丝缕，不是一块塑料）
  float dens = mix(0.18, 0.55, smoothstep(0.0, 0.55, prof)) * mix(1.0, 0.4, smoothstep(0.1, 1.0, ux)) * (1.0 + 0.35 * flow);
  return clamp(d / skin, 0.0, 1.0) * dens;
}

// 视线穿过笠云 / 吊し雲包围盒的区间 [t0, t1]（穿不过返回 t1 < t0）。水平投影是直线（和 cloudRayDist2D 同样的近似），高度按球壳
vec2 lensRayInterval(vec3 ro, vec3 rd) {
  if (uLens.w < 0.5) return vec2(1.0, 0.0);
  vec2 wd = uLensWind.xy;
  vec2 perp = vec2(-wd.y, wd.x);
  vec2 C = uLens.xy - uCloudOffset;
  vec2 o = vec2(dot(-C, wd), dot(-C, perp));
  vec2 dir = vec2(dot(rd.xz, wd), dot(rd.xz, perp));
  float xMax = uLensChain.x > 0.0 ? uLensWind.z * (uLensChain.y + 0.6) : 6.0;
  float yMax = max(6.5, 0.72 * uLensWind.z);
  vec2 lo = vec2(-6.0, -yMax), hi = vec2(xMax, yMax);
  vec2 inv = 1.0 / (abs(dir) + 1e-7) * sign(dir + 1e-9);
  vec2 ta = (lo - o) * inv, tb = (hi - o) * inv;
  vec2 tmin = min(ta, tb), tmax = max(ta, tb);
  float t0 = max(max(tmin.x, tmin.y), 0.0);
  float t1 = min(tmax.x, tmax.y);
  vec2 sh = cloudShellIntervalH(ro, rd, uLens.z - 1.6, max(uLensCap.y + 2.0, uLensChain.z + 2.4));
  return vec2(max(t0, sh.x), min(t1, min(sh.y, AERIAL_MAX_DISTANCE)));
}

// 云步进用的密度：普通云（及雷暴 / 台风）与笠云 / 吊し雲取大。这两个函数经 MARCH_FRAG 里的宏替换掉 main 里的
// cloudDensity / layerDensity 调用（本变体才有），默认程序的文本不动
float cloudDensityLens(vec3 p, float lod, bool detail) {
  float d = cloudDensity(p, lod, detail);
  float dl = lensDensity(p, lod, true);
  if (dl > d) {
#ifdef CLOUD_WEATHER
    gStormW = 0.0;
    gStormAO = 1.0;
    gStormSoft = 0.0;
#endif
    return dl;
  }
  gLensW = 0.0;
  return d;
}
float layerDensityLens(vec3 p, float lod, bool detail) {
  return max(layerDensity(p, lod, detail), lensDensity(p, lod, false));
}
`;
