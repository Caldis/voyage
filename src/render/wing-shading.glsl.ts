/**
 * 机翼着色（GLSL，座舱系）：漫反射 + 清漆镜面 + 环境反射 + 翼尖灯的照明，以及翼尖航行灯 / 频闪灯本身。
 * 依赖 WING_COMMON（wingCabinToAircraft / wingTrace / wingSurface / wingFuselageShadow / ggxD / smithG）/
 * LIGHTS_COMMON（keyLight / skyRadiance）/ CLOUD_COMMON（uCoverage、uCloudBottom / uCloudTop）/
 * 场景着色器里的 uCameraFog（在本片段之前声明）。
 *
 * 对外的入口：
 * - wingView(...)：视线打到机翼时的颜色与覆盖率（轮廓解析抗锯齿；含隔着云雾看机翼的效果）
 * - wingLights(ro, rd)：航行灯 / 频闪灯本身的亮点，以及在云里时灯光照亮周围云雾的光晕
 */
export const WING_SHADING_COMMON = /* glsl */ `
// ---- 翼尖的灯（机体坐标）----
// 0：航行灯（右绿左红），装在翼尖弯折处前缘的透明罩里；1：白色频闪（防撞灯），同一个罩里；2：后缘的白色尾航行灯
vec3 wingLampPos(int i) {
  float arcLen = WING_BEND_R * wingBendAngle();
  float sg = arcLen * (i == 0 ? 0.35 : (i == 1 ? 0.6 : 0.5));
  float n = i == 1 ? -0.02 : 0.0;
  float x = i == 2 ? wingTipLE(sg, arcLen) - wingTipChord(sg, arcLen, WINGLET_H - WING_BEND_R) - 0.04   // 尾灯在后缘
                   : wingTipLE(sg, arcLen) + (i == 0 ? 0.07 : 0.05);                              // 前缘的透明灯罩里
  return wingTipToAircraft(sg, n, x);
}

// 灯在 dir 方向（机体系，从灯出发）上的发光强度（cd）。
// 航行灯按 FAR 25.1389–1391：正前方 0–10° 至少 40 cd，10–20° 30 cd，20–110°（朝外侧）5 cd；
// 光区之外只剩灯罩的散射漏光（这里取 3 cd，经验值）。尾灯：向后 ±70° 内 20 cd。频闪：各向约 1500 cd（LED 防撞灯的峰值量级）。
vec3 wingLampIntensity(int i, vec3 dir) {
  if (i == 1) return vec3(1.0, 0.98, 1.0) * 1500.0 * uStrobe;
  vec2 hz = normalize(dir.xz + vec2(1e-5, 0.0));
  float ang = atan(hz.y, hz.x);   // 0 = 正前方，正值朝外侧（+Z）
  float a = abs(degrees(ang));
  if (i == 0) {
    float cd = ang > -0.05 && a < 110.0 ? (a < 10.0 ? 40.0 : (a < 20.0 ? 30.0 : 5.0)) : 3.0;
    return (uSeatSign > 0.0 ? vec3(0.1, 1.0, 0.35) : vec3(1.0, 0.08, 0.05)) * cd;
  }
  return vec3(1.0, 0.95, 0.85) * (a > 110.0 ? 20.0 : 2.0);
}

// 环境反射的来源：天空；地平线以下是海面 / 地面（天空视图 LUT 的地面部分），飞在云层之上时混入云海的亮度
vec3 wingEnv(vec3 rW, float rough, vec3 eSky, vec3 eDown, float belowAlbedo) {
  float tG = raySphere(vec3(0.0, uCamR, 0.0), rW, BOTTOM);
  vec3 env = skyRadiance(rW, tG > 0.0);
  if (tG > 0.0) {
    // 云海在地平线附近被空气透视冲淡，按俯角渐入。硬切的话，翼面「油罐」起伏把反射方向在地平线上下来回拨，
    // 地平线的亮暗突变就被映成一圈圈木纹似的等高线（贴着看翼面时最明显）
    float aboveDeck = smoothstep(uCloudBottom, uCloudTop, uCamR - BOTTOM);
    float dip = smoothstep(0.0, 0.12, -rW.y);
    env = mix(env, 0.7 * eDown / M_PI, clamp(uCoverage * 0.9, 0.0, 1.0) * aboveDeck * dip);
  }
  // 粗糙的表面看到的是一大片天空的平均，而不是一个方向
  vec3 avg = (eSky * (0.5 + 0.5 * rW.y) + belowAlbedo * eDown * (0.5 - 0.5 * rW.y)) / M_PI;
  return mix(env, avg, smoothstep(0.12, 0.6, rough));
}

// 机翼着色（座舱系）。w 是 wingTrace 的结果（法线、自阴影、部件已经算好）；eSky / eDown / belowAlbedo 是窗外的天空光、下方反射光
vec3 shadeWing(vec3 pc, vec3 rd, WingTraceResult w, vec3 sunC, vec3 eSky, vec3 eDown, float belowAlbedo) {
  vec3 P = wingCabinToAircraft(pc);
  vec3 nA = w.nA;
  vec3 n = vec3(uSeatSign * nA.x, nA.y, nA.z);          // 机体系 → 座舱系
  vec3 v = -rd;
  vec3 nW = uCabinToWorld * n;
  // 命中点处一个像素对应的米数。斜着看翼面时像素在表面上被拉长约 1/cosθ 倍，按长边算，
  // 接缝、铆钉线、污渍这些高频在掠射角下才不会闪（宁可略软，不要闪）
  float pix = length(pc - uHead) * 2.0 * uTanHalfFov / uResolution.y / max(dot(n, v), 0.2);
  WingSurface m = wingSurface(P, pix, nA.y, w.part);
  vec3 lA = vec3(uSeatSign * sunC.x, sunC.y, sunC.z);
  float nl = dot(n, sunC);
  float shadow = wingFuselageShadow(P, lA) * step(0.0, nl) * w.shadow;
  vec3 eSun = keyLight(uCamR, vec3(0.0, 1.0, 0.0)) * shadow * uKeyCloud.x;   // 穿云时机翼也没有直射光（T31）
  float nv = max(dot(n, v), 1e-3);
  nl = max(nl, 0.0);

  // 漫反射：阳光 + 上方天空 + 下方海面 / 云海反射上来的光
  vec3 diffuse = m.albedo * (1.0 - m.metal) / M_PI
    * (eSun * nl + eSky * (0.5 + 0.5 * nW.y) + belowAlbedo * eDown * (0.5 - 0.5 * nW.y));

  // 镜面：基础层（漆或裸铝）+ 清漆层（很光滑，太阳在上面是一个刺眼的亮点）
  vec3 h = normalize(sunC + v);
  float nh = max(dot(n, h), 0.0);
  float vh = max(dot(v, h), 0.0);
  vec3 f0 = mix(vec3(0.04), m.albedo, m.metal);
  // 边缘像素（轮廓、薄后缘）：法线在一个像素里从正对扫到侧对，逆光时总有一个方向正好把太阳以掠射角
  // 镜面反射进眼睛（1/(4·n·v) 在 n·v → 0 时放大上千倍）。几条子射线只有一两条碰上，平均后就是后缘上的一串亮珠。
  // 边缘处把 n·v 下限抬到 0.3、波瓣放宽（镜面抗锯齿：像素足迹内的平均亮度远没有单点那么高）
  float nvS = w.edge ? max(nv, 0.3) : nv;
  float vhS = w.edge ? max(vh, 0.3) : vh;
  vec3 fBase = f0 + (1.0 - f0) * pow(1.0 - vhS, 5.0);
  // 按像素足迹滤掉的油罐鼓包斜率方差并入粗糙度（α² += 2σ²，LEAN 的思路；见 wingTrace）
  float aBase = w.edge ? max(m.rough * m.rough, 0.1) : sqrt(m.rough * m.rough * m.rough * m.rough + 2.0 * w.bumpVar);
  vec3 spec = fBase * ggxD(nh, aBase) * smithG(nvS, max(nl, 1e-3), aBase) / (4.0 * nvS * max(nl, 1e-3)) * eSun * nl;
  float coat = m.coat * (1.0 - m.metal);
  float fCoat = 0.04 + 0.96 * pow(1.0 - vhS, 5.0);
  // 清漆：翼面粗糙度 0.06（α = 0.004），小翼 0.15；再加上滤掉的鼓包方差。边缘处放宽
  float cr2 = m.coatRough * m.coatRough;
  float WING_A_COAT = w.edge ? max(cr2, 0.05) : sqrt(cr2 * cr2 + 2.0 * w.bumpVar);
  spec += coat * fCoat * ggxD(nh, WING_A_COAT) * smithG(nvS, max(nl, 1e-3), WING_A_COAT) / (4.0 * nvS * max(nl, 1e-3)) * eSun * nl;

  // 环境反射：清漆近乎镜面，基础层按粗糙度取模糊的平均
  vec3 r = uCabinToWorld * reflect(rd, n);
  // PERF-14：两个粗糙度各取一次，写成循环（起点依赖 uniform，FXC 不展开）：wingEnv 只内联一份（离线 FXC 约 −4%），结果逐位不变
  vec3 envSharp = vec3(0.0), envBase = vec3(0.0);
  for (int i = min(uWingSteps, 0); i < 2; i++) {
    vec3 e = wingEnv(r, i == 0 ? m.coatRough : m.rough, eSky, eDown, belowAlbedo);
    if (i == 0) envSharp = e;
    else envBase = e;
  }
  // 边缘像素（轮廓、薄后缘）上的法线在一个像素里从正对转到侧对，菲涅尔在掠射端冲到 1，
  // 地平线最亮的那一段天空被整条反射进来——子采样一平均，后缘就成了一串亮点。边缘处按 n·v ≥ 0.3 算菲涅尔
  float nvF = w.edge ? max(nv, 0.3) : nv;
  vec3 fEnv = f0 + (max(vec3(1.0 - m.rough), f0) - f0) * pow(1.0 - nvF, 5.0);
  float fEnvCoat = 0.04 + 0.96 * pow(1.0 - nvF, 5.0);
  // 反射方向朝向机翼自己（比如小翼内侧反射到翼面）时，被自己挡住的部分按天空光的一半估计
  vec3 envSpec = envBase * fEnv * (m.metal > 0.5 ? 1.0 : 0.3) + envSharp * coat * fEnvCoat;

  // 翼尖的灯照到翼面上：点光源，照度 = I·cosθ / d²（lux → klux）。
  // 用不带油罐鼓包的几何法线：灯在翼尖、几乎贴着翼面照过来（掠射），鼓包 1° 左右的起伏就让 n·l 和镜面在 0 附近大幅跳动，
  // 夜里频闪一亮，翼面上满是一团团云状的暗斑（审查返工项）。鼓包只留给天空反射和太阳
  vec3 nG = w.nGeo;
  if (dot(nG, nA) < 0.0) nG = -nG;
  vec3 nGc = vec3(uSeatSign * nG.x, nG.y, nG.z);
  vec3 lampLit = vec3(0.0);
  for (int i = min(uWingSteps, 0); i < 3; i++) {  // 起点依赖 uniform：不让 FXC 展开成三份
    vec3 d = wingLampPos(i) - P;
    float dist2 = max(dot(d, d), 0.04);
    vec3 l = d * inversesqrt(dist2);
    float nlL = dot(nG, l);
    if (nlL <= 0.0) continue;
    vec3 e = wingLampIntensity(i, -l) / dist2 * 1e-3 * nlL;
    vec3 lC = vec3(uSeatSign * l.x, l.y, l.z);
    vec3 hL = normalize(lC + v);
    float nhL = max(dot(nGc, hL), 0.0);
    float fL = 0.04 + 0.96 * pow(1.0 - max(dot(v, hL), 0.0), 5.0);
    // 镜面项 D·F·G / (4·n·v)：G 在掠射时和 n·v 同阶，两者相消。之前漏了 G、直接除以 n·v，
    // 轮廓上 n·v → 0.001 时灯的镜面被放大几百倍，边缘超采样的子射线一碰上就是一颗白点（后缘一串亮珠）
    float gv = 1.0 / (4.0 * max(nv, 0.25));
    lampLit += e * (m.albedo * (1.0 - m.metal) / M_PI
      + coat * fL * ggxD(nhL, max(WING_A_COAT, 0.02)) * gv
      + mix(vec3(0.04), m.albedo, m.metal) * ggxD(nhL, max(aBase, 0.02)) * gv);
  }
  if ((uWingDebug & 2) != 0) lampLit = vec3(0.0);
  if ((uWingDebug & 4) != 0) envSpec = vec3(0.0);
  if ((uWingDebug & 16) != 0) return m.albedo * 1e-3 * dot(eSky, vec3(0.3333)) * 50.0;
  return diffuse + spec + envSpec + lampLit + m.emit;
}

// 旋转网格（RGSS）的四个子像素偏移（单位：像素）
vec2 wingRgss(int k) {
  return k == 1 ? vec2(0.125, 0.375) : (k == 2 ? vec2(-0.375, 0.125) : (k == 3 ? vec2(0.375, -0.125) : vec2(-0.125, -0.375)));
}

// 视线打到机翼：返回 (颜色 × 窗板透射率之前的辐亮度, 覆盖率)。
// 覆盖率 < 1 的是轮廓上的像素，调用方按它和窗外混合。cloud 是这条视线上的云（半分辨率云层纹理）
//
// 抗锯齿：先打一条中心射线——
// - 擦边没打中：外轮廓外侧，用解析覆盖率（最近距离 / 像素宽度）就够平滑。这里曾经也做子射线超采样，
//   结果子射线在薄后缘外侧几毫米「命中」、法线指向后缘端面，夕阳下后缘成了一串亮珠，反而比解析法差；
// - 打中了、按曲率估计离外轮廓不到 1.5 个像素：外轮廓内侧、薄的后缘、小翼的边；
// - 打中之前先擦过另一处轮廓：内轮廓（襟翼压在主翼上、小翼和翼面、短舱和机翼）。
// 后两种是「边缘像素」：
// 边缘像素改成 4 条旋转网格（RGSS）子射线各自求交再平均，每条子射线只按「打中 / 没打中」计覆盖率。
// 只用中心射线的解析覆盖率时，轮廓只有外侧半个像素有过渡、内侧是硬的，距离场又常高估距离，斜边上还是一级级的台阶。
// 开销只落在边缘像素上（回归场景里约 3% 的机翼像素），但它们散在 13–15% 的 warp 里、同一 warp 的其余像素都陪着等，
// 所以子射线的活要压到最少（PERF-3）：
// - 从中心射线的命中点（内轮廓：第一次擦过前面部件的地方）前 4 个像素宽处出发，不算自阴影；
// - 四条共用 uWingSteps/2 步的预算；内轮廓的子射线擦过前面的部件以后直接跳到中心射线的命中点附近；
// - 子射线打中的部件和法线跟中心射线相同（同一块表面）时，直接沿用中心射线的颜色，不再着色。
// 贵的是求交步数而不是着色：warp 的耗时取决于里面最慢的那条子射线，所以压的是步数的上限，而不只是平均。
// 求交和着色都放在同一个循环里、各只有一处调用，FXC 不会把它们内联成五份（冷编译时间不涨）。
// refL：这个像素背后窗外的亮度（场景 pass 的结果），给子样本去亮点用
vec4 wingView(vec3 ro, vec3 rd, float tStart, vec3 sunC, vec3 eSky, vec3 eDown, float belowAlbedo, vec4 cloud, float refL) {
  vec3 lA = vec3(uSeatSign * sunC.x, sunC.y, sunC.z);
  vec3 right = uCamBasis[0];
  vec3 up = uCamBasis[1];
  float pa = wingPixelAngle();
  vec3 acc = vec3(0.0);
  float covSum = 0.0;
  int n = 1;
  float single = 1.0;  // 1 = 只有中心射线（解析覆盖率），0 = 超采样
  float t0 = tStart;
  float tJ = -1.0;
  const int SUB_MIN = 8;
  int pool = uWingSteps / 2;   // 四条子射线共用的求交步数
  // 边缘像素的中心射线：部件、法线、自阴影、颜色（子样本打在同一块表面上时沿用它的颜色）
  int partC = -1;
  vec3 nC = vec3(0.0);
  float shC = 1.0;
  vec3 colC = vec3(0.0);
  vec3 subCol[4];
  float subCov[4];
  for (int i = 0; i < 4; i++) { subCol[i] = vec3(0.0); subCov[i] = 0.0; }
  for (int k = min(uWingSteps, 0); k < 5; k++) {
    if (k >= n) break;
    vec3 rdk = k == 0 ? rd : normalize(rd + (right * wingRgss(k).x + up * wingRgss(k).y) * pa);
    // 子射线：从中心射线命中点前几个像素开始，不带自阴影（沿用中心射线的）。
    // 求交步数四条共用一份预算（uWingSteps/2），每条至少给后面的留 SUB_MIN 步：大多数子射线几步就打中，
    // 偶尔一条要多走的可以用掉别人省下的。一个边缘像素最多走 uWingSteps/2 步（以前每条各 uWingSteps/2，
    // 再加上白走的阴影段），warp 的尾巴有了上限。调试位 1024：每条各给 uWingSteps/2 步（旧预算，对照用）
    int lim = k == 0 ? uWingSteps : ((uWingDebug & 1024) != 0 ? uWingSteps / 2 : max(pool - SUB_MIN * (4 - k), SUB_MIN));
    WingTraceResult w = wingTrace(ro, rdk, t0, lA, lim, k == 0 ? uWingShadowSteps : 0, k == 0 ? -1.0 : tJ);
    if (k > 0) pool -= w.steps;
    if (k == 0 && uWingEdgeAA > 0 && w.cov >= 1.0 && w.edge) {
      n = uWingEdgeAA == 3 ? 1 : 5;   // 3：只判断不超采样（测开销用）
      single = 0.0;
      partC = w.part;
      nC = w.nA;
      shC = w.shadow;
      // 子射线从「最前面的那处轮廓」前 4 个像素宽的地方出发：外轮廓附近（按曲率判断的边缘）是中心命中点，
      // 内轮廓（中心射线打中之前先擦过别的部件）是擦过的那一处，前面那个部件也能打到。
      // 子射线离中心射线不到半个像素，比中心射线更早碰到表面的，出发点就在表面里面，第一步就算打中（覆盖率照样对）。
      // 以前外轮廓从 16 个像素前、内轮廓从命中距离的一半出发，贴着表面一步只挪零点几个像素，四条一共要走一百多步（PERF-3）。
      // 调试位 128：一律从一半出发（T22 之前的做法）
      float tFront = w.inner && w.tGraze > 0.0 ? w.tGraze : w.t;
      t0 = max(tStart, (uWingDebug & 128) != 0 ? w.t * 0.5 : tFront - 4.0 * pa * tFront);
      // 内轮廓：子射线擦过前面的部件以后，直接跳到中心射线命中后面那个部件之前 4 个像素处（见 wingTrace 的 tJump）。
      // 不跳的话它要贴着前面部件（前缘）的下表面慢慢远离，共用的步数不够走到后面的短舱 / 整流罩，
      // 这条子样本就露出背后的天空，前缘上一条亮线（route-hnd-cts 最明显）。调试位 4096：不跳
      tJ = w.inner && w.tGraze > 0.0 && (uWingDebug & 4096) == 0 ? w.t - 4.0 * pa * w.t : -1.0;
    }
    // 中心射线用解析覆盖率；子射线只算真正打中的（擦边没打中的算窗外）。
    // 之前子射线也按擦边的斜坡计入，着色点落在薄后缘外侧几毫米的空中，那里的距离场法线指向后缘端面，
    // 夕阳下每隔几个像素就冒一个亮点（一串亮珠）
    float c = single > 0.5 ? w.cov : step(1.0, w.cov);
    if (c <= 0.0) continue;
    // 颜色从哪来（PERF-3）：边缘像素上中心射线照常着色，它的颜色给子样本沿用，W-STAIR 起也作为第 5 个样本计入平均（见循环后）；
    // 子样本和中心射线打在同一块表面上（同一部件、法线差 < 18°）就沿用中心的颜色，
    // 否则（换了部件、跨过薄后缘的上下表面、圆前缘上法线转得快）自己着色。
    // 丢掉的只是像素内的纹理 / 高光变化。调试位 256：每条子样本都自己着色（旧做法，对照用）
    // 步数用完的子样本（wingStarved，见 wingTrace）一律沿用中心的颜色
    bool useC = k > 0 && (wingStarved(w) || ((uWingDebug & 256) == 0 && w.part == partC && dot(w.nA, nC) > 0.95));
    vec3 col = colC;
    if (!useC) {
      if (k > 0) w.shadow = shC;
      col = shadeWing(ro + rdk * w.t, rdk, w, sunC, eSky, eDown, belowAlbedo);
      // 在云里：机翼隔着几米到十几米的雾。消光系数取探针测到的云密度，雾色取这条视线上云的亮度
      if (uCameraFog > 0.0) {
        float tFog = exp(-uCameraFog * w.t * 0.001);
        vec3 fogColor = cloud.rgb / max(1.0 - cloud.a, 0.05);
        col = mix(fogColor, col, tFog);
      }
      // 调试：超采样的像素染成品红（亮度不变，不影响自动曝光）
      if (uWingEdgeAA > 1 && single < 0.5) col = vec3(1.0, 0.0, 1.0) * dot(col, vec3(0.2126, 0.7152, 0.0722)) * 1.4;
    }
    if (single > 0.5) {
      acc += col * c;
      covSum += c;
    } else if (k == 0) {
      colC = col;
    } else {
      subCol[k - 1] = col;
      subCov[k - 1] = c;
    }
  }
  if (single < 0.5) {
    // 子样本去亮点（firefly）：薄后缘这类地方偶尔有一条子射线打到一个法线极端的点（后缘端面、掠射的镜面），
    // 亮度是周围的几十倍，平均后就是一颗白点，沿后缘排成虚线。把每个子样本的亮度限制在
    // 「打中的子样本里最暗的 3 倍」和「背后窗外亮度的 1.2 倍」两者中较大的那个以内——真实的明暗交界不受影响
    // W-STAIR：中心射线本身也是这个像素里的一个样本（像素中心），一起平均：4 条旋转网格 + 中心 = 5 个样本。
    // 以前只用 4 条子射线，中心射线的颜色只给子样本沿用。细于半个像素的亮线（夜里频闪照亮的钝后缘端面）
    // 4 个样本的固定图案沿斜线轮流「碰上 / 碰不上」，成了一段一段的虚线；中心样本每个像素都碰上，线就连续了。
    // 中心射线能进到这里一定是打中了（覆盖率 1），不会把轮廓外扩
    float lC = dot(colC, vec3(0.2126, 0.7152, 0.0722));
    float lMin = lC;
    for (int i = 0; i < 4; i++) {
      if (subCov[i] > 0.0) lMin = min(lMin, dot(subCol[i], vec3(0.2126, 0.7152, 0.0722)));
    }
    float lCap = max(2.0 * lMin, 0.7 * refL);
    acc += colC * (lC > lCap ? lCap / lC : 1.0);
    covSum += 1.0;
    for (int i = 0; i < 4; i++) {
      if (subCov[i] <= 0.0) continue;
      float l = dot(subCol[i], vec3(0.2126, 0.7152, 0.0722));
      acc += subCol[i] * (l > lCap ? lCap / l : 1.0) * subCov[i];
      covSum += subCov[i];
    }
  }
  if (covSum <= 0.0) return vec4(0.0);
  return vec4(acc / covSum, single > 0.5 ? covSum : covSum * 0.2);
}

// 翼尖的航行灯（右绿左红）、白色频闪、尾灯：小光源 + 周围的光晕（光晕靠后面的眩光处理放大）；
// 在云里时再加上灯光照亮周围云雾的散射光（频闪一闪，整片雾跟着亮一下）
vec3 wingLights(vec3 ro, vec3 rd) {
  vec3 L = vec3(0.0);
  float sigma = uCameraFog * 1e-3;   // 云雾的消光系数，1/m（云滴几乎不吸收，散射系数取同一个值）
  vec3 rdA = vec3(uSeatSign * rd.x, rd.y, rd.z);  // 机体系里的视线方向
  for (int i = min(uWingSteps, 0); i < 3; i++) {  // 起点依赖 uniform：不让 FXC 展开成三份
    vec3 a = wingLampPos(i);
    vec3 c = wingAircraftToCabin(a);
    vec3 d = c - ro;
    float t = dot(d, rd);
    float dist = length(d - rd * max(t, 0.0));
    vec3 toEye = -rdA;
    vec3 I = wingLampIntensity(i, toEye);
    // 发光强度（cd）换算成一个 3 cm 光球的亮度
    if (t > 0.0) {
      float core = 1.0 - smoothstep(0.02, 0.03, dist);
      L += I / (M_PI * 0.03 * 0.03) * 1e-3 * core * exp(-sigma * t); // cd/m² → kcd/m²
    }
    // 云雾里的单次散射：沿视线积分 σ·I/(4π r²)，r² = h² + (s − t)²，有解析解。
    // 用灯的平均强度（各方向）近似；视线穿过的雾同时也衰减一部分
    if (sigma > 0.0) {
      vec3 Iavg = i == 1 ? I : wingLampIntensity(i, vec3(1.0, 0.0, 0.3)) * 0.3;
      float hh = max(dist, 0.05);
      float s1 = 60.0;
      float integ = (atan((s1 - t) / hh) - atan(-t / hh)) / hh;
      L += sigma * Iavg / (4.0 * M_PI) * integ * exp(-sigma * max(t, 0.0)) * 1e-3;
    }
  }
  return L;
}
`;
