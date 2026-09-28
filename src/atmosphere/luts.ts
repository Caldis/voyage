import * as THREE from "three";
import { ATMOSPHERE_COMMON, FULLSCREEN_VERT, LUT_SIZE } from "./common.glsl";
import type { FullscreenPass } from "../render/pass";

const TRANSMITTANCE_FRAG = /* glsl */ `
${ATMOSPHERE_COMMON}
varying vec2 vUv;
void main() {
  // uv → (r, mu)，是 transmittanceUv 的逆映射
  float xMu = uvToUnit(gl_FragCoord.x / TRANSMITTANCE_SIZE.x, TRANSMITTANCE_SIZE.x);
  float xR = uvToUnit(gl_FragCoord.y / TRANSMITTANCE_SIZE.y, TRANSMITTANCE_SIZE.y);
  float H = sqrt(TOP * TOP - BOTTOM * BOTTOM);
  float rho = H * xR;
  float r = sqrt(rho * rho + BOTTOM * BOTTOM);
  float dMin = TOP - r;
  float dMax = rho + H;
  float d = dMin + xMu * (dMax - dMin);
  float mu = d == 0.0 ? 1.0 : clamp((H * H - rho * rho - d * d) / (2.0 * r * d), -1.0, 1.0);

  vec3 ro = vec3(0.0, r, 0.0);
  vec3 rd = vec3(sqrt(1.0 - mu * mu), mu, 0.0);
  const float STEPS = 40.0;
  vec3 opticalDepth = vec3(0.0);
  for (float i = 0.0; i < STEPS; i += 1.0) {
    vec3 p = ro + rd * (d * (i + 0.5) / STEPS);
    opticalDepth += sampleMedium(length(p) - BOTTOM).extinction;
  }
  gl_FragColor = vec4(exp(-opticalDepth * d / STEPS), 1.0);
}
`;

// Hillaire 2020 第 5.5 节：二阶散射 L2 与传递因子 f_ms，多次散射 Ψ = L2 / (1 - f_ms)
const MULTI_SCATTERING_FRAG = /* glsl */ `
${ATMOSPHERE_COMMON}
varying vec2 vUv;
void main() {
  float sunCos = uvToUnit(gl_FragCoord.x / MULTI_SCATTERING_SIZE.x, MULTI_SCATTERING_SIZE.x) * 2.0 - 1.0;
  float h = uvToUnit(gl_FragCoord.y / MULTI_SCATTERING_SIZE.y, MULTI_SCATTERING_SIZE.y);
  float r = mix(BOTTOM + 0.01, TOP - 0.01, h);
  vec3 ro = vec3(0.0, r, 0.0);
  vec3 sunDir = vec3(sqrt(max(0.0, 1.0 - sunCos * sunCos)), sunCos, 0.0);
  const float SQRT_DIRS = 8.0;
  const float STEPS = 20.0;
  const float ISO_PHASE = 1.0 / (4.0 * M_PI);
  vec3 lum = vec3(0.0);
  vec3 fms = vec3(0.0);
  for (float i = 0.0; i < SQRT_DIRS; i += 1.0) {
    for (float j = 0.0; j < SQRT_DIRS; j += 1.0) {
      // 球面均匀分布的 64 个方向
      float phi = 2.0 * M_PI * (i + 0.5) / SQRT_DIRS;
      float cosT = 1.0 - 2.0 * (j + 0.5) / SQRT_DIRS;
      float sinT = sqrt(max(0.0, 1.0 - cosT * cosT));
      vec3 rd = vec3(sinT * cos(phi), cosT, sinT * sin(phi));
      float tBottom = raySphere(ro, rd, BOTTOM);
      float tTop = raySphere(ro, rd, TOP);
      float tMax = tBottom > 0.0 ? tBottom : tTop;
      float dt = tMax / STEPS;
      vec3 T = vec3(1.0);
      vec3 L = vec3(0.0);
      vec3 F = vec3(0.0);
      for (float k = 0.0; k < STEPS; k += 1.0) {
        vec3 p = ro + rd * (dt * (k + 0.3));
        float pr = length(p);
        Medium m = sampleMedium(pr - BOTTOM);
        vec3 stepT = exp(-m.extinction * dt);
        vec3 scat = m.rayleigh + m.mie + m.haze;
        vec3 ext = max(m.extinction, vec3(1e-7));
        F += T * (scat - scat * stepT) / ext;
        vec3 S = scat * ISO_PHASE * sunTransmittance(pr, dot(p / pr, sunDir));
        L += T * (S - S * stepT) / ext;
        T *= stepT;
      }
      if (tBottom > 0.0) {
        // 射线打到地面：加上地面的朗伯反射
        vec3 hit = ro + rd * tBottom;
        vec3 n = normalize(hit);
        float c = dot(n, sunDir);
        L += T * GROUND_ALBEDO / M_PI * max(c, 0.0) * sunTransmittance(BOTTOM, c);
      }
      lum += L;
      fms += F;
    }
  }
  float invN = 1.0 / (SQRT_DIRS * SQRT_DIRS);
  lum *= invN;
  fms *= invN;
  gl_FragColor = vec4(lum / (1.0 - fms), 1.0);
}
`;

