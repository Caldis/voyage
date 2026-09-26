import * as THREE from "three";
import { FULLSCREEN_VERT } from "../atmosphere/common.glsl";
import { Bloom } from "./bloom";
import type { FullscreenPass } from "./pass";

/**
 * 人眼式自动曝光：
 * 1. 测光：在 HDR 图上取 32×32 个点（HDR 的 alpha 是窗外遮罩）。
 *    窗外：中心加权的对数平均亮度（视线落在窗上），另记线性平均（判断视野是否均匀）。
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
  vec2 sum = vec2(0.0);   // 窗外（中心加权）、舱内（按面积）
  vec2 wsum = vec2(0.0);
  float linSum = 0.0;     // 窗外的线性平均亮度（中心加权）：比对数平均更偏向亮处，用来估计窗外高光有多亮
  for (float i = 0.0; i < N; i += 1.0) {
    for (float j = 0.0; j < N; j += 1.0) {
      vec2 uv = (vec2(i, j) + 0.5) / N;
      vec2 d = uv - 0.5;
      float w = exp(-dot(d, d) / 0.045);
      vec4 c = texture(uHdr, uv);
      float l = log2(max(dot(c.rgb, vec3(0.2126, 0.7152, 0.0722)), 1e-7));
      vec2 ww = vec2(w * c.a, 1.0 - c.a);
      sum += ww * l;
      wsum += ww;
      linSum += ww.x * min(exp2(l), 1e3);
    }
  }
  vec2 avg = sum / max(wsum, vec2(1e-6));
  float hi = max(log2(max(linSum / max(wsum.x, 1e-6), 1e-7)), avg.x);
  // 舱内看不到（极端视角）时跟随窗外
  if (wsum.y < 1e-3) avg.y = avg.x;
  // 窗外看不到（遮光板全放下）时，给窗外一个「虚拟」适应亮度作绝对锚点，不能直接取舱内自身的亮度，
  // 否则舱内按自己完全适应，关灯的夜里拉下遮光板反而比开着窗亮。
  // 锚点：白天（舱内 > 约 300 cd/m²）就是舱内亮度；越暗越低于舱内，暗处低 2.2 档（关灯夜里实测窗外比舱内低约 2.7 档，取略小的值，舱壁落在屏幕 Y 25 左右）。
  // 按可见的窗外权重混合，遮光板拉到最后一条缝时连续过渡，不跳。
  float cLog10 = (avg.y + 9.965784) * 0.30103;
  float anchor = avg.y - 2.2 * (1.0 - smoothstep(1.0, 2.5, cLog10));
  float vis = smoothstep(0.0, 2.0, wsum.x);   // 中心加权的权重总和约 140，2 相当于窗只剩一条缝
  avg.x = mix(anchor, avg.x, vis);
  hi = mix(avg.x, hi, vis);
  gl_FragColor = vec4(avg, hi, 0.0);
}
`;

const ADAPT_FRAG = /* glsl */ `
uniform sampler2D uPrev;
uniform sampler2D uMeter;
uniform float uDt;
uniform bool uReset;
varying vec2 vUv;
void main() {
  vec4 target = texture(uMeter, vec2(0.5));
  vec4 prev = texture(uPrev, vec2(0.5));
  // 适应速度（1/秒）：亮适应约 0.5 s，暗适应这里取 2.5 s（真实的完全暗适应要几十分钟，不照搬）
  vec4 rate = mix(vec4(0.4), vec4(2.0), step(prev, target));
  vec4 next = uReset ? target : prev + (target - prev) * (1.0 - exp(-uDt * rate));
  gl_FragColor = next;
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
uniform vec2 uCabinBeta;    // 舱内局部适应比例：x = 暗处（中间视 / 暗视），y = 白天（明视）
uniform vec2 uCabinCapEv;   // 舱内均值的显示亮度相对窗外均值的上限（EV）：x = 暗处，y = 白天
uniform float uCabinWhiteEv;// 白天舱内的明度恒常补偿（EV）
uniform float uCabinMaxBoostEv; // 舱内曝光最多比窗外高多少 EV（局部适应的幅度上限）
uniform float uCabinHiMarginEv; // 舱内均值的显示亮度最多比窗外高光（线性平均）高多少 EV
uniform float uSnowEv;      // 窗外是均匀而明亮的视野（云中、雪原）时，窗外目标中灰上调的档位
uniform vec2 uUniformRange; // 「均匀视野」判据：窗外线性均值与对数均值之差（log2）在此区间内由 1 过渡到 0
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
    vec4 adapted = texture(uAdapted, vec2(0.5)); // log2 亮度（kcd/m²）：窗外（对数均值）、舱内（按面积）、窗外（线性均值）
    const float L2_10 = 0.30103;                     // log10(2)
    const float LOG2_1000 = 9.965784;                // kcd → cd
    float o = adapted.x;
    float c = adapted.y;
    float h = adapted.z;
    // 白天程度：窗外适应亮度从 uPhotopicRange.x 到 .y（log10 cd/m²）之间由 0 过渡到 1
    float day = smoothstep(uPhotopicRange.x, uPhotopicRange.y, (o + LOG2_1000) * L2_10);
    // 窗外：按窗外自身的适应亮度曝光
    float eO = log2(exposureKey((o + LOG2_1000) * L2_10)) - o;
    // ① 局部适应：舱内的适应亮度从窗外出发，向舱内自身的亮度靠拢一部分；明视时周边视网膜能独立适应得更多
    float beta = mix(uCabinBeta.x, uCabinBeta.y, day);
    float aC = o + beta * (c - o);
    float eC = log2(exposureKey((aC + LOG2_1000) * L2_10)) - aC;
    // ② 明度恒常：白天舱内大多是浅色饰面，人眼把它看成「白墙在阴影里」而不是中灰，所以舱内的中灰锚点上调
    eC += uCabinWhiteEv * day;
    // ③ 上限：舱内均值在屏幕上的亮度不超过窗外均值 + cap（暗处 cap < 0：舱内一定比窗外暗）
    //    舱内均值的显示亮度 = eC + c，窗外均值 = eO + o；窗外是一片均匀的雾时（h ≈ o）收紧
    float cap = min(mix(uCabinCapEv.x, uCabinCapEv.y, day), h - o + uCabinHiMarginEv);
    eC = min(eC, eO + o - c + cap);
    // ④ 局部适应的幅度有限：余光里的舱内最多比注视的窗外多提亮 uCabinMaxBoostEv 档
    eC = min(eC, eO + uCabinMaxBoostEv);
    aC = log2(exposureKey((aC + LOG2_1000) * L2_10)) - eC; // 等效适应亮度（浦肯野用），与曝光一致
    // ⑤ 雪景补偿（只作用于窗外，放在舱内的约束之后，不连带抬亮舱内）：白天窗外是均匀而明亮的视野
    //    （云中白茫茫一片）时，测光会把它压成中灰；人眼看到的是白，窗应当是画面最亮处。
    //    判据：线性均值与对数均值几乎相等 ⇔ 视野里没有明暗起伏（有天空 / 海 / 云影的画面差 ≥ 0.15 档）
    float uniformField = day * (1.0 - smoothstep(uUniformRange.x, uUniformRange.y, h - o));
    eO += uSnowEv * uniformField;
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

/**
 * 双区曝光的公式（T23，用户定「人眼式」）。记号：o = 窗外适应亮度、c = 舱内适应亮度（按面积）、
 * h = 窗外线性平均亮度（都是 log2），key(L) = 目标中灰（暗处更低），曝光 e = log2(key / L)。
 *   窗外：eO = log2 key(o) − o                                       （和改前一致，窗外观感不变）
 *   白天程度 day = smoothstep(1.5, 3.0, log10 o[cd/m²])              （约 30 → 1000 cd/m²，中间视 → 明视）
 *   ① 局部适应：aC = o + β·(c − o)，β = mix(0.3, 0.8, day)，eC = log2 key(aC) − aC
 *      明视时周边视网膜能独立适应得多（白天余光里的舱内看得清）；暗处视杆主导、适应是全局的，舱内只能跟着窗外。
 *   ② 明度恒常：eC += 2.2·day。测光把均值压成 18% 中灰，但舱内大多是浅色饰面（反照率 0.6–0.8），
 *      白天人眼看到的是「阴影里的白墙」，所以舱内锚点上调约 2 档；暗处明度恒常失效，不补。
 *   ③ 不许反超：舱内均值的显示亮度 ≤ 窗外均值 + cap，cap = min(mix(−0.75, 2.0, day), h − o + 1.4)。
 *      暗处 cap < 0：舱内一定比窗外暗（关灯的夜里舱壁 ≈ 屏幕 Y 30，窗外的城市灯 / 月光是最亮的）；
 *      白天放宽到 +2 档（窗外的对数均值被深蓝天空拉低，白墙本来就比蓝天「亮」），
 *      但窗外是一片均匀的雾（云中、h ≈ o）或遮光板全放下时收紧到 +1.4 档。
 *   ④ 幅度上限：eC ≤ eO + 4.5（局部适应最多把余光里的舱内提亮 4.5 档；日落逆光时舱内因此比正午暗）。
 *   ⑤ 雪景补偿（只加在窗外，舱内的约束用补偿前的 eO）：eO += 2.0·day·(1 − smoothstep(0.05, 0.12, h − o))。
 *      均匀而明亮的视野（云中白茫茫一片）被测光压成中灰，人眼看到的却是白；h − o 是线性均值与对数均值之差，
 *      只有视野里几乎没有明暗起伏时才接近 0（实测云中 0.035 档；其他白天回归场景 0.15–2.2 档，判据为 0）。
 *   窗外看不到（遮光板全放下）时 o 取绝对锚点：o = c − 2.2·(1 − smoothstep(1.0, 2.5, log10 c[cd/m²]))，
 *      白天等于舱内亮度，暗处比舱内低 2.2 档（关灯夜里实测窗外比舱内低约 2.7 档），按窗外可见权重连续混合。
 * 各项都是 min / smoothstep 的组合，对 o、c、h 连续；o、c、h 本身经过时间适应，所以不会闪。
 * 参数的来源：六个场景的统计（apps/voyage/scripts/cabin-luminance.playwright.js + cabin_luminance.py），
 * 目标是用户给的屏幕亮度（白天舱壁 150–185、关灯夜里 25–45、窗最亮）。这是经验模型，不是视觉科学的定量结果。
 * 调试：finalMat.uniforms.uDebugMask = true 输出窗外遮罩。
 */
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
      uCabinBeta: { value: new THREE.Vector2(0.3, 0.8) },
      uCabinCapEv: { value: new THREE.Vector2(-0.75, 2.0) },
      uCabinWhiteEv: { value: 2.2 },
      uCabinMaxBoostEv: { value: 4.5 },
      uCabinHiMarginEv: { value: 1.4 },
      uSnowEv: { value: 2.0 },
      uUniformRange: { value: new THREE.Vector2(0.05, 0.12) },
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
