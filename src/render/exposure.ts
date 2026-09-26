import * as THREE from "three";
import { FULLSCREEN_VERT } from "../atmosphere/common.glsl";
import { Bloom } from "./bloom";
import type { FullscreenPass } from "./pass";

/**
 * 人眼式自动曝光：
 * 1. 测光：在 HDR 图上取 32×32 个点（HDR 的 alpha 是窗外遮罩）。
 *    窗外：中心加权的对数平均亮度（视线落在窗上）。
 *    舱内：按面积平均的对数亮度（舱内在余光里，周边视网膜适应的是它看到的整片舱壁，不是窗洞内衬上那一小块光斑）。
 * 2. 适应：在对数域里向测光值靠拢，变亮时快、变暗时慢，和人眼的明暗适应一致。
 * 3. 双区曝光（T23，「人眼式」，公式与理由见 Exposure 类上方的注释）：
 *    窗外永远按窗外的亮度曝光（和改前一致）；舱内的曝光由窗外的曝光出发，
 *    按绝对亮度决定能独立适应多少，并且不许比窗外还亮。因为遮罩是解析算出来的，交界处没有光晕。
 * 4. 输出：曝光 × HDR → 浦肯野 → AgX 色调映射 → sRGB，最后加抖动避免天空渐变出现色带。
 */

const METER_FRAG = /* glsl */ `
uniform sampler2D uHdr;
varying vec2 vUv;
void main() {
  const float N = 32.0;
  vec3 sum = vec3(0.0);   // 窗外（中心加权）、舱内（中心加权，旧口径，仅作对照）、舱内（按面积）
  vec3 wsum = vec3(0.0);
  for (float i = 0.0; i < N; i += 1.0) {
    for (float j = 0.0; j < N; j += 1.0) {
      vec2 uv = (vec2(i, j) + 0.5) / N;
      vec2 d = uv - 0.5;
      float w = exp(-dot(d, d) / 0.045);
      vec4 c = texture(uHdr, uv);
      float l = log2(max(dot(c.rgb, vec3(0.2126, 0.7152, 0.0722)), 1e-7));
      vec3 ww = vec3(w * c.a, w * (1.0 - c.a), 1.0 - c.a);
      sum += ww * l;
      wsum += ww;
    }
  }
  vec3 avg = sum / max(wsum, vec3(1e-6));
  // 窗外几乎看不到（遮光板拉下）时，窗外那一路跟随舱内，反之亦然
  if (wsum.x < 1e-3) avg.x = avg.z;
  if (wsum.z < 1e-3) avg.yz = avg.xx;
  gl_FragColor = vec4(avg, 0.0);
}
`;

const ADAPT_FRAG = /* glsl */ `
uniform sampler2D uPrev;
uniform sampler2D uMeter;
uniform float uDt;
uniform bool uReset;
varying vec2 vUv;
void main() {
  vec3 target = texture(uMeter, vec2(0.5)).rgb;
  vec3 prev = texture(uPrev, vec2(0.5)).rgb;
  // 适应速度（1/秒）：亮适应约 0.5 s，暗适应这里取 2.5 s（真实的完全暗适应要几十分钟，不照搬）
  vec3 rate = mix(vec3(0.4), vec3(2.0), step(prev, target));
  vec3 next = uReset ? target : prev + (target - prev) * (1.0 - exp(-uDt * rate));
  gl_FragColor = vec4(next, 0.0);
}
`;