// 水平面上的天空漫射辐照度：对上半球做余弦加权采样，E = π · 平均辐亮度
const IRRADIANCE_FRAG = /* glsl */ `
${ATMOSPHERE_COMMON}
varying vec2 vUv;
void main() {
  float sunCos = uvToUnit(gl_FragCoord.x / IRRADIANCE_SIZE.x, IRRADIANCE_SIZE.x) * 2.0 - 1.0;
  float h = uvToUnit(gl_FragCoord.y / IRRADIANCE_SIZE.y, IRRADIANCE_SIZE.y);
  float r = mix(BOTTOM + 0.01, TOP - 0.01, h);
  vec3 ro = vec3(0.0, r, 0.0);
  vec3 sunDir = vec3(sqrt(max(0.0, 1.0 - sunCos * sunCos)), sunCos, 0.0);
  const float SQRT_DIRS = 8.0;
  vec3 sum = vec3(0.0);
  for (float i = 0.0; i < SQRT_DIRS; i += 1.0) {
    for (float j = 0.0; j < SQRT_DIRS; j += 1.0) {
      float phi = 2.0 * M_PI * (i + 0.5) / SQRT_DIRS;
      float u = (j + 0.5) / SQRT_DIRS;
      float sinT = sqrt(u);
      vec3 rd = vec3(sinT * cos(phi), sqrt(1.0 - u), sinT * sin(phi));
      sum += integrateScattering(ro, rd, sunDir, 24.0);
    }
  }
  gl_FragColor = vec4(M_PI * sum / (SQRT_DIRS * SQRT_DIRS), 1.0);
}
`;

// 每帧更新：以相机高度为准，沿「相对太阳的方位角 × 天顶角」存天空辐亮度（含到地面为止的空气透视）
const SKY_VIEW_FRAG = /* glsl */ `
${ATMOSPHERE_COMMON}
uniform float uCamR;
uniform float uSunCosZenith;
varying vec2 vUv;
void main() {
  float x = uvToUnit(gl_FragCoord.x / SKY_VIEW_SIZE.x, SKY_VIEW_SIZE.x);
  float y = uvToUnit(gl_FragCoord.y / SKY_VIEW_SIZE.y, SKY_VIEW_SIZE.y);
  float r = max(uCamR, BOTTOM + 0.01);
  float vHorizon = sqrt(max(0.0, r * r - BOTTOM * BOTTOM));
  float beta = acos(clamp(vHorizon / r, -1.0, 1.0));
  float zenithHorizonAngle = M_PI - beta;
  float viewZenith;
  if (y < 0.5) {
    float c = 1.0 - 2.0 * y;
    viewZenith = zenithHorizonAngle * (1.0 - c * c);
  } else {
    float c = 2.0 * y - 1.0;
    viewZenith = zenithHorizonAngle + beta * c * c;
  }
  float lightViewCos = 1.0 - 2.0 * x * x;
  float vz = cos(viewZenith);
  float vs = sin(viewZenith);
  vec3 rd = vec3(vs * lightViewCos, vz, vs * sqrt(max(0.0, 1.0 - lightViewCos * lightViewCos)));
  vec3 sunDir = vec3(sqrt(max(0.0, 1.0 - uSunCosZenith * uSunCosZenith)), uSunCosZenith, 0.0);
  gl_FragColor = vec4(integrateScattering(vec3(0.0, r, 0.0), rd, sunDir, 40.0), 1.0);
}
`;

