/**
 * 云的密度场与光照（GLSL），思路来自 Schneider《The Real-time Volumetric Cloudscapes of Horizon: Zero Dawn》(2015)
 * 和 Hillaire《Physically Based Sky, Atmosphere and Cloud Rendering in Frostbite》(2016)。
 * 坐标与大气一致：km，地心为原点，相机在 (0, uCamR, 0)，y 向上。
 * 云场随飞机前进整体向后平移：采样坐标 = 相机相对坐标 + uCloudOffset（飞机累计走过的水平位移）。
 */
// ---- 雷暴 / 台风的占据网格（PERF-2）----
// 一张粗的 3D 纹理（世界坐标，水平 OCC_N × OCC_N、竖直 OCC_LAYERS 层），格点上存「这里有没有雷暴 / 台风的云」（0 / 1）。
// 由 clouds.ts 在天气变化或飞机走远时重建；云步进（主步进和受光步进）先查它，空白处不再求完整的雷暴 / 台风密度。
// 查询时用 mip OCC_MIP 的三线性采样：mip 是 2×2×2 块的平均，只要块里有一个格点有云，采样值就 > 0，
// 相当于把「有云」的范围向外膨胀了至少 2.5 个格距（mip 2），能盖住格点之间漏掉的小突起和不同 lod 噪声造成的表面差异
export const OCC_N = 512;           // 水平格点数（每个方向）
export const OCC_SPACING = 0.5;     // 水平格距，km：覆盖 ±128 km
export const OCC_LAYERS = 84;       // 竖直层数：均分 [uShellBottom, uShellTop]
export const OCC_MIP = 2.0;

// ---- 云影图（T27）----
// 海面 / 地面的云影不再在窗外程序里逐像素步进，改查一张按世界坐标铺开的图（clouds.ts 建图）：
// 三级，每级 CLOUD_SHADOW_RES² 个格点，半边长 CLOUD_SHADOW_EXT km（格距约 62 m / 312 m / 1.6 km）
export const CLOUD_SHADOW_RES = 512;
export const CLOUD_SHADOW_EXT = [16, 80, 400];

// 台风密度的两个版本共用同一段眼壁 / 眼底 / 卷云盖代码，只有雨带不同（见 CLOUD_COMMON 里的两处展开）
function hurricaneDensityGlsl(name: string, bands: string): string {
  return /* glsl */ `
float ${name}(vec2 xz, float alt, float lod, bool detail, out float ao) {
  ao = 1.0;
  gHurSoft = false;
  gHurCanopy = false;
  if (alt > HUR_TOP + 4.2) return 0.0;
  vec2 d2 = xz - uHurricane.xy;
  float r = length(d2);
  float Re = uHurricane.z;          // 低层的眼半径
  if (r > Re * 18.0) return 0.0;
  float theta = atan(d2.y, d2.x);
  float u = theta / HUR_TWO_PI;
  float d = 0.0;
  float wallW = 0.0;                // 这个点属于眼壁 / 雨区（1）还是别的部分

  // ---- 眼壁的内缘半径 rIn(θ, 高度) ----
  // 眼的平面形状不是正圆（常见近似多边形 / 椭圆），随高度缓慢扭转
  float shape = 0.10 * sin(2.0 * theta + 0.6 + alt * 0.05) + 0.06 * sin(3.0 * theta + 2.1 - alt * 0.08) + 0.035 * sin(5.0 * theta + 4.0);
  // 各扇区倾角不同：Δr / Δz 在 0.6–1.3 之间（约 30–52°）
  float slopeK = 0.95 + 0.35 * sin(theta + 1.3) + 0.12 * sin(4.0 * theta + 0.5);
  float rLow = Re * (1.0 + shape);
  if (r < Re * 4.2) {
    // 两次采样给出四个尺度：
    //  nT：切向约 1/6 圈一个周期（约 35 km）、竖直 28 km —— g ≈ 9 km 宽 7 km 高的大对流塔，b ≈ 4 km
    //  nS：切向 1/24 圈（约 9 km）、竖直 4 km —— g ≈ 2.3 km × 1 km 的横条，b 更细：水平的层状条纹
    float lodT = max(lod - 2.3, 0.0);
    vec4 nT = textureLod(uShapeNoise, vec3(u * 6.0, alt / 28.0, 0.37), lodT);
    vec4 nS = textureLod(uShapeNoise, vec3(u * 24.0, alt / 4.0, 0.71), max(lod - 0.5, 0.0));
    // 下陡上缓：低处接近 30°，越往上越向外摊（看台的形状）
    // 卷云盖顶以上（上冲的对流塔）内壁不再外退：塔身是竖直的
    float altW = min(alt, HUR_TOP - 0.2);
    float rise = slopeK * (0.55 * altW + 0.045 * altW * altW);
    // 两三级不规则的台阶（平台）：高度沿方位角大幅起伏、只在部分扇区明显。
    // 试过按固定间距一级级量化，从巡航高度俯看像等高线地图
    float l1 = 4.5 + 1.3 * sin(2.0 * theta + 0.4) + 0.6 * sin(5.0 * theta + 2.2);
    float l2 = 8.5 + 1.6 * sin(3.0 * theta + 1.9) + 0.7 * sin(7.0 * theta + 0.3);
    rise += 1.6 * smoothstep(l1 - 0.35, l1 + 0.35, alt) * smoothstep(-0.3, 0.5, sin(3.0 * theta + 0.8));
    rise += 2.0 * smoothstep(l2 - 0.4, l2 + 0.4, alt) * smoothstep(-0.4, 0.4, sin(2.0 * theta + 2.6));
    // 顶部向外卷：越接近卷云盖，内壁越平，最后变成卷云盖的底面，没有切边
    float flare = HUR_FLARE * pow(smoothstep(HUR_FLARE_START, HUR_TOP, alt), 2.0);
    // 对流塔：强弱按扇区变化（随机性），低处（雨区上方的层状云）平缓一些
    float towerAmp = mix(0.8, 4.5, smoothstep(0.3, 0.7, nT.r)) * smoothstep(0.8, 4.0, alt);
    // 外卷的上半截（从下面看是一片「天花板」）隆起要更大，否则是一条没有细节的灰带
    float bump = towerAmp * hurCap(nT.g) + 1.1 * hurCap(nT.b) + (0.35 + 1.3 * smoothstep(10.0, 14.5, alt)) * hurCap(nS.g) + 0.2 * (nS.b - 0.5);
    float rIn = rLow + rise + flare - bump;
    float s = r - rIn;
    // 眼壁 + 雨区：从海面附近到卷云盖是实心的；再往外云底抬升成卷云盖
    // 雨区外缘（T44）：旧版外缘半径只随方位角正弦变化、云底从 0.5 km 平滑抬到 12 km，从台风外围看过去是一整块
    // 光滑、均匀发暗的巨型圆柱（视平线上的深色横带），侧面轮廓是一条斜直线。外缘半径加两级噪声（约 35 km / 9 km，
    // 随高度缓慢变），抬升的云底叠球冠起伏：外缘成了参差的塔群和挂下来的云底
    // 这组噪声专门给外缘：远处（外围看它在 150–300 km 外）步长大、lod 高，nT / nS 已被 mip 平均成常数，
    // 起伏全没了——云底抬升段是一个光滑的圆锥面，圆锥的轮廓线是直线，就是那条斜直线。所以这里固定取 mip 3（尺度约 20–30 km 的起伏在 mip 3 里还在，远处也不闪；
    // 按 lod − 4 取细 mip 时远处每个样本都读细纹理，缓存不友好，typhoon-bands 云步进 +3 ms）
    vec4 nO = textureLod(uShapeNoise, vec3(u * 11.0, alt / 18.0, 0.53), 3.0);
    float coreOuter = Re * (2.9 + 0.35 * sin(2.0 * theta + 1.0) + 0.8 * (nO.r - 0.5) + 0.3 * (nS.r - 0.5));
    float baseAlt = mix(0.5 + 0.3 * (nS.a - 0.5), 12.0 - 4.0 * max(hurCap(nO.g), 0.0) - 1.2 * max(hurCap(nS.g), 0.0),
                        smoothstep(coreOuter, coreOuter + Re * (0.5 + 0.8 * nO.b), r));
    // 眼壁顶沿：各扇区高低不同（hurricaneRimTop），顶上一座座上冲的对流塔高出 1–4.5 km（天际线上高耸的圆顶塔），
    // 离眼壁内缘远了就没有。塔的平面位置只取水平切片（极坐标 θ × r），不随高度变：
    // 用随高度变的 3D 噪声当高度场，塔会上下断开成漂浮的团块（README 坑点）
    vec4 nR = textureLod(uShapeNoise, vec3(u * 13.0, 0.61, r / 26.0), max(lod - 1.5, 0.0));
    // 离顶沿（卷云盖高度上的内缘，不含隆起）多远：必须和高度无关。旧版用本高度的 s，塔顶高度随高度变，
    // 加大起伏以后顶上会飘出一小片一小片的碎云（T37）
    float rInTop = rLow + slopeK * 20.3 + 1.6 * smoothstep(-0.3, 0.5, sin(3.0 * theta + 0.8))
                 + 2.0 * smoothstep(-0.4, 0.4, sin(2.0 * theta + 2.6)) + HUR_FLARE;
    float rimZone = 1.0 - smoothstep(3.0, 14.0, r - rInTop);
    // 圆顶：Worley 距离直接给半椭圆剖面（宽约 5 km、高 1–4.5 km），再叠约 3 km 的小圆顶，顶上不是平台
    float ddR = clamp((1.0 - nR.g) * 1.6, 0.0, 1.0) / 0.8;
    float domeR = sqrt(max(1.0 - ddR * ddR, 0.0));
    // 高的上冲圆顶之间也不是平的（T37）：到处都有两级球冠起伏（约 5 km 和 2.5 km 的塔群，±1 km），
    // 上冲圆顶是从塔群里冒出来的，不是一排孤立的小丘立在一条水平线上
    float turret = 1.1 * hurCap(nR.g) + 0.6 * hurCap(nR.a) + 0.5 * (nR.r - 0.5);
    // 更细一级（约 1–2 km）的菜花鼓包，上冲圆顶上最明显：旧版圆顶是光滑的钟形，像雪堆。
    // 只往下刻（鼓包之间的折痕），不往上加：往上加的细尖顶会高过内壁（内壁半径随高度起伏）连续的部分，飘出一小片一小片碎云
    vec4 nR2 = textureLod(uShapeNoise, vec3(u * 47.0, 0.23, r / 8.0), max(lod - 0.5, 0.0));
    turret += (0.35 + 0.5 * domeR) * (hurCap(nR2.g) + 0.5 * hurCap(nR2.b) - 0.675);
    float overshoot = (4.2 * (0.4 + 0.6 * nR.b) * domeR * smoothstep(0.3, 0.6, nR.r) + turret
                     + 0.6 * max(hurCap(nT.b) + 0.1, 0.0) * domeR + 0.6 * hurTower(nT.g) * smoothstep(0.4, 0.7, nT.r)) * rimZone;
    // 顶沿往外是雨区和卷云盖：云顶从顶沿往外缓慢下降（外流的冰晶云），不再抬到统一的卷云盖顶——
    // 那样顶沿低的扇区后面会露出一道比顶沿还高的水平云顶（T37 之前眼里看到的「栏杆」之一）
    float top = min(hurricaneRimTop(theta) - 1.4 * smoothstep(Re * 2.0, Re * 5.0, r) + overshoot, HUR_TOP + 4.2);
    // 外侧在 4.2 倍眼半径之前淡出（T44）：这一段（云底已抬到 12 km）原来一直实心到 r = 4.2Re（上面 if 的边界）才一刀切掉，
    // 是一堵半径 84 km 的竖直圆柱面。台风外围在 11–13 km 朝中心看，它正好在视平线上：一条深色的横带，
    // 右端是圆柱面透视成的一条斜直线（美术总监说的「卷云盖底外缘的斜直线」其实是它，关掉卷云盖照样在）。外面交给卷云盖接着
    float wall = smoothstep(0.0, 0.35, s) * smoothstep(baseAlt, baseAlt + 0.3, alt) * (1.0 - smoothstep(top - 0.4, top, alt))
               * (1.0 - smoothstep(Re * 3.3, Re * 4.1, r + Re * 0.35 * (nT.a - 0.5)));
    if (wall > d) { d = wall; wallW = 1.0; }
    // 遮蔽：隆起顶端看到的天空多、凹处少；眼壁下部像在井底，只看得到头顶一块天
    // 眼壁表面只看得到半边天（另一半被眼壁自己挡住），对面还是眼壁：天空光约为开阔处的一半
    ao = 0.55 * mix(0.3, 1.0, smoothstep(-1.5, 1.0, bump)) * mix(0.4, 1.0, smoothstep(1.0, 13.0, alt));
    // ---- 眼底的层积云 ----
    float rEyeLow = rLow + slopeK * 1.2;
    if (r < rEyeLow + 2.0 && alt < 2.8) {
      // 随低层气流旋转：离中心越远转得越多，单体被拉成略弯的弧
      vec2 q = rot2(d2, 0.9 * r / Re);
      vec4 nF = textureLod(uShapeNoise, vec3(q.x / 16.0, alt / 8.0, q.y / 16.0) + 0.43, max(lod - 1.2, 0.0));
      // 成片：几公里大小的一片片云，中间有空隙露出海面，靠近眼壁更密；边界陡（云片的边缘是清楚的）
      float cov = smoothstep(0.44, 0.54, nF.r + 0.25 * smoothstep(0.55, 1.0, r / rEyeLow));
      // 云片有厚度（约 0.4–1 km），顶上是约 2 km 的闭合单体圆顶和约 1 km 的小圆顶
      float fbase = 0.8 + 0.15 * nF.a;
      float ftop = fbase + cov * (0.45 + 0.6 * hurCap(nF.b) + 0.3 * hurCap(nF.a)) + 0.5 * smoothstep(0.7, 1.05, r / rEyeLow);
      float floorD = smoothstep(fbase, fbase + 0.12, alt) * smoothstep(0.0, 0.2, ftop - alt) * 0.8;
      if (floorD > d) {
        d = floorD;
        wallW = 0.0;
        // 眼底只看得到头顶的开口：越靠近眼壁越暗
        ao = mix(0.75, 0.45, smoothstep(0.3, 1.0, r / rEyeLow));
      }
    }
  }
  // ---- 眼墙外：卷云盖与流出层的丝缕 ----
  if (r > Re * 2.5 && alt > 9.5) {   // C-TYPH：底面起伏最低到约 9.7 km
    // 卷云盖的底往外抬升（外缘只剩 14 km 附近薄薄一层卷云，巡航高度可以在它下面俯看雨带）
    float canopyBase = 11.8 + 2.4 * smoothstep(Re * 4.0, Re * 12.0, r);
    float canopyTop = hurricaneCanopyTop(theta, r);
    // 底面起伏（T44）：旧版底面是光滑的解析曲面，往外抬升、在相机高度处和视平面相交，从卷云盖下面看，
    // 底面外缘是一条从左上到右下的斜直线（像天花板开了个口）。加一层水平切片噪声高度场，只挪高度、不软化竖直梯度
    // （T37 坑：软化会在相机附近多出一大片要细走的稀薄云），相交线跟着弯曲、断开。
    // C-TYPH（TW04）：旧版 30 km 一个周期、按步长取 mip——远处（外围朝中心看 100–300 km）mip 高、噪声被平均成常数（T44 同一个坑），
    // 远处的底面仍是一条水平直线，近处是 7.5 km 一格、整齐排开的扇贝（「规则的水波纹」）。现在周期 47 km（不和别的噪声成整数比）、
    // mip 封顶 3，三级（约 47 / 12 / 6 km）起伏 ±1.5 km，外围顶面也跟着起伏一半（眼壁附近不动，T37 的栏杆）
    float undC = 0.0;
    if (alt > canopyBase - 3.0 && alt < canopyTop + 1.6) {
      vec4 nCb = textureLod(uShapeNoise, vec3(xz / 47.0, 0.83), min(max(lod - 1.0, 0.0), 3.0));
      // 幅度 ×1.6（约 ±2 km）：外围的丝缕层被起伏的底面切成一块块，透出天；眼壁附近（3–5 倍眼半径）起伏减半
      undC = 1.6 * (1.3 * (nCb.r - 0.5) + 0.9 * hurCap(nCb.g) + 0.45 * hurCap(nCb.b)) * mix(0.5, 1.0, smoothstep(Re * 5.0, Re * 7.0, r)) * smoothstep(Re * 3.0, Re * 4.0, r);
      canopyBase += undC;
      canopyTop += 0.5 * undC * smoothstep(Re * 6.0, Re * 8.0, r);
    }
    if (alt > canopyBase - 0.6 && alt < canopyTop + 0.3) {
      // 流出气流：高空的丝缕沿反气旋弯曲的螺线向外，坐标 (θ − 1.1 ln r) 沿丝缕不变。
      // mip 封顶 3（同上：远处按步长取 mip 时丝缕被平均掉，外围整片是均匀的白）
      float lr = log(max(r, 1.0));
      vec4 nC = textureLod(uShapeNoise, vec3((theta - 1.1 * lr) / HUR_TWO_PI * 16.0, lr * 1.6, alt / 6.0), min(lod, 3.0));
      float fib = nC.g * 0.7 + nC.b * 0.3;
      float edge = 1.0 - smoothstep(Re * 9.0, Re * 16.0, r + Re * 4.0 * (fib - 0.5));
      float thin = smoothstep(Re * 3.5, Re * 10.0, r);
      // 外围的底面按丝缕参差（±0.3 km，只在变薄的外围）：丝缕下沿一条条垂下来，底面不再是一整块光滑的面
      float cb = canopyBase - 0.6 * (fib - 0.5) * thin;
      float vert = smoothstep(cb - 0.3, cb + 0.4, alt) * (1.0 - smoothstep(canopyTop - 0.4, canopyTop + 0.2, alt));
      // 冰云：靠近眼壁厚，往外越来越薄、越来越丝缕状。
      // T44：旧版外围仍是 0.3 × 60 = 18 /km，2 km 厚的光学厚度几十，从下面看是一块不透光、均匀灰色的平板顶棚。
      // 真实的外围卷云盖是光学厚度一到几的冰云（能透出上面的天、下面的塔也不被整片压暗）：
      // 中心密蔽云区以外按约 1.3 倍眼半径的 e 折长度变薄。
      // C-TYPH（TW04）：外围再撕开——旧版处处至少 0.012（0.7 /km），从卷云盖下面近水平看出去，几十公里的路程累积成一整块过曝的白板
      // （中位 235，TASKS C-TYPH）。现在丝缕之间是空的（fibS 的门槛抬到 0.35），丝缕本身也更淡，透过缝能看到上面的天
      float fibS = smoothstep(0.35, 0.8, fib);
      float canopy = vert * edge * max(min(0.9 * exp(-(r - Re * 3.5) / (Re * 1.3)), 0.9) * mix(1.0, 0.25 + 1.0 * fibS, thin),
                                       mix(0.0, 0.035 * fibS * fibS, thin));
      if (canopy > d) { d = canopy; wallW = 0.0; ao = 1.0; gHurSoft = true; gHurCanopy = true; }
    }
  }
${bands}
  if (d <= 0.0) return 0.0;
  // 眼壁、雨带、眼底：表面附近侵蚀成小的圆团（同雷暴）；卷云盖不侵蚀
  if (detail && (wallW > 0.5 || alt < 3.0)) {
    vec3 dn = textureLod(uDetailNoise, vec3(xz.x, alt, xz.y) / DETAIL_TILE, lod).rgb;
    float dfbm = dn.r * 0.625 + dn.g * 0.25 + dn.b * 0.125;
    d = remapc(d, (1.0 - dfbm) * 0.45, 1.0, 0.0, 1.0);
  }
  return d;
}
`;
}

