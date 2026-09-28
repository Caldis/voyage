/**
 * 海面（GLSL）：波面斜率场、耀斑、离水辐亮度。依赖 ATMOSPHERE_COMMON / CLOUD_COMMON（uCloudOffset）/ ISLANDS_COMMON（程序生成岛屿）/ PANE_COMMON（fbm2 / hash12）。
 *
 * 斜率来源（T14）：FFT 海浪（src/ocean/waves.ts）三个级联的纹理数组。
 * 每级存 (∂h/∂x, ∂h/∂z, 斜率二阶矩, Σ|k|h)，用解析的像素足迹做 textureGrad（各向异性过滤 + mip），
 * 过滤掉的斜率方差按 LEAN mapping 并入 Cox–Munk 粗糙度，比 FFT 更短的波（厘米级毛细波）由 Cox–Munk 总方差补齐：总方差守恒。
 *
 * 去平铺（T21）：每级不再直接平铺，而是按世界坐标的三角格子做「六边形随机平铺」（Heitz & Neyret 2018；Mikkelsen 2022）：
 * 每个格点给这一级的纹理一个随机平移和小角度旋转，像素取周围三个格点的样本，按重心权重做「方差守恒」混合
 * （Σwᵢsᵢ / √Σwᵢ²）。海浪是随机相位的高斯场，这样混合出来的仍是同一频谱的高斯场，但整个海面上不再有周期。
 * 格子在 CPU 上按双精度拆成整数 + 小数（uOceanHex），飞多远格点编号都精确、不跳变。
 */
