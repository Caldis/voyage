/**
 * 机翼着色（GLSL，座舱系）：漫反射 + 清漆镜面 + 环境反射，以及翼尖航行灯 / 频闪灯。
 * 依赖 WING_COMMON（cabinToAircraft / wingNormal / wingSurface / fuselageShadow / ggxD / smithG）/
 * LIGHTS_COMMON（keyLight / skyRadiance）。从 scene.ts 拆出（T01 纯重构，未改动任何算法或参数）。
 */
export const WING_SHADING_COMMON = /* glsl */ `
// 机翼着色（座舱系）。eSky / eDown / belowAlbedo 是窗外的天空光、下方反射光
vec3 shadeWing(vec3 pc, vec3 rd, vec3 sunC, vec3 eSky, vec3 eDown, float belowAlbedo) {
  vec3 P = cabinToAircraft(pc);
  vec3 nA = wingNormal(P);
  vec3 n = vec3(uSeatSign * nA.x, nA.y, nA.z);          // 机体系 → 座舱系
  vec3 v = -rd;
  if (dot(n, v) < 0.0) n = -n;
  vec3 nW = uCabinToWorld * n;
  float pix = length(pc - uHead) * 2.0 * uTanHalfFov / uResolution.y; // 命中点处一个像素对应的米数
  WingSurface m = wingSurface(P, pix);
  vec3 lA = vec3(uSeatSign * sunC.x, sunC.y, sunC.z);
  float nl = dot(n, sunC);
  float shadow = fuselageShadow(P, lA) * step(0.0, nl);
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
  float coat = (1.0 - m.metal) * 0.9;
  float fCoat = 0.04 + 0.96 * pow(1.0 - vh, 5.0);
  const float A_COAT = 0.004; // 清漆粗糙度 0.06 的平方
  spec += coat * fCoat * ggxD(nh, A_COAT) * smithG(nv, max(nl, 1e-3), A_COAT) / (4.0 * nv * max(nl, 1e-3)) * eSun * nl;

  // 环境反射：天空（反射到地平线以下时是海面，用天空视图 LUT 的地面部分近似）
  vec3 r = uCabinToWorld * reflect(rd, n);
  float tG = raySphere(vec3(0.0, uCamR, 0.0), r, BOTTOM);
  vec3 env = skyRadiance(r, tG > 0.0);
  vec3 fEnv = f0 + (max(vec3(1.0 - m.rough), f0) - f0) * pow(1.0 - nv, 5.0);
  float fEnvCoat = 0.04 + 0.96 * pow(1.0 - nv, 5.0);
  vec3 envSpec = env * (fEnv * (m.metal > 0.5 ? 1.0 : 0.3) + coat * fEnvCoat);
  return diffuse + spec + envSpec + m.emit;
}

// 翼尖的航行灯（右绿左红）和白色频闪灯：小光源 + 周围的光晕（光晕靠后面的眩光处理放大）
vec3 wingLights(vec3 ro, vec3 rd) {
  float tipY = ROOT_Y + (TIP_Z - ROOT_Z) * tan(DIHEDRAL) + uWingFlex;
  float tipLE = -(TIP_Z - ROOT_Z) * tan(SWEEP);
  vec3 navA = vec3(tipLE - 0.15, tipY + 0.05, TIP_Z + 0.12);
  vec3 strobeA = navA + vec3(-0.35, 0.0, 0.0);
  vec3 L = vec3(0.0);
  for (int i = 0; i < 2; i++) {
    vec3 a = i == 0 ? navA : strobeA;
    vec3 c = vec3(uSeatSign * (a.x + uWingRootLE), a.y - WINDOW_HEIGHT, a.z - CABIN_WALL_RADIUS);
    vec3 d = c - ro;
    float t = dot(d, rd);
    if (t < 0.0) continue;
    float dist = length(d - rd * t);
    // 发光强度（cd）：航行灯约 40 cd，频闪闪亮时约 1500 cd。换算成一个 3 cm 光球的亮度，再加上宽一点的衰减
    vec3 intensity = i == 0 ? (uSeatSign > 0.0 ? vec3(0.1, 1.0, 0.35) : vec3(1.0, 0.08, 0.05)) * 40.0
                            : vec3(1.0) * 1500.0 * uStrobe;
    float core = 1.0 - smoothstep(0.02, 0.03, dist);
    L += intensity / (M_PI * 0.03 * 0.03) * 1e-3 * core; // cd/m² → kcd/m²
  }
  return L;
}
`;