const HUR_BANDS_FULL = /* glsl */ `
  // ---- 外围螺旋雨带：一条条积雨云带 ----
  // 6 条对数螺旋，倾角约 18°（tan = 6 / 18.5），相邻两带的半径比约 1.4（外围间距几十到一百公里）。
  // 螺旋相位是纯解析的（不加噪声扰动）：带子保持连贯的弧形，从高处斜看才读得出弧形的排列；断续和宽窄交给强度噪声。
  // 带上的积雨云塔是一个个解析单体（约 11 km 一格，每格随机位置、高矮、胖瘦）：几个上升气泡叠成的塔群（bandTowerSdf），
  // 菜花状隆起，塔顶被高空风吹歪；高的塔顶上摊开砧，相邻几座塔的砧融成一片（T37）。
  // 旧做法把 Worley 距离当高度场，塔身竖直、一样高、顶是平台，侧看像一片石笋；T26 的单个圆柱 + 圆顶又像一排圆桶配餐桌板
  if (r > Re * 2.8 && alt < 15.0) {
    vec4 nB = textureLod(uShapeNoise, vec3(xz / 40.0, 0.19), max(lod - 2.5, 0.0));
    float phB = 6.0 * theta - 18.5 * log(max(r, 1.0));
    float cb = cos(phB);
    float radial = smoothstep(Re * 2.8, Re * 4.0, r) * (1.0 - smoothstep(Re * 13.0, Re * 17.0, r));
    float band = smoothstep(0.2, 0.75, cb) * smoothstep(0.3, 0.55, nB.b * 0.6 + nB.r * 0.4) * radial;
    // 高过这一带最高的塔顶（含隆起、砧）就不必进单体循环：从 13 km 俯看时相机附近的大段视线都在这里，
    // 不加这道判断 typhoon-outer 的帧时间是原来的近 3 倍
    float topHere = mix(13.0, 8.5, smoothstep(Re * 3.5, Re * 15.0, r)) + 1.5;
    // 离最近的带轴（相位差）够不够得着：塔只长在格子中心相位差 < 1 rad 的地方，塔和砧离塔心最远约 13 km
    // （7 km 以下没有砧、塔也不怎么歪，约 10 km），按相位梯度折成相位差。
    // 旧的判断（cb > 0.45）在内圈（相位梯度大）会把离带轴远一点的塔和砧截出直边
    float pd = abs(mod(phB + 3.1415927, HUR_TWO_PI) - 3.1415927);
    float phGradLen = 19.4 / r;   // |∇φ| = √(6² + 18.5²) / r
    if (pd < 1.0 + phGradLen * mix(10.0, 13.0, smoothstep(6.0, 8.0, alt)) && alt < topHere) {
      // 塔身表面的菜花状隆起（约 2 km / 1 km），3D 噪声，只作为表面起伏，不当高度场
      vec4 nU = textureLod(uShapeNoise, vec3(xz.x / 9.0, alt / 7.0, xz.y / 9.0) + 0.29, max(lod - 0.7, 0.0));
      float bump = 1.0 * hurCap(nU.g) + 0.45 * hurCap(nU.b);
      const float CELL = 11.0;
      // 3×3 的单体窗口能完整罩住离塔心 13 km 以内的东西。高处的塔顶和砧都偏向下风方：窗口顺高空风往回挪 5 km 跟着它们
      // （塔在低处几乎不歪，低处不挪）。每座塔的所有部分都落在「塔心 + 挪动量」13 km 以内，窗口换格子时不会截出直边
      float wsh = 5.0 * smoothstep(5.0, 9.0, alt);
      vec2 gid = floor((xz - uUpperWind * wsh) / CELL);
      float sdf = 1e3;
      gHurCell = vec3(0.0);
      // 砧：各高塔的核加起来（相邻的砧融成一片）、按核加权的塔顶高、离最近高塔轴的距离（塔身半径为单位）
      float aSum = 0.0, aTopW = 0.0, aRho = 9.0;
      // 上界写成「1 + 恒为 0 的 uniform 表达式」，FXC 不把 9 个单体展开（这段被内联进步进和受光步进两处）
      int cellHi = 1 + min(uStormCount, 0);
      for (int ix = -1; ix <= cellHi; ix++)
      for (int iy = -1; iy <= cellHi; iy++) {
        vec2 id = gid + vec2(float(ix), float(iy));
        vec2 h1 = stormHash22(id + 17.3);
        vec2 c = (id + 0.2 + 0.6 * h1) * CELL;
        vec2 dc = xz - c - uUpperWind * wsh;
        if (dot(dc, dc) > 180.0) continue;   // 这座塔（连同砧）够不着
        vec2 h2 = stormHash22(id * 1.7 + 3.1);
        vec2 hc = c - uHurricane.xy;
        float rcc = length(hc);
        // 格子中心落在带轴附近才长塔；带轴上也有约 1/4 的格子空着（塔与塔之间的缝）。
        // 相位按格子中心求（不从采样点线性外推）：外推的误差随距离平方增长（内圈 0.4 rad），同一座塔在不同采样点上高矮不一、形状会扭。
        // 方位角差用 atan 的有理近似（夹角 < 0.4 rad，误差 < 0.005 rad）：每格一个完整的 atan 在 typhoon-bands 上约 +0.35 ms
        float ta = (d2.x * hc.y - d2.y * hc.x) / dot(d2, hc);
        float phC = phB + 6.0 * ta / (1.0 + 0.28 * ta * ta) - 9.25 * log(dot(hc, hc) / (r * r));
        float coreC = smoothstep(0.55, 0.92, cos(phC))
                    * smoothstep(Re * 3.0, Re * 4.2, rcc) * (1.0 - smoothstep(Re * 12.0, Re * 16.0, rcc)) * step(0.25, h2.x);
        if (coreC <= 0.0) continue;
        // 高矮参差：浓积云 5–7 km 到积雨云 9–13 km，离中心远的矮一些；胖瘦 2.4–5 km
        float topMax = mix(13.0, 8.5, smoothstep(Re * 3.5, Re * 15.0, rcc));
        float Ht = 2.0 + (mix(5.0, topMax, h2.y * (1.3 - 0.3 * h2.y)) - 2.0) * mix(0.55, 1.0, coreC);
        float Rt = CELL * (0.22 + 0.24 * h1.x) * mix(0.75, 1.0, coreC);
        vec2 h3 = stormHash22(id * 2.3 + 7.9);
        vec2 ax = bandTowerAxis(c, alt, Ht, h3);
        float rho = length(xz - ax);
        // 砧的核：高过约 10 km 的塔，砧心在塔心下风方 4–5.5 km，顺风半轴 2–2.5 倍塔身半径（≤ 12 km）、上风方短一半、横向 0.7 倍
        if (Ht > 9.5 && alt > 7.0) {
          vec2 da = xz - c - uUpperWind * (4.0 + 1.5 * h3.y);
          float al = dot(da, uUpperWind);
          float La = min(Rt * (2.0 + 0.5 * h2.y), 12.0);
          // 平面是向下风方张开的扇形（T44）：靠近塔顶窄（横向 0.45 倍），越往下风越宽（0.8 倍）；上风方只伸出一点（0.4 倍）。
          // 旧版横向处处 0.7 倍、上风 0.55 倍，从侧面看塔顶两边对称地伸出一圈帽檐，远处的塔读成蘑菇 / 高脚杯
          vec2 dw = vec2(al / (al > 0.0 ? 1.0 : 0.4), dot(da, vec2(-uUpperWind.y, uUpperWind.x)) / mix(0.45, 0.8, smoothstep(-0.3 * La, La, al)));
          float e = dot(dw, dw) / (La * La);
          if (e < 1.0) {
            float k = (1.0 - e) * (1.0 - e) * smoothstep(9.5, 10.5, Ht);
            aSum += k;
            aTopW += k * Ht;
          }
          aRho = min(aRho, rho / Rt);
        }
        // 塔身（含侧向气泡、表面隆起）离塔轴不超过约 1.5 倍半径 + 隆起
        if (rho > 1.6 * Rt + 2.5) continue;
        float sd = bandTowerSdf(xz, alt, c, Ht, Rt, h3);
        if (sd < sdf) gHurCell = vec3(id, coreC);
        // 相邻的塔平滑并在一起（塔群），交界处是凹进去的阴影
        sdf = sminStorm(sdf, sd, 1.0);
      }
      // 菜花隆起：越往上越翻腾（塔顶最明显），低处平缓
      sdf -= bump * mix(0.6, 1.2, smoothstep(3.0, 10.0, alt)) * smoothstep(0.5, 2.5, alt);
      float towerD = smoothstep(0.0, 0.35, -sdf);
      float anv = 0.0;
      if (aSum > 0.0) {
        // 砧：不是一块圆盘——
        //  - 厚度随核值（离砧心越远越小）变薄，外缘薄到没有；两座塔的核叠在一起更厚，砧连成一片；
        //  - 顶面：靠近塔顶翻腾（约 3 km 的圆鼓包），往外被吹平、略微下沉；
        //  - 底面：大尺度起伏 + 絮状的小鼓包（向下垂），靠近塔顶处向下弯、和塔身连成蘑菇伞；
        //  - 外缘被高空风撕成纤维（沿风拉长、随高度变的噪声）。
        // 顶面、底面是高度场，只用水平切片噪声（README 坑点：3D 噪声当高度场会断成漂浮的团块）
        float Fa = min(aSum, 1.0);
        float topA = aTopW / aSum;
        vec4 nH = textureLod(uShapeNoise, vec3(xz / 14.0, 0.47), max(lod - 1.0, 0.0));
        vec2 wn = vec2(dot(xz, uUpperWind), dot(xz, vec2(-uUpperWind.y, uUpperWind.x)));
        vec4 nA = textureLod(uShapeNoise, vec3(wn.x / 16.0, alt / 2.5, wn.y / 3.5) + 0.61, max(lod - 1.0, 0.0));
        float fib = nA.b * 0.6 + nA.g * 0.4;
        float aTopS = topA - 0.35 - 1.0 * (1.0 - Fa) + (0.15 + 0.7 * Fa) * hurCap(nH.g) + 0.5 * (nB.g - 0.5);
        float thick = 0.25 + 2.2 * pow(Fa, 1.4) + 0.5 * min(aSum - Fa, 1.0);
        float aBot = aTopS - thick + 0.8 * (nB.a - 0.5) * Fa - 0.6 * max(hurCap(nH.b), 0.0) * Fa
                   - 1.8 * (1.0 - smoothstep(0.6, 1.6, aRho));
        float edge = smoothstep(0.0, 0.3, Fa - 0.15 + 0.55 * (fib - 0.5));
        float a = smoothstep(aBot, aBot + 0.35, alt) * (1.0 - smoothstep(aTopS - 0.35, aTopS, alt)) * edge;
        // 冰晶云比水滴云稀：中心不透明，外缘半透明
        anv = a * mix(0.12, 0.85, smoothstep(0.1, 0.75, Fa));
      }
      // 两侧是 1–3 km 高的层状云「裙边」（雨区），带与带之间是晴空或零散的小积云
      float H = 1.0 + 1.6 * band * (0.6 + 0.4 * nU.r) + 0.5 * bump - 0.6 * (1.0 - band);
      float skirt = smoothstep(0.0, 0.35, H - alt) * smoothstep(0.5, 0.8, alt);
      float bd = max(max(towerD, skirt), anv);
      if (bd > d) {
        d = bd;
        bool isAnvil = anv > towerD && anv > skirt;
        gHurSoft = isAnvil;
        gHurCanopy = false;
        // 砧是半透明的冰晶云，不做表面侵蚀（侵蚀会把 0.1–0.4 的稀薄外缘整片削掉）
        wallW = isAnvil ? 0.0 : 1.0;
        // 裙边（1–3 km 的层状雨区云）顶面看得到整片天：旧版和塔身一样按高度压到约一半，天空的蓝色补光少了，
        // 受光面只剩偏暖的直射，雨带上的低云读成沙土色（T44）。只有裙边的下半截、贴着塔的地方暗一些
        bool isSkirt = !isAnvil && skirt > towerD;
        ao = isAnvil ? mix(0.5, 1.0, smoothstep(9.0, 12.0, alt))
           : isSkirt ? mix(0.55, 1.0, smoothstep(H - 1.0, H - 0.1, alt))
           // 塔身（T38，T44 遗留）：明暗交给隆起（鼓包顶面亮、鼓包之间的折痕暗），按高度压暗减轻（旧版 0.5 → 1：
           // 和步进里按高度的环境光叠在一起，下半截整片发暗，读成圆桶）
           : mix(0.25, 1.0, smoothstep(-1.0, 0.8, bump)) * mix(0.75, 1.0, smoothstep(0.5, 8.0, alt));
      }
    }
  }
`;