export const OCEAN_COMMON = /* glsl */ `
uniform sampler2DArray uOceanWaves; // 三个级联：R = ∂h/∂x，G = ∂h/∂z，B = R² + G²，A = Σ|k|·h
uniform vec3 uOceanTile;            // 各级平铺尺寸（m）
uniform vec4 uOceanHex[3];          // 各级：相机在斜格坐标里的整数部分（xy）和小数部分（zw）（CPU 双精度拆好）
uniform vec4 uOceanCam;             // xy：相机的世界位置对 4096 m 取余（m），闪烁格子用
uniform vec3 uOceanVar;             // 各级整张平铺的总斜率方差 ⟨sx² + sz²⟩
uniform vec4 uOceanFoam;            // x：白浪阈值 τ（对前两级的 Σ|k|h），y：1 = FFT 海浪已接入，z：阵风斑随风漂移的距离（km，CPU 逐段积分）

// 格子密度：每个平铺尺寸内约 2 个格点（六边形约半个平铺大），整张平铺永远不会完整出现；与 src/ocean/waves.ts 一致
const float OCEAN_HEX_SCALE = 2.0;
// 每个格点的随机旋转上限（弧度）。风浪和涌浪有方向，只允许小角度偏转（真实海面的波向本来就有这么大的起伏）
const float OCEAN_HEX_ROT = 0.35;

// 整数哈希 pcg3d（Jarzynski & Olano 2020）：输入是精确的整数，飞多远都不丢精度
vec3 oceanHash3(ivec3 p) {
  uvec3 v = uvec3(p) * 1664525u + 1013904223u;
  v.x += v.y * v.z; v.y += v.z * v.x; v.z += v.x * v.y;
  v ^= v >> 16u;
  v.x += v.y * v.z; v.y += v.z * v.x; v.z += v.x * v.y;
  return vec3(v) * (1.0 / 4294967296.0);
}

float fresnelWater(float c) {
  return 0.02 + 0.98 * pow(1.0 - clamp(c, 0.0, 1.0), 5.0);
}

// 标准正态上尾 Q(x) = P(X > x)（Börjesson–Sundberg 近似，与 src/ocean/spectrum.ts 相同）
float normalTail(float x) {
  float a = abs(x);
  float q = exp(-0.5 * a * a) / ((0.661 * a + 0.339 * sqrt(a * a + 5.51)) * 2.5066283);
  return x >= 0.0 ? q : 1.0 - q;
}

// ---- 海面的波面斜率 ----
struct SeaSlope { vec2 mean; float var; float foam; };

const float WIND_DIR = 0.6;   // 风浪的传播方向（弧度，相对正东；与 src/ocean/spectrum.ts 一致）
vec3 oceanHexDbg = vec3(0.0); // 调试 13：第 0 级各格点的随机数按权重混合（看格子大小与过渡）

// xzM：相对相机的海面坐标（m）；dir2 / footAlong / footAcross：像素足迹（沿视线、垂直视线，m）；
// cmLocal：本地的 Cox–Munk 总方差；rel：本地相对全局风况的粗糙度倍数（阵风斑、风痕、浅水）；calm：湖泊河流 < 1
SeaSlope seaSlope(vec2 xzM, vec2 dir2, float footAlong, float footAcross, float cmLocal, float rel, float calm) {
  SeaSlope s;
  s.mean = vec2(0.0);
  s.foam = 0.0;
  if (uOceanFoam.y < 0.5) { s.var = cmLocal; return s; }
  // 各级的振幅平方倍数：短波对阵风、油膜的响应快而强，长浪几乎不受影响；湖泊没有长浪
  vec3 amp2 = pow(vec3(max(rel, 1e-3)), vec3(0.25, 0.6, 1.0)) * vec3(calm * calm, calm, 1.0);
  vec2 perp = vec2(-dir2.y, dir2.x);
  float lean = 0.0;     // 像素内看不清的斜率方差
  float leanFoam = 0.0; // 前两级的（给白浪用）
  float tr = 0.0;       // 前两级的 Σ|k|h
  float fftLocal = 0.0; // FFT 部分在本地的总方差
  for (int c = 0; c < 3 + uLoopGuard; c++) {
    float L = max(uOceanTile[c], 1.0);
    // 像素足迹（各向异性过滤按最多 16:1 算）比两个平铺还大时，这一级只剩整体方差，省掉取样
    vec4 t = vec4(0.0, 0.0, uOceanVar[c], 0.0);
    if (max(footAcross, footAlong / 16.0) < 2.0 * L) {
      // 三角格子（Mikkelsen 2022 的 TriangleGrid）：斜格坐标 = (x − z/√3, 2z/√3)，单位是 1/OCEAN_HEX_SCALE 个平铺
      vec2 st = xzM / L * OCEAN_HEX_SCALE;
      vec2 sk = vec2(st.x - st.y * 0.57735027, st.y * 1.15470054) + uOceanHex[c].zw;
      vec2 skF = floor(sk);
      vec2 fr = sk - skF;
      float zz = 1.0 - fr.x - fr.y;
      float up = step(zz, 0.0);            // 落在菱形的上半个三角形
      float sg = 2.0 * up - 1.0;
      vec3 w = vec3(-zz * sg, up - fr.y * sg, up - fr.x * sg); // 三个格点的重心权重，和为 1
      ivec2 base = ivec2(skF) + ivec2(uOceanHex[c].xy);
      vec2 vo[3];
      vo[0] = vec2(up, up); vo[1] = vec2(up, 1.0 - up); vo[2] = vec2(1.0 - up, up);
      vec2 gA = dir2 * (footAlong / L), gC = perp * (footAcross / L);
      vec4 acc = vec4(0.0);
      float unres = 0.0;
      for (int j = 0; j < 3 + uLoopGuard; j++) {
        vec3 h = oceanHash3(ivec3(base + ivec2(vo[j]), c));
        // 像素相对格点的位置换回平铺单位（反斜变换：x = a + b/2，z = b·√3/2）
        vec2 d = fr - vo[j];
        d = vec2(d.x + 0.5 * d.y, d.y * 0.8660254) / OCEAN_HEX_SCALE;
        float ang = (h.z * 2.0 - 1.0) * OCEAN_HEX_ROT;
        mat2 R = mat2(cos(ang), sin(ang), -sin(ang), cos(ang));
        // 纹理坐标 = R·d + 随机平移（纹理本身是周期的，平移取 [0,1) 即可）；显式梯度跟着一起旋转，分支里可用
        vec4 tj = textureGrad(uOceanWaves, vec3(R * d + h.xy, float(c)), R * gA, R * gC);
        acc += w[j] * vec4(tj.xy * R, tj.w, 0.0); // tj.xy * R = Rᵀ·∇：斜率转回世界方向
        unres += w[j] * max(tj.z - dot(tj.xy, tj.xy), 0.0);
        if (c == 0) oceanHexDbg += w[j] * h;
      }
      // 方差守恒混合：零均值的斜率和 Σ|k|h 除以 √Σw²；像素内看不清的方差本身是期望值，按权重直接平均
      acc.xyz /= sqrt(dot(w, w));
      t = vec4(acc.xy, unres + dot(acc.xy, acc.xy), acc.z);
    }
    float a2 = amp2[c];
    float a = sqrt(a2);
    s.mean += a * t.xy;
    float v = a2 * max(t.z - dot(t.xy, t.xy), 0.0);
    lean += v;
    fftLocal += a2 * uOceanVar[c];
    if (c < 2) { tr += a * t.w; leanFoam += v; }
  }
  // 比 FFT 最短波（约 0.23 m）还短的毛细波：Cox–Munk 总方差减去 FFT 已有的部分
  s.var = lean + max(cmLocal - fftLocal, 0.15 * cmLocal);
  // 白浪：像素内 Σ|k|h 近似服从 N(tr, leanFoam)，超过阈值的面积比例就是白浪覆盖率。
  // 远处 tr → 0、leanFoam → 整体方差，自动回到 Monahan 覆盖率；近处落在陡峭的波峰上
  float sd = sqrt(leanFoam + 1e-4 * uOceanFoam.x * uOceanFoam.x);
  s.foam = normalTail((uOceanFoam.x - tr) / sd);
  return s;
}

// 阵风斑（「猫爪」）：几百米到公里级、顺风拉长的阵风区，毛细波和短波更密，粗糙度更高；随风漂移。
// 漂移距离由 CPU 逐段积分（uOceanFoam.z，WX11g）：写成 uWind·uTime 时风速一变整片阵风斑就瞬移 Δ风速 × 运行秒数
float gustFactor(vec2 xzKm) {
  vec2 w = vec2(cos(WIND_DIR), sin(WIND_DIR));
  vec2 q = xzKm - w * uOceanFoam.z;
  vec2 p = vec2(dot(q, w) * 0.9, dot(q, vec2(-w.y, w.x)) * 1.7);
  p += (vec2(vnoise(p * 0.5 + 5.3), vnoise(p * 0.5 + 9.1)) - 0.5) * 1.5;
  float g = fbm2(p + 11.3);
  return exp(2.4 * (g - 0.47));
}

// 风痕：顺风方向拉长的平静带，粗糙度低，在耀斑里显成一条条纹路。边缘放软、加扭曲，免得低空时出现笔直的「断层」
float slickFactor(vec2 xzKm) {
  vec2 w = vec2(cos(WIND_DIR), sin(WIND_DIR));
  vec2 p = vec2(dot(xzKm, w) * 0.35, dot(xzKm, vec2(-w.y, w.x)) * 2.2);
  p += (vec2(fbm2(p * 0.9 + 3.1), fbm2(p * 0.9 + 7.7)) - 0.5) * 1.2;
  float n = fbm2(p * 0.6);
  return mix(1.1, 0.55, smoothstep(0.45, 0.75, n));
}

// 海面在海面处的辐亮度，不含天空反射（天空反射在 outsideRadiance 里单独算）。
// nView 输出带波浪扰动的平均法线，给天空反射用
// body：水体本身的反射率（< 0 用开阔大洋的默认值；真实地面时取卫星影像的水色）；calm：风浪系数（湖泊河流 < 1）
// eSun：主光源（太阳或月亮）在海面处垂直于光线的直射照度，已乘云影，即 keyLight(BOTTOM, n) · cloudShadow(P, uKeyDir)；
// eSky：海面处的天空光照度 skyIrradiance(BOTTOM, n)。两者由调用处算好传进来（和地面、内陆水面共用一份）：
// cloudShadow 很重，FXC 在每个调用点整份内联。本函数在整个场景程序里也只能有一个调用点（SC-3，见 scene.ts 的 outsideRadiance）
vec3 oceanRadiance(vec3 P, vec3 rd, float tGround, vec3 body, float calm, vec3 eSun, vec3 eSky, out float fView, out vec3 nView) {
  vec3 n = normalize(P);
  vec3 v = -rd;
  float cosV = max(dot(n, v), 1e-3);
  float cosS = dot(n, uKeyDir);

  // 海面坐标随飞机前进平移（和云场用同一个位移），海面才会从窗外流过
  vec2 xzKm = P.xz + uCloudOffset;
  float pixelAngle = 2.0 * uTanHalfFov / uResolution.y;
  // 像素在海面上的足迹（m）：垂直视线方向 = 距离 × 像素张角，沿视线方向再除以 cos(视线天顶角)
  float footAcross = tGround * 1000.0 * pixelAngle;
  float footAlong = footAcross / max(cosV, 0.02);
  float footprint = max(footAlong, 0.5);
  // ---- 岛屿（程序生成的示例） ----
  vec4 isl = (uIslandDensity > 0.0 && uGroundOn < 0.5) ? islandField(xzKm) : vec4(10.0, 0.0, 1.0, 0.0);
  if (isl.x < 0.0) {
    // 陆地：地形高度求法线；按海拔和坡度分沙滩、植被、岩石
    const float E = 0.03; // km
    float h0 = islandHeight(xzKm, isl);
    float hx = islandHeight(xzKm + vec2(E, 0.0), islandField(xzKm + vec2(E, 0.0)));
    float hz = islandHeight(xzKm + vec2(0.0, E), islandField(xzKm + vec2(0.0, E)));
    vec3 nL = normalize(n - vec3((hx - h0) / E, 0.0, (hz - h0) / E));
    float slope = 1.0 - dot(nL, n);
    float tex = fbm2(xzKm * 40.0);
    vec3 forest = mix(vec3(0.03, 0.06, 0.025), vec3(0.06, 0.09, 0.035), tex);
    vec3 rock = vec3(0.11, 0.1, 0.085) * (0.8 + 0.4 * tex);
    vec3 sand = vec3(0.42, 0.38, 0.3);
    vec3 albedo = mix(forest, rock, smoothstep(0.15, 0.35, slope) + smoothstep(0.6, 0.9, h0 / max(isl.z * 0.25, 0.01)) * 0.5);
    // 沙滩：海岸线往内一小圈；环礁的礁岛本身大半是白沙
    float sandW = max(smoothstep(-0.05, -0.015, isl.x), 0.6 * step(0.5, isl.y));
    albedo = mix(albedo, sand, sandW);
    fView = 0.0;
    nView = nL;
    return albedo / M_PI * (eSun * max(dot(nL, uKeyDir), 0.0) + eSky * (0.5 + 0.5 * dot(nL, n)));
  }
  float shallow = isl.w;

  // 波浪纹理坐标要精确到厘米：ro 在 6360 km 处，通用的 raySphere 有抵消误差（近处可达半米，会变成噪点）。
  // 海平面上的点改用稳定的二次方程解 t = c / (−b + √(b² − c))；地形上的水面（有海拔）仍用传进来的 P
  float hCam = uCamR - BOTTOM;
  float bq = uCamR * rd.y;
  float cq = hCam * (2.0 * BOTTOM + hCam);
  float dq = bq * bq - cq;
  float tS = (bq < 0.0 && dq > 0.0) ? cq / (-bq + sqrt(dq)) : tGround;
  vec2 xzM = (abs(tS - tGround) < 0.002 * tGround + 0.005 ? rd.xz * tS : P.xz) * 1000.0;
  vec2 dir2 = length(rd.xz) > 1e-4 ? normalize(rd.xz) : vec2(1.0, 0.0);

  // 本地粗糙度：Cox–Munk 1954 × 阵风斑 × 风痕；潟湖和浅水更平静
  float rel = gustFactor(xzKm) * slickFactor(xzKm) * mix(1.0, 0.45, shallow);
  float cmLocal = (0.003 + 0.00512 * uWind * calm) * rel;
  SeaSlope sl = seaSlope(xzM, dir2, footAlong, footAcross, cmLocal, rel, calm);
  // 近似地把东、南方向当作海面切向（离相机几百 km 内误差很小）
  nView = normalize(n - vec3(sl.mean.x, 0.0, sl.mean.y));
  float sigma2 = sl.var;

  // 天空反射率。波面粗糙，掠射时达不到 1（Schlick 粗糙度近似）
  float cosVn = max(dot(nView, v), 1e-3);
  float rough = sqrt(sigma2);
  fView = 0.02 + (max(1.0 - rough, 0.02) - 0.02) * pow(1.0 - cosVn, 5.0);

  // 离水辐亮度：开阔大洋的反射率，蓝光最高
  // 浅水：海底的白沙透上来，水色变成碧绿
  vec3 waterRefl = mix(vec3(0.002, 0.008, 0.025), vec3(0.03, 0.13, 0.13), shallow * shallow);
  if (body.r >= 0.0) waterRefl = body;
  // 白浪：FFT 接入时落在陡峭波峰上（期望覆盖率仍是 Monahan 1980：≈ 3.84e-6·U^3.41）；没接入时退回均匀覆盖
  float foam = uOceanFoam.y > 0.5 ? min(sl.foam, 1.0) : clamp(3.84e-6 * pow(uWind, 3.41), 0.0, 0.1);
  // 岸边和礁石外缘的碎浪
  foam += 0.5 * (1.0 - smoothstep(0.0, 0.025, isl.x)) * (0.6 + 0.4 * fbm2(xzKm * 60.0 + uTime * 0.2));
  vec3 L = ((1.0 - fView) * waterRefl + foam * 0.6) / M_PI * (eSun * max(cosS, 0.0) + eSky);

  // 太阳耀斑：L = E·F·p(斜率) / (4·cosθv·cos⁴β)，斜率分布以可分辨波浪的法线为中心
  vec3 hv = normalize(uKeyDir + v);
  float cb = dot(hv, nView);
  vec2 cell = vec2(0.0);
  if (cosS > 0.0 && cb > 0.0) {
    float cb2 = cb * cb;
    float tan2 = (1.0 - cb2) / cb2;
    float p = exp(-tan2 / sigma2) / (M_PI * sigma2);
    // 波光粼粼：像素里「恰好把阳光反射进眼睛」的小波面数服从泊松分布，λ ∝ 像素覆盖面积 × 斜率概率。
    // 耀斑中心 λ 大，画面平滑；尾部 λ < 1，只剩稀疏的亮点闪烁；高空时像素覆盖大，λ 大，自然变平滑。
    // 结果保持期望值不变（除以 λ），只改变分布。
    // 随机数的来源（T21）：格子钉在世界坐标上（随海水流过窗外，而不是跟着飞机走）；尺寸按像素足迹取 2 的整数次幂
    // （沿视线长、垂直视线短），足迹连续变化时格子不会跟着伸缩「游动」；方向按视线方位量化成 16 个扇区，扇区内格子不随视线转动。
    // 每个格子有自己的相位，各自以约 8 Hz 换一次随机数，不再全场同步地一齐跳（原来整片耀斑以 8 Hz 频闪）
    vec2 fp = vec2(footprint, max(footAcross, 0.5));
    vec2 lv = floor(log2(fp));
    float sect = (floor(atan(dir2.y, dir2.x) * (8.0 / M_PI)) + 0.5) * (M_PI / 8.0);
    vec2 ax = vec2(cos(sect), sin(sect));
    vec2 wM = xzM + uOceanCam.xy;
    cell = floor(vec2(dot(wM, ax), dot(wM, vec2(-ax.y, ax.x))) * exp2(-lv));
    ivec3 cid = ivec3(ivec2(cell), int(lv.x) * 64 + int(lv.y) + int(sect * 100.0) * 4096);
    float ph = oceanHash3(cid).x;
    vec3 hs = oceanHash3(cid + ivec3(0, 0, int(floor(uTime * 8.0 + ph)) * 7919));
    float u = hs.x;
    float lambda = 5.0 * fp.x * fp.y * exp(-tan2 / sigma2);
    float sparkle;
    if (lambda < 4.0) {
      float pHit = 1.0 - exp(-lambda);
      sparkle = u < pHit ? 1.0 / max(pHit, 1e-4) : 0.0;
    } else {
      sparkle = 1.0 + (u * 2.0 - 1.0) * sqrt(3.0 / lambda);
    }
    L += eSun * fresnelWater(dot(v, hv)) * p / (4.0 * cosV * cb2 * cb2) * sparkle;
  }
  if (uDebug == 8) L = vec3(sigma2 * 20.0, footprint / 50.0, 0.0);
  if (uDebug == 9) L = eSun / max(uKeyIlluminance, vec3(1e-9));
  if (uDebug == 10) L = vec3(fract(cell.x * 0.1), fract(cell.y * 0.1), 0.0);
  if (uDebug == 11) L = vec3(sl.foam, rel * 0.5, 0.0);                     // 白浪覆盖率、本地粗糙度倍数
  if (uDebug == 12) L = vec3(sl.mean * 5.0 + 0.5, 0.0);                   // 可分辨的平均斜率
  if (uDebug == 13) L = oceanHexDbg;                                      // 第 0 级的随机平铺格子
  return L;
}
`;
