/**
 * 机翼着色（GLSL，座舱系）：漫反射 + 清漆镜面 + 环境反射 + 翼尖灯的照明，以及翼尖航行灯 / 频闪灯本身。
 * 依赖 WING_COMMON（cabinToAircraft / traceWing / wingSurface / fuselageShadow / ggxD / smithG）/
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
vec3 lampPos(int i) {
  float arcLen = BEND_R * bendAngle();
  float sg = arcLen * (i == 0 ? 0.35 : (i == 1 ? 0.6 : 0.5));
  float n = i == 1 ? -0.02 : 0.0;
  float x = i == 2 ? tipLE(sg, arcLen) - tipChord(sg, arcLen, WINGLET_H - BEND_R) - 0.04   // 尾灯在后缘
                   : tipLE(sg, arcLen) + (i == 0 ? 0.07 : 0.05);                              // 前缘的透明灯罩里
  return tipToAircraft(sg, n, x);
}

// 灯在 dir 方向（机体系，从灯出发）上的发光强度（cd）。
// 航行灯按 FAR 25.1389–1391：正前方 0–10° 至少 40 cd，10–20° 30 cd，20–110°（朝外侧）5 cd；
// 光区之外只剩灯罩的散射漏光（这里取 3 cd，经验值）。尾灯：向后 ±70° 内 20 cd。频闪：各向约 1500 cd（LED 防撞灯的峰值量级）。
vec3 lampIntensity(int i, vec3 dir) {
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

// 机翼着色（座舱系）。w 是 traceWing 的结果（法线、自阴影、部件已经算好）；eSky / eDown / belowAlbedo 是窗外的天空光、下方反射光
vec3 shadeWing(vec3 pc, vec3 rd, WingTrace w, vec3 sunC, vec3 eSky, vec3 eDown, float belowAlbedo) {
  vec3 P = cabinToAircraft(pc);
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
  float shadow = fuselageShadow(P, lA) * step(0.0, nl) * w.shadow;
  vec3 eSun = keyLight(uCamR, vec3(0.0, 1.0, 0.0)) * shadow;
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
  vec3 fBase = f0 + (1.0 - f0) * pow(1.0 - vh, 5.0);
  float aBase = m.rough * m.rough;
  vec3 spec = fBase * ggxD(nh, aBase) * smithG(nv, max(nl, 1e-3), aBase) / (4.0 * nv * max(nl, 1e-3)) * eSun * nl;
  float coat = m.coat * (1.0 - m.metal);
  float fCoat = 0.04 + 0.96 * pow(1.0 - vh, 5.0);
  const float A_COAT = 0.004; // 清漆粗糙度 0.06 的平方
  spec += coat * fCoat * ggxD(nh, A_COAT) * smithG(nv, max(nl, 1e-3), A_COAT) / (4.0 * nv * max(nl, 1e-3)) * eSun * nl;

  // 环境反射：清漆是镜面，基础层按粗糙度取模糊的平均
  vec3 r = uCabinToWorld * reflect(rd, n);
  vec3 envSharp = wingEnv(r, 0.0, eSky, eDown, belowAlbedo);
  vec3 envBase = wingEnv(r, m.rough, eSky, eDown, belowAlbedo);
  vec3 fEnv = f0 + (max(vec3(1.0 - m.rough), f0) - f0) * pow(1.0 - nv, 5.0);
  float fEnvCoat = 0.04 + 0.96 * pow(1.0 - nv, 5.0);
  // 反射方向朝向机翼自己（比如小翼内侧反射到翼面）时，被自己挡住的部分按天空光的一半估计
  vec3 envSpec = envBase * fEnv * (m.metal > 0.5 ? 1.0 : 0.3) + envSharp * coat * fEnvCoat;

  // 翼尖的灯照到翼面上：点光源，照度 = I·cosθ / d²（lux → klux）
  vec3 lampLit = vec3(0.0);
  for (int i = min(uWingSteps, 0); i < 3; i++) {  // 起点依赖 uniform：不让 FXC 展开成三份
    vec3 d = lampPos(i) - P;
    float dist2 = max(dot(d, d), 0.04);
    vec3 l = d * inversesqrt(dist2);
    float nlL = dot(nA, l);
    if (nlL <= 0.0) continue;
    vec3 e = lampIntensity(i, -l) / dist2 * 1e-3 * nlL;
    vec3 lC = vec3(uSeatSign * l.x, l.y, l.z);
    vec3 hL = normalize(lC + v);
    float nhL = max(dot(n, hL), 0.0);
    float fL = 0.04 + 0.96 * pow(1.0 - max(dot(v, hL), 0.0), 5.0);
    lampLit += e * (m.albedo * (1.0 - m.metal) / M_PI
      + coat * fL * ggxD(nhL, 0.02) * 0.25 / nv
      + mix(vec3(0.04), m.albedo, m.metal) * ggxD(nhL, max(aBase, 0.02)) * 0.25 / nv);
  }
  return diffuse + spec + envSpec + lampLit + m.emit;
}

// 旋转网格（RGSS）的四个子像素偏移（单位：像素）
vec2 rgss(int k) {
  return k == 1 ? vec2(0.125, 0.375) : (k == 2 ? vec2(-0.375, 0.125) : (k == 3 ? vec2(0.375, -0.125) : vec2(-0.125, -0.375)));
}

// 视线打到机翼：返回 (颜色 × 窗板透射率之前的辐亮度, 覆盖率)。
// 覆盖率 < 1 的是轮廓上的像素，调用方按它和窗外混合。cloud 是这条视线上的云（半分辨率云层纹理）
//
// 抗锯齿：先打一条中心射线，判断这个像素是不是「边缘像素」——
// - 擦边没打中（解析覆盖率介于 0 和 1 之间）：外轮廓外侧；
// - 打中了但表面斜对视线（|n·v| < 0.3）：外轮廓内侧、薄的后缘、小翼的边；
// - 打中之前先擦过另一处轮廓：内轮廓（襟翼压在主翼上、小翼和翼面、短舱和机翼）。
// 边缘像素改成 4 条旋转网格（RGSS）子射线各自求交、着色再平均，每条子射线自己的覆盖率按半个像素的斜坡算。
// 只用中心射线的解析覆盖率时，轮廓只有外侧半个像素有过渡、内侧是硬的，距离场又常高估距离，斜边上还是一级级的台阶。
// 开销只落在边缘像素上（回归场景里约占 1% 以下）。
// 求交和着色都放在同一个循环里、各只有一处调用，FXC 不会把它们内联成五份（冷编译时间不涨）。
vec4 wingView(vec3 ro, vec3 rd, float tStart, vec3 sunC, vec3 eSky, vec3 eDown, float belowAlbedo, vec4 cloud) {
  vec3 lA = vec3(uSeatSign * sunC.x, sunC.y, sunC.z);
  vec3 right = uCamBasis[0];
  vec3 up = uCamBasis[1];
  float pa = pixelAngle();
  vec3 acc = vec3(0.0);
  float covSum = 0.0;
  int n = 1;
  float single = 1.0;  // 1 = 只有中心射线（解析覆盖率），0 = 超采样
  float t0 = tStart;
  float sh0 = 1.0;
  for (int k = min(uWingSteps, 0); k < 5; k++) {
    if (k >= n) break;
    vec3 rdk = k == 0 ? rd : normalize(rd + (right * rgss(k).x + up * rgss(k).y) * pa);
    // 子射线：从中心射线命中点前一段开始走（挡在前面的部件一般在几米之内），不带自阴影（沿用中心射线的）
    WingTrace w = traceWing(ro, rdk, t0, lA, k == 0 ? uWingSteps : uWingSteps / 4, k == 0 ? uWingShadowSteps : 0);
    if (k > 0) w.shadow = sh0;
    if (k == 0 && uWingEdgeAA > 0 && ((w.cov > 0.0 && w.cov < 1.0) || w.edge)) {
      n = uWingEdgeAA == 3 ? 1 : 5;   // 3：只判断不超采样（测开销用）
      single = 0.0;
      t0 = max(tStart, w.t * 0.85);
      sh0 = w.shadow;
      continue;
    }
    // 中心射线用解析覆盖率；子射线的斜坡收窄到半个像素（子射线之间相距约半个像素）
    float c = single > 0.5 ? w.cov : clamp(2.0 * w.cov - 1.0, 0.0, 1.0);
    if (c <= 0.0) continue;
    vec3 col = shadeWing(ro + rdk * w.t, rdk, w, sunC, eSky, eDown, belowAlbedo);
    // 在云里：机翼隔着几米到十几米的雾。消光系数取探针测到的云密度，雾色取这条视线上云的亮度
    if (uCameraFog > 0.0) {
      float tFog = exp(-uCameraFog * w.t * 0.001);
      vec3 fogColor = cloud.rgb / max(1.0 - cloud.a, 0.05);
      col = mix(fogColor, col, tFog);
    }
    // 调试：超采样的像素染成品红（亮度不变，不影响自动曝光）
    if (uWingEdgeAA > 1 && single < 0.5) col = vec3(1.0, 0.0, 1.0) * dot(col, vec3(0.2126, 0.7152, 0.0722)) * 1.4;
    acc += col * c;
    covSum += c;
  }
  if (covSum <= 0.0) return vec4(0.0);
  return vec4(acc / covSum, single > 0.5 ? covSum : covSum * 0.25);
}

// 翼尖的航行灯（右绿左红）、白色频闪、尾灯：小光源 + 周围的光晕（光晕靠后面的眩光处理放大）；
// 在云里时再加上灯光照亮周围云雾的散射光（频闪一闪，整片雾跟着亮一下）
vec3 wingLights(vec3 ro, vec3 rd) {
  vec3 L = vec3(0.0);
  float sigma = uCameraFog * 1e-3;   // 云雾的消光系数，1/m（云滴几乎不吸收，散射系数取同一个值）
  vec3 rdA = vec3(uSeatSign * rd.x, rd.y, rd.z);  // 机体系里的视线方向
  for (int i = min(uWingSteps, 0); i < 3; i++) {  // 起点依赖 uniform：不让 FXC 展开成三份
    vec3 a = lampPos(i);
    vec3 c = aircraftToCabin(a);
    vec3 d = c - ro;
    float t = dot(d, rd);
    float dist = length(d - rd * max(t, 0.0));
    vec3 toEye = -rdA;
    vec3 I = lampIntensity(i, toEye);
    // 发光强度（cd）换算成一个 3 cm 光球的亮度
    if (t > 0.0) {
      float core = 1.0 - smoothstep(0.02, 0.03, dist);
      L += I / (M_PI * 0.03 * 0.03) * 1e-3 * core * exp(-sigma * t); // cd/m² → kcd/m²
    }
    // 云雾里的单次散射：沿视线积分 σ·I/(4π r²)，r² = h² + (s − t)²，有解析解。
    // 用灯的平均强度（各方向）近似；视线穿过的雾同时也衰减一部分
    if (sigma > 0.0) {
      vec3 Iavg = i == 1 ? I : lampIntensity(i, vec3(1.0, 0.0, 0.3)) * 0.3;
      float hh = max(dist, 0.05);
      float s1 = 60.0;
      float integ = (atan((s1 - t) / hh) - atan(-t / hh)) / hh;
      L += sigma * Iavg / (4.0 * M_PI) * integ * exp(-sigma * max(t, 0.0)) * 1e-3;
    }
  }
  return L;
}
`;