const HUR_BANDS_LIGHT = /* glsl */ `
  // ---- 外围螺旋雨带（受光步进用的简化版）----
  // 完整版的 3×3 单体循环（每格一座塔 + 砧）被内联进受光步进后，云程序的真冷启动多约 4 s（+20%），帧时间也涨得多。
  // 这里只算完整版记下的那一座塔（gHurCell），不算砧、表面隆起和其他塔的遮挡：朝太阳的光学厚度只要大概，
  // 但塔的形状必须和完整版一致——试过用一道不分单体的「脊」近似，塔身受光面出现大块亮斑、背面整片发黑
  if (r > Re * 2.8 && alt < 15.0) {
    // 带子的断续（强度噪声）不采样：受光步进每步少一次纹理读取，裙边按带子全连着算
    float cb = cos(6.0 * theta - 18.5 * log(max(r, 1.0)));
    float radial = smoothstep(Re * 2.8, Re * 4.0, r) * (1.0 - smoothstep(Re * 13.0, Re * 17.0, r));
    float band = smoothstep(0.2, 0.75, cb) * radial;
    float topHere = mix(13.0, 8.5, smoothstep(Re * 3.5, Re * 15.0, r)) + 1.5;
    vec3 bc = gHurCell;
    if ((band > 0.01 || bc.z > 0.0) && alt < topHere) {
      // 直接用完整版在这条受光射线的起点记下的那座塔（gHurCell）：射线上其他塔的遮挡不算
      const float CELL = 11.0;
      float towerD = 0.0;
      if (bc.z > 0.0) {
        vec2 h1 = stormHash22(bc.xy + 17.3);
        vec2 h2 = stormHash22(bc.xy * 1.7 + 3.1);
        vec2 h3 = stormHash22(bc.xy * 2.3 + 7.9);
        vec2 c = (bc.xy + 0.2 + 0.6 * h1) * CELL;
        float rcc = length(c - uHurricane.xy);
        float coreC = bc.z;
        float topMax = mix(13.0, 8.5, smoothstep(Re * 3.5, Re * 15.0, rcc));
        float Ht = 2.0 + (mix(5.0, topMax, h2.y * (1.3 - 0.3 * h2.y)) - 2.0) * mix(0.55, 1.0, coreC);
        float Rt = CELL * (0.22 + 0.24 * h1.x) * mix(0.75, 1.0, coreC);
        // 受光步进的一步有多长（gLightLen，km），过渡带就放多宽：约等于「这一步落在塔里的比例」。
        // 旧版只按中点取 0 / 1，后几步一步几公里，中点进出塔身在某个高度上一跳，背光面的亮度跟着跳 4 倍：
        // 近处的塔半腰一条水平分界、下半截整片发暗，读成圆桶（T38，T44 遗留；读回的光学厚度只有 227 / 457 两个值）
        towerD = smoothstep(-0.5 * gLightLen, 0.35 + 0.5 * gLightLen, -bandTowerSdf(xz, alt, c, Ht, Rt, h3));
      }
      float H = 1.0 + 1.6 * band * 0.8 - 0.6 * (1.0 - band);
      float skirt = smoothstep(0.0, 0.35, H - alt) * smoothstep(0.5, 0.8, alt);
      float bd = max(towerD, skirt);
      if (bd > d) { d = bd; wallW = 1.0; ao = 1.0; }
    }
  }
`;