const FINAL_FRAG = /* glsl */ `
uniform sampler2D uHdr;
uniform sampler2D uAdapted;
uniform bool uAuto;
uniform float uManualEv;
uniform float uEvComp;
uniform sampler2D uBloom;
uniform float uBloomLevels;
uniform float uGlare;       // 被眼睛和窗板散射到周围的能量比例
uniform bool uDebugMask;    // 调试：输出窗外遮罩
uniform bool uLegacy;       // 调试：改前的公式（β = 0.5），A/B 对照用
uniform vec2 uCabinBeta;    // 舱内局部适应比例：x = 暗处（中间视 / 暗视），y = 白天（明视）
uniform vec2 uCabinCapEv;   // 舱内均值的显示亮度相对窗外均值的上限（EV）：x = 暗处，y = 白天
uniform float uCabinWhiteEv;// 白天舱内的明度恒常补偿（EV）
uniform float uCabinMaxBoostEv; // 舱内曝光最多比窗外高多少 EV（局部适应的幅度上限）
uniform vec2 uPhotopicRange;// 「白天」判定：窗外适应亮度的 log10(cd/m²) 区间
#include <common>
#include <dithering_pars_fragment>
varying vec2 vUv;

// 目标中灰：亮度低于 100 cd/m² 后逐渐降低（暗处人眼看到的整体更暗；经验近似）
float exposureKey(float logCd10) { return 0.18 * clamp((logCd10 + 2.0) / 4.0, 0.12, 1.0); }

void main() {
  vec4 src = texture(uHdr, vUv);
  float logExposure;  // log2 曝光（HDR 单位 kcd/m²）
  float logAdapt;     // 这个像素的适应亮度，log2 kcd/m²（浦肯野用）
  if (uAuto) {
    vec3 adapted = texture(uAdapted, vec2(0.5)).rgb; // log2 亮度（kcd/m²）：窗外、舱内（中心加权）、舱内（按面积）
    const float L2_10 = 0.30103;                     // log10(2)
    const float LOG2_1000 = 9.965784;                // kcd → cd
    float o = adapted.x;
    // 窗外：按窗外自身的适应亮度曝光（和改前一致）
    float keyO = exposureKey((o + LOG2_1000) * L2_10);
    float eO = log2(keyO) - o;
    float eC, aC;
    if (uLegacy) {
      aC = mix(o, adapted.y, 0.5);
      eC = log2(exposureKey((aC + LOG2_1000) * L2_10)) - aC;
    } else {
      float c = adapted.z;
      // 白天程度：窗外适应亮度从 uPhotopicRange.x 到 .y（log10 cd/m²）之间由 0 过渡到 1
      float day = smoothstep(uPhotopicRange.x, uPhotopicRange.y, (o + LOG2_1000) * L2_10);
      // ① 局部适应：舱内的适应亮度从窗外出发，向舱内自身的亮度靠拢一部分；明视时周边视网膜能独立适应得更多
      float beta = mix(uCabinBeta.x, uCabinBeta.y, day);
      aC = o + beta * (c - o);
      eC = log2(exposureKey((aC + LOG2_1000) * L2_10)) - aC;
      // ② 明度恒常：白天舱内大多是浅色饰面，人眼把它看成「白墙在阴影里」而不是中灰，所以舱内的中灰锚点上调
      eC += uCabinWhiteEv * day;
      // ③ 上限：舱内均值在屏幕上的亮度不超过窗外均值 + cap（暗处 cap < 0：舱内一定比窗外暗）
      //    舱内均值的显示亮度 = eC + c，窗外均值 = eO + o
      float cap = mix(uCabinCapEv.x, uCabinCapEv.y, day);
      eC = min(eC, eO + o - c + cap);
      // ④ 局部适应的幅度有限：余光里的舱内最多比注视的窗外多提亮 uCabinMaxBoostEv 档
      eC = min(eC, eO + uCabinMaxBoostEv);
      aC = log2(exposureKey((aC + LOG2_1000) * L2_10)) - eC; // 等效适应亮度（浦肯野用），与曝光一致
    }
    logExposure = mix(eC, eO, src.a);
    logAdapt = mix(aC, o, src.a);
  } else {
    // EV100 曝光：H = L(cd/m²) / (1.2 · 2^EV)
    logExposure = log2(1000.0 / (1.2 * exp2(uManualEv)));
    logAdapt = 0.0;
  }
  float exposure = exp2(logExposure + uEvComp);
  vec3 hdr = src.rgb;
  vec3 glare = texture(uBloom, vUv).rgb / uBloomLevels;
  vec3 c = mix(hdr, glare, uGlare);
  // 浦肯野效应：暗处视杆细胞接管，看不出颜色、对蓝绿光敏感（峰值 507 nm），月夜因此是银蓝色的。
  // 按这个像素的适应亮度在明视觉（> 3 cd/m²）和暗视觉（< 0.01 cd/m²）之间过渡（经验近似，参考 Jensen 2000）
  if (uAuto) {
    float cdAdapt = exp2(logAdapt) * 1000.0;
    float scotopic = 1.0 - smoothstep(-2.0, 0.5, log(max(cdAdapt, 1e-6)) / log(10.0));
    // 像素本身够亮（夜里的灯）就能刺激视锥细胞，保留颜色
    float cdPixel = dot(c, vec3(0.2126, 0.7152, 0.0722)) * 1000.0;
    scotopic *= 1.0 - smoothstep(-2.0, 0.0, log(max(cdPixel, 1e-6)) / log(10.0));
    float rod = dot(c, vec3(0.05, 0.62, 0.33));
    c = mix(c, rod * vec3(0.66, 0.82, 1.0), scotopic * 0.8);
  }
  gl_FragColor = vec4(c * exposure, 1.0);
  if (uDebugMask) { gl_FragColor = vec4(vec3(src.a), 1.0); return; }
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
  #include <dithering_fragment>
}
`;

