import * as THREE from "three";
import { FULLSCREEN_VERT } from "../atmosphere/common.glsl";
import { Bloom } from "./bloom";
import type { FullscreenPass } from "./pass";

/**
 * 人眼式自动曝光：
 * 1. 测光：在 HDR 图上取 32×32 个点，窗外和舱内分开求中心加权的对数平均亮度（HDR 的 alpha 是窗外遮罩）
 * 2. 适应：在对数域里向测光值靠拢，变亮时快、变暗时慢，和人眼的明暗适应一致
 * 3. 局部适应：窗外按窗外的亮度曝光；舱内只「部分」适应到舱内亮度（β = 0.5，档位差减半）。
 *    人眼看窗外时，余光里的舱内也看得清，但不会和窗外一样亮。因为遮罩是解析算出来的，交界处没有光晕。
 * 4. 输出：曝光 × HDR → AgX 色调映射 → sRGB，最后加抖动避免天空渐变出现色带
 */

const METER_FRAG = /* glsl */ `
uniform sampler2D uHdr;
varying vec2 vUv;
void main() {
  const float N = 32.0;
  vec2 sum = vec2(0.0);   // 窗外、舱内
  vec2 wsum = vec2(0.0);
  for (float i = 0.0; i < N; i += 1.0) {
    for (float j = 0.0; j < N; j += 1.0) {
      vec2 uv = (vec2(i, j) + 0.5) / N;
      vec2 d = uv - 0.5;
      float w = exp(-dot(d, d) / 0.045);
      vec4 c = texture(uHdr, uv);
      float l = log2(max(dot(c.rgb, vec3(0.2126, 0.7152, 0.0722)), 1e-7));
      vec2 ww = w * vec2(c.a, 1.0 - c.a);
      sum += ww * l;
      wsum += ww;
    }
  }
  vec2 avg = sum / max(wsum, vec2(1e-6));
  // 窗外几乎看不到（遮光板拉下）时，窗外那一路跟随舱内，反之亦然
  if (wsum.x < 1e-3) avg.x = avg.y;
  if (wsum.y < 1e-3) avg.y = avg.x;
  gl_FragColor = vec4(avg, 0.0, 1.0);
}
`;

const ADAPT_FRAG = /* glsl */ `
uniform sampler2D uPrev;
uniform sampler2D uMeter;
uniform float uDt;
uniform bool uReset;
varying vec2 vUv;
void main() {
  vec2 target = texture(uMeter, vec2(0.5)).rg;
  vec2 prev = texture(uPrev, vec2(0.5)).rg;
  // 适应速度（1/秒）：亮适应约 0.5 s，暗适应这里取 2.5 s（真实的完全暗适应要几十分钟，不照搬）
  vec2 rate = mix(vec2(0.4), vec2(2.0), step(prev, target));
  vec2 next = uReset ? target : prev + (target - prev) * (1.0 - exp(-uDt * rate));
  gl_FragColor = vec4(next, 0.0, 1.0);
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
uniform bool uDebugMask;      // 调试：输出窗外遮罩
uniform float uCabinAdaptation; // 舱内向自身亮度适应的程度，0 = 跟窗外一样曝光，1 = 完全按舱内曝光
#include <common>
#include <dithering_pars_fragment>
varying vec2 vUv;
void main() {
  vec4 src = texture(uHdr, vUv);
  float exposure;
  if (uAuto) {
    vec2 adapted = texture(uAdapted, vec2(0.5)).rg; // log2 亮度：窗外、舱内
    // 舱内只部分适应：在对数域里取窗外和舱内的中点（β = 0.5）
    float logCabin = mix(adapted.x, adapted.y, uCabinAdaptation);
    float logL = mix(logCabin, adapted.x, src.a);
    // 场景单位是 kcd/m²，换算到 cd/m²
    float cd = max(exp2(logL) * 1000.0, 1e-3);
    // 暗处人眼看到的整体更暗：亮度低于 100 cd/m² 后逐渐降低目标中灰（经验近似）
    float key = 0.18 * clamp((log(cd) / log(10.0) + 2.0) / 4.0, 0.12, 1.0);
    exposure = key / (cd / 1000.0);
  } else {
    // EV100 曝光：H = L(cd/m²) / (1.2 · 2^EV)
    exposure = 1000.0 / (1.2 * exp2(uManualEv));
  }
  exposure *= exp2(uEvComp);
  vec3 hdr = src.rgb;
  vec3 glare = texture(uBloom, vUv).rgb / uBloomLevels;
  vec3 c = mix(hdr, glare, uGlare);
  // 浦肯野效应：暗处视杆细胞接管，看不出颜色、对蓝绿光敏感（峰值 507 nm），月夜因此是银蓝色的。
  // 按这个像素的适应亮度在明视觉（> 3 cd/m²）和暗视觉（< 0.01 cd/m²）之间过渡（经验近似，参考 Jensen 2000）
  if (uAuto) {
    vec2 adapted = texture(uAdapted, vec2(0.5)).rg;
    float logAdapt = mix(mix(adapted.x, adapted.y, uCabinAdaptation), adapted.x, src.a);
    float cdAdapt = exp2(logAdapt) * 1000.0;
    float scotopic = 1.0 - smoothstep(-2.0, 0.5, log(max(cdAdapt, 1e-6)) / log(10.0));
    // 像素本身够亮（夜里的灯）就能刺激视锥细胞，保留颜色
    float cdPixel = dot(c, vec3(0.2126, 0.7152, 0.0722)) * 1000.0;
    scotopic *= 1.0 - smoothstep(-2.0, 0.0, log(max(cdPixel, 1e-6)) / log(10.0));
    float rod = dot(c, vec3(0.05, 0.62, 0.33));
    c = mix(c, rod * vec3(0.66, 0.82, 1.0), scotopic * 0.8);
  }
  gl_FragColor = vec4(c * exposure, 1.0);
  // 调试：直接输出窗外遮罩（统计脚本用它区分窗外 / 舱内像素），不走色调映射
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
      uCabinAdaptation: { value: 0.5 },
      uDebugMask: { value: false },
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