// 空气透视 LUT：每一层是一个距离，存「从相机到该距离」的内散射（RGB）和透射率（另一张图的 RGB）。
// PERF-CPU：两张图一次画出（MRT：location 0 = 内散射，即 three 的 gl_FragColor；location 1 = 透射率）。
// 以前按 uOutputTransmittance 分两遍各画 32 层，同一段 integrateSegment 算两次、每帧 64 次 draw（全帧 111 次里的 64 次），
// 现在 32 次；两张图的数值与分两遍时逐位相同（同一段代码、同样的输入）
// NIGHT-AP-1：太阳、月亮两路光源一起积分，以「主导光源照度 = 1」为单位存，方位角按主导光源参数化（见 Atmosphere.updateAerialPerspective）。
// 次要光源弱到可以忽略时（白天的月亮、深夜的太阳）走原来的单光源 integrateSegment，这张表与改前逐位相同
const AERIAL_FRAG = /* glsl */ `
${ATMOSPHERE_COMMON}
uniform float uCamR;
uniform vec3 uSunDirLocal;      // 主导光源方向，已经转到「主导光源方位角 = 0」的坐标里（名字沿用改前，白天就是太阳）
uniform vec4 uApSecondLocal;    // xyz：次要光源方向（同一坐标，放在 z ≥ 0 这一侧）；w > 0.5 时才积分这一路
uniform vec3 uApSecondScale;    // 次要光源照度 ÷ 主导光源照度（逐通道：月光比日光偏暖）
uniform float uLayer;
layout(location = 1) out highp vec4 aerialTransmittanceOut;
varying vec2 vUv;

// integrateSegment 的两光源版：介质、透射率沿视线只算一次，两路光源各自的相函数、到光源的透射率、多次散射相加。
// 次要光源按 bScale 换算到主导光源的单位
vec3 integrateSegment2(vec3 ro, vec3 rd, vec3 aDir, vec3 bDir, vec3 bScale, float tLimit, float sampleCount, out vec3 transmittance) {
  float tBottom = raySphere(ro, rd, BOTTOM);
  float tTop = raySphere(ro, rd, TOP);
  float tMax = min(tBottom > 0.0 ? tBottom : tTop, tLimit);
  transmittance = vec3(1.0);
  if (tMax <= 0.0) return vec3(0.0);
  float cA = dot(rd, aDir);
  float cB = dot(rd, bDir);
  vec3 phA = vec3(rayleighPhase(cA), miePhase(cA), csPhase(cA, HAZE_G));
  vec3 phB = vec3(rayleighPhase(cB), miePhase(cB), csPhase(cB, HAZE_G));
  vec3 L = vec3(0.0);
  vec3 T = vec3(1.0);
  float tPrev = 0.0;
  for (int i = 0; i < 64; i++) {
    if (float(i) >= sampleCount) break;
    float s = (float(i) + 1.0) / sampleCount;
    float tNext = tMax * s * s;
    float dt = tNext - tPrev;
    vec3 p = ro + rd * (tPrev + 0.3 * dt);
    float r = length(p);
    Medium m = sampleMedium(r - BOTTOM);
    vec3 up = p / r;
    float muA = dot(up, aDir);
    float muB = dot(up, bDir);
    vec3 scat = m.rayleigh + m.mie + m.haze;
    vec3 stepT = exp(-m.extinction * dt);
    vec3 S = (m.rayleigh * phA.x + m.mie * phA.y + m.haze * phA.z) * sunTransmittance(r, muA) + scat * multiScattering(r, muA)
           + bScale * ((m.rayleigh * phB.x + m.mie * phB.y + m.haze * phB.z) * sunTransmittance(r, muB) + scat * multiScattering(r, muB));
    L += T * (S - S * stepT) / max(m.extinction, vec3(1e-7));
    T *= stepT;
    tPrev = tNext;
  }
  transmittance = T;
  return L;
}

void main() {
  float x = uvToUnit(gl_FragCoord.x / AERIAL_SIZE.x, AERIAL_SIZE.x);
  float y = uvToUnit(gl_FragCoord.y / AERIAL_SIZE.y, AERIAL_SIZE.y);
  float z = uvToUnit((uLayer + 0.5) / AERIAL_SIZE.z, AERIAL_SIZE.z);
  float lightViewCos = 1.0 - 2.0 * x * x;
  float c = 1.0 - 2.0 * y;
  float vz = sign(c) * c * c;
  float vs = sqrt(max(0.0, 1.0 - vz * vz));
  vec3 rd = vec3(vs * lightViewCos, vz, vs * sqrt(max(0.0, 1.0 - lightViewCos * lightViewCos)));
  float dist = z * z * AERIAL_MAX_DISTANCE;
  vec3 T;
  vec3 ro = vec3(0.0, max(uCamR, BOTTOM + 0.01), 0.0);
  vec3 L;
  if (uApSecondLocal.w > 0.5) L = integrateSegment2(ro, rd, uSunDirLocal, uApSecondLocal.xyz, uApSecondScale, dist, 24.0, T);
  else L = integrateSegment(ro, rd, uSunDirLocal, dist, 24.0, T);
  gl_FragColor = vec4(L, 1.0);
  aerialTransmittanceOut = vec4(T, 1.0);
}
`;