function tinyTarget() {
  return new THREE.WebGLRenderTarget(1, 1, {
    type: THREE.FloatType,
    format: THREE.RGBAFormat,
    minFilter: THREE.NearestFilter,
    magFilter: THREE.NearestFilter,
    depthBuffer: false,
  });
}

function material(fragmentShader: string, uniforms: Record<string, THREE.IUniform>, final = false) {
  return new THREE.ShaderMaterial({
    vertexShader: FULLSCREEN_VERT,
    fragmentShader,
    uniforms,
    depthTest: false,
    depthWrite: false,
    toneMapped: final,
    dithering: final,
  });
}

export class Exposure {
  private readonly meter = tinyTarget();
  private adapted = [tinyTarget(), tinyTarget()];
  private reset = true;

  private readonly meterMat = material(METER_FRAG, { uHdr: { value: null } });
  private readonly adaptMat = material(ADAPT_FRAG, {
    uPrev: { value: null },
    uMeter: { value: this.meter.texture },
    uDt: { value: 0 },
    uReset: { value: true },
  });
  readonly finalMat = material(
    FINAL_FRAG,
    {
      uHdr: { value: null },
      uAdapted: { value: null },
      uAuto: { value: true },
      uManualEv: { value: 14 },
      uEvComp: { value: 0 },
      uBloom: { value: null },
      uBloomLevels: { value: Bloom.WEIGHT_SUM },
      uGlare: { value: 0.04 },
      uDebugMask: { value: false },
      uLegacy: { value: false },
      uCabinBeta: { value: new THREE.Vector2(0.3, 0.8) },
      uCabinCapEv: { value: new THREE.Vector2(-0.75, 2.0) },
      uCabinWhiteEv: { value: 2.2 },
      uCabinMaxBoostEv: { value: 4.0 },
      uPhotopicRange: { value: new THREE.Vector2(1.5, 3.0) },
    },
    true,
  );

  constructor(private readonly pass: FullscreenPass) {}

  /** 跳变（换地点、拖时间）后让眼睛直接适应到新亮度 */
  snap() {
    this.reset = true;
  }

  render(hdr: THREE.Texture, bloom: THREE.Texture, dt: number) {
    this.finalMat.uniforms.uBloom.value = bloom;
    this.meterMat.uniforms.uHdr.value = hdr;
    this.pass.render(this.meterMat, this.meter);

    const [prev, next] = this.adapted;
    this.adaptMat.uniforms.uPrev.value = prev.texture;
    this.adaptMat.uniforms.uDt.value = dt;
    this.adaptMat.uniforms.uReset.value = this.reset;
    this.pass.render(this.adaptMat, next);
    this.adapted = [next, prev];
    this.reset = false;

    this.finalMat.uniforms.uHdr.value = hdr;
    this.finalMat.uniforms.uAdapted.value = next.texture;
    this.pass.render(this.finalMat, null);
  }
}
