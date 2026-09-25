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
        vec3 scat = m.rayleigh + m.mie;
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

// 空气透视 LUT：每一层是一个距离，存「从相机到该距离」的内散射（RGB）和透射率（另一张图的 RGB）
const AERIAL_FRAG = /* glsl */ `
${ATMOSPHERE_COMMON}
uniform float uCamR;
uniform vec3 uSunDirLocal;   // 太阳方向，已经转到「太阳方位角 = 0」的坐标里
uniform float uLayer;
uniform bool uOutputTransmittance;
varying vec2 vUv;
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
  vec3 L = integrateSegment(vec3(0.0, max(uCamR, BOTTOM + 0.01), 0.0), rd, uSunDirLocal, dist, 24.0, T);
  gl_FragColor = vec4(uOutputTransmittance ? T : L, 1.0);
}
`;

function aerialTarget() {
  const [w, h, d] = LUT_SIZE.aerial;
  const rt = new THREE.WebGL3DRenderTarget(w, h, d, {
    type: THREE.HalfFloatType,
    format: THREE.RGBAFormat,
    minFilter: THREE.LinearFilter,
    magFilter: THREE.LinearFilter,
    depthBuffer: false,
  });
  rt.texture.wrapR = THREE.ClampToEdgeWrapping;
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

export class Atmosphere {
  readonly transmittance = lutTarget(LUT_SIZE.transmittance);
  readonly multiScattering = lutTarget(LUT_SIZE.multiScattering);
  readonly irradiance = lutTarget(LUT_SIZE.irradiance);
  readonly skyView = lutTarget(LUT_SIZE.skyView);
  /** 同一张天空视图 LUT，光源换成月亮（结果同样以「光源照度 = 1」为单位） */
  readonly skyViewMoon = lutTarget(LUT_SIZE.skyView);
  readonly aerialInscatter = aerialTarget();
  readonly aerialTransmittance = aerialTarget();

  /** 所有用到大气 LUT 的着色器共享这两个 uniform */
  readonly sharedUniforms = {
    uTransmittanceLut: { value: this.transmittance.texture },
    uMultiScatteringLut: { value: this.multiScattering.texture },
  };

  private readonly skyViewMaterial = lutMaterial(SKY_VIEW_FRAG, {
    ...this.sharedUniforms,
    uCamR: { value: 6370 },
    uSunCosZenith: { value: 0.5 },
  });

  private readonly aerialMaterial = lutMaterial(AERIAL_FRAG, {
    ...this.sharedUniforms,
    uCamR: { value: 6370 },
    uSunDirLocal: { value: new THREE.Vector3() },
    uLayer: { value: 0 },
    uOutputTransmittance: { value: false },
  });

  constructor(private readonly pass: FullscreenPass) {
    // 透射率 → 多次散射 → 辐照度，大气参数不变，只需算一次
    pass.render(lutMaterial(TRANSMITTANCE_FRAG, {}), this.transmittance);
    pass.render(lutMaterial(MULTI_SCATTERING_FRAG, { ...this.sharedUniforms }), this.multiScattering);
    pass.render(lutMaterial(IRRADIANCE_FRAG, { ...this.sharedUniforms }), this.irradiance);
  }

  updateSkyView(camR: number, sunCosZenith: number, moonCosZenith: number) {
    this.skyViewMaterial.uniforms.uCamR.value = camR;
    this.skyViewMaterial.uniforms.uSunCosZenith.value = sunCosZenith;
    this.pass.render(this.skyViewMaterial, this.skyView);
    this.skyViewMaterial.uniforms.uSunCosZenith.value = moonCosZenith;
    this.pass.render(this.skyViewMaterial, this.skyViewMoon);
  }

  updateAerialPerspective(camR: number, sunCosZenith: number) {
    const u = this.aerialMaterial.uniforms;
    u.uCamR.value = camR;
    u.uSunDirLocal.value.set(Math.sqrt(Math.max(0, 1 - sunCosZenith * sunCosZenith)), sunCosZenith, 0);
    for (const [target, isT] of [[this.aerialInscatter, false], [this.aerialTransmittance, true]] as const) {
      u.uOutputTransmittance.value = isT;
      for (let layer = 0; layer < LUT_SIZE.aerial[2]; layer++) {
        u.uLayer.value = layer;
        this.pass.render(this.aerialMaterial, target, layer);
      }
    }
  }
}
