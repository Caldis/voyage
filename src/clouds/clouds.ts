import * as THREE from "three";
import { ATMOSPHERE_COMMON, FULLSCREEN_VERT } from "../atmosphere/common.glsl";
import type { Atmosphere } from "../atmosphere/luts";
import type { FullscreenPass } from "../render/pass";
import { LIGHTS_COMMON } from "../render/lights.glsl";
import { VIEW_COMMON } from "../render/view.glsl";
import { CLOUD_COMMON } from "./clouds.glsl";
import type { CloudNoise } from "./noise";

/**
 * 体积云：半分辨率光线步进 + 时间累积。
 * 输出纹理 RGB = 已经加上空气透视的云辐亮度（预乘），A = 云的透射率（背景还剩多少）。
 */

const MARCH_FRAG = /* glsl */ `
${ATMOSPHERE_COMMON}
${VIEW_COMMON}
${CLOUD_COMMON}
${LIGHTS_COMMON}
uniform sampler3D uAerialInscatter;
uniform sampler3D uAerialTransmittance;
uniform float uFrame;
uniform vec2 uCloudResolution;
layout(location = 1) out highp vec4 outDepth;
varying vec2 vUv;

// 交错梯度噪声：每个像素的步进起点错开，时间累积后抹平成平滑结果
float ign(vec2 p) { return fract(52.9829189 * fract(dot(p, vec2(0.06711056, 0.00583715)))); }

float hg(float c, float g) {
  float g2 = g * g;
  return (1.0 - g2) / (4.0 * M_PI * pow(max(1.0 + g2 - 2.0 * g * c, 1e-4), 1.5));
}

void main() {
  outDepth = vec4(AERIAL_MAX_DISTANCE, 0.0, 0.0, 1.0);
  gl_FragColor = vec4(0.0, 0.0, 0.0, 1.0);
  vec2 fc = gl_FragCoord.xy * (uResolution / uCloudResolution);
  vec3 rdC = cabinRay(fc);
  // 只算能穿出窗外的像素（留一点余量，避免上采样时窗边出现一圈空白）
  bool anyWeather = uCoverage > 0.0 || uStormCount > 0 || uHurricane.w > 0.5;
  if (!anyWeather || paneDistance(uHead, rdC) > 0.02) return;
  vec3 rd = uCabinToWorld * rdC;
  vec3 ro = vec3(0.0, uCamR, 0.0);
  vec2 seg = cloudShellInterval(ro, rd);
  seg.y = min(seg.y, AERIAL_MAX_DISTANCE);
  if (seg.y <= seg.x) return;

  // 直射主光源：白天是太阳，夜里是月亮（月光照亮云海）
  float cosT = dot(rd, uKeyDir);
  float jitter = fract(ign(gl_FragCoord.xy) + uFrame * 0.61803);
  vec3 L = vec3(0.0);
  float T = 1.0;
  float depthSum = 0.0;
  float wSum = 0.0;
  float t = seg.x;
  // 有雷暴时：从空白进入云的那一步退回去，用 1/8 的小步走过这段，采样点才能落在云的表面附近。
  // 否则远处步长几百米、云的消光又高（60 /km），第一个采样点可能已经在云里几百米深处，
  // 被阳光照亮的那层表面被跳过，受光面发灰、菜花状的隆起也看不出来
  bool refineOn = uStormCount > 0;
  int fine = 0;
  bool wasEmpty = true;
  // 闪电放电通道（线段）：两端换到相机坐标
  vec3 fA = vec3(uFlash.x - uCloudOffset.x, BOTTOM + uFlash.y, uFlash.z - uCloudOffset.y);
  vec3 fAB = vec3(uFlashB.x - uCloudOffset.x, BOTTOM + uFlashB.y, uFlashB.z - uCloudOffset.y) - fA;
  float flashI = uFlash.w / (1.0 + 0.25 * length(fAB)); // 总能量摊到整条通道上
  // 下方（海面 / 低云）反射上来的光的反照率：有低云时明显更亮
  float albedoBelow = 0.06 + 0.5 * uCoverage;
  // 次数上限：从相机空步走到 60 km 外本身就要约 190 步，细化还要额外的步数（每进一次云 9 步）
  for (int i = 0; i < 256; i++) {
    // 没有雷暴时仍是原来的 192 步（多出的步数只给雷暴的表面细化用，普通云不必多走）
    if (t >= seg.y || T < 0.005 || (!refineOn && i >= 192)) break;
    // 步长随距离变长：近处 60 m，远处 2 km
    float dtBase = clamp(t * 0.008, 0.06, 2.0);
    float dt = fine > 0 ? max(dtBase * 0.25, 0.03) : dtBase;
    // 这一步代表的区间长度：空白处走 2 倍步长。抖动必须覆盖整个区间——旧版只抖动 dt、却走 2dt，
    // 每个区间的后一半永远采不到，远处的薄云被「同心球壳」切成一条条水平细纹（T13）
    float stepLen = (fine > 0 || !wasEmpty) ? dt : 2.0 * dt;
    vec3 p = ro + rd * (t + stepLen * jitter);
    float lod = clamp(log2(dtBase / 0.055), 0.0, 5.0);
    float dens = cloudDensity(p, lod, t < 150.0);
    float stormW = gStormW;
    float stormAO = gStormAO;
    // 只在进入雷暴时细化（层状云不必，保持原样）；退回后这段会被小步重新采样，进云那一步的密度并没有丢
    if (dens > 0.002 && stormW > 0.5 && wasEmpty && fine == 0 && dtBase > 0.1 && t > seg.x) {
      // 退回上一步（空白处走的是 2 倍步长），接下来 8 小步走完这 2 个大步
      t = max(t - 2.0 * dtBase, seg.x);
      fine = 8;
      wasEmpty = false;
      continue;
    }
    if (fine > 0) fine--;
    if (dens > 0.002) {
      wasEmpty = false;
      float sigma = dens * CLOUD_EXTINCTION;
      float r = length(p);
      vec3 up = p / r;
      // 朝太阳方向做短距步进，估计阳光在云里走过的光学厚度。
      // 有雷暴、台风时走得更远（约 15 km），否则几公里厚的积雨云底部照样被照亮
      float od = 0.0;
      float ls = 0.06;
      float lt = 0.0;
      int lightSteps = (uStormCount > 0 || uHurricane.w > 0.5) ? 8 : 6;
      if (lightSteps == 6) {
        // 普通云（没有雷暴、台风）：只有层状云，常量上界，编译器展开后最快（和改动前一致）。
        // 这里只能调用层状云密度：展开的每一份都带上雷暴密度的话，冷编译会从 55 s 涨到 90 s
        for (int j = 0; j < 6; j++) {
          lt += ls;
          od += layerDensity(p + uKeyDir * (lt - 0.5 * ls), lod + 0.5, j < 3) * ls;
          ls *= 1.9;
        }
      } else {
        // 雷暴 / 台风：上界依赖 uniform，FXC 不展开（展开成 8 份雷暴密度时冷编译很慢）
        for (int j = 0; j < lightSteps; j++) {
          lt += ls;
          od += cloudDensityLite(p + uKeyDir * (lt - 0.5 * ls), lod + 0.5, j < 3) * ls;
          ls *= 2.0;
        }
      }
      od *= CLOUD_EXTINCTION;
      // 多次散射近似（Wrenninge 2013）：每一阶散射更弱、衰减更慢、相函数更平。
      // 原来只取 4 阶、权重每阶折半，顺光（背散射）时厚云的有效反照率只有 ~0.3，真实厚云是 0.7–0.8，
      // 所以顺光的云普遍偏灰。改成 6 阶、权重衰减放慢，补回高阶散射的能量
      float sunScatter = 0.0;
      float a = 1.0, b = 1.0, c = 1.0;
      // 雷暴的光学厚度大得多（几百），高阶散射占比更高、整体反照率更接近 1：高阶权重衰减得更慢
      float aDecay = stormW > 0.5 ? 0.7 : 0.62;
      for (int k = 0; k < 6; k++) {
        float phase = mix(hg(cosT, -0.25 * c), hg(cosT, 0.8 * c), 0.7);
        sunScatter += a * phase * exp(-b * od);
        a *= aDecay; b *= 0.35; c *= 0.5;
      }
      // Beer-Powder：云团边缘朝向太阳的地方偏暗，看起来更有体积（Schneider 2015）
      float powder = 1.0 - exp(-2.0 * od - 0.5);
      vec3 sunLight = keyLight(r, up) * sunScatter * mix(1.0, powder, 0.5);
      // 环境光：上半球的天空光，云顶亮、云底暗
      float h01 = clamp((r - BOTTOM - uShellBottom) / (uShellTop - uShellBottom), 0.0, 1.0);
      vec3 eSky = skyIrradiance(r, up);
      vec3 ambient = eSky / (2.0 * M_PI) * mix(0.12, 1.0, pow(h01, 0.7));
      if (stormW > 0.5) {
        // 雷暴：隆起之间的凹处、砧底、雨幡里看到的天空少（菜花状的明暗）；
        // 塔身下半截还被下方的海面 / 低云反射的光照着（中性的灰白，冲淡天空光的蓝）
        ambient *= mix(0.3, 1.0, stormAO);
        vec3 eBelow = albedoBelow * keyLight(BOTTOM + 1.0, up) * max(dot(up, uKeyDir), 0.0);
        ambient += eBelow / (2.0 * M_PI) * 0.5 * (1.0 - h01) * stormAO;
      }
      vec3 S = sunLight + ambient;
      // 闪电：云里一段几公里长的放电通道，光在云里多次散射后向外扩散（扩散长度约 2 km），
      // 整团云从内部亮起来，离通道越远越暗。凹处（ao 小）被周围的云挡住，也暗一些
      if (uFlash.w > 0.0) {
        vec3 pw = vec3(p.x, length(p), p.z);
        float u = clamp(dot(pw - fA, fAB) / max(dot(fAB, fAB), 1e-6), 0.0, 1.0);
        float fd = length(pw - fA - fAB * u);
        // 强度按观感标定：白天只在通道附近隐约可见，夜里通道周围几公里亮起来、十公里外的云只被照亮一点
        S += vec3(0.8, 0.85, 1.0) * flashI * 0.005 * exp(-fd / 1.5) / (1.0 + fd * fd) * mix(1.0, stormAO, 0.5);
      }
      float stepT = exp(-sigma * stepLen);
      // 云的反照率接近 1：散射系数 ≈ 消光系数，积分式里 σ 被约掉
      L += T * S * (1.0 - stepT);
      depthSum += T * (1.0 - stepT) * t;
      wSum += T * (1.0 - stepT);
      T *= stepT;
      t += stepLen;
    } else {
      // 空白区域大步走（细化时仍用小步）
      wasEmpty = true;
      t += stepLen;
    }
  }
  if (wSum <= 0.0) return;
  float depth = depthSum / wSum;
  // 相机到云之间的空气透视：远处的云被大气染蓝、变淡，融进地平线
  vec3 uvw = aerialPerspectiveUvw(rd, uSunDir, depth);
  vec3 apL = texture(uAerialInscatter, uvw).rgb * uSunIlluminance;
  vec3 apT = texture(uAerialTransmittance, uvw).rgb;
  L = L * apT + apL * (1.0 - T);
  gl_FragColor = vec4(min(L, vec3(60000.0)), T);
  outDepth = vec4(depth, 0.0, 0.0, 1.0);
}
`;