/** 空气透视的 3D 目标，两个颜色附件（textures[0] 内散射、textures[1] 透射率，见 AERIAL_FRAG） */
function aerialTarget() {
  const [w, h, d] = LUT_SIZE.aerial;
  const rt = new THREE.WebGL3DRenderTarget(w, h, d, {
    type: THREE.HalfFloatType,
    format: THREE.RGBAFormat,
    minFilter: THREE.LinearFilter,
    magFilter: THREE.LinearFilter,
    depthBuffer: false,
    count: 2,
  });
  // three 的 WebGL3DRenderTarget 只把 textures[0] 换成 Data3DTexture，count: 2 多出来的 textures[1] 还是 2D Texture：
  // 换成同样设置的 Data3DTexture（three 的多目标 3D 分支按 TEXTURE_3D 分配、逐附件 framebufferTextureLayer）
  const t0 = rt.textures[0];
  const t1 = new THREE.Data3DTexture(null, w, h, d);
  for (const k of ["type", "format", "minFilter", "magFilter", "generateMipmaps", "flipY", "internalFormat", "isRenderTargetTexture"] as const)
    (t1 as unknown as Record<string, unknown>)[k] = t0[k];
  t1.renderTarget = rt;
  rt.textures[1] = t1;
  for (const t of rt.textures) t.wrapS = t.wrapT = t.wrapR = THREE.ClampToEdgeWrapping;
  return rt;
}

function lutTarget([w, h]: readonly [number, number]) {
  return new THREE.WebGLRenderTarget(w, h, {
    type: THREE.HalfFloatType,
    format: THREE.RGBAFormat,
    minFilter: THREE.LinearFilter,
    magFilter: THREE.LinearFilter,
    wrapS: THREE.ClampToEdgeWrapping,
    wrapT: THREE.ClampToEdgeWrapping,
    depthBuffer: false,
    generateMipmaps: false,
  });
}

function lutMaterial(fragmentShader: string, uniforms: Record<string, THREE.IUniform>) {
  return new THREE.ShaderMaterial({
    vertexShader: FULLSCREEN_VERT,
    fragmentShader,
    uniforms,
    depthTest: false,
    depthWrite: false,
    toneMapped: false,
  });
}

// 地平线天光系数（NIGHT-AP-1）：天空视图 LUT 在地平线上第一行、所有方位的亮度均值（「光源照度 = 1」为单位），
// 按光源高度角查表，只用来判断太阳 / 月亮哪一路主导空气透视、另一路可不可以忽略（相对量，不进画面）。
// TODO 实测填表
const HORIZON_SKY_ELEV = [-90, 0, 90];
const HORIZON_SKY_LOG10 = [-30, -5, -5];

function horizonSkyScale(elevDeg: number, _camR: number) {
  const e = HORIZON_SKY_ELEV, v = HORIZON_SKY_LOG10;
  if (elevDeg <= e[0]) return 10 ** v[0];
  for (let i = 1; i < e.length; i++) {
    if (elevDeg <= e[i]) {
      const f = (elevDeg - e[i - 1]) / (e[i] - e[i - 1]);
      return 10 ** (v[i - 1] + f * (v[i] - v[i - 1]));
    }
  }
  return 10 ** v[v.length - 1];
}