export const CLOUD_COMMON = /* glsl */ `
uniform sampler3D uShapeNoise;
uniform sampler3D uDetailNoise;
uniform sampler2D uWeather;
uniform vec2 uCloudOffset;      // km
uniform float uCloudBottom;     // 云底高度，km
uniform float uCloudTop;        // 云顶高度，km
uniform float uCoverage;        // 0..1
uniform float uCloudType;       // 0 = 层积云（扁平），1 = 积云（圆顶高耸）
uniform float uCloudDensity;    // 消光系数的倍率
uniform vec3 uCuShape;         // C-TOFU：(nA 竖直倍率, nB 竖直倍率, 积云族权重)，clouds.ts 的 cumulusShape() 每帧按层厚 / 云型算好
// ---- 天气系统 ----
uniform float uShellBottom;     // 所有云（层状云、雷暴、台风）合起来的高度范围，km
uniform float uShellTop;
uniform int uStormCount;
uniform vec4 uStorms[4];        // 雷暴单体：(本地 x, 本地 z, 塔身半径 km, 云顶高度 km)
uniform vec2 uUpperWind;        // 高空风方向（砧状云被吹向下风方）
uniform vec4 uHurricane;        // 台风：(本地 x, 本地 z, 风眼半径 km, 是否启用)
uniform vec4 uFlash;            // 闪电放电通道的一端（低端）：(本地 x, 高度 km, 本地 z, 强度)
uniform vec3 uFlashB;           // 放电通道的另一端：(本地 x, 高度 km, 本地 z)；云内闪电是几公里长的一段
// 云影图（T27，见 cloudShadow 和 clouds.ts 的 SHADOW_FRAG）：三级并排，RGBA = 从 0 / 1 / 2 / 3 km 高度出发朝光源的透射率
uniform sampler2D uCloudShadowMap;
uniform vec3 uCloudShadowSun;     // 建图时的主光源方向
uniform vec3 uCloudShadowCenter;  // xy：建图时的中心（世界坐标 km）；z：1 = 图已建好
uniform float uCloudDepthOn;      // 1：云缓冲右半（云的平均深度，T38）这一帧写了（PERF-11，见 cloudBufferDepth）

// 雷暴 / 台风的占据网格（见文件头 OCC_*）。只有云步进程序定义 CLOUD_OCC：窗外程序的 sampler 已满 16/16，
// 云影、探针照旧逐点求值
#ifdef CLOUD_OCC
uniform sampler3D uOcc;
uniform vec2 uOccOrigin;        // 格点 (0, 0) 的世界坐标（km）
uniform vec2 uOccAlt;           // (第 0 层的高度, 层距)，km
uniform float uOccValid;        // 0：网格还没建好（程序还在后台编译），一律当作有云
#endif
// ---- 天气变体（PERF-10）----
// 雷暴 / 台风的密度代码只编进定义了 CLOUD_STORM / CLOUD_TYPHOON 的程序（clouds.ts 的变体材质按需编译，
// 两者任一定义时 clouds.ts 同时加 CLOUD_WEATHER，放两者共用的部分）。默认程序（晴天 / 普通云）预处理后不含任何雷暴 / 台风代码：
// 这些代码平时靠 uniform 分支跳过、却一直编在默认程序里，云步进离线 FXC 13.9 s 中 12.4 s 是它们（第 6 波性能报告 §2.4）
#ifdef CLOUD_WEATHER
// 这条视线（连同它的受光步进）够得着雷暴 / 台风吗（T33）。云步进程序按像素设：够不着的像素（例如雷暴在几百公里外、
// 或在身后）把雷暴 / 台风整个当作不存在，走普通云的快路径（192 步、展开的受光步进、不查天气）。
// 其他程序（云影图、占据网格、探针）不设，保持 true
bool gWeatherOn = true;

// 这一点可能有雷暴 / 台风的云吗（false = 肯定没有，可以不求它们的密度）
bool cloudWeatherMaybe(vec2 xz, float alt) {
#ifdef CLOUD_OCC
  if (uOccValid < 0.5) return true;
  vec3 uvw = vec3((xz - uOccOrigin) / ${OCC_SPACING.toFixed(3)} + 0.5, (alt - uOccAlt.x) / uOccAlt.y + 0.5)
           / vec3(${OCC_N.toFixed(1)}, ${OCC_N.toFixed(1)}, ${OCC_LAYERS.toFixed(1)});
  // 网格外（离网格中心 128 km 以外）照旧逐点求值
  if (any(lessThan(uvw, vec3(0.0))) || any(greaterThan(uvw, vec3(1.0)))) return true;
  return textureLod(uOcc, uvw, ${OCC_MIP.toFixed(1)}).r > 0.0;
#else
  return true;
#endif
}
float gLightLen = 0.0;   // 受光步进这一步代表的长度（km），只在雷暴 / 台风的受光步进里非 0（T38，见 HUR_BANDS_LIGHT）
#endif

const float SHAPE_TILE = 7.0;     // 形状噪声一个周期覆盖的水平距离，km
const float DETAIL_TILE = 0.9;
const float WEATHER_TILE = 90.0;
// 积云的消光系数量级是 50–100 /km；密度场是 0..1，乘上这个值
const float CLOUD_EXTINCTION = 60.0;

float remapc(float v, float a, float b, float c, float d) {
  return clamp(c + (v - a) / (b - a) * (d - c), min(c, d), max(c, d));
}

// ---- 噪声的随机平铺（T32）----
// 细节噪声一个周期只有 0.9 km（最低一级 Worley 每周期 2 个格子），远处细的几级被 mip 滤掉后只剩这一级：
// 同一组云团每 0.9 km 重复一次，巡航高度看中远处的云海是一排排等距的小云团（像铺瓷砖；自相关峰 0.3–0.5）。
// 做法同海面（T21）：按世界坐标的三角格子（Mikkelsen 2022 的 TriangleGrid）做「六边形随机平铺」
// （Heitz & Neyret 2018）——每个格点给纹理一个随机平移（水平 + 竖直）和任意角度的水平旋转，
// 采样点取周围三个格点的样本，按重心权重做方差守恒混合（均值 + Σwᵢ(sᵢ − 均值) / √Σwᵢ²）：
// 统计性质（均值、方差）不变，整片云海上不再有周期
const float DETAIL_FBM_MEAN = 0.4756;   // 细节噪声 fbm（r·0.625 + g·0.25 + b·0.125）的均值（handoff/T32-noise-stats.mjs 实测）

// 整数哈希 pcg3d（Jarzynski & Olano 2020）：格点编号是精确的整数
vec3 cloudHash3(ivec3 p) {
  uvec3 v = uvec3(p) * 1664525u + 1013904223u;
  v.x += v.y * v.z; v.y += v.z * v.x; v.z += v.x * v.y;
  v ^= v >> 16u;
  v.x += v.y * v.z; v.y += v.z * v.x; v.z += v.x * v.y;
  return vec3(v) * (1.0 / 4294967296.0);
}

// 三角格子：st 是以「格距」为单位的水平坐标。返回周围三个格点的整数编号、
// 采样点相对各格点的位置（格距为单位，已换回正交坐标）和重心权重
struct HexTaps { ivec2 id[3]; vec2 rel[3]; vec3 w; };
HexTaps hexTaps(vec2 st) {
  HexTaps t;
  vec2 sk = vec2(st.x - st.y * 0.57735027, st.y * 1.15470054);
  vec2 skF = floor(sk);
  vec2 fr = sk - skF;
  float zz = 1.0 - fr.x - fr.y;
  float up = step(zz, 0.0);               // 落在菱形的上半个三角形
  float sg = 2.0 * up - 1.0;
  t.w = vec3(-zz * sg, up - fr.y * sg, up - fr.x * sg);   // 和为 1
  vec2 vo0 = vec2(up, up), vo1 = vec2(up, 1.0 - up), vo2 = vec2(1.0 - up, up);
  ivec2 base = ivec2(skF);
  t.id[0] = base + ivec2(vo0); t.id[1] = base + ivec2(vo1); t.id[2] = base + ivec2(vo2);
  vec2 d0 = fr - vo0, d1 = fr - vo1, d2 = fr - vo2;
  // 反斜变换：x = a + b/2，z = b·√3/2
  t.rel[0] = vec2(d0.x + 0.5 * d0.y, d0.y * 0.8660254);
  t.rel[1] = vec2(d1.x + 0.5 * d1.y, d1.y * 0.8660254);
  t.rel[2] = vec2(d2.x + 0.5 * d2.y, d2.y * 0.8660254);
  return t;
}

// 细节噪声的一个格点的样本：rel 是采样点相对格点的位置（平铺周期为单位），h 是这个格点的随机数：
// 纹理随机平移（水平 xy + 竖直 x + y）、水平任意角度旋转（z）
float detailTap(vec2 rel, vec3 h, float qy, float lod) {
  float ang = h.z * 6.2831853;
  float ca = cos(ang), sa = sin(ang);
  vec2 r = vec2(ca * rel.x - sa * rel.y, sa * rel.x + ca * rel.y) + h.xy;
  vec3 dn = textureLod(uDetailNoise, vec3(r.x, qy / DETAIL_TILE + h.x + h.y, r.y), lod).rgb;
  return dn.r * 0.625 + dn.g * 0.25 + dn.b * 0.125;
}

// 受光步进（朝太阳的一小段）的细节噪声只取随机平铺的一个格点（gDetailLight = true 时）：
// 云步进那一点（完整三样本）顺手按权重随机挑一个格点（随机数 gDetailRnd），把它的位置和随机数记在 gDetailVert / gDetailHash，
// 这一段受光步进的样本都沿用这个格点的变换，不再求格子和哈希。
// 受光步进也三样本全取时，展开的受光循环里多了三份格子 / 哈希 / 取样，云步进 GPU 时间涨约 20%；
// 固定沿用权重最大的格点又会在格子交界处突变，光照上露出一圈圈六边形的边。随机挑的期望就是按权重的平均，时间累积会把噪点抹平。
// 受光步进用到细节的只有最近的几百米，和一个平铺周期（0.9 km）相比很短，沿用同一个格点的变换是连续的。
// 云步进那一点没求细节（150 km 以外、或那一点只有雷暴 / 台风的云）时沿用上一个求过的格点：只是换了一个随机平移，仍然连续
float gDetailRnd = 0.5;
bool gDetailLight = false;
vec2 gDetailVert = vec2(0.0);
vec3 gDetailHash = vec3(0.0);

// 细节噪声的 fbm，随机平铺。q = (水平 x, 高度, 水平 z)，km。
// 格距 = 一个平铺周期：一个格点管的区域约一个周期大，整个周期至多完整出现一次
float detailFbm(vec3 q, float lod) {
  vec2 st = q.xz / DETAIL_TILE;
  if (gDetailLight) return detailTap(st - gDetailVert, gDetailHash, q.y, lod);
  HexTaps t = hexTaps(st);
  // 权重取三次方再归一：过渡带变窄，两套图案叠在一起的「重影」区域少一些（方差守恒混合负责保住对比度）
  vec3 w = t.w * t.w * t.w;
  w /= dot(w, vec3(1.0));
  int pick = gDetailRnd < w.x ? 0 : (gDetailRnd < w.x + w.y ? 1 : 2);
  float s = 0.0;
  for (int j = 0; j < 3; j++) {
    vec3 h = cloudHash3(ivec3(t.id[j], 7));
    if (j == pick) { gDetailVert = st - t.rel[j]; gDetailHash = h; }
    // 权重很小的格点（三次方后 < 2%）不取样：平均每点从 3 个样本降到约 2 个，混合结果几乎不变
    if (w[j] > 0.02) s += w[j] * (detailTap(t.rel[j], h, q.y, lod) - DETAIL_FBM_MEAN);
  }
  return clamp(DETAIL_FBM_MEAN + s * inversesqrt(dot(w, w)), 0.0, 1.0);
}

// 高度剖面：层积云扁而平，积云底平、顶圆
float heightProfile(float h, float type) {
  float stratus = smoothstep(0.0, 0.08, h) * (1.0 - smoothstep(0.35, 0.7, h));
  float cumulus = smoothstep(0.0, 0.12, h) * (1.0 - smoothstep(0.45, 1.0, h));
  return mix(stratus, cumulus, type);
}

// ---- 积云的立体形状（C-TOFU：去掉「二维轮廓往上挤出来」的豆腐块）----
// 旧版三个成因（research/TOWERING.md §2.1，着色器开关对照定位）：
//  ①形状噪声竖直方向几乎不变：大云团那级 nB 竖直周期约 18 km（alt × 0.9 / 16.1 km）、小的 nA 约 5.4 km，
//    积云层只有 2–5 km 厚 → 一层之内噪声只随水平位置变，云就是水平轮廓的竖直挤出；
//  ②剖面 h 0.12–0.45 是满密度平台，再 ×4.5 饱和 → 侧壁竖直，云顶被剖面的下降段统一截平；
//  ③远处取到形状噪声 mip 4–5（128³ 的 mip 5 只剩 4³ 纹素），三线性插值的平面小面在竖直方向连成肋纹。
// 竖直频率按层厚归一（uCuShape.xy，算法和常数在 clouds.ts 的 cumulusShape()：每帧在 CPU 上算一次，
// 着色器里写成 clamp(7 / (1.3·层厚)) 这类算术的话，layerDensity 被内联进步进 / 受光 / 云影各处，cloud-march 冷编译 +10%）
// ③远处竖肋：试过形状噪声 mip 封顶 3（C-TOFU 初版），竖直频率与云顶改好以后远排几乎看不出差别，
// 却让云 pass 贵 5–10%、远处时间噪声更高（C-TOFU 审查复测），已撤回，mip 仍按步长取
// 这一列的云顶（h 单位，按局部云顶归一）：归一强度 σ = (d − CU_VIS_D) / max(覆盖率 − CU_VIS_D, CU_RANGE_MIN)，
// 云顶 = 基 + (1 − 基)·σ^(1/CU_TOP_POW)：弱的芯（σ → 0，云的水平边缘）只到 CU_DOME_BASE，高度连续收到云底（圆顶），
// 最强的才顶到局部云顶；同一片云场里云顶高低错落，「多数矮、少数高」来自 σ 本身的分布（强芯少）。
// 云顶用一块「斜天花板」压：d ≤ CU_VIS_D + CU_TOP_GRAD·(云顶 − h)，天花板正好在云顶处降到「看得见」的门槛。
// 斜率 CU_TOP_GRAD 决定云顶那一层被细节侵蚀啃成菜花的厚度（旧版剖面下降段在 d 空间的斜率约 0.75；0.5 碎块偏多、0.75 稀疏天气里云量掉得多，取 0.6）：
//  - 太缓（初版按 (覆盖率 − CU_VIS_D)·门槛(h) 从 d 里扣，斜率约 0.2）：云的上半截整段都是「刚过阈值」的淡密度，
//    细节侵蚀把它啃成一片悬空的碎块（浓积云预设近处满是「爆米花」）；
//  - 太陡（试过云顶下 0.12 内把 d 乘到 0，斜率约 3）：侵蚀没有余地，云顶是光滑的塑料团子，弱的云被削成薄片、云量明显变少。
//  - CU_VIS_D：细节侵蚀平均吃掉的 d（远处不取细节时 layerDensity 就按 0.275 侵蚀），d 高出它的那段才看得见；
//  - CU_RANGE_MIN：覆盖率接近 CU_VIS_D 时（稀疏的天气）「看得见的一段」很窄，不按它放大，否则一点点强度差就把弱云拉满整层；
//    直接用 d / 覆盖率（不扣 CU_VIS_D）的话，低覆盖率天气里所有看得见的云 σ 都挤在 0.7–1，全都一样高（初版踩过：成了扁饼）
//  - CU_CEIL 以上乘法收到 0：最强的几列在局部云顶处收口，不在 h = 1 处一刀截平
const float CU_DOME_BASE = 0.25;
const float CU_TOP_POW = 1.2;
const float CU_TOP_GRAD = 0.6;
const float CU_VIS_D = 0.275;
const float CU_RANGE_MIN = 0.15;
const float CU_CEIL = 0.8;
float cumulusTop(float d, float coverage) {
  float sig = clamp((d - CU_VIS_D) / max(coverage - CU_VIS_D, CU_RANGE_MIN), 0.0, 1.0);
  return CU_DOME_BASE + (1.0 - CU_DOME_BASE) * pow(sig, 1.0 / CU_TOP_POW);
}

// ---- 天气场：决定每个区域长什么样的云，而不只是「有没有云」----
struct Weather {
  float coverage;  // 0..1
  float top;       // 这一带的云顶占整层厚度的比例：云顶高低起伏，不是一刀切平
  float scaleMix;  // 0 = 小碎积云，1 = 大云团
  vec2 warp;       // 采样坐标的扭曲（km），打散噪声纹理的网格感
};

Weather sampleWeather(vec2 xz) {
  // 显式用 mip 0：天气图一个像素约 176 m，远比像素覆盖范围粗；隐式导数在循环里没有定义（D3D X3595）
  vec4 w1 = textureLod(uWeather, xz / WEATHER_TILE, 0.0);
  vec4 w2 = textureLod(uWeather, xz / (WEATHER_TILE * 0.31) + 0.37, 0.0);
  vec4 w3 = textureLod(uWeather, xz / (WEATHER_TILE * 3.1) + 0.71, 0.0);
  Weather w;
  float field = w1.r * 0.55 + w2.r * 0.25 + w3.r * 0.2;
  float c = clamp(uCoverage + (field - 0.5) * 1.2, 0.0, 1.0);
  // 中尺度组织（主要对积云）：
  //  - 对流单体：闭合单体（云在单体中心）和开放单体（云在单体边缘、中心晴空）两种形态按区域切换
  float cells = w1.g;
  float openCells = smoothstep(0.4, 0.6, w3.b);
  float cellular = mix(cells, 1.0 - cells, openCells);
  //  - 云街：沿低层风向排成一条条，间距约 4 km，只在部分区域出现
  const vec2 LOW_WIND = vec2(0.94, 0.34);
  float across = dot(xz, vec2(-LOW_WIND.y, LOW_WIND.x));
  float streets = 0.5 + 0.5 * sin(across * 1.57 + (w2.b - 0.5) * 6.0);
  float streetZone = smoothstep(0.55, 0.75, w3.g);
  float org = mix(0.45 + 0.9 * cellular, 0.35 + 0.9 * streets, streetZone);
  c *= mix(1.0, org, uCloudType * 0.8);
  // 小单体：让云团之间的间隙有大有小
  c *= mix(1.0, 0.75 + 0.5 * w2.a, uCloudType * 0.5);
  w.coverage = clamp(c, 0.0, 1.0);
  w.top = mix(0.45, 1.0, smoothstep(0.2, 0.8, w1.b * 0.6 + w2.b * 0.4));
  w.scaleMix = smoothstep(0.35, 0.65, w3.b * 0.5 + w2.r * 0.5);
  // 扭曲场必须平缓（梯度远小于 1）：旧版用了 5 km 的 Worley 小单体（带尖锐折痕），扭曲的梯度 > 1，
  // 噪声被沿某个方向拉长、折叠，云上满是斜向的拖影和一圈椭圆形的「分身」（T13）
  w.warp = (vec2(w1.b, w3.r) - 0.5) * 2.0;
  return w;
}

vec2 rot2(vec2 p, float a) {
  float c = cos(a), s = sin(a);
  return vec2(c * p.x - s * p.y, s * p.x + c * p.y);
}

#ifdef CLOUD_STORM
// 积雨云塔脚周围的低云（TW04）：塔脚淹在一圈浓积云 / 层积云里（上升气流带起的低云、辐合带），远看塔底不是一刀平切地
// 「坐」在海面上（research/TOWERING.md §2.2 第 5 条）。不另写一套裙边密度（试过：高度场做的裙边是一块边缘整齐的圆盘 / 一排蛋托），
// 而是让普通云层在塔的 1–3.5 倍半径内云量变大——裙边和远处的积云是同一种云、同一套受光。返回要加到覆盖率上的量（0..0.5）
// layerDensity 不自己算（它被内联进展开的 6 步受光等多处，循环写在里面 cloud-march-storm 离线 FXC +3%）：
// cloudDensity 按采样点算一次放进 gCovBoost，同一样本的受光步进（几公里内）沿用；云影 / 探针程序不算（0）
float gCovBoost = 0.0;
float stormLayerBoost(vec2 xz) {
  float b = 0.0;
  for (int i = 0; i < uStormCount; i++) {
    vec4 c = uStorms[i];
    vec2 d = xz - c.xy;
    float r2 = dot(d, d) / (c.z * c.z);
    if (r2 < 12.25) b = max(b, 0.5 * (1.0 - smoothstep(1.4, 12.25, r2)));
  }
  return b;
}
#endif

// 层状云（普通云层）的密度：lod 是噪声采样的 mip 级别，远处用粗的；detail = false 时跳过细节侵蚀（阴影、远景用）
float layerDensity(vec3 p, float lod, bool detail) {
  float r = length(p);
  float alt = r - BOTTOM;
  float thick = uCloudTop - uCloudBottom;
  float hLayer = (alt - uCloudBottom) / thick;
  if (hLayer <= 0.0 || hLayer >= 1.0) return 0.0;
  vec2 xz = p.xz + uCloudOffset;
  // 卷云的权重（云型接近 0）。卷云专用的代码只编进定义了 CLOUD_CIRRUS 的程序（云步进的卷云变体、云影、探针）：
  // 写成不分支的算术、或按 uniform 分支（平时一次都不走），积云场景的云步进都会落到慢一档
  // （noon-cumulus 0.40 → 0.50 ms，typhoon-bands +20%，T12 按 pass 计时；和 W00 奇观代码同一类坑）
  float cir = 0.0;
  const vec2 HIGH_WIND = vec2(0.8, 0.6);
  vec2 xzW = xz;
#ifdef CLOUD_CIRRUS
  if (uCloudType < 0.2) {
    cir = 1.0 - smoothstep(0.0, 0.2, uCloudType);
    // 卷云的成片范围也顺风拉长（天气图沿风向压缩 3 倍）：一条条顺风的卷云带，而不是一块块圆斑
    xzW -= HIGH_WIND * (dot(xz, HIGH_WIND) * 0.67 * cir);
  }
#endif
  Weather wx = sampleWeather(xzW);
#ifdef CLOUD_STORM
  wx.coverage += gCovBoost * (1.0 - wx.coverage);
#endif
  if (wx.coverage < 0.01) return 0.0;
  // 这一带的云顶：高度剖面按局部云顶重新归一
  float h = hLayer / wx.top;
  if (h >= 1.0) return 0.0;
  vec2 xw = xz + wx.warp;
  vec2 xzn = vec2(dot(xw, HIGH_WIND), dot(xw, vec2(-HIGH_WIND.y, HIGH_WIND.x)));
#ifdef CLOUD_CIRRUS
  if (cir > 0.0) {
    // 卷云（T12）：冰晶被高空风拉成纤维状的丝缕。沿风向拉长 14 倍、横向压窄 1.8 倍（丝缕只有几十到两百米宽）；
    // 丝缕在几十公里上缓慢蜿蜒；冰晶下落拖出的「马尾」随高度被风切变甩向一侧：越往下横向偏得越多，
    // 从下面斜着看是一条条向一侧弯下去的钩（钩卷云）。旧版只拉长 5 倍、阈值和积云一样，是一团团灰色的棉絮
    float fall = 1.0 - h;
    float across = xzn.y + cir * (1.3 * sin(xzn.x * 0.13 + 5.0 * wx.warp.x) + 1.6 * fall * fall * (0.6 + wx.warp.y));
    xzn = vec2(xzn.x / (1.0 + 13.0 * cir), across * (1.0 + 0.8 * cir));
  }
#endif
  // 两个尺度的形状噪声，相互旋转 37°，按区域混合：有的地方是小碎云，有的地方是大云团
  // 竖直频率按层厚归一（C-TOFU，见 uCuShape 的注释）。
  // 竖直频率只改积云族（cuW）：层积云 / 高积云 / 卷云本来就该是薄层，照旧
  float cuW = uCuShape.z;
  float va = uCuShape.x;
  float vb = uCuShape.y;
  vec4 nA = textureLod(uShapeNoise, vec3(xzn.x, alt * va, xzn.y) / SHAPE_TILE, lod);
  vec2 xzB = rot2(xzn, 0.65);
  vec4 nB = textureLod(uShapeNoise, vec3(xzB.x, alt * vb, xzB.y) / (SHAPE_TILE * 2.3) + 0.37, max(lod - 1.0, 0.0));
  float fbmA = nA.g * 0.625 + nA.b * 0.25 + nA.a * 0.125;
  float fbmB = nB.g * 0.625 + nB.b * 0.25 + nB.a * 0.125;
  float baseA = remapc(nA.r, fbmA - 1.0, 1.0, 0.0, 1.0);
  float baseB = remapc(nB.r, fbmB - 1.0, 1.0, 0.0, 1.0);
  float base = mix(baseA, baseB, wx.scaleMix);
  // 云底（T12）：抬升凝结高度处处差不多，所以积云底大体是平的，但不是一整块光滑的平面——
  // 按约 0.4 km 的小单体（nA.a）和几公里的大起伏（fbmB）上下错开，有的地方垂下来一兜、有的地方缩上去，
  // 云底才有明暗不一的絮团。只挪高度剖面的输入，不多取纹理
  float hB = h + (1.0 - cir) * (0.09 * (nA.a - 0.45) + 0.05 * (fbmB - 0.5)) * (1.0 - smoothstep(0.1, 0.3, h));
  // 积云族（云型 > 0.45）不再用「满密度平台 + 统一下降段」的剖面（C-TOFU），改成「云顶随这一列的强度变」：
  // 剖面只管云底，云顶由这一列的强度决定（cumulusTop）——强的芯长得高、弱的矮，边缘处高度连续收到云底（圆顶），
  // 层积云 / 高积云 / 卷云（云型 ≤ 0.45）照旧
  base *= mix(heightProfile(hB, uCloudType), smoothstep(0.0, 0.12, hB) * (1.0 - smoothstep(CU_CEIL, 1.0, h)), cuW);
  float coverage = wx.coverage;
  float d = remapc(base, 1.0 - coverage, 1.0, 0.0, 1.0) * coverage;
  float topC = cumulusTop(d, coverage);
  d = mix(d, max(min(d, CU_VIS_D + CU_TOP_GRAD * (topC - h)), 0.0), cuW);
  // 卷云的丝缕要细：覆盖阈值再往上抬，只留噪声的脊
#ifdef CLOUD_CIRRUS
  if (cir > 0.0) d = remapc(d, 0.25 * cir, 1.0, 0.0, 1.0);
#endif
  if (detail && d > 0.0) {
    float dfbm = detailFbm(vec3(xzn.x, alt, xzn.y), lod);
    // 云底是被抽丝的絮状，云顶是翻卷的菜花状；卷云整层都是抽丝的
    float hs = clamp(h * 5.0, 0.0, 1.0) * (1.0 - cir);
    float dmod = mix(dfbm, 1.0 - dfbm, hs);
    // 云底最下面一两百米侵蚀得更狠：碎絮挂在云底下，而不是一刀切的底面
    d = remapc(d, dmod * (0.55 + 0.25 * (1.0 - smoothstep(0.0, 0.15, h)) + 0.2 * cir), 1.0, 0.0, 1.0);
  } else d = remapc(d, 0.275 + 0.1 * cir, 1.0, 0.0, 1.0);
  // 不取细节时按细节噪声的均值（约 0.5 × 0.55）侵蚀，不取纹理（T12）。旧版不侵蚀：大形比画出来的云胖一大圈、又被 ×3.5 饱和成实心，
  // 受光步进后 3 步（0.4–3 km，不带细节）落在这些「胖影子」里。太阳低时光线平着穿过整层云，几乎每个样本都被邻居的胖大形挡住：
  // sunset-wing 逆光的积云整团是灰褐色剪影，顶上和边缘没有一点被照亮的金边（受光光学厚度置 0 / 后 3 步也带细节，金边都回来）。
  // 150 km 以外的远云也走这里，和近处带细节的云一样瘦，不再有「越远越胖」的接缝
  // 真实积云的边界在几十米内消光就从 0 升到 ~50/km：让密度在边缘快速饱和，轮廓才干脆
  // 卷云不饱和：冰晶云的丝缕中间浓、两边渐淡，是半透明的（T12）
  // 饱和倍率 3.5 → 4.5（C10）：沿视线的表皮剖面实测（handoff/C10.md）视线光学厚度到 1 要进云约 100 m、到 3 约 200 m，
  // 进云 100 m 处 σ 中位只有 12 /km（真实积云 50–150 /km，表皮几十米）。倍率越大表皮越薄、轮廓越干脆，
  // 但半透明的薄丝在 1 spp 下变成「要么全中要么全空」，单帧颗粒和时间波动随之上升（×6 时相邻差 +12%、最差 +31%）；
  // 4.5 当初配合云步进的进云二分定位（C10）取得噪声持平；C10b 撤掉二分、改成近处空白步不加倍（clouds.ts），噪声反而更低，倍率未动
  return min(d * mix(4.5, 1.5, cir), 1.0) * uCloudDensity;
}

// ---- 雷暴（积雨云）----
// 形状用「有符号距离（km）+ 翻卷隆起」来描述，而不是「按高度改变半径」：
//  - 塔身：一根被高空风吹斜的圆柱，顶上是扁圆的穹顶（主塔的穹顶高出砧顶约 1 km，就是上冲云顶）；
//    表面叠两级圆鼓鼓的隆起（约 3 km 和 1 km），隆起的高度和它的尺寸相当，所以是菜花状而不是撕碎的纸片。
//  - 砧状云：单独的一块「透镜」，平面外形只随水平位置变（和高度无关），顶面平缓，底面向外缘抬升、越往外越薄，
//    下风方伸得更远；底下挂着半椭球形的乳状云口袋。
//  - 云底以下是倾斜的雨幡，截面不规则、带竖直的雨丝。
// 旧版把砧状云的半径交给随高度变化的 Worley 噪声去调，每个高度的外缘各不相同，看起来是一层层叠起来的盘子。
#ifdef CLOUD_WEATHER
// cloudDensity 的副产物（最近一次求值的点）：是否属于雷暴、雷暴的环境光遮蔽（隆起之间的凹处、砧底、雨幡里看到的天空少）
float gStormW = 0.0;
float gStormAO = 1.0;
float gStormSoft = 0.0;   // 1：属于软边的部分（雷暴的砧和雨幡、台风的卷云盖和砧），见 gStormSoftHit / gHurSoft

// 雷暴、台风雨带共用的两个小工具
vec2 stormHash22(vec2 p) {
  vec3 p3 = fract(vec3(p.xyx) * vec3(0.1031, 0.1030, 0.0973));
  p3 += dot(p3, p3.yzx + 33.33);
  return fract((p3.xx + p3.yz) * p3.zy);
}

float sminStorm(float a, float b, float k) {
  float h = clamp(0.5 + 0.5 * (b - a) / k, 0.0, 1.0);
  return mix(b, a, h) - k * h * (1.0 - h);
}
#endif

#ifdef CLOUD_STORM
const float STORM_BASE = 1.2;
const float STORM_OVERSHOOT = 1.3;   // 上冲云顶最多高出 uStorms.w（砧顶）多少，km（TW04：按单体 0.7–1.3，见 stormTowersSdf）

// 乳状云口袋：平面上的格子，每格至多一个口袋，位置几乎可以贴到格边、半径 0.3–0.75 格各不相同，约 1/4 的格子空着；
// 返回这一点下垂的深度（格为单位，口袋剖面是半椭球 √(1 − (d/半径)²)，大口袋更深），相邻口袋重叠处取最深的（T37）。
// 旧版每个口袋一样大、特征点被限制在格子中间，砧底是一排大小一样、间距一样的扇贝（美术总监 wave5）。
// 半径 ≤ 0.75 格、中心离格边 ≥ 0.05 格：3×3 以外的口袋够不着采样点，不会截出直边
float pouchField(vec2 p) {
  vec2 id = floor(p);
  vec2 f = fract(p);
  float best = 0.0;
  for (int x = -1; x <= 1; x++)
  for (int y = -1; y <= 1; y++) {
    vec2 o = vec2(float(x), float(y));
    vec2 h = stormHash22(id + o);
    vec2 fp = o + 0.05 + 0.9 * h - f;
    float d2 = dot(fp, fp);
    // PERF-STORM：口袋半径 ≤ 0.75 格，中心离采样点 ≥ 0.75 格的格子一定够不着（s ≤ 0），不必算第二个哈希。
    // 结果逐位不变；9 个格子里平均只有约 2 个过这一关。乳状云带里这段是雷暴云步进最贵的一处（去掉整个口袋场 ×0.68–0.75，
    // 这一条 + mammatusDensity 的深度剪枝 ×0.72，handoff/PERF-STORM.md）
    if (d2 >= 0.5625) continue;
    vec2 h2 = stormHash22(id + o + 41.7);
    float rad = 0.3 + 0.45 * h2.x;
    float s = 1.0 - d2 / (rad * rad);
    if (s > 0.0 && h2.y > 0.25) best = max(best, (0.4 + 1.2 * h2.y * h2.y) * rad * sqrt(s));
  }
  return best;
}

// Worley 值（1 − 到最近特征点的距离）→ 球冠隆起 √(1 − d²) − 0.55：每个格子鼓成圆顶，交界处是尖锐的折痕（菜花）。
// 直接用 Worley 值是圆锥形的尖包
float stormCap(float w) {
  float dd = clamp((1.0 - w) * 1.6, 0.0, 1.0);
  return sqrt(1.0 - dd * dd) - 0.55;
}

// 一座对流塔的有符号距离（km，负值在云里）。apex：穹顶最高点；R：塔身半径；sd：这座塔的两个随机数（0..1）；
// neck：顶部收窄的比例（主塔的上冲云顶比塔身窄，伴生塔 0）。ao：隆起之间凹处的遮蔽（0..1）
// TW04 重做（research/TOWERING.md §2.2 第 1、3 条：中远处是光滑竖壁的柱子、塔底平切、缺多尺度卷团）：
//  - 外形：塔脚窄（约 0.6R）、中上部最胖（约 1.1R），一节节上升气泡叠出的腰身（±15%），截面按方位角两级起伏（几股上升气流并成一簇），
//    倾斜程度每座塔不同；
//  - 隆起三级：约 3.3 / 1.6 / 1.05 km（形状噪声 G / B 两个 Worley 频率，两次取样就有），高度与尺度相当，更细的交给细节侵蚀；
//    远处 mip 封顶（大的一级 2、小的一级 3）：旧版按步长取 mip，150 km 外 mip 4–5 把隆起平均成常数，只剩光滑的竖壁；
//  - 云底不是一刀切的平面：±0.2 km 的起伏；塔脚周围的低云由层状云负责（layerDensity 里按离塔多远加云量，stormLayerBoost）
float towerSdf(vec2 xz, float alt, vec2 axis, float R, float apex, float domeFrac, float lod, vec2 sd, float neck, out float ao) {
  ao = 1.0;
  float H = apex - STORM_BASE;
  float h = (alt - STORM_BASE) / H;
  if (h < -0.1 || h > 1.12) return 1e3;
  // 轴线随高度缓慢摆动（一簇小塔错落上升），上半截被高空风吹斜（斜多少每座塔不同）。
  // 摆动必须是平滑的低频函数：旧版用 Worley 噪声，每隔几百米整个截面就横移一公里多，侧面成了一层层的锯齿
  float ph = sd.x * 6.2831853;
  vec2 wob = vec2(sin(alt * 0.45 + ph), sin(alt * 0.33 + ph * 1.7 + 1.3)) * R * 0.12;
  vec2 shear = uUpperWind * R * (0.4 + 0.7 * sd.y) * h * h;
  vec2 rel = xz - axis - wob - shear;
  float r = length(rel);
  if (r > R * 2.4) return r - R * 1.6;  // 远离塔身：不必算噪声，给一个保守的距离
  // 截面的方位角起伏：cos / sin 的倍角直接由方向向量得到（不求 atan）
  vec2 cs = rel / max(r, 1e-3);
  vec2 cs2 = vec2(cs.x * cs.x - cs.y * cs.y, 2.0 * cs.x * cs.y);
  vec2 cs3 = vec2(cs2.x * cs.x - cs2.y * cs.y, cs2.x * cs.y + cs2.y * cs.x);
  float a2 = ph * 3.0 + h * 2.0, a3 = ph * 5.0 - h * 3.0;
  float lobe = 0.13 * (cs2.y * cos(a2) + cs2.x * sin(a2)) + 0.07 * (cs3.y * cos(a3) + cs3.x * sin(a3));
  float prof = (0.6 + 0.52 * smoothstep(0.0, 0.55, h) - 0.1 * smoothstep(0.65, 1.0, h)) * (1.0 - neck * smoothstep(0.72, 1.0, h));
  prof *= 1.0 + (0.1 * sin(h * 17.0 + ph) + 0.06 * sin(h * 29.0 + 2.3 * ph + 1.7)) * smoothstep(0.05, 0.25, h) + lobe;
  float Rd = R * prof;
  float domeStart = STORM_BASE + H * domeFrac;
  float Hd = apex - domeStart;
  vec2 q = vec2(r / Rd, max(alt - domeStart, 0.0) / Hd);
  float lq = length(q);
  float sdf = (lq - 1.0) * mix(Rd, Hd, q.y / max(lq, 1e-3));
  // 隆起的尺度随塔身半径缩：半径 2–3 km 的伴生塔上叠 3 km 的大团就成了一个土豆（坐标缩放不多取样；按 R 平移错开，免得相邻小塔花纹相同）
  float bs = clamp(R / 5.5, 0.45, 1.0);
  vec3 bq = vec3(xz.x, alt, xz.y) + vec3(sd.x, 0.0, sd.y) * 17.0 * (1.0 - bs);
  vec4 nA = textureLod(uShapeNoise, vec3(bq.x, bq.y * 0.8, bq.z) / (13.0 * bs), min(lod, 2.0));
  vec4 nB = textureLod(uShapeNoise, vec3(bq.x, bq.y * 1.1, bq.z) / (4.2 * bs) + 0.31, min(lod, 3.0));
  // 试过再叠两级（约 0.5 / 0.26 km，按 mip 淡出）：cloud-march-storm 离线 FXC +14%（towerSdf 在步进程序里内联 4 份），
  // 近处那一尺度本来就由细节侵蚀（DETAIL_TILE 0.9 km 的三级 Worley）负责，撤了
  float bump = 1.9 * stormCap(nA.g) + 0.8 * stormCap(nA.b) + 0.6 * stormCap(nB.g) + 0.25 * (nB.r - 0.55);
  bump *= mix(0.35, 1.0, smoothstep(0.03, 0.3, h)) * bs;
  // 隆起的顶端看得到大半个天空，凹处只看得到一小块
  ao = smoothstep(-1.1, 0.7, bump);
  float base = STORM_BASE + 0.25 * (nA.a - 0.5) + 0.15 * stormCap(nA.b);
  return max(sdf - bump, base - alt);
}

// 砧状云（含乳状云）：返回密度（0..1），ao 是环境光遮蔽
float anvilDensity(vec2 xz, float alt, vec2 center, float R, float top, float lod, out float ao, out vec3 geo) {
  ao = 1.0;
  geo = vec3(0.0, 9.0, 0.0);
  float H = top - STORM_BASE;
  float thick0 = 0.22 * H;                 // 中心处约 2.7 km 厚
  if (alt < top - thick0 - 2.6 || alt > top + 0.4) return 0.0;  // 下限含乳状云和靠近塔身处下弯的砧底
  vec2 ac = center + uUpperWind * R * 1.5; // 被高空风吹向下风方
  vec2 da = xz - ac;
  float ra = length(da);
  float down = dot(da, uUpperWind) / max(ra, 1e-3);  // 1 = 正下风方，-1 = 上风方
  // 平面外形：只取噪声的一个水平切片，和高度无关
  vec4 np = textureLod(uShapeNoise, vec3(xz / (R * 6.0), 0.37), lod);
  float Ra = R * 2.6 * (1.0 + 0.7 * max(down, 0.0) - 0.25 * max(-down, 0.0)) * (0.8 + 0.45 * np.g);
  float rho = ra / Ra;
  if (rho > 1.35) return 0.0;
  // 外缘是被高空风拉开的冰晶纤维：沿风向拉长的噪声。
  // 必须随高度变（竖直尺度约 0.7 km）：只用水平切片时，侧看每一列都一样，被竖直拉成木板纹（飑线里最明显）
  vec2 wn = vec2(dot(xz, uUpperWind), dot(xz, vec2(-uUpperWind.y, uUpperWind.x)));
  vec4 nf = textureLod(uShapeNoise, vec3(wn.x / (R * 3.0), alt / 2.8, wn.y / (R * 0.35)) + 0.61, lod);
  float fib = nf.b;
  // 顶面：对流层顶附近几乎是平的，只有缓慢起伏，向外缘略微下沉
  // 顶面起伏：约 1.5 km 的圆鼓包（球冠化的 Worley），靠近塔顶翻腾得厉害，往外缘被吹平
  vec4 nu = textureLod(uShapeNoise, vec3(xz / 6.0, 0.53), lod);
  float du = clamp((1.0 - nu.g) * 1.6, 0.0, 1.0);
  float und = sqrt(1.0 - du * du) - 0.55;
  // 两级：约 1.5 km 的圆鼓包 + 约 0.7 km 的小鼓包；塔顶附近翻腾（±1 km），往外缘被吹平但不是平板（T37：旧版幅度 0.7 → 0.15，侧看是一块光滑的板）
  float dv = clamp((1.0 - nu.b) * 1.6, 0.0, 1.0);
  float und2 = sqrt(1.0 - dv * dv) - 0.55;
  float aTop = top - 0.2 - 0.9 * rho * rho + 0.6 * (np.b - 0.5) + (und * 1.3 + und2 * 0.6) * mix(1.0, 0.35, smoothstep(0.1, 0.9, rho));
  // 底面：中心厚、外缘薄成一片；有大尺度的起伏
  // 下风方是被吹出去的冰晶主体，外缘仍有一两公里厚；上风方很快变薄
  // 下风方的外缘也要越来越薄（T37：旧版外缘仍厚 1.3 km，侧看是一块齐边的厚板）
  float thick = mix(thick0, 0.25 + 0.6 * max(down, 0.0), pow(min(rho, 1.0), 0.6));
  float aBot = aTop - thick + 0.6 * (np.a - 0.5) * smoothstep(0.2, 0.6, rho);
  // 和塔顶连续过渡：靠近塔身上端的地方砧底向下弯，像蘑菇伞从伞柄上长出来，而不是一块插在塔上的板
  float dTop = length(xz - center - uUpperWind * R * 0.7);
  aBot -= 2.0 * (1.0 - smoothstep(0.5 * R, 2.2 * R, dTop));
  float vert = smoothstep(aBot - 0.05, aBot + 0.25, alt) * (1.0 - smoothstep(aTop - 0.25, aTop + 0.05, alt));
  // 下风方的前缘变薄、变碎：纤维噪声在下风方权重更大
  float edge = 1.0 - smoothstep(0.55, 1.0, rho + (0.6 + 0.5 * max(down, 0.0)) * (fib - 0.5) + 0.4 * (nf.r - 0.5));
  // 冰晶云比水滴云稀：中心不透明，外缘半透明
  float dens = vert * edge * mix(0.8, 0.12, smoothstep(0.25, 1.0, rho));
  // 砧底和砧的下半部分看到的天空少
  ao = mix(0.45, 1.0, smoothstep(aBot, aTop, alt));
  // 砧底下的冰晶幡试过用竖直拉长的噪声做，远看成了一排梳齿状的竖条（squall 里尤其明显），先去掉
  geo = vec3(aBot, rho, down);   // 给乳状云用
  return dens;
}

// 乳状云：砧底下风方的一圈，挂着一个个半椭球形的口袋（口袋底面 = 砧底 − 深度 × √(1 − (d/半径)²)）。geo = (砧底, rho, down)
float mammatusDensity(vec2 xz, float alt, vec3 geo) {
  float aBot = geo.x;
  float zone = smoothstep(0.3, 0.45, geo.y) * (1.0 - smoothstep(0.65, 0.8, geo.y)) * smoothstep(-0.2, 0.4, geo.z);
  if (zone <= 0.0 || alt > aBot + 0.3 || alt < aBot - 1.0) return 0.0;
  // 成簇：一片片口袋群（约 5–10 km），群与群之间的砧底是平的或只有零星几个；群里的口袋有大有小（两级格子：1.4 km、0.6 km）
  float cl = smoothstep(0.38, 0.62, textureLod(uShapeNoise, vec3(xz / 11.0, 0.21), 0.0).r);
  // PERF-STORM 深度剪枝（结果逐位不变）：pouchField ≤ 1.6·0.75 = 1.2，两级合起来 pd ≤ 1.2·1.4 = 1.68，下垂深度 ≤ 0.75·1.68·cl·zone；
  // 采样点在砧底下比这还深时 pb ≥ alt，下面的 smoothstep(pb, …, alt) 必为 0。乳状云带（砧底下 1 km）里大半的采样点在这一关就退出
  if (cl <= 0.0 || aBot + 0.1 - alt >= 1.26 * cl * zone) return 0.0;
  float pd = max(pouchField(xz / 1.4) * 1.4, pouchField(xz / 0.6 + 7.3) * 0.6 * 0.8);
  float depth = 0.75 * pd * cl * zone;
  if (depth <= 0.01) return 0.0;
  float pb = aBot + 0.1 - depth;
  // 深浅不一：口袋越深越浓（远处看得出一个个下垂的圆底），浅的只是砧底的一点起伏
  return smoothstep(pb, pb + 0.12, alt) * (1.0 - smoothstep(aBot + 0.1, aBot + 0.3, alt)) * mix(0.3, 0.5, smoothstep(0.1, 0.5, depth));
}

// 雨幡：云底以下、主塔下方偏下风一点；被低层风吹斜；截面不规则，边缘是一道道竖直的雨丝
float rainDensity(vec2 xz, float alt, vec2 center, float R, float lod) {
  const vec2 LOW_WIND_R = vec2(0.94, 0.34);
  vec2 dr = xz - center - uUpperWind * R * 0.25 - LOW_WIND_R * (STORM_BASE - alt) * 0.35;
  float n = textureLod(uShapeNoise, vec3(xz / (R * 2.0), 0.83), lod).g;
  float rr = length(dr) / (R * (0.4 + 0.35 * n));
  if (rr > 1.4) return 0.0;
  // 雨丝：水平约 150 m，竖直方向拉得很长
  float streak = textureLod(uShapeNoise, vec3(xz.x / 1.2, alt * 0.02, xz.y / 1.2) + 0.13, max(lod - 1.0, 0.0)).b;
  float core = 1.0 - smoothstep(0.1, 1.2, rr + 0.5 * (streak - 0.5));
  // 强降水的消光约 1–2 /km（能见度 1–3 km）；贴近云底更密，近地面略有蒸发
  float sigma = 1.8 * core * (0.5 + 0.9 * streak) * mix(0.75, 1.0, alt / STORM_BASE) * smoothstep(0.0, 0.1, alt);
  return sigma / CLOUD_EXTINCTION;
}

// ---- 砧盾（TW04）----
// 真实积雨云的砧向下风铺开几十到一百多公里（孤立单体），上风侧只伸出一点、边缘陡，下风侧越来越薄、被高空风撕成纤维；
// 飑线 / 团簇的几块砧连成一整片起伏的层状云盾（research/TOWERING.md §2.2 第 2 条）。旧版只有每个单体一块半径 10–36 km 的透镜
// （anvilDensity），远看是一张薄圆盘（「飞碟」），飑线是四块透镜连成的一条等厚长板。
// 做法（research/PERF_PREVIEW_wave8.md 的预审：照原样把透镜放大 2–5 倍，砧覆盖的天空 ×4–25，雷暴天整帧 ×1.3–2）：
// 砧的外缘不走逐单体的 SDF，改成一片「砧盾」层状密度——每个单体只贡献一个平面椭圆足迹（纯算术：下风半轴、上风半轴、向下风张开的宽度），
// 足迹叠加（相邻单体的砧连成一片）、按足迹加权出顶高与厚度，然后整片只取一次水平切片噪声（顶面鼓包、底面起伏、边缘）
// 和一次顺风拉长的纤维噪声（只在主步进）。靠近塔身的砧根、蘑菇伞与乳状云仍由 anvilDensity 负责，两者取最大。
// 受光走正常的 8 步受光步进（精简密度里也有砧盾）；步进把它当软边（不细化、稀薄处 2 倍步长）。
// 试过像台风卷云盖那样用「本点消光 × 到砧顶的斜程」解析受光：砧底被照得和砧顶一样白，仰看是一片发亮的波纹，
// 也没有塔身、砧根投在砧盾上的影子；而且并不省——受光步进让砧底变暗，视线的透射率降得快、早停，
// gpu-ab 反而比解析版快 6–12%（storm-day ×1.58 对 ×1.81，飑线 ×1.74 对 ×1.85）

// 单体的种子：按半径与砧顶取（换原点时整体平移，按位置取哈希会让形状在换原点时跳变）
vec2 stormSeed2(vec4 c) { return stormHash22(vec2(c.z * 7.13 + c.w * 0.37, c.w * 3.71 + c.z * 1.9)); }
// 砧盾下风半轴 / 上风半轴（km）：孤立单体下风 6–17 倍塔身半径（R 4–6.5 km → 约 25–110 km），上风 1.2–2 倍
vec2 shieldAxes(vec4 c, vec2 h) {
  return vec2(c.z * (6.0 + 11.0 * h.x), c.z * (1.2 + 0.8 * h.y));
}
// 砧盾的平面外接圆（xy：世界坐标圆心，z：半径 km），给视线 / 采样点的包围判断用（clouds.ts）
vec3 shieldCircle(vec4 c) {
  vec2 L = shieldAxes(c, stormSeed2(c));
  return vec3(c.xy + uUpperWind * (c.z * 0.7 + (L.x - L.y) * 0.5), (L.x + L.y) * 0.5 + c.z * 2.5 + 8.0);
}
const float SHIELD_BELOW = 6.5;   // 砧盾在砧顶以下最多伸到多深（厚 3 km、多单体叠加处 ×1.55，+ 顶面下沉与底面起伏）
const float SHIELD_ABOVE = 1.3;
const float SHIELD_LIGHT_K = 0.36;   // 受光（精简密度 / 云影 / 阴影估计）里砧盾消光的 δ 缩放，见 cloudDensityLite   // 砧顶以上（顶面鼓包）

// 砧盾的密度（0..1）。detail：主步进（取纤维与细节噪声）；受光 / 云影 / 探针 / 占据网格不取
float anvilShield(vec2 xz, float alt, float lod, bool detail) {
  vec2 W = uUpperWind;
  vec2 Pp = vec2(-W.y, W.x);
  float aSum = 0.0, topW = 0.0, thW = 0.0, faW = 0.0;
  for (int i = 0; i < uStormCount; i++) {
    vec4 c = uStorms[i];
    if (alt < c.w - SHIELD_BELOW || alt > c.w + SHIELD_ABOVE) continue;
    vec2 h = stormSeed2(c);
    vec2 L = shieldAxes(c, h);
    // 从被高空风吹歪的塔顶量起
    vec2 d = xz - c.xy - W * (c.z * 0.7);
    float a = dot(d, W);
    float fa = clamp(a / L.x, 0.0, 1.0);
    // 下风方的中线略弯（高空风随距离转向），弯向按单体随机
    float b = dot(d, Pp) - (h.y - 0.5) * 0.5 * a * fa;
    // 平面是向下风张开的扇形：塔顶处宽约 2 倍塔身半径，每往下风走 1 km 半宽加 0.36 km（约 20°）
    float wh = c.z * 1.9 + 0.36 * max(a, 0.0);
    float u = a > 0.0 ? a / L.x : -a / L.y;
    float e = u * u + (b * b) / (wh * wh);
    if (e >= 1.0) continue;
    float k = 1.0 - e;
    aSum += k;
    // 顶高：塔顶附近在砧顶，往下风缓慢下沉（冰晶被吹出去以后慢慢沉降，远端低 1–1.6 km）
    topW += k * (c.w - 0.15 - (1.0 + 0.6 * h.x) * fa * fa);
    // 厚度：塔顶附近约 3 km，下风端只剩几百米；上风侧一直很厚、到边上陡降（上风侧陡）
    thW += k * (a > 0.0 ? mix(3.0, 0.3, pow(fa, 0.6)) : mix(3.0, 1.6, -a / L.y));
    faW += k * fa;
  }
  if (aSum <= 0.0) return 0.0;
  float F = min(aSum, 1.0);
  float topA = topW / aSum;
  // 几个单体的足迹叠在一起（飑线 / 团簇）的地方砧更厚、底面垂得更低：旧版相连的砧是一张等厚平板，塔与塔之间露出规整的「门洞」
  // （TW02 审查遗留 ①）。足迹和超过 1 的部分最多再厚 1.6 km
  float thA = thW / aSum * (1.0 + 0.55 * clamp(aSum - 1.0, 0.0, 1.0));
  float fa = faW / aSum;
  // 取噪声之前先按起伏的上限判高度（下面 aTop / aBot 的噪声项取到极值时的范围）：砧盾那一段高度层里大半是空的
  // （下风薄段只有几百米厚），视线在层里空走的每一步都不必取纹理
  float und0 = (1.0 - fa) * (1.0 - fa);
  if (alt > topA + 0.7 * und0 + 0.02 || alt < topA - thA * (0.35 + 0.65 * sqrt(F)) - 1.5 * und0 - 0.02) return 0.0;
  // 水平切片噪声（高度场只能用水平切片，README 坑点）：约 6 km / 3 km / 1.5 km 的鼓包 + Perlin-Worley 的大起伏
  vec4 nH = textureLod(uShapeNoise, vec3(xz / 24.0, 0.29), max(lod - 1.0, 0.0));
  float dG = clamp((1.0 - nH.g) * 1.6, 0.0, 1.0);
  float dB = clamp((1.0 - nH.b) * 1.6, 0.0, 1.0);
  float capG = sqrt(1.0 - dG * dG) - 0.55;
  float capB = sqrt(1.0 - dB * dB) - 0.55;
  // 顶面：塔顶附近翻腾（±0.5 km 的圆鼓包），往下风被吹平但不是平板。
  // 试过 ±0.8 km：从略低于砧顶的巡航高度斜看，下风方下沉的顶面整片是光滑的大鼓包，读成一层融化的塑料
  // 大起伏（整片上下挪，不改厚度）+ 顶面鼓包（只在厚的砧根一带）
  // 起伏都只在砧根一段（× (1 − fa)²）：下风的薄段只有几百米厚，巡航高度就在它下面不远，整片按 24 km 的光滑噪声上下挪
  // 零点几公里，仰看是一条条光滑的等值线波纹（ab 开关对照：去掉这张噪声波纹就没了）；那一段的纹理交给顺风的纤维
  float und = (1.0 - fa) * (1.0 - fa);
  float aTop = topA + (0.4 * (nH.r - 0.5) + (0.12 + 0.55 * (1.0 - fa)) * (capG + 0.6 * capB)) * und;
  // 底面：厚度按足迹平滑变化，起伏与下垂的絮团只在厚的一段。
  // 试过顶面、底面各自按噪声起伏：下风端只有几百米厚，两面的起伏和厚度同量级，整片被一条条等值线掐断，
  // 从下面仰看是一层层发亮的波纹（像水面的焦散）
  float aBot = aTop - thA * (0.35 + 0.65 * sqrt(F)) + ((0.7 * (nH.a - 0.5)) - 0.6 * max(capB, 0.0)) * und;
  if (alt < aBot || alt > aTop) return 0.0;
  // 纤维：沿高空风拉长的噪声（顺风约 11 km、横风约 1.2 km、竖直约 0.4 km），只在主步进取
  float fib = 0.5;
  float ero = 1.0;
  if (detail) {
    vec2 wn = vec2(dot(xz, W), dot(xz, Pp));
    vec4 nF = textureLod(uShapeNoise, vec3(wn.x / 45.0, alt / 1.6, wn.y / 5.0) + 0.41, lod);
    fib = nF.b * 0.6 + nF.g * 0.4;
    // 细节：和塔顶砧（anvilDensity）同一种按比例变稀疏的侵蚀，冰晶云表面是絮状的，不是光滑的壳
    vec3 dn = textureLod(uDetailNoise, vec3(xz.x, alt, xz.y) / DETAIL_TILE, lod).rgb;
    ero = clamp(0.35 + 1.3 * (dn.r * 0.625 + dn.g * 0.25 + dn.b * 0.125 - 0.3), 0.25, 1.1);
  }
  // 外缘：足迹的边被纤维和小鼓包撕开，下风端撕得更碎
  float edge = smoothstep(0.0, 0.2, F - 0.12 + (0.25 + 0.6 * fa) * (fib - 0.5) + 0.3 * (nH.a - 0.5));
  // 竖直剖面按相对厚度（上下各 30% 渐变）：薄的地方不会被两条固定宽度的渐变带夹成一条线
  float xv = (alt - aBot) / max(aTop - aBot, 0.05);
  float vert = smoothstep(0.0, 0.3, xv) * (1.0 - smoothstep(0.7, 1.0, xv));
  // 冰晶云：塔顶附近不透明（消光约 30 /km），下风端只剩光学厚度一两（能透出后面的天），沿纤维一条条浓淡
  return vert * edge * ero * mix(0.5, 0.045, smoothstep(0.0, 0.9, fa)) * mix(0.7 + 0.6 * fib, 0.25 + 1.5 * fib, smoothstep(0.2, 0.8, fa));
}

// 砧盾投在下面云层上的影子（TW04）：光学厚度的解析估计（只有足迹循环的算术，不取纹理）。
// 层状云离塔心 7.5R + 15 km 以外的样本走 6 步只有层状云的受光（2.8 km），够不着 10 km 以上的砧；
// 而一片上百公里的砧盾把下面整片云海罩进阴影，是积雨云「大」的主要线索之一（海面的影子由云影图负责，已经有）。
// p：采样点的世界坐标（xz）与高度；sunDir：主光源方向。沿光线走到砧盾的中间高度，在那里按足迹估计竖直柱的光学厚度，再按斜程放大
float anvilShadowOD(vec2 xz, float alt, vec3 sunDir) {
  if (sunDir.y < 0.03) return 0.0;
  float od = 0.0;
  vec2 W = uUpperWind;
  vec2 Pp = vec2(-W.y, W.x);
  for (int i = 0; i < uStormCount; i++) {
    vec4 c = uStorms[i];
    float hm = c.w - 1.2;                        // 砧盾的中间高度（大致）
    if (alt > hm - 0.5) continue;
    vec2 q = xz + sunDir.xz * ((hm - alt) / sunDir.y);
    vec2 h = stormSeed2(c);
    vec2 L = shieldAxes(c, h);
    vec2 d = q - c.xy - W * (c.z * 0.7);
    float a = dot(d, W);
    float fa = clamp(a / L.x, 0.0, 1.0);
    float b = dot(d, Pp) - (h.y - 0.5) * 0.5 * a * fa;
    float wh = c.z * 1.9 + 0.36 * max(a, 0.0);
    float u = a > 0.0 ? a / L.x : -a / L.y;
    float e = u * u + (b * b) / (wh * wh);
    if (e >= 1.0) continue;
    float F = 1.0 - e;
    float th = (a > 0.0 ? mix(3.0, 0.3, pow(fa, 0.6)) : 3.0) * (0.35 + 0.65 * sqrt(F));
    // 与 anvilShield 的密度一致（纤维取均值），边缘按 F 的门槛淡出；× 0.6：竖直柱里上下渐变各 30%
    od += smoothstep(0.1, 0.35, F) * mix(0.5, 0.045, smoothstep(0.0, 0.9, fa)) * th * 0.6 * CLOUD_EXTINCTION;
  }
  return od / sunDir.y;
}

// stormDensity 的副产物：这一点取的是「软边」的部分（砧、雨幡），见 gStormSoft
bool gStormSoftHit = false;


// 幞状云（pileus，TW04 / SPEC-PILEUS）：迅速长高的浓积云塔顶上方几百米处一顶光滑的「头巾」——塔顶把上面的湿空气层抬到饱和，
// 凝结成一片薄薄的、边缘光滑的帽子，披在塔顶上，塔继续长就会把它顶穿。靠近太阳时常带虹彩（小而均匀的新生云滴衍射）。
// 挂在按种子挑中的那座伴生塔（k = 0，约六成的雷暴有）上：它最像「正在长的塔」，也低于主塔的上冲云顶，不碰外壳上限。
// 形状：一片弯的透镜，中心在塔顶正上方 0.35–0.7 km，半径 1.1–1.5 倍塔身，向四周下垂（披下来），厚 0.12–0.3 km，不侵蚀（光滑）
float gStormPileus = 0.0;   // cloudDensity 的副产物：1 = 这一点属于幞状云（受光加虹彩），2 = 雨幡（只吸收，见 clouds.ts）
// 幞状云的密度：stormTowersSdf 顺手算出（伴生塔 k = 0 的轴线、塔顶、半径都已在手，不再重复求哈希 / 三角函数；
// 单独写成一个函数、在完整密度与精简密度里各求一次时，雷暴云步进 gpu-ab ×1.2——FXC 的寄存器 / 分档翻到慢的一档）
float gPileusD = 0.0;
float pileusShape(vec2 xz, float alt, vec2 ax, float tk, float Rk, vec2 hk, float sdy) {
  float gap = 0.2 + 0.25 * hk.y;
  if (alt < tk - 0.8 || alt > tk + gap + 0.4) return 0.0;
  // 与 towerSdf 同一条轴线（摆动 + 被高空风吹歪），取塔顶处
  float ph = hk.x * 6.2831853;
  vec2 axT = ax + vec2(sin(tk * 0.45 + ph), sin(tk * 0.33 + ph * 1.7 + 1.3)) * Rk * 0.12 + uUpperWind * (Rk * (0.4 + 0.7 * hk.y) + 0.3);
  float Rh = Rk * (0.95 + 0.3 * sdy);
  float rr = length(xz - axT) / Rh;
  if (rr > 1.0) return 0.0;
  float mid = tk + gap - 0.7 * rr * rr;          // 往外下垂
  float th = mix(0.28, 0.1, rr);
  float v = 1.0 - smoothstep(0.0, 1.0, abs(alt - mid) / th);
  return v * smoothstep(1.0, 0.7, rr) * 0.1;
}

// 主塔 + 伴生塔（TW04）：完整版与精简版共用（形状必须一致，T12 教训），各内联一处。ao：取胜那座塔的凹处遮蔽。
// 旧版伴生塔固定 3 座、等角度（k·2.1 rad）、等比例（0.45R、顶 0.35 + 0.12k），每座雷暴都是同一个配方（铁律 4）；
// 现在按单体种子：2–4 座，方位集中在一侧（侧翼线）再各自随机偏，离主塔 1.25–2.35R，半径 0.3–0.58R，顶 0.28–0.7 倍塔高（少数高、多数矮）
float stormTowersSdf(vec4 c, vec2 xz, float alt, float lod, out float ao) {
  float top = c.w;
  float R = c.z;
  vec2 sd = stormSeed2(c);
  gPileusD = 0.0;
  // 上冲云顶：高出砧顶 0.7–1.3 km、比塔身窄（neck 0.35）；外壳只留到砧顶 + 1.8 km（weather.ts updateShell），隆起再高会被截平
  float sdf = towerSdf(xz, alt, c.xy, R, top + 0.7 + 0.6 * sd.y, 0.72, lod, sd, 0.35, ao);
  // 伴生塔数量写成「4 + 一个恒为 0 的 uniform 表达式」，FXC 就不会把塔身 SDF 展开 4 份
  int nSat = 2 + int(sd.x * 2.99);
  float flank = sd.y * 6.2831853;
  for (int k = 0; k < 4 + min(uStormCount, 0); k++) {
    if (k >= nSat) break;
    vec2 hk = stormHash22(sd * 37.1 + float(k) * 1.37);
    float ang = flank + (float(k) - 0.5 * float(nSat - 1)) * 1.1 + (hk.x - 0.5) * 0.9;
    vec2 ax = c.xy + vec2(cos(ang), sin(ang)) * R * (1.25 + 1.1 * hk.y);
    float tk = STORM_BASE + (top - STORM_BASE) * (0.28 + 0.42 * hk.y * hk.y);
    float Rk = R * (0.3 + 0.28 * hk.x);
    // 幞状云（约六成的雷暴有）挂在 k = 0 这座塔上
    if (k == 0 && fract(sd.x * 7.31 + sd.y * 3.17) < 0.6) gPileusD = pileusShape(xz, alt, ax, tk, Rk, hk, sd.y);
    if (alt > tk + 0.8) continue;
    float a2;
    float s2 = towerSdf(xz, alt, ax, Rk, tk, 0.45 + 0.2 * hk.x, lod, hk, 0.0, a2);
    if (s2 < sdf) ao = a2;
    // 低处融合得更宽：小塔和主塔从同一片云底长出来（飑线侧翼那样连成一体），高处才各自分开
    sdf = sminStorm(sdf, s2, mix(2.2, 0.6, smoothstep(STORM_BASE + 0.5, STORM_BASE + 3.5, alt)));
  }
  return sdf;
}

float stormDensity(vec4 c, vec2 xz, float alt, float lod, bool detail, out float ao) {
  ao = 1.0;
  gStormSoftHit = true;
  float top = c.w;
  float R = c.z;
  if (alt > top + STORM_OVERSHOOT + 0.7) return 0.0;
  float rain = 0.0;
  if (alt < STORM_BASE + 0.1) {
    rain = rainDensity(xz, alt, c.xy, R, lod);
    ao = 0.3; // 头顶是几公里厚的云
    if (alt < STORM_BASE - 0.1) { gStormPileus = 2.0; return rain; }
  }
  // 主塔（穹顶就是上冲云顶）+ 伴生的浓积云小塔 + 塔脚的低云裙边（TW04）
  float aoT;
  float sdf = stormTowersSdf(c, xz, alt, lod, aoT);
  // 从表面往里约 250 m 内密度升到饱和：边界干脆，但步进能看到它的厚度
  float tower = smoothstep(0.0, 0.25, -sdf);
  float aoA;
  vec3 geo;
  float anvil = anvilDensity(xz, alt, c.xy, R, top, lod, aoA, geo);
  float mam = mammatusDensity(xz, alt, geo);
  // 乳状云的口袋有清楚的圆底，按硬边处理（要表面细化）
  bool isMam = mam > anvil;
  if (isMam) { anvil = mam; aoA = 0.5; }
  // 幞状云：比砧优先（两者不会重叠），光滑、不侵蚀
  float pil = gPileusD;
  if (pil > anvil) { anvil = pil; aoA = 1.0; isMam = false; gStormPileus = 1.0; }
  if (tower <= 0.0 && anvil <= 0.0) { gStormPileus = rain > 0.0 ? 2.0 : gStormPileus; return rain; }
  if (detail) {
    vec3 dn = textureLod(uDetailNoise, vec3(xz.x, alt, xz.y) / DETAIL_TILE, lod).rgb;
    float dfbm = dn.r * 0.625 + dn.g * 0.25 + dn.b * 0.125;
    // 塔身：表面附近侵蚀成小的圆团（反相 Worley）；砧：按比例变稀疏，保留半透明的外缘
    tower = remapc(tower, (1.0 - dfbm) * 0.45, 1.0, 0.0, 1.0);
    if (gStormPileus < 0.5) anvil *= clamp(0.35 + 1.3 * (dfbm - 0.3), 0.25, 1.1);
  }
  if (tower >= anvil) {
    ao = aoT;
    gStormSoftHit = rain > tower;
    if (rain > tower) gStormPileus = 2.0;
    return max(tower, rain);
  }
  ao = aoA;
  gStormSoftHit = !isMam || rain > anvil;
  if (rain > anvil) gStormPileus = 2.0;
  return max(anvil, rain);
}

// 精简版雷暴密度：塔身（含伴生塔）和砧的大形 + 雨幡，没有乳状云、细节侵蚀。
// 给光线步进（朝太阳）、云影、探针用：这些地方只要光学厚度的大概，而完整版被内联进 4 个地方，冷编译慢了约 50%。
// 雨幡必须在（T45）：旧版这里没有雨幡，雨幡朝太阳的受光步进一路透明、不自遮挡。黄昏太阳贴着地平线从云底下平射进来，
// 整片雨幡被照透，逆光看又落在前向散射的峰上，云底下挂着一块边缘清楚的橙色发光椭圆（美术总监 wave6 第 4 条的「飞碟」）
float stormDensityLite(vec4 c, vec2 xz, float alt, float lod) {
  float top = c.w;
  float R = c.z;
  if (alt > top + STORM_OVERSHOOT + 0.7) return 0.0;
  float rainL = alt < STORM_BASE + 0.1 ? rainDensity(xz, alt, c.xy, R, lod) : 0.0;
  if (alt < STORM_BASE - 0.1) return rainL;
  float ao;
  float sdf = stormTowersSdf(c, xz, alt, lod, ao);
  float pilL = gPileusD;
  vec3 geo;
  return max(max(max(smoothstep(0.0, 0.25, -sdf), pilL), anvilDensity(xz, alt, c.xy, R, top, lod, ao, geo)), rainL);
}
#endif

#ifdef CLOUD_TYPHOON
// ---- 台风 ----
// 按真实的台风眼（Hurricane Hunters 飞入眼内的照片、「体育场效应」）建模：
//  - 眼壁是向外倾斜的「看台」：下窄上宽，各扇区倾角 30–55° 不等；表面有一级级水平的台阶（层状条纹），
//    叠着约 10 km / 5 km / 2 km 三级球冠隆起（对流塔），塔的强弱按扇区变化；顶部向外卷进卷云盖，没有切边。
//    噪声在极坐标里采样（切向拉长约 2.5 倍，像被 60 m/s 的切向风抹开），切向周期取整数，绕一圈无缝。
//  - 眼底是成片的层积云：闭合单体、一片片圆顶，有空隙；随低层气流略微旋转，靠近眼壁更密。
//  - 眼墙外是雨区（云底几百米、顶到卷云盖），再往外云底抬升成卷云盖（约 12–16 km），外缘被高空流出气流拉成反气旋弯曲的丝缕。
//  - 外围螺旋雨带：6 条对数螺旋（倾角约 18°），沿带排着一座座积雨云塔，带子有断续、宽窄不一。
// 旧版把眼壁做成一堵垂直的墙：同一尺度的噪声铺满墙面、顶上一刀切平、底部挂一排絮条，眼底低云是一块块平板。
const float HUR_TWO_PI = 6.2831853;
const float HUR_TOP = 16.2;      // 卷云盖顶，km
const float HUR_FLARE = 8.5;     // 眼壁顶部向外卷的距离，km（看台最上面一圈）
const float HUR_FLARE_START = 9.8;

// 眼壁顶沿的高度随方位角变：对流最强的扇区（顺切变左侧）高、对面低 2 km 左右，顶沿不是一条水平线（T26）
float hurricaneRimTop(float theta) {
  return HUR_TOP - 0.5 + 1.2 * sin(theta + 0.4) + 0.45 * sin(3.0 * theta + 1.7);
}

// 卷云盖顶（T37）：眼壁附近压在顶沿以下（外流的冰晶云从顶沿往外缓慢下降），离眼壁远了回到原来的高度。
// 旧版卷云盖顶处处约 16 km：顶沿低（约 14 km）的扇区，从眼里看，顶沿后面横着一道比顶沿还高、光滑笔直的卷云盖边——就是「栏杆」。
// 往外回升的那段（3.5–6 倍眼半径）从眼里看仰角比顶沿低，被顶沿挡住。完整版、探针 / 云影用的大形共用
float hurricaneCanopyTop(float theta, float r) {
  float Re = uHurricane.z;
  float far = HUR_TOP - 1.2 * smoothstep(Re * 2.0, Re * 5.0, r) - 1.4 * smoothstep(Re * 5.0, Re * 16.0, r);
  float near = hurricaneRimTop(theta) - 1.2 - 1.4 * smoothstep(Re * 2.0, Re * 5.0, r);
  return mix(min(far, near), far, smoothstep(Re * 3.5, Re * 6.0, r));
}

// Worley 值 → 「陡侧壁 + 圆顶」的塔：格子中心一圈是平台（带圆顶），往外很快掉下去。
// 直接用球冠当高度场，塔成了圆锥（雨带从侧面看像一片石笋）
float hurTower(float w) {
  float dd = clamp((1.0 - w) * 1.6, 0.0, 1.0);
  return (1.0 - smoothstep(0.5, 0.8, dd)) * (0.75 + 0.25 * sqrt(1.0 - dd * dd));
}

float hurCap(float w) {
  // Worley 值（1 − 距离）→ 球冠隆起 √(1 − d²) − 0.55：每个格子鼓成圆顶，交界处是折痕（见 towerSdf 的说明）
  float dd = clamp((1.0 - w) * 1.6, 0.0, 1.0);
  return sqrt(1.0 - dd * dd) - 0.55;
}

// 台风的密度（0..1）。ao：环境光遮蔽（眼底、眼壁下部、隆起之间的凹处看到的天空少）
// 完整版雨带求值时顺手记下「离采样点最近的那座塔」（格子号 xy、coreC）：受光步进直接用它，不再在循环里找
vec3 gHurCell = vec3(0.0);
// 台风密度的副产物：最近一次求值的点属于「软边」的冰晶云（卷云盖、雨带塔顶的砧）。这类云边缘本来就是渐变的，
// 云步进对它们不做表面细化、稀薄处放大步长（PERF-2）
bool gHurSoft = false;
// 最近一次求值的点属于台风卷云盖（T44）：云步进对它用解析的受光（见 clouds.ts），cloudDensity 里记成 gStormSoft = 2
bool gHurCanopy = false;

// ---- 雨带上的积雨云塔（T37）----
// 塔轴（塔心在高度 alt 处的水平位置）：上半截被高空风吹歪，歪多少每座塔不同（塔顶偏 0.1–0.35 倍塔高，约 6–19°），还略带横向
vec2 bandTowerAxis(vec2 c, float alt, float Ht, vec2 h3) {
  vec2 perp = vec2(-uUpperWind.y, uUpperWind.x);
  return c + (uUpperWind * (0.1 + 0.25 * h3.y) + perp * 0.12 * (h3.x - 0.5)) * alt * alt / Ht;
}

// 一座塔的有符号距离（km，负值在云里）。真实的雨带对流塔不是一根圆柱，而是一个个上升气泡叠成的塔群：
//  - 主柱：上宽下窄（底部只有顶部的 70–95% 粗；再细就成了细柄蘑菇：雨区上方较细的上升气流，往上气泡膨胀），顶上扁圆穹顶；
//  - 两个侧向气泡：一个在上部（和主穹顶高低错落的次级塔顶），一个在中部侧面（侧向生长的隆起），大小、方位每座塔不同；
//  三者平滑并在一起，交界处凹进去，侧面有阴影。表面的菜花隆起在调用处叠加（3D 噪声只作为表面起伏，不当高度场）。
// 完整版（单体循环）和受光版（gHurCell 那一座）共用，形状一致
float bandTowerSdf(vec2 xz, float alt, vec2 c, float Ht, float Rt, vec2 h3) {
  float hh = clamp(alt / Ht, 0.0, 1.0);
  float rho = length(xz - bandTowerAxis(c, alt, Ht, h3));
  // T44：底部收得少一些。旧版底部只有顶部的 70–95%，远看是细柄上顶着一块砧——高脚杯 / 蘑菇（美术总监 wave6 第 3 条）；
  // 试过底部比顶部宽（100–115% → 90%），近处的塔成了上下一样粗的圆桶（T37 要避免的），取中间：底部 88–103%
  float rb = Rt * mix(0.88 + 0.15 * h3.x, 1.0, smoothstep(0.05, 0.7, hh));
  // 一节节上升气泡叠出来的腰身（T38，T44 遗留）：半径随高度起伏 ±约 10%，两个不成整数比的周期（约 0.3 / 0.17 倍塔高）、
  // 相位每座塔不同。旧版侧面是一根直筒，背光面明暗只随高度变，近处的塔读成圆桶；有了腰身，鼓出的一节顶面朝天、
  // 收进去的一节被上面挡住，侧面才有一层层的体积起伏
  float ph = h3.y * 6.2831853;
  rb *= 1.0 + (0.07 * sin(alt * 21.0 / Ht + ph) + 0.045 * sin(alt * 37.0 / Ht + 2.3 * ph + 1.7)) * smoothstep(0.1, 0.3, hh);
  float domeH = min(Rt * 0.6, Ht * 0.3);
  vec2 q = vec2(rho / rb, max(alt - Ht + domeH, 0.0) / domeH);
  float lq = length(q);
  float sd = (lq - 1.0) * mix(rb, domeH, q.y / max(lq, 1e-3));
  float ang = h3.x * 6.2831853;
  // 上部的次级塔顶：顶比主穹顶低 0–0.3 倍气泡半径
  float hA = fract(h3.y * 7.13);
  float brA = Rt * (0.45 + 0.2 * hA);
  float zA = Ht - 0.8 * brA * (1.0 + 0.3 * hA);
  vec2 cA = bandTowerAxis(c, zA, Ht, h3) + vec2(cos(ang), sin(ang)) * Rt * (0.5 + 0.3 * hA);
  float sA = length(vec3(xz - cA, (alt - zA) / 0.8)) - brA;
  // 中部侧面的气泡
  float hB = fract(h3.x * 5.31 + 0.37);
  float brB = Rt * (0.4 + 0.2 * hB);
  float zB = Ht * (0.3 + 0.25 * hB);
  vec2 cB = bandTowerAxis(c, zB, Ht, h3) + vec2(cos(ang + 2.4), sin(ang + 2.4)) * Rt * (0.6 + 0.3 * hB);
  float sB = length(vec3(xz - cB, (alt - zB) / 0.75)) - brB;
  sd = sminStorm(sd, sA, 0.7);
  return sminStorm(sd, sB, 0.9);
}
${hurricaneDensityGlsl("hurricaneDensity", HUR_BANDS_FULL)}
// 受光步进（朝太阳）用：雨带只算最近的一座塔（见 HUR_BANDS_LIGHT）
${hurricaneDensityGlsl("hurricaneDensityLight", HUR_BANDS_LIGHT)}

// 台风内部不要普通的晴天积云（眼里、眼壁、雨区都已由台风自己描述）：返回层状云的保留比例
float hurricaneLayerMask(vec2 xz) {
  float r = length(xz - uHurricane.xy);
  return smoothstep(uHurricane.z * 3.0, uHurricane.z * 4.5, r);
}

// 云影用的台风大形：只有眼壁（不含隆起）、卷云盖和雨带的解析形状，不采样纹理。
// 完整的 hurricaneDensity 放进场景着色器（海面云影）后，FXC 编译场景着色器从约 2 s 涨到 130 s
float hurricaneShadowDensity(vec2 xz, float alt) {
  if (alt > HUR_TOP || alt < 0.5) return 0.0;
  vec2 d2 = xz - uHurricane.xy;
  float r = length(d2);
  float Re = uHurricane.z;
  if (r > Re * 16.0) return 0.0;
  float theta = atan(d2.y, d2.x);
  float slopeK = 0.95 + 0.35 * sin(theta + 1.3);
  float rIn = Re + slopeK * (0.55 * alt + 0.045 * alt * alt) + 7.0 * pow(smoothstep(10.5, 16.2, alt), 2.0);
  float core = smoothstep(rIn, rIn + 1.0, r) * (1.0 - smoothstep(Re * 3.0, Re * 3.8, r));
  // 卷云盖的高度范围与完整版一致（底往外抬升到约 14.2 km、顶往外降低）：旧版底恒为 12 km，
  // typhoon-outer（13 km，卷云盖底下）被探针当成在云里（T31 发现）
  float canopyBase = 11.8 + 2.4 * smoothstep(Re * 4.0, Re * 12.0, r);
  float canopyTop = hurricaneCanopyTop(theta, r);
  float canopy = smoothstep(Re * 2.5, Re * 3.0, r) * (1.0 - smoothstep(Re * 9.0, Re * 16.0, r))
               * smoothstep(canopyBase - 0.3, canopyBase + 0.4, alt) * (1.0 - smoothstep(canopyTop - 0.4, canopyTop + 0.2, alt))
               * max(min(0.9 * exp(-(r - Re * 3.5) / (Re * 1.3)), 0.9), 0.03 * smoothstep(Re * 3.5, Re * 10.0, r));   // 与完整版的变薄一致（T44）
  float band = smoothstep(0.3, 0.8, cos(6.0 * theta - 18.5 * log(max(r, 1.0)))) * smoothstep(Re * 2.8, Re * 4.0, r)
             * (1.0 - smoothstep(8.0, 12.0, alt)) * 0.6;
  return max(max(core, canopy), band);
}
#endif

// 所有云的密度（精简版雷暴）：光线步进、云影、探针用；层状云与完整版相同。
// fullHurricane = false 时台风只用解析大形（云影、探针）：完整的台风密度被内联进场景着色器会让它的冷编译慢约 60%。
// 雷暴 / 台风部分只在对应的天气变体里（PERF-10，见 CLOUD_WEATHER 的说明）；默认程序里只剩层状云
float cloudDensityLite(vec3 p, float lod, bool detail, bool fullHurricane) {
  float alt = length(p) - BOTTOM;
  if (alt < uShellBottom || alt > uShellTop) return 0.0;
  float d = layerDensity(p, lod, detail);
#ifdef CLOUD_WEATHER
  if (gWeatherOn && (uStormCount > 0 || uHurricane.w > 0.5)) {
    vec2 xz = p.xz + uCloudOffset;
#ifdef CLOUD_TYPHOON
    if (uHurricane.w > 0.5) d *= hurricaneLayerMask(xz);
#endif
    // 占据网格说这里没有雷暴 / 台风的云（只有云步进程序查网格，见 cloudWeatherMaybe）
    if (!cloudWeatherMaybe(xz, alt)) return d;
#ifdef CLOUD_STORM
    // 循环上界用 uniform（最多 4 个）：常量上界会被 FXC 展开成 4 份完整的雷暴密度，冷编译大幅变慢
    for (int i = 0; i < uStormCount; i++) {
      vec4 c = uStorms[i];
      vec2 dd = xz - c.xy;
      if (dot(dd, dd) > c.z * c.z * 56.0) continue;
      d = max(d, stormDensityLite(c, xz, alt, lod) * uCloudDensity);
    }
    // 砧盾（TW04）：所有单体共用一片，不取纤维噪声
    // 砧盾（TW04），× SHIELD_LIGHT_K：冰晶的散射几乎全在前向峰里（g ≈ 0.8），穿过砧盾的阳光大半仍朝前走，对受光而言有效消光按 δ 缩放只剩约 1/3
    // （Joseph 1976 的 δ-Eddington，f ≈ g²）。不缩放时塔身被自己的砧罩成一整片灰（TW01 南海连续航程截图），比照片暗得多
    // 云步进程序（定义了 CLOUD_OCC）的受光步进里不算：塔身被砧挡的那部分主要在砧根（anvilDensity 已在精简密度里），
    // 砧盾再内联进 8 步受光，cloud-march-storm 离线 FXC +8%
#ifndef CLOUD_OCC
    if (uStormCount > 0) d = max(d, anvilShield(xz, alt, lod, false) * uCloudDensity * SHIELD_LIGHT_K);
#endif
#endif
#ifdef CLOUD_TYPHOON
    if (uHurricane.w > 0.5) {
      float hao;
      float hd = fullHurricane ? hurricaneDensityLight(xz, alt, lod, detail, hao) : hurricaneShadowDensity(xz, alt);
      d = max(d, hd * uCloudDensity);
    }
#endif
  }
#endif
  return d;
}

// 所有云的密度：层状云、雷暴、台风取最大（雷暴 / 台风只在对应的天气变体里，PERF-10）
float cloudDensity(vec3 p, float lod, bool detail) {
  float alt = length(p) - BOTTOM;
  if (alt < uShellBottom || alt > uShellTop) return 0.0;
#ifdef CLOUD_STORM
  gCovBoost = gWeatherOn && uStormCount > 0 ? stormLayerBoost(p.xz + uCloudOffset) : 0.0;
#endif
  float d = layerDensity(p, lod, detail);
#ifdef CLOUD_WEATHER
  gStormW = 0.0;
  gStormAO = 1.0;
  gStormSoft = 0.0;
#ifdef CLOUD_STORM
  gStormPileus = 0.0;
#endif
  if (gWeatherOn && (uStormCount > 0 || uHurricane.w > 0.5)) {
    vec2 xz = p.xz + uCloudOffset;
#ifdef CLOUD_TYPHOON
    // 台风内部不要普通的层状云（和雷暴取最大之前先乘，与改动前的顺序等价：雷暴、台风不会同时出现）
    if (uHurricane.w > 0.5) d *= hurricaneLayerMask(xz);
#endif
    // 占据网格说这里没有雷暴 / 台风的云：只剩层状云（PERF-2：空白处占了雷暴 / 台风场景云步进的大半开销）
    if (!cloudWeatherMaybe(xz, alt)) return d;
#ifdef CLOUD_STORM
    // 循环上界用 uniform（最多 4 个）：常量上界会被 FXC 展开成 4 份完整的雷暴密度，冷编译大幅变慢
    for (int i = 0; i < uStormCount; i++) {
      vec4 c = uStorms[i];
      vec2 dd = xz - c.xy;
      if (dot(dd, dd) > c.z * c.z * 56.0) continue; // 砧状云加上下风偏移最远约 7 倍塔身半径（1.5R + 2.6R × 1.7 × 1.25）
      float ao;
      float pPrev = gStormPileus;
      gStormPileus = 0.0;
      float sd = stormDensity(c, xz, alt, lod, detail, ao) * uCloudDensity;
      if (sd > d) { d = sd; gStormW = 1.0; gStormAO = ao; gStormSoft = gStormSoftHit ? 1.0 : 0.0; }
      else gStormPileus = pPrev;
    }
    // 砧盾（TW04）：所有单体共用一片，只求一次；取胜时按软边处理（不做表面细化）
    if (uStormCount > 0) {
      float sh = anvilShield(xz, alt, lod, detail) * uCloudDensity;
      if (sh > d) { d = sh; gStormW = 1.0; gStormAO = 0.8; gStormSoft = 1.0; gStormPileus = 0.0; }
    }
#endif
#ifdef CLOUD_TYPHOON
    if (uHurricane.w > 0.5) {
      // 台风的受光和雷暴一样处理（凹处遮蔽、下方反射光、表面细化）
      float hao;
      float hd = hurricaneDensity(xz, alt, lod, detail, hao) * uCloudDensity;
      if (hd > d) { d = hd; gStormW = 1.0; gStormAO = hao; gStormSoft = gHurSoft ? (gHurCanopy ? 2.0 : 1.0) : 0.0; }
    }
#endif
  }
#endif
  return d;
}

// 视线穿过云壳的区间 [t0, t1]；穿不过返回 t1 < t0
vec2 raySphere2(vec3 ro, vec3 rd, float R) {
  float r = length(ro);
  float mu = dot(ro, rd) / r;
  float rs = r * sqrt(max(0.0, 1.0 - mu * mu));
  float disc = (R - rs) * (R + rs);
  if (disc < 0.0) return vec2(-1.0);
  float s = sqrt(disc);
  return vec2(-r * mu - s, -r * mu + s);
}

// 高度范围 [hb, ht]（km）的球壳
vec2 cloudShellIntervalH(vec3 ro, vec3 rd, float hb, float ht) {
  float rb = BOTTOM + hb;
  float rt = BOTTOM + ht;
  float r = length(ro);
  vec2 outer = raySphere2(ro, rd, rt);
  vec2 inner = raySphere2(ro, rd, rb);
  vec2 ground = raySphere2(ro, rd, BOTTOM);
  if (r > rt) {
    if (outer.y < 0.0 || outer.x < 0.0) return vec2(1.0, 0.0);
    float t1 = inner.x > 0.0 ? inner.x : outer.y;
    return vec2(outer.x, t1);
  }
  if (r < rb) {
    if (ground.x > 0.0) return vec2(1.0, 0.0); // 在云下往下看，只会看到海
    return vec2(inner.y, outer.y);
  }
  float t1 = inner.x > 0.0 ? inner.x : outer.y;
  return vec2(0.0, t1);
}
vec2 cloudShellInterval(vec3 ro, vec3 rd) { return cloudShellIntervalH(ro, rd, uShellBottom, uShellTop); }

// 云缓冲（clouds.ts 的 history，T38 起两倍宽）：左半是云（RGB 预乘辐亮度 + A 透射率），右半是 (深度 × 不透明度, 不透明度)，
// cloudBufferDepth 相除得到云按不透明度加权的平均深度（km）。
// 放进同一张纹理而不是另给一张深度图：窗外 / 机翼程序不多占 sampler（窗外程序 sampler 快满了）。
// 取样夹在各自半边以内半个纹素，线性过滤不会串到另一半
vec4 cloudBufferColor(sampler2D buf, vec2 uv) {
  float w = float(textureSize(buf, 0).x) * 0.5;
  return texture(buf, vec2(min(uv.x * w, w - 0.5) / (2.0 * w), uv.y));
}
// 右半只在附近有高出海面的真实地形时才写（PERF-11，clouds.ts 的 depthOn）：没写的时候返回 0（= 云都在地面之前，cloudBeforeGround 原样保留）
float cloudBufferDepth(sampler2D buf, vec2 uv) {
  if (uCloudDepthOn < 0.5) return 0.0;
  float w = float(textureSize(buf, 0).x) * 0.5;
  vec2 d = textureLod(buf, vec2((w + clamp(uv.x * w, 0.5, w - 0.5)) / (2.0 * w), uv.y), 0.0).rg;
  return d.x / max(d.y, 1e-4);
}

// 地形挡住它后面的云（T38）。云步进不知道地形（只按球壳走），视线打到山上以后还一路走到几百公里外，
// 山后面的云被合成到山体前面：清晨 4 km 看富士山，远处地平线上的层云（1.2–3.4 km）被画在山腰上，
// 成了一条横切山体的云带，山顶像浮在带子上（美术总监 wave5 次要 2；读回云的平均深度 65–290 km，山只在 38 km）。
// 云缓冲里只有整条视线的透射率、辐亮度和按不透明度加权的平均深度 D：D 不比地面远就是山前的云，整个保留；
// D 比地面远 30% 以上就是山后的云，去掉；中间渐变。浓云挡在山前时它后面的云权重 ≈ 0，D 就是它自己的深度，山前的云带完整保留。
// 已知误差：山前一层薄云、山后还有浓云时 D 被拉远，山前那层薄云也一起去掉（山体上少一层薄纱，比「山后的云画到山前」轻得多）。
// 试过再按「视线在云壳里均匀」估计地面之前的份额 f、保留 1 − T^f：山后的浓云 T ≈ 0 时 T^f 也 ≈ 0，整条云带原样留在山前，已撤回
vec4 cloudBeforeGround(vec4 cloud, float D, float tGround) {
  float k = 1.0 - smoothstep(1.0, 1.3, D / max(tGround, 1e-3));
  return vec4(cloud.rgb * k, 1.0 - k * (1.0 - cloud.a));
}

// 海面、地面的云影（T27）：查 clouds.ts 预先算好的云影图（见 CLOUD_SHADOW_*）。
// 旧版在窗外程序里逐像素沿太阳方向取 5 个固定点（点距约 4 km、不抖动、每个点按 4 km 的弦长算光学厚度）：
// 太阳低时相邻像素的采样点落在云的有 / 无两侧，影子是一刀切的二值边，被它剪出来的 HDR 耀斑成了带阶梯的硬边色块，
// 飞机前进时这条边还会逐像素开关。现在云影图按世界坐标铺开（与云一起不动），每个格点沿太阳方向取 48 个点，
// 查的时候按 B 样条插值透射率：边缘至少有一两个格距的渐变，也不再随像素闪。
//
// 第 k 级（半边长 ext km）在相对坐标 rel 处的值：三次 B 样条插值（4 次双线性取样）。
// 只用双线性时，格点之间的高对比边缘会露出一格一格的菱形台阶（远处一格约 0.3–1.6 km）
vec4 cloudShadowTexel(vec2 rel, float k, float ext) {
  const float N = ${CLOUD_SHADOW_RES.toFixed(1)};
  // 夹到本级内 2 个格子：三级并排在一张纹理里，取样不会串到隔壁一级
  vec2 st = clamp(rel / ext * 0.5 + 0.5, vec2(2.0 / N), vec2(1.0 - 2.0 / N)) * N - 0.5;
  vec2 i = floor(st);
  vec2 f = st - i;
  vec2 f2 = f * f, f3 = f2 * f;
  vec2 w0 = (1.0 - 3.0 * f + 3.0 * f2 - f3) / 6.0;
  vec2 w1 = (4.0 - 6.0 * f2 + 3.0 * f3) / 6.0;
  vec2 w2 = (1.0 + 3.0 * f + 3.0 * f2 - 3.0 * f3) / 6.0;
  vec2 w3 = f3 / 6.0;
  vec2 g0 = w0 + w1, g1 = w2 + w3;
  vec2 c0 = (i - 0.5 + w1 / g0) / N;   // 两组双线性取样点（纹理坐标）
  vec2 c1 = (i + 1.5 + w3 / g1) / N;
  vec4 a = textureLod(uCloudShadowMap, vec2((c0.x + k) / 3.0, c0.y), 0.0);
  vec4 b = textureLod(uCloudShadowMap, vec2((c1.x + k) / 3.0, c0.y), 0.0);
  vec4 c = textureLod(uCloudShadowMap, vec2((c0.x + k) / 3.0, c1.y), 0.0);
  vec4 d = textureLod(uCloudShadowMap, vec2((c1.x + k) / 3.0, c1.y), 0.0);
  return g0.y * (g0.x * a + g1.x * b) + g1.y * (g0.x * c + g1.x * d);
}
float cloudShadow(vec3 p, vec3 sunDir) {
  if (sunDir.y < -0.2 || (uCoverage <= 0.0 && uStormCount == 0 && uHurricane.w < 0.5)) return 1.0;
  if (uCloudShadowCenter.z < 0.5) return 1.0;   // 云影图还没建好（程序在后台编译）
  // 沿（建图时的）光线方向退回到海平面上：高处的地面点和它下方海平面那一点在同一条光线上，
  // 按这一点的高度在四个起点高度（0 / 1 / 2 / 3 km）之间插值（只算这一点以上的云）
  float h = max(length(p) - BOTTOM, 0.0);
  vec3 s = uCloudShadowSun;
  vec2 rel = p.xz + uCloudOffset - s.xz * (h / max(s.y, 0.05)) - uCloudShadowCenter.xy;
  float r = max(abs(rel.x), abs(rel.y));
  // 由近到远三级（±${CLOUD_SHADOW_EXT[0]} / ±${CLOUD_SHADOW_EXT[1]} / ±${CLOUD_SHADOW_EXT[2]} km），每级外缘 15% 与下一级交叉过渡，没有接缝
  vec4 T;
  if (r < ${CLOUD_SHADOW_EXT[0].toFixed(1)}) {
    T = cloudShadowTexel(rel, 0.0, ${CLOUD_SHADOW_EXT[0].toFixed(1)});
    float f = smoothstep(${(CLOUD_SHADOW_EXT[0] * 0.85).toFixed(2)}, ${CLOUD_SHADOW_EXT[0].toFixed(1)}, r);
    if (f > 0.0) T = mix(T, cloudShadowTexel(rel, 1.0, ${CLOUD_SHADOW_EXT[1].toFixed(1)}), f);
  } else if (r < ${CLOUD_SHADOW_EXT[1].toFixed(1)}) {
    T = cloudShadowTexel(rel, 1.0, ${CLOUD_SHADOW_EXT[1].toFixed(1)});
    float f = smoothstep(${(CLOUD_SHADOW_EXT[1] * 0.85).toFixed(2)}, ${CLOUD_SHADOW_EXT[1].toFixed(1)}, r);
    if (f > 0.0) T = mix(T, cloudShadowTexel(rel, 2.0, ${CLOUD_SHADOW_EXT[2].toFixed(1)}), f);
  } else {
    // 最外一级以外（离飞机 ${CLOUD_SHADOW_EXT[2]} km 以上，已经在地平线附近的霾里）不算云影
    T = mix(cloudShadowTexel(rel, 2.0, ${CLOUD_SHADOW_EXT[2].toFixed(1)}), vec4(1.0), smoothstep(${(CLOUD_SHADOW_EXT[2] * 0.85).toFixed(2)}, ${CLOUD_SHADOW_EXT[2].toFixed(1)}, r));
  }
  vec4 w = max(1.0 - abs(vec4(0.0, 1.0, 2.0, 3.0) - min(h, 3.0)), 0.0);
  return dot(T, w);
}
`;