// 时间累积：把上一帧的结果按云的运动重投影过来，再和这一帧混合；用邻域夹取防止拖影
const RESOLVE_FRAG = /* glsl */ `
${VIEW_COMMON}
uniform sampler2D uCurrent;
uniform sampler2D uCurrentDepth;
uniform sampler2D uHistory;
uniform mat3 uPrevCamBasis;
uniform mat3 uPrevCabinToWorld;
uniform vec3 uMotion;
uniform bool uReset;
uniform vec2 uCloudResolution;
varying vec2 vUv;
void main() {
  vec2 texel = 1.0 / uCloudResolution;
  vec2 uv = gl_FragCoord.xy * texel;
  vec4 cur = texture(uCurrent, uv);
  if (uReset) { gl_FragColor = cur; return; }

  vec4 mn = cur, mx = cur;
  for (int x = -1; x <= 1; x++)
  for (int y = -1; y <= 1; y++) {
    vec4 s = texture(uCurrent, uv + vec2(x, y) * texel);
    mn = min(mn, s);
    mx = max(mx, s);
  }

  float depth = texture(uCurrentDepth, uv).r;
  vec3 rd = uCabinToWorld * cabinRay(gl_FragCoord.xy * (uResolution / uCloudResolution));
  vec3 prevDir = normalize(rd * depth + uMotion);
  vec3 v = transpose(uPrevCamBasis) * (transpose(uPrevCabinToWorld) * prevDir);
  float blend = 0.12;
  vec2 puv = vec2(-1.0);
  if (v.z < 0.0) {
    vec2 ndc = v.xy / (-v.z) / uTanHalfFov;
    ndc.x /= uResolution.x / uResolution.y;
    puv = ndc * 0.5 + 0.5;
  }
  if (any(lessThan(puv, vec2(0.0))) || any(greaterThan(puv, vec2(1.0)))) blend = 1.0;
  vec4 hist = clamp(texture(uHistory, puv), mn, mx);
  gl_FragColor = mix(hist, cur, blend);
}
`;