export class Atmosphere {
  readonly transmittance = lutTarget(LUT_SIZE.transmittance);
  readonly multiScattering = lutTarget(LUT_SIZE.multiScattering);
  readonly irradiance = lutTarget(LUT_SIZE.irradiance);
  readonly skyView = lutTarget(LUT_SIZE.skyView);
  /** 同一张天空视图 LUT，光源换成月亮（结果同样以「光源照度 = 1」为单位） */
  readonly skyViewMoon = lutTarget(LUT_SIZE.skyView);
  /** 空气透视：一个两附件的 3D 目标（PERF-CPU）；下面两个字段保持原来「`.texture` 取纹理」的用法 */
  private readonly aerial = aerialTarget();
  readonly aerialInscatter = { texture: this.aerial.textures[0] as THREE.Data3DTexture };
  readonly aerialTransmittance = { texture: this.aerial.textures[1] as THREE.Data3DTexture };

  /**
   * 所有用到大气 LUT 的着色器共享这几个 uniform。
   * uApDir / uApIlluminance（NIGHT-AP-1）：空气透视 LUT 的主导光源方向与照度（klux，逐通道）。查表一律
   * `aerialPerspectiveUvw(rd, uApDir, 距离)`，内散射乘 `uApIlluminance`——白天就是太阳（与 uSunDir / uSunIlluminance 同值），
   * 满月夜是月亮（表里已含换算过来的另一路光源）。由 updateAerialPerspective 每帧写
   */
  readonly sharedUniforms = {
    uTransmittanceLut: { value: this.transmittance.texture },
    uMultiScatteringLut: { value: this.multiScattering.texture },
    uApDir: { value: new THREE.Vector3(0, 1, 0) },
    uApIlluminance: { value: new THREE.Vector3(120, 120, 120) },
  };

  /**
   * 空气透视 LUT 的光源状态（NIGHT-AP-1，调试读）：dominant 主导光源；second 这一帧是否积分了次要光源；
   * ratio 次要 ÷ 主导的地平线天光估计；sunSky / moonSky 两路的估计值（照度 klux × 地平线天光系数，相对量）
   */
  readonly apState = { dominant: "sun" as "sun" | "moon", second: false, ratio: 0, sunSky: 0, moonSky: 0 };
  /** 调试：false = 只有太阳一路（NIGHT-AP-1 改前的行为，同页 A/B 用） */
  apMoon = true;

  /**
   * 边界层霾（T18）：所有 LUT 程序共用这两个 uniform 对象（含义见 common.glsl.ts 的 uHaze / uHazeShape）。
   * 默认 x = 0：没有霾，和改前完全一样。用 setHaze 改，改动够大时 updateSkyView 顺带重算透射率 / 多次散射 / 辐照度 LUT
   */
  readonly hazeUniforms = {
    uHaze: { value: new THREE.Vector4(0, 1.5, 3, 0.1) },
    uHazeShape: { value: new THREE.Vector4(0, 0.92, 1.3, 0) },
  };
  private staticDirty = false;
  private lastStaticUpdate = -Infinity;
  /** 上一次重算静态 LUT 时的霾参数，用来判断变化够不够大 */
  private readonly staticHaze = new THREE.Vector4(0, 1.5, 3, 0.1);
  private readonly staticHazeShape = new THREE.Vector4(0, 0.92, 1.3, 0);

  private readonly transmittanceMaterial = lutMaterial(TRANSMITTANCE_FRAG, { ...this.hazeUniforms });
  private readonly multiScatteringMaterial = lutMaterial(MULTI_SCATTERING_FRAG, { ...this.sharedUniforms, ...this.hazeUniforms });
  private readonly irradianceMaterial = lutMaterial(IRRADIANCE_FRAG, { ...this.sharedUniforms, ...this.hazeUniforms });

  private readonly skyViewMaterial = lutMaterial(SKY_VIEW_FRAG, {
    ...this.sharedUniforms,
    ...this.hazeUniforms,
    uCamR: { value: 6370 },
    uSunCosZenith: { value: 0.5 },
  });