// 探针：算飞机位置和前方几百米的云密度，异步读回给 CPU（判断是否在云里：窗上起水痕、颠簸）
const PROBE_FRAG = /* glsl */ `
${ATMOSPHERE_COMMON}
${CLOUD_COMMON}
uniform float uCamR;
uniform vec3 uProbeDir;   // 航向（窗外坐标）
varying vec2 vUv;
void main() {
  vec3 p0 = vec3(0.0, uCamR, 0.0);
  float d = 0.0;
  for (int k = 0; k < 4; k++) d += cloudDensityLite(p0 + uProbeDir * (float(k) * 0.12), 1.0, false);
  gl_FragColor = vec4(d * 0.25, 0.0, 0.0, 1.0);
}
`;

export interface CloudPreset {
  id: string;
  name: string;
  bottom: number;
  top: number;
  coverage: number;
  type: number;
  density: number;
}

export const CLOUD_PRESETS: CloudPreset[] = [
  { id: "cumulus", name: "晴天积云", bottom: 1.2, top: 3.4, coverage: 0.42, type: 1, density: 1 },
  { id: "stratocumulus", name: "层积云云海", bottom: 1.0, top: 2.2, coverage: 0.78, type: 0.2, density: 0.8 },
  { id: "towering", name: "浓积云（午后对流）", bottom: 1.4, top: 6.5, coverage: 0.35, type: 1, density: 1.2 },
  { id: "altocumulus", name: "高积云（中层，4.5–6 km）", bottom: 4.5, top: 6.0, coverage: 0.6, type: 0.45, density: 0.7 },
  { id: "deck-below", name: "云海贴着航路（云顶 9.8 km）", bottom: 8.0, top: 9.8, coverage: 0.85, type: 0.25, density: 0.8 },
  { id: "cirrus", name: "卷云（航路上方 11.5–12.5 km）", bottom: 11.5, top: 12.5, coverage: 0.4, type: 0.0, density: 0.12 },
  { id: "clear", name: "无云", bottom: 1.2, top: 3.4, coverage: 0, type: 1, density: 1 },
];

/** 云场参数。场景着色器（海面云影）和云着色器共用同一组 uniform 对象 */
export function createCloudUniforms(noise: CloudNoise) {
  return {
    uShapeNoise: { value: noise.shape },
    uDetailNoise: { value: noise.detail },
    uWeather: { value: noise.weather },
    uCloudOffset: { value: new THREE.Vector2() },
    uCloudBottom: { value: 1.2 },
    uCloudTop: { value: 3.4 },
    uCoverage: { value: 0.42 },
    uCloudType: { value: 1 },
    uCloudDensity: { value: 1 },
    uShellBottom: { value: 1.2 },
    uShellTop: { value: 3.4 },
    uStormCount: { value: 0 },
    uStorms: { value: [0, 1, 2, 3].map(() => new THREE.Vector4()) },
    uUpperWind: { value: new THREE.Vector2(0.8, 0.6) },
    uHurricane: { value: new THREE.Vector4(0, 0, 20, 0) },
    uFlash: { value: new THREE.Vector4() },
    uFlashB: { value: new THREE.Vector3() },
  };
}
export type CloudUniforms = ReturnType<typeof createCloudUniforms>;

function target(w: number, h: number, count = 1) {
  return new THREE.WebGLRenderTarget(w, h, {
    count,
    type: THREE.HalfFloatType,
    format: THREE.RGBAFormat,
    minFilter: THREE.LinearFilter,
    magFilter: THREE.LinearFilter,
    depthBuffer: false,
  });
}

export class Clouds {
  private raw = target(1, 1, 2);
  private history = [target(1, 1), target(1, 1)];
  private frame = 0;
  /** 云的渲染分辨率相对全屏的比例 */
  resolutionScale = 1;
  private reset = true;
  private readonly prevCamBasis = new THREE.Matrix3();
  private readonly prevCabinToWorld = new THREE.Matrix3();

  private readonly marchMat: THREE.ShaderMaterial;
  private readonly probeMat: THREE.ShaderMaterial;
  private readonly probeTarget = new THREE.WebGLRenderTarget(1, 1, { type: THREE.FloatType, depthBuffer: false });
  private readonly probePixel = new Float32Array(4);
  private probeBusy = false;
  /** 飞机所在位置的云密度（0..1，几帧前的值） */
  cameraDensity = 0;
  private readonly resolveMat: THREE.ShaderMaterial;