  private readonly aerialMaterial = lutMaterial(AERIAL_FRAG, {
    ...this.sharedUniforms,
    ...this.hazeUniforms,
    uCamR: { value: 6370 },
    uSunDirLocal: { value: new THREE.Vector3() },
    uApSecondLocal: { value: new THREE.Vector4() },
    uApSecondScale: { value: new THREE.Vector3() },
    uLayer: { value: 0 },
  });

  /** LUT 是否存成 32 位浮点（T36）：能线性过滤 32 位浮点纹理时为 true，否则退回半精度（深暮光会有块状阶梯） */
  readonly float32: boolean;

  constructor(private readonly pass: FullscreenPass) {
    // T36：所有 LUT 以「光源照度 = 1」为单位存辐亮度，深暮光时数值极小——天空视图 LUT 在太阳 −10° 时中位数约 4e-8，
    // −15° 约 6e-10，−18° 约 6e-11，全都低于半精度的最小次正规数 5.96e-8，每个 texel 只剩 0 / 1 / 2 个最低位，
    // 双线性插值后被曝光放大成一格一格的阶梯。32 位浮点的最小正规数是 1.2e-38，到 −18° 仍有 23 位尾数。
    // 目标还没分配显存（three 在第一次 setRenderTarget 时才分配），所以在首次渲染前改 type 即可
    // 调试：URL 带 ?lut16 时强制半精度，复现改前的阶梯 / 模拟不支持 32 位浮点线性过滤的设备。
    // check:glsl（scripts/lint-shaders.mjs）在 Node 里用不带 renderer 的假 pass 构造本类，也没有 location，两处都要容忍
    const ext = (pass as Partial<FullscreenPass>).renderer?.extensions;
    const forceHalf = typeof location !== "undefined" && new URLSearchParams(location.search).has("lut16");
    this.float32 = !!ext && !forceHalf && ext.has("OES_texture_float_linear") && ext.has("EXT_color_buffer_float");
    if (this.float32) {
      for (const rt of [this.transmittance, this.multiScattering, this.irradiance, this.skyView, this.skyViewMoon, this.aerial])
        for (const t of rt.textures) t.type = THREE.FloatType;
    }
    // 透射率 → 多次散射 → 辐照度：只依赖大气参数，启动时算一次；霾参数变化够大时再重算（见 setHaze）
    this.renderStatic();
  }

  private renderStatic() {
    this.pass.render(this.transmittanceMaterial, this.transmittance);
    this.pass.render(this.multiScatteringMaterial, this.multiScattering);
    this.pass.render(this.irradianceMaterial, this.irradiance);
    this.staticHaze.copy(this.hazeUniforms.uHaze.value);
    this.staticHazeShape.copy(this.hazeUniforms.uHazeShape.value);
    this.staticDirty = false;
  }

  /**
   * 设霾参数（T18）：haze = (霾底消光 1/km, 霾顶海拔 km, 标高 km, 霾顶过渡层厚 km)，
   * shape = (霾底海拔 km, 单次散射反照率, Ångström 指数, 吸收倾斜)。天空视图 / 空气透视每帧都重算，立即生效；
   * 透射率 / 多次散射 / 辐照度三张 LUT 在参数变化超过约 3%（霾顶 30 m）时标脏，下一次 updateSkyView 重算（最多每 0.25 秒一次）
   */
  setHaze(haze: THREE.Vector4, shape: THREE.Vector4) {
    this.hazeUniforms.uHaze.value.copy(haze);
    this.hazeUniforms.uHazeShape.value.copy(shape);
    const a = this.staticHaze, b = this.staticHazeShape;
    const rel = (x: number, y: number, eps: number) => Math.abs(x - y) > eps;
    if (
      rel(haze.x, a.x, 0.03 * Math.max(a.x, 0.01)) || rel(haze.y, a.y, 0.03) || rel(haze.z, a.z, 0.1) || rel(haze.w, a.w, 0.02) ||
      rel(shape.x, b.x, 0.03) || rel(shape.y, b.y, 0.01) || rel(shape.z, b.z, 0.05) || rel(shape.w, b.w, 0.005)
    ) this.staticDirty = true;
  }