  constructor(
    private readonly pass: FullscreenPass,
    atmosphere: Atmosphere,
    readonly uniforms: CloudUniforms,
    /** 场景着色器的 uniform（视角、太阳等），直接共享同一批对象 */
    viewUniforms: Record<string, THREE.IUniform>,
  ) {
    const common = { depthTest: false, depthWrite: false, toneMapped: false, vertexShader: FULLSCREEN_VERT };
    this.marchMat = new THREE.ShaderMaterial({
      ...common,
      fragmentShader: MARCH_FRAG,
      uniforms: {
        ...atmosphere.sharedUniforms,
        ...viewUniforms,
        ...this.uniforms,
        uAerialInscatter: { value: atmosphere.aerialInscatter.texture },
        uAerialTransmittance: { value: atmosphere.aerialTransmittance.texture },
        uFrame: { value: 0 },
        uCloudResolution: { value: new THREE.Vector2(1, 1) },
      },
    });
    this.probeMat = new THREE.ShaderMaterial({
      ...common,
      fragmentShader: PROBE_FRAG,
      uniforms: { ...viewUniforms, ...this.uniforms, uProbeDir: { value: new THREE.Vector3(1, 0, 0) } },
    });
    this.resolveMat = new THREE.ShaderMaterial({
      ...common,
      fragmentShader: RESOLVE_FRAG,
      uniforms: {
        ...viewUniforms,
        uCurrent: { value: null },
        uCurrentDepth: { value: null },
        uHistory: { value: null },
        uPrevCamBasis: { value: this.prevCamBasis },
        uPrevCabinToWorld: { value: this.prevCabinToWorld },
        uMotion: { value: new THREE.Vector3() },
        uReset: { value: true },
        uCloudResolution: this.marchMat.uniforms.uCloudResolution,
      },
    });
  }

  /** 每几帧调用一次：在 GPU 上算飞机位置的云密度，异步读回（不阻塞渲染） */
  probe(renderer: THREE.WebGLRenderer, heading: THREE.Vector3) {
    if (this.probeBusy) return;
    this.probeMat.uniforms.uProbeDir.value.copy(heading);
    this.pass.render(this.probeMat, this.probeTarget);
    this.probeBusy = true;
    renderer
      .readRenderTargetPixelsAsync(this.probeTarget, 0, 0, 1, 1, this.probePixel)
      .then(() => (this.cameraDensity = this.probePixel[0]))
      .finally(() => (this.probeBusy = false));
  }

  get texture() {
    return this.history[0].texture;
  }

  applyPreset(p: CloudPreset) {
    const u = this.uniforms;
    u.uCloudBottom.value = p.bottom;
    u.uCloudTop.value = p.top;
    u.uCoverage.value = p.coverage;
    u.uCloudType.value = p.type;
    u.uCloudDensity.value = p.density;
    this.snap();
  }

  snap() {
    this.reset = true;
  }

  setSize(fullWidth: number, fullHeight: number) {
    // 降分辨率步进，时间累积补回细节
    const w = Math.max(1, Math.round(fullWidth * this.resolutionScale));
    const h = Math.max(1, Math.round(fullHeight * this.resolutionScale));
    this.raw.setSize(w, h);
    for (const t of this.history) t.setSize(w, h);
    this.marchMat.uniforms.uCloudResolution.value.set(w, h);
    this.reset = true;
  }

  /**
   * motion：上一帧到这一帧，云相对相机的位移反过来（km，窗外坐标）。飞机向前飞，云向后退，
   * 所以同一朵云上一帧在「现在的位置 + 飞机位移」。
   */
  render(motion: THREE.Vector3, camBasis: THREE.Matrix3, cabinToWorld: THREE.Matrix3) {
    this.marchMat.uniforms.uFrame.value = this.frame++ % 64;
    this.pass.render(this.marchMat, this.raw);

    const [prev, next] = this.history;
    const r = this.resolveMat.uniforms;
    r.uCurrent.value = this.raw.textures[0];
    r.uCurrentDepth.value = this.raw.textures[1];
    r.uHistory.value = prev.texture;
    r.uMotion.value.copy(motion);
    r.uReset.value = this.reset;
    this.pass.render(this.resolveMat, next);
    this.history = [next, prev];
    this.reset = false;
    this.prevCamBasis.copy(camBasis);
    this.prevCabinToWorld.copy(cabinToWorld);
  }
}