  updateSkyView(camR: number, sunCosZenith: number, moonCosZenith: number) {
    const now = performance.now();
    if (this.staticDirty && now - this.lastStaticUpdate > 250) {
      this.lastStaticUpdate = now;
      this.renderStatic();
    }
    this.skyViewMaterial.uniforms.uCamR.value = camR;
    this.skyViewMaterial.uniforms.uSunCosZenith.value = sunCosZenith;
    this.pass.render(this.skyViewMaterial, this.skyView);
    this.skyViewMaterial.uniforms.uSunCosZenith.value = moonCosZenith;
    this.pass.render(this.skyViewMaterial, this.skyViewMoon);
  }

  /**
   * 空气透视 LUT（NIGHT-AP-1：太阳、月亮两路）。sunDir / moonDir 是世界坐标的单位向量，照度单位 klux（月光逐通道）。
   * 主导光源：按两路在地平线处天光的估计（照度 × horizonSkyScale）比大小，带 25% 回差，谁大谁定方位参数化与单位；
   * 另一路估计不到主导的 1e-3 时不积分（白天的月亮约 1e-6、满月深夜的太阳 0），LUT 与改前逐位相同
   */
  updateAerialPerspective(camR: number, sunDir: ArrayLike<number>, sunKlux: number, moonDir: ArrayLike<number>, moonKlux: THREE.Vector3) {
    const u = this.aerialMaterial.uniforms;
    const st = this.apState;
    u.uCamR.value = camR;
    const altOf = (d: ArrayLike<number>) => (Math.asin(Math.max(-1, Math.min(1, d[1]))) * 180) / Math.PI;
    const moonLum = 0.2126 * moonKlux.x + 0.7152 * moonKlux.y + 0.0722 * moonKlux.z;
    st.sunSky = sunKlux * horizonSkyScale(altOf(sunDir), camR);
    st.moonSky = this.apMoon ? moonLum * horizonSkyScale(altOf(moonDir), camR) : 0;
    // 回差：月亮要比太阳亮 25% 才接管，太阳要比月亮亮 25% 才交回（两路都是 0 时回到太阳，与改前一致）
    if (st.dominant === "sun" && st.moonSky > st.sunSky * 1.25) st.dominant = "moon";
    else if (st.dominant === "moon" && !(st.moonSky * 1.25 > st.sunSky)) st.dominant = "sun";
    const moonDom = st.dominant === "moon";
    const dom = moonDom ? moonDir : sunDir;
    const sec = moonDom ? sunDir : moonDir;
    st.ratio = moonDom ? st.sunSky / Math.max(st.moonSky, 1e-30) : st.moonSky / Math.max(st.sunSky, 1e-30);
    st.second = st.ratio > 1e-3 && (moonDom ? st.sunSky : st.moonSky) > 0;
    const apDir = this.sharedUniforms.uApDir.value;
    const apI = this.sharedUniforms.uApIlluminance.value;
    apDir.set(dom[0], dom[1], dom[2]);
    if (moonDom) apI.copy(moonKlux);
    else apI.setScalar(sunKlux);
    const cz = dom[1];
    u.uSunDirLocal.value.set(Math.sqrt(Math.max(0, 1 - cz * cz)), cz, 0);
    const s2 = u.uApSecondLocal.value as THREE.Vector4;
    if (st.second) {
      // 次要光源转到「主导光源方位角 = 0」的坐标：LUT 只存 z ≥ 0 半边（消费方按 |方位差| 查），次要光源放在这半边，
      // 与它同侧的视线准确，另一侧是镜像（两路量级相当时误差最大，但那时次要光源本身也只有一半的份额）
      const lh = Math.hypot(dom[0], dom[2]);
      const hx = lh > 1e-5 ? dom[0] / lh : 1, hz = lh > 1e-5 ? dom[2] / lh : 0;
      const sx = sec[0] * hx + sec[2] * hz;
      const sz = Math.abs(sec[2] * hx - sec[0] * hz);
      s2.set(sx, sec[1], sz, 1);
      const scale = u.uApSecondScale.value as THREE.Vector3;
      if (moonDom) scale.set(sunKlux / Math.max(moonKlux.x, 1e-30), sunKlux / Math.max(moonKlux.y, 1e-30), sunKlux / Math.max(moonKlux.z, 1e-30));
      else scale.copy(moonKlux).divideScalar(sunKlux);
    } else s2.w = 0;
    for (let layer = 0; layer < LUT_SIZE.aerial[2]; layer++) {
      u.uLayer.value = layer;
      this.pass.render(this.aerialMaterial, this.aerial, layer);
    }
  }
}
