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
 *    T28：舱内再做部分色适应（von Kries / CAT02）；舱灯开、窗外暗时舱内成为主导适应区。
 * 4. 输出：曝光 × HDR → 舱内色适应 → 浦肯野（T48：窗外高饱和、够亮的发光体只保色度）→ AgX 色调映射
 *    （T48：夜里窗外高饱和像素做色度保持）→ sRGB，最后加抖动避免天空渐变出现色带。
 */

// 测光目标是 2×1：左像素是亮度（本段），右像素是色度（CHROMA_METER，T28）
const METER_FRAG = /* glsl */ `
uniform sampler2D uHdr;
uniform sampler2D uPrevAdapted; // 上一帧的适应结果（色度测光排除高光用）
uniform bool uReset;            // 跳变后的第一帧：上一帧的适应结果不可信，不排除高光
varying vec2 vUv;

// T28 色度测光：舱内（按面积）、窗外（中心加权）各自的「白点」，取各通道的对数均值（几何平均，天然不被高光带跑），
// 另外把比本区对数均值亮 2 档以上的样本（窗洞内衬上的阳光光斑、窗外的太阳 / 耀斑）逐渐排除。
// 输出 log2(R/G)、log2(B/G)：舱内在 xy，窗外在 zw。
vec4 chromaMeter() {
  // 16×16 就够（色度是低频量）。高光判据用上一帧已适应的亮度（窗外 / 舱内的对数均值），省掉一遍求均值的循环：
  // 这个 pass 只有两个像素，耗时就是单线程的串行采样链，多一遍 256 次采样实测就多 0.03 ms
  const float N = 16.0;
  vec2 avg = texture(uPrevAdapted, vec2(0.25, 0.5)).xy;
  vec3 lo = vec3(0.0), lc = vec3(0.0);
  vec2 cw = vec2(0.0);
  for (float i = 0.0; i < N; i += 1.0) {
    for (float j = 0.0; j < N; j += 1.0) {
      vec2 uv = (vec2(i, j) + 0.5) / N;
      vec2 d = uv - 0.5;
      vec4 c = texture(uHdr, uv);
      float y = max(dot(c.rgb, vec3(0.2126, 0.7152, 0.0722)), 1e-7);
      float l = log2(y);
      // 排除高光；近黑的样本色度不可靠，权重也降下来
      vec2 keep = uReset ? vec2(1.0) : (1.0 - smoothstep(vec2(2.0), vec2(4.0), l - avg)) * smoothstep(vec2(-6.0), vec2(-3.0), l - avg);
      vec2 ww = vec2(exp(-dot(d, d) / 0.045) * c.a, 1.0 - c.a) * keep;
      vec3 lg = log2(max(c.rgb, vec3(y * 0.01)));
      lo += ww.x * lg;
      lc += ww.y * lg;
      cw += ww;
    }
  }
  lo /= max(cw.x, 1e-6);
  lc /= max(cw.y, 1e-6);
  vec4 r = vec4(lc.r - lc.g, lc.b - lc.g, lo.r - lo.g, lo.b - lo.g);
  // 某一区看不到时，跟随另一区
  if (cw.y < 1e-3) r.xy = r.zw;
  if (cw.x < 1e-3) r.zw = r.xy;
  return r;
}

void main() {
  if (gl_FragCoord.x > 1.0) { gl_FragColor = chromaMeter(); return; }
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

// ---- 双区曝光模型（T23 / T28；T30 抽出来给适应 pass 共用，见文件末尾 Exposure 类上方的公式说明） ----
export const EXPOSURE_MODEL = /* glsl */ `
uniform bool uAuto;
uniform vec2 uCabinBeta;    // 舱内局部适应比例：x = 暗处（中间视 / 暗视），y = 白天（明视）
uniform vec2 uCabinCapEv;   // 舱内均值的显示亮度相对窗外均值的上限（EV）：x = 暗处，y = 白天
uniform float uCabinWhiteEv;// 白天舱内的明度恒常补偿（EV）
uniform float uCabinMaxBoostEv; // 舱内曝光最多比窗外高多少 EV（局部适应的幅度上限）
uniform float uCabinHiMarginEv; // 舱内均值的显示亮度最多比窗外高光（线性平均）高多少 EV
uniform float uSnowEv;      // 窗外是均匀而明亮的视野（云中、雪原）时，窗外目标中灰上调的档位
uniform vec2 uUniformRange; // 「均匀视野」判据：窗外线性均值与对数均值之差（log2）在此区间内由 1 过渡到 0
uniform float uWhiteout;    // C02 飞机在云里的程度（0–1），云里窗外是白茫茫一片：直接算「均匀视野」
uniform vec2 uDayEvAnchor;  // C02 白天窗外曝光的下限：x = 相当于 EV100 多少的相机曝光（再亮的视野不再往下压），y = 强度（0 = 关）
uniform vec2 uPhotopicRange;// 「白天」判定：窗外适应亮度的 log10(cd/m²) 区间
uniform vec2 uDominanceRange; // 「舱内主导」判据：舱内与窗外适应亮度之差 c − o（log2）在此区间内由 0 过渡到 1
uniform vec2 uCabinLitRange;  // 「舱灯开着」判据：舱内适应亮度 log10(cd/m²) 在此区间内由 0 过渡到 1
uniform float uCabinLitWhiteEv; // 舱内主导（开灯）时的明度恒常补偿（EV）
uniform float uWinGapLitEv;   // T30 开着舱灯时窗内曝光最多比舱内高多少 EV
uniform vec2 uReflGapEv;      // T30 窗上倒影的曝光最多比舱内高多少 EV：x = 暗处（睡眠 / 全关），y = 开着舱灯
uniform vec2 uReflCapK;       // T34 窗上倒影（面状部分）显示亮度的硬上限 = 舱内均值显示亮度 × k（线性）：x = 暗处，y = 开着舱灯

// 目标中灰：亮度低于 100 cd/m² 后逐渐降低（暗处人眼看到的整体更暗；经验近似）
float exposureKey(float logCd10) { return 0.18 * clamp((logCd10 + 2.0) / 4.0, 0.12, 1.0); }

struct ExpModel { float eO; float eC; float aC; float aO; float dom; float lit; float reflLog; float reflCapLog; };

// adapted：log2 亮度（kcd/m²）——窗外（对数均值）、舱内（按面积）、窗外（线性均值）
ExpModel exposureModel(vec4 adapted) {
    const float L2_10 = 0.30103;                     // log10(2)
    const float LOG2_1000 = 9.965784;                // kcd → cd
    float o = adapted.x;
    float c = adapted.y;
    float h = adapted.z;
    // 白天程度：窗外适应亮度从 uPhotopicRange.x 到 .y（log10 cd/m²）之间由 0 过渡到 1
    float day = smoothstep(uPhotopicRange.x, uPhotopicRange.y, (o + LOG2_1000) * L2_10);
    // 窗外：按窗外自身的适应亮度曝光
    float eO = log2(exposureKey((o + LOG2_1000) * L2_10)) - o;
    // ⑨ C02 物理 EV 锚定 + 有限自适应：白天窗外越亮，眼睛（和相机）越不会把它完整地压回中灰——满窗受光的云海按
    //    「对数均值 = 中灰」曝光时，受光最亮的云顶只有显示值 157–163/255，一片灰（research/CLOUD_SHARPNESS.md §1.7）。
    //    所以白天窗外的曝光不低于 EV100 = uDayEvAnchor.x 的相机曝光（sunny-16 是 EV100 15），比它暗的视野（海面、陆地、
    //    天空为主的窗）照旧自动曝光、一点不变。强度 uDayEvAnchor.y（0 = 关）。
    //    放在舱内的约束之前：锚定之后眼睛就适应在这个水平上，③ ④ 的「舱内相对窗外」都按它算——否则云越亮、窗外对数均值越高，
    //    ④「舱内最多比窗外多提亮 4.5 档」把舱壁一起压暗（clouds-variety 舱壁 139 → 123）
    eO = mix(eO, max(eO, log2(1000.0 / 1.2) - uDayEvAnchor.x), day * uDayEvAnchor.y);
    // ① 局部适应：舱内的适应亮度从窗外出发，向舱内自身的亮度靠拢一部分；明视时周边视网膜能独立适应得更多
    // T28「舱内主导」：舱内比窗外亮得多（dom），并且舱内本身够亮、是明视 / 高中间视（lit：开着舱灯，不是睡眠 / 全关），
    //    这时眼睛适应的是舱内：舱内按自身完全适应（β → 1）、明度恒常照样成立、不再受「不许比窗外亮」的约束。
    ExpModel m;
    float dom = smoothstep(uDominanceRange.x, uDominanceRange.y, c - o);
    float lit = dom * smoothstep(uCabinLitRange.x, uCabinLitRange.y, (c + LOG2_1000) * L2_10);
    float beta = mix(mix(uCabinBeta.x, uCabinBeta.y, day), 1.0, lit);
    float aC = o + beta * (c - o);
    float eC = log2(exposureKey((aC + LOG2_1000) * L2_10)) - aC;
    // ② 明度恒常：白天舱内大多是浅色饰面，人眼把它看成「白墙在阴影里」而不是中灰，所以舱内的中灰锚点上调
    eC += max(uCabinWhiteEv * day, uCabinLitWhiteEv * lit);
    // ③ 上限：舱内均值在屏幕上的亮度不超过窗外均值 + cap（暗处 cap < 0：舱内一定比窗外暗）
    //    舱内均值的显示亮度 = eC + c，窗外均值 = eO + o；窗外是一片均匀的雾时（h ≈ o）收紧；舱内主导时放开
    float cap = mix(min(mix(uCabinCapEv.x, uCabinCapEv.y, day), h - o + uCabinHiMarginEv), uCabinMaxBoostEv, lit);
    eC = min(eC, eO + o - c + cap);
    // ④ 局部适应的幅度有限：余光里的舱内最多比注视的窗外多提亮 uCabinMaxBoostEv 档
    eC = min(eC, eO + uCabinMaxBoostEv);
    aC = log2(exposureKey((aC + LOG2_1000) * L2_10)) - eC; // 等效适应亮度（浦肯野用），与曝光一致
    // ④' T30 反方向的幅度上限，只在「舱内主导」（开着舱灯，lit）时生效：这时眼睛真的适应在舱内的亮度上（β → 1，
    //    eC 是真实的适应而不是 ③ 的压暗），窗内最多比舱内多提亮 uWinGapLitEv 档——夜里开着灯看窗外本来就更难看清。
    //    改前窗内的测光里混着很亮的倒影，把窗外曝光「顺带」压住了；倒影按 ⑦ 压暗后测光只剩窗外，要靠这一条接住。
    //    睡眠 / 全关（lit ≈ 0）时 eC 是 ③ 为了「舱内一定比窗外暗」压出来的显示值，不代表适应，不拿它牵制窗外
    float eO0 = eO;
    eO = mix(eO, min(eO, eC + uWinGapLitEv), lit);
    m.aO = o + (eO0 - eO); // 窗内被压低了曝光，相当于适应在更亮的水平上（浦肯野随之减弱）
    // ⑤ 雪景补偿（只作用于窗外，放在舱内的约束之后，不连带抬亮舱内）：白天窗外是均匀而明亮的视野
    //    （云中白茫茫一片）时，测光会把它压成中灰；人眼看到的是白，窗应当是画面最亮处。
    //    判据：线性均值与对数均值几乎相等 ⇔ 视野里没有明暗起伏（有天空 / 海 / 云影的画面差 ≥ 0.15 档）
    //    C02：再加一条直接的判据——飞机在云里（uWhiteout，云的密度探针给的，见 clouds.ts keyVisibility）。
    //    C01 以后云里的雾不再被高阶散射抹匀，机翼比雾亮，in-cloud 的 h − o 从 0.016 升到约 0.1，统计判据落在边缘上
    float uniformField = day * max(1.0 - smoothstep(uUniformRange.x, uUniformRange.y, h - o), uWhiteout);
    eO += uSnowEv * uniformField;
    m.eO = eO; m.eC = eC; m.aC = aC; m.dom = dom; m.lit = lit;
    // ⑦ T30 倒影的显示增益（log2，≤ 0，写进适应结果左像素的 w，舱内合成读它乘到窗板倒影上）：
    //    倒影是舱内表面的像，人眼把它当作「舱内」这一层来看（透明层分解 / 锚定框架：Anderson 的 scission、
    //    Gilchrist 的 anchoring），它的明暗跟舱内同一个框架走，而不是跟着窗外暗处被单独拉高。
    //    所以倒影最多比舱内的曝光高 uReflGapEv 档（局部适应的余量），超出的部分在舱内合成里预先扣掉；
    //    窗外本身照旧按窗外曝光（T23），城市灯光、机翼不受影响。白天 eO ≤ eC，从不触发
    m.reflLog = uAuto ? min(0.0, eC + mix(uReflGapEv.x, uReflGapEv.y, lit) - eO) : 0.0;
    // ⑧ T34 倒影的硬上限（log2，窗内 HDR 单位，已含倒影增益之后的量）：⑦ 只管「曝光差」，管不住来源本身就比
    //    看得见的舱壁亮得多的情况（睡眠档对面紧挨氛围灯的那段侧壁约 20 cd/m²，是可见舱壁均值的 30 倍，⑦ 之后在屏幕上
    //    仍比舱壁亮 2.8 倍）。所以再给显示亮度一个绝对上限：倒影 · 2^eO ≤ k · 舱内均值 · 2^eC，
    //    即倒影 ≤ k · 2^(c + eC − eO)。k 是线性比（AgX 下显示 Y 的一半约等于线性的 0.2）；手动曝光时不限
    m.reflCapLog = uAuto ? log2(mix(uReflCapK.x, uReflCapK.y, lit)) + c + eC - eO : 60.0;
    return m;
}
`;

const ADAPT_FRAG = /* glsl */ `
${EXPOSURE_MODEL}
uniform sampler2D uPrev;
uniform sampler2D uMeter;
uniform float uDt;
uniform bool uReset;
varying vec2 vUv;
void main() {
  // 2×1：左像素亮度、右像素色度（T28）
  vec4 target = texture(uMeter, vUv);
  vec4 prev = texture(uPrev, vUv);
  // 适应速度（1/秒）：亮适应约 0.5 s，暗适应这里取 2.5 s（真实的完全暗适应要几十分钟，不照搬）
  // 色度与亮度同速：舱内色度（xy）跟舱内亮度（y）的明暗方向，窗外色度（zw）跟窗外亮度（x）
  vec4 dir = step(prev, target);
  if (vUv.x > 0.5) {
    vec4 pL = texture(uPrev, vec2(0.25, 0.5));
    vec4 tL = texture(uMeter, vec2(0.25, 0.5));
    dir = step(pL.yyxx, tL.yyxx);
  }
  vec4 rate = mix(vec4(0.4), vec4(2.0), dir);
  vec4 next = uReset ? target : prev + (target - prev) * (1.0 - exp(-uDt * rate));
  // 左像素的 w：倒影的显示增益（T30，由适应后的亮度直接算出，不参与时间积分）
  if (vUv.x < 0.5) next.w = exposureModel(next).reflLog;
  gl_FragColor = next;
}
`;

const FINAL_FRAG = /* glsl */ `
uniform sampler2D uHdr;
uniform sampler2D uAdapted;
${EXPOSURE_MODEL}
uniform float uManualEv;
uniform float uEvComp;
uniform sampler2D uBloom;
uniform float uBloomLevels;
uniform float uGlare;       // 被眼睛和窗板散射到周围的能量比例
uniform bool uDebugMask;    // 调试：输出窗外遮罩
uniform vec2 uChromaD;      // T28 舱内色适应程度：x = 窗外主导，y = 舱内主导（0 = 关掉色适应）
uniform vec2 uChromaCabinW; // 适应白点里舱内白点的权重：x = 窗外主导，y = 舱内主导（其余来自窗外）
uniform vec3 uCabinRefAlbedo; // 舱内饰面的平均反照率（只用色度）：舱内平均色 ÷ 它 = 舱内光源色
uniform vec2 uOffLocusAdapt; // 适应白点偏离普朗克轨迹的那部分人眼只适应这个比例：x = 偏绿一侧，y = 偏品红 / 紫一侧（1 = 和轨迹方向一样）
uniform float uWinChromaMax;  // 窗外平均色进入适应白点前的色度限幅（log2 色度向量的长度）
uniform vec4 uMesopicKeep;    // T48 饱和发光体不做浦肯野：饱和度 x→y、像素亮度 log10 cd/m² z→w 之间由 0 过渡到 1（只在窗外）
uniform vec3 uNightChroma;    // T48 夜里色调映射后的色度保持：x = 强度，窗外适应亮度 log10 cd/m² 在 y→z 之间由 1 过渡到 0
#include <common>
#include <dithering_pars_fragment>
varying vec2 vUv;

// 线性 sRGB ↔ CAT02 LMS（M = M_CAT02 · M_sRGB→XYZ，按列写）
const mat3 RGB2LMS = mat3(0.390473, 0.070926, 0.023143,
                          0.549904, 0.963107, 0.128012,
                          0.008902, 0.001358, 0.936052);
const mat3 LMS2RGB = mat3(2.858311, -0.210435, -0.041890,
                          -1.628708, 1.158415, -0.118154,
                          -0.024819, 0.000320, 1.068887);

// 部分 von Kries 色适应（CAT02 空间）：把适应白点 w（线性 sRGB）往 D65 白 (1,1,1) 拉 D 的比例，返回 LMS 三通道的增益
// 普朗克轨迹（2200–10000 K，CIE 1931 xy 的 Kim 近似换到线性 sRGB）在 (log2 R/G, log2 B/G) 平面上的折线，
// 返回 w 相对轨迹的竖直偏差：> 0 偏品红 / 紫，< 0 偏绿（x 超出折线范围时按端点算）
float planckDev(vec2 w) {
  const vec2 P0 = vec2(1.716, -3.421), P1 = vec2(1.261, -2.061), P2 = vec2(0.809, -1.140), P3 = vec2(0.335, -0.333),
             P4 = vec2(0.084, 0.073), P5 = vec2(-0.066, 0.319), P6 = vec2(-0.189, 0.525);
  float x = clamp(w.x, P6.x, P0.x);
  float y = x > P1.x ? mix(P1.y, P0.y, (x - P1.x) / (P0.x - P1.x))
          : x > P2.x ? mix(P2.y, P1.y, (x - P2.x) / (P1.x - P2.x))
          : x > P3.x ? mix(P3.y, P2.y, (x - P3.x) / (P2.x - P3.x))
          : x > P4.x ? mix(P4.y, P3.y, (x - P4.x) / (P3.x - P4.x))
          : x > P5.x ? mix(P5.y, P4.y, (x - P5.x) / (P4.x - P5.x))
          : mix(P6.y, P5.y, (x - P6.x) / (P5.x - P6.x));
  return w.y - y;
}

vec3 vonKries(vec3 w, float D) {
  vec3 lw = RGB2LMS * (w / max(dot(w, vec3(0.2126, 0.7152, 0.0722)), 1e-6));
  vec3 lr = RGB2LMS * vec3(1.0);
  return mix(vec3(1.0), lr / max(lw, vec3(1e-4)), D);
}

void main() {
  vec4 src = texture(uHdr, vUv);
  float logExposure;  // log2 曝光（HDR 单位 kcd/m²）
  float logAdapt;     // 这个像素的适应亮度，log2 kcd/m²（浦肯野用）
  float logAdaptO = 0.0; // 窗外的适应亮度，log2 kcd/m²（T48 判断「夜里」用）
  vec3 catGain = vec3(1.0); // 舱内色适应的 LMS 增益（窗外不用）
  if (uAuto) {
    vec4 adapted = texture(uAdapted, vec2(0.25, 0.5)); // log2 亮度（kcd/m²）：窗外（对数均值）、舱内（按面积）、窗外（线性均值）
    vec4 chroma = texture(uAdapted, vec2(0.75, 0.5));  // log2(R/G)、log2(B/G)：舱内 xy、窗外 zw（T28）
    ExpModel em = exposureModel(adapted);
    float eO = em.eO, eC = em.eC, aC = em.aC, o = adapted.x, dom = em.dom;
    // T47：交界像素（遮罩 0 < a < 1，窗板开口边、座椅 / 头枕压在窗前的轮廓）按「曝光的倒数」线性混合，不在 log 域混合。
    // HDR 里这个像素 = a·窗外 + (1 − a)·舱内，窗外绝对亮度高、曝光低；log 域混合给出两者的几何平均曝光，
    // 窗外那一份被多乘了 √(E舱内 / E窗外) 倍，显示出来比窗外本身还亮——头枕轮廓外、窗板边上一圈 1 px、逐像素跳的白线
    // （美术总监 wave6 第 6 条）。按倒数混合时，显示值 = 窗外显示值与舱内显示值的加权平均（权重 a / E窗外 : (1 − a) / E舱内），
    // 永远落在两者之间，不会过冲；代价只是交界往窗外一侧偏了零点几个像素
    logExposure = -log2(mix(exp2(-eC), exp2(-eO), src.a));
    logAdapt = mix(aC, em.aO, src.a);
    logAdaptO = em.aO;
    // ⑥ 色适应（T28，只作用于舱内）：适应白点 = 舱内光源色与窗外平均色的对数混合，
    //    舱内越主导（舱内比窗外亮得多：夜里开灯），越以舱内光源为准、适应得越完全。
    //    窗外平均色先限幅：很蓝的天空不是灰色表面，照单全收会把舱内的红补过头（fuji-day 偏粉）
    vec2 wo = chroma.zw * min(1.0, uWinChromaMax / max(length(chroma.zw), 1e-6));
    vec2 wLog = mix(wo, chroma.xy - log2(uCabinRefAlbedo.rb / uCabinRefAlbedo.g), mix(uChromaCabinW.x, uChromaCabinW.y, dom));
    //    人眼沿普朗克轨迹（暖 ↔ 冷）适应得充分，对离开轨迹的那部分（紫色睡眠氛围灯、偏绿的天光混色）只适应一小部分：
    //    睡眠光保留淡紫，fuji-day 的白点不因偏绿而把舱壁补成粉色；暖阅读灯、日光几乎在轨迹上，不受影响
    float dev = planckDev(wLog);
    wLog.y -= (1.0 - (dev > 0.0 ? uOffLocusAdapt.y : uOffLocusAdapt.x)) * dev;
    catGain = vonKries(exp2(vec3(wLog.x, 0.0, wLog.y)), mix(uChromaD.x, uChromaD.y, dom));
  } else {
    // EV100 曝光：H = L(cd/m²) / (1.2 · 2^EV)
    logExposure = log2(1000.0 / (1.2 * exp2(uManualEv)));
    logAdapt = 0.0;
  }
  float exposure = exp2(logExposure + uEvComp);
  vec3 hdr = src.rgb;
  vec3 glare = texture(uBloom, vUv).rgb / uBloomLevels;
  vec3 c = mix(hdr, glare, uGlare);
  // 舱内色适应：只改色度，亮度保持（亮度适应已由上面的曝光负责）；遮罩是解析的，交界处按 alpha 过渡
  vec3 ca = max(LMS2RGB * (catGain * (RGB2LMS * c)), vec3(0.0));
  ca *= dot(c, vec3(0.2126, 0.7152, 0.0722)) / max(dot(ca, vec3(0.2126, 0.7152, 0.0722)), 1e-9);
  c = mix(ca, c, src.a);
  // 浦肯野效应：暗处视杆细胞接管，看不出颜色、对蓝绿光敏感（峰值 507 nm），月夜因此是银蓝色的。
  // 按这个像素的适应亮度在明视觉（> 3 cd/m²）和暗视觉（< 0.01 cd/m²）之间过渡（经验近似，参考 Jensen 2000）
  // T48：饱和度按浦肯野之前的颜色算（1 − min / max），发光体「保色」的两处都用它
  float satIn = 1.0 - min(min(c.r, c.g), c.b) / max(max(max(c.r, c.g), c.b), 1e-12);
  float logPix = log2(max(dot(c, vec3(0.2126, 0.7152, 0.0722)) * 1000.0, 1e-6)) * 0.30103; // log10 cd/m²
  float nightChroma = 0.0; // T48 夜里饱和发光体的色度保持权重（窗外），色调映射之后用
  if (uAuto) {
    float cdAdapt = exp2(logAdapt) * 1000.0;
    float scotopic = 1.0 - smoothstep(-2.0, 0.5, log(max(cdAdapt, 1e-6)) / log(10.0));
    // 像素本身够亮（夜里的灯）就能刺激视锥细胞，保留颜色
    scotopic *= 1.0 - smoothstep(-2.0, 0.0, logPix);
    // T48 色觉阈值：中间视觉里颜色不是按比例褪掉，而是「色度低于阈值的看不出颜色」——月光下的云、星光下的海
    //    本来就只有很淡的颜色，落到阈值以下就是银灰；钠灯照亮的雾（R:G:B ≈ 1 : 0.23 : 0.01）色度远在阈值之上，
    //    只要像素本身进了中间视范围（> 约 0.003 cd/m²）人眼就看得出是橙的。所以高饱和、够亮的窗外像素不混视杆的灰蓝。
    //    但亮度照旧按视杆的光谱灵敏度走（中间视的光效率移向蓝绿，橙红的灯在夜里显得暗一些——CIE 191 的中间视光度学），
    //    只保色度、不保亮度：灯的光晕不会因此变亮变糊，W02 标定的雾亮度层次也不变。
    float satKeep = smoothstep(uMesopicKeep.x, uMesopicKeep.y, satIn) * src.a;
    float keep = satKeep * smoothstep(uMesopicKeep.z, uMesopicKeep.w, logPix);
    float rod = dot(c, vec3(0.05, 0.62, 0.33));
    vec3 cs = mix(c, rod * vec3(0.66, 0.82, 1.0), scotopic * 0.8);
    c = mix(cs, c * (dot(cs, vec3(0.2126, 0.7152, 0.0722)) / max(dot(c, vec3(0.2126, 0.7152, 0.0722)), 1e-12)), keep);
    // 窗外适应在暗视 / 低中间视（夜里）时才做色调映射后的色度保持，黄昏、白天一律不动
    float nightO = 1.0 - smoothstep(uNightChroma.y, uNightChroma.z, (logAdaptO + 9.965784) * 0.30103);
    //    只按饱和度门控、不再乘像素亮度门限：暗处 AgX 本来就几乎不压色度（目标 ≈ AgX 自己），叠两道门限会让雾边缘的色相变化太陡
    nightChroma = uNightChroma.x * nightO * satKeep;
  }
  gl_FragColor = vec4(c * exposure, 1.0);
  if (uDebugMask) { gl_FragColor = vec4(vec3(src.a), 1.0); return; }
  #ifdef TONE_MAPPING
  {
    vec3 x = gl_FragColor.rgb;
    vec3 a = toneMapping(x);
    // T48 色度保持：AgX 在对数域逐通道压缩，高光的通道比被压扁，夜里被曝光拉到中灰之上 4–7 档的钠灯 / 灯照的雾
    //    就成了奶白。对「夜里、窗外、高饱和、够亮」的像素，把 AgX 的结果往「同色相、同显示亮度（放不下时降亮度保色度）」
    //    的颜色拉一部分：钠灯读成橙黄、LED（饱和度低，不进这条）仍是白。中性色的目标就是 AgX 自己，不受影响
    //    （不写分支：shader-budget 实测带 if 的版本 exposure-final 编译 +7–10%，无分支 +3–6%，约 +4 ms）
    float yx = max(dot(x, vec3(0.2126, 0.7152, 0.0722)), 1e-9);
    vec3 hue = x * min(dot(a, vec3(0.2126, 0.7152, 0.0722)) / yx, 1.0 / max(max(max(x.r, x.g), x.b), 1e-9));
    gl_FragColor.rgb = mix(a, hue, nightChroma);
  }
  #endif
  #include <colorspace_fragment>
  #include <dithering_fragment>
}
`;

function tinyTarget() {
  return new THREE.WebGLRenderTarget(2, 1, {
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
 *      C02：判据取 max(上式, uWhiteout)，uWhiteout = 飞机在云里的程度（C01 后云中的 h − o 升到约 0.1，统计判据不再可靠）。
 *   ⑨ C02 白天窗外的曝光下限（放在 ① 之前，舱内的约束都按锚定后的 eO 算）：eO = max(eO, log2(1000/1.2) − 15)·day，
 *      即不比 EV100 15（sunny-16）的相机更暗；只有比锚点亮的视野（满窗受光的云海）会被抬高，其余不变。
 *   窗外看不到（遮光板全放下）时 o 取绝对锚点：o = c − 2.2·(1 − smoothstep(1.0, 2.5, log10 c[cd/m²]))，
 *      白天等于舱内亮度，暗处比舱内低 2.2 档（关灯夜里实测窗外比舱内低约 2.7 档），按窗外可见权重连续混合。
 * T28「人眼式色适应」（用户定，选项 A）：
 *   舱内主导 dom = smoothstep(−1, 2, c − o)；开着舱灯 lit = dom · smoothstep(0.5, 1.2, log10 c[cd/m²])（睡眠 / 全关 ≈ 0）。
 *   lit 时眼睛适应的是舱内：β → 1、明度恒常 +0.35 EV、③ 的上限放开到 ④。窗外的曝光一律不动。
 *   ⑥ 色适应（只作用于舱内像素，按遮罩 alpha 过渡）：
 *      测光：舱内（按面积）/ 窗外（中心加权）各通道的对数均值，排除比上一帧适应亮度亮 2–4 档的高光和暗 3–6 档的近黑样本；
 *      舱内光源色 = 舱内平均色 ÷ 饰面平均反照率 (0.75, 0.72, 0.665)（否则暖白饰面会被当成暖光抵消掉，白天就还是冷灰）；
 *      窗外平均色先把 log2 色度向量限幅到长度 0.6（很蓝的天空不是灰色表面）；
 *      适应白点 W = 窗外平均色^(1−k) · 舱内光源色^k，k = mix(0.7, 1.0, dom)；
 *      普朗克轨迹：W 相对轨迹（2200–10000 K 折线，log2 色度平面）的竖直偏差 dev，偏品红 / 紫的一侧只适应 40%，
 *      偏绿一侧照常（人眼沿暖 ↔ 冷适应得充分，对紫色氛围灯不会完全适应：睡眠档保留淡紫）；
 *      CAT02 LMS 里的部分 von Kries：g = mix(1, LMS(D65) / LMS(W), D)，D = mix(0.7, 0.72, dom)；
 *      结果再按原亮度归一（只改色度，不碰 T23 标定的亮度）。色度测光与亮度同速做时间适应。
 * T30「窗上倒影与曝光一致」：
 *   根因：夜里窗内按窗外单独适应，eO 比 eC 高 5–7 档（睡眠 7.0、开灯 5.2、全关 6.4），倒影（舱内表面 × 菲涅尔 × 1.5，约 −3.5 EV）
 *      在屏幕上反比它的来源亮 1.5–3.5 档：睡眠档的洗墙光带接近白，开灯时座椅的倒影成了下半窗一层均匀的棕褐纱。
 *   ⑦ 倒影按「舱内」这一层显示：增益 reflLog = min(0, eC + uReflGapEv − eO)（暗处 2.5、开灯 2.0 档余量），
 *      由适应 pass 写进左像素的 w，舱内合成（scene.ts）乘到倒影上；窗外本身不受影响。
 *   ④' 开着舱灯（lit）时窗内曝光最多比舱内高 uWinGapLitEv = 6.5 档：倒影压暗后测光不再被它抬高，
 *      没有这一条的话开灯时窗外会亮得和全关一样（改前是被倒影「顺带」压住的）。
 *   倒影的色度在 scene.ts 里按主灯色温预先抵掉 70%（和舱内的色适应一致，窗外不做舱内色适应）。
 * T34「倒影亮度自洽」：
 *   ⑦ 只约束「倒影的曝光 ≤ 舱内曝光 + 余量」，等于说「倒影不比它的来源亮」；可睡眠档倒影的来源是对面紧挨氛围灯的
 *      那段侧壁（约 20 cd/m²，是可见舱壁均值的 30 倍），⑦ 之后在屏幕上仍是舱壁的 2.8 倍（Y 83 对 30）。
 *   ⑧ 所以再加一条按显示亮度的硬上限：面状倒影 · 2^eO ≤ k · 2^(c + eC)（舱内均值的显示亮度），
 *      reflCapLog = log2 k + c + eC − eO，k = uReflCapK（暗处 0.2、开灯 0.25（T42，原 0.35），按 lit 混合；AgX 下线性 0.2 ≈ 显示 Y 的 0.4–0.5）。
 *      舱内合成（scene.ts）用 4 次范数软限幅，并在窗外够亮（黄昏）时再收紧到窗外的 15%；阅读灯光点不进上限。
 *      scene.ts 直接内联 EXPOSURE_MODEL、共用 EXPOSURE_MODEL_UNIFORMS，按上一帧的适应结果算。
 * 各项都是 min / smoothstep 的组合，对 o、c、h 连续；o、c、h 本身经过时间适应，所以不会闪。
 * 参数的来源：六个场景的统计（apps/voyage/scripts/cabin-luminance.playwright.js + cabin_luminance.py），
 * 目标是用户给的屏幕亮度（白天舱壁 150–185、关灯夜里 25–45、窗最亮）。这是经验模型，不是视觉科学的定量结果。
 * 调试：finalMat.uniforms.uDebugMask = true 输出窗外遮罩。
 */
/**
 * 上一帧的适应结果（2×1 浮点纹理），给舱内合成读：左像素 w = 窗上倒影的显示增益（log2，T30，见 EXPOSURE_MODEL ⑦）。
 * 模块级共享的 uniform 对象：scene.ts 直接放进自己的 uniforms，不用在 main.ts 里接线。
 * 舱内合成在曝光之前画，读到的是上一帧的值（适应本来就是秒级的慢变量，差一帧看不出）。
 */
export const EXPOSURE_STATE: THREE.IUniform<THREE.Texture | null> = { value: null };

/**
 * 飞机在云里的程度（0–1，C02）：clouds.ts 的 keyVisibility 按密度探针写（已按 0.5 s 平滑），EXPOSURE_MODEL ⑤ 读。
 * 同 EXPOSURE_STATE 一样是模块级共享的 uniform 对象，不用在 main.ts 里接线
 */
export const EXPOSURE_WHITEOUT: THREE.IUniform<number> = { value: 0 };

/** 双区曝光模型的参数（EXPOSURE_MODEL）：适应 pass、最终合成、舱内合成（scene.ts，T34 倒影上限）共用同一批 uniform 对象 */
export const EXPOSURE_MODEL_UNIFORMS: Record<string, THREE.IUniform> = {
  uAuto: { value: true },
  uCabinBeta: { value: new THREE.Vector2(0.3, 0.8) },
  uCabinCapEv: { value: new THREE.Vector2(-0.75, 2.0) },
  uCabinWhiteEv: { value: 2.2 },
  uCabinMaxBoostEv: { value: 4.5 },
  uCabinHiMarginEv: { value: 1.4 },
  uSnowEv: { value: 2.0 },
  uUniformRange: { value: new THREE.Vector2(0.05, 0.12) },
  uWhiteout: EXPOSURE_WHITEOUT,
  uDayEvAnchor: { value: new THREE.Vector2(15.0, 1.0) }, // C02：sunny-16（14.0 / 14.5 时满窗云海的云芯被 AgX 肩部压平，见 handoff/C01-02.md）
  uPhotopicRange: { value: new THREE.Vector2(1.5, 3.0) },
  uDominanceRange: { value: new THREE.Vector2(-1.0, 2.0) },
  uCabinLitRange: { value: new THREE.Vector2(0.5, 1.2) },
  uCabinLitWhiteEv: { value: 0.35 },
  uWinGapLitEv: { value: 6.5 },
  uReflGapEv: { value: new THREE.Vector2(2.5, 2.0) },
  uReflCapK: { value: new THREE.Vector2(0.2, 0.25) }, // T42：开灯档 0.35 → 0.25（美术总监第 6 波第 1 条）
};

export class Exposure {
  private readonly meter = tinyTarget();
  private adapted = [tinyTarget(), tinyTarget()];
  private reset = true;

  private readonly meterMat = material(METER_FRAG, { uHdr: { value: null }, uPrevAdapted: { value: null }, uReset: { value: true } });
  /** 双区曝光模型的参数：模块级共享（EXPOSURE_MODEL_UNIFORMS），舱内合成也要读 */
  readonly model = EXPOSURE_MODEL_UNIFORMS;
  private readonly adaptMat = material(ADAPT_FRAG, {
    ...this.model,
    uPrev: { value: null },
    uMeter: { value: this.meter.texture },
    uDt: { value: 0 },
    uReset: { value: true },
  });
  readonly finalMat = material(
    FINAL_FRAG,
    {
      ...this.model,
      uHdr: { value: null },
      uAdapted: { value: null },
      uManualEv: { value: 14 },
      uEvComp: { value: 0 },
      uBloom: { value: null },
      uBloomLevels: { value: Bloom.WEIGHT_SUM },
      uGlare: { value: 0.04 },
      uDebugMask: { value: false },
      uChromaD: { value: new THREE.Vector2(0.7, 0.72) },
      uChromaCabinW: { value: new THREE.Vector2(0.7, 1.0) },
      uCabinRefAlbedo: { value: new THREE.Vector3(0.75, 0.72, 0.665) },
      uOffLocusAdapt: { value: new THREE.Vector2(1.0, 0.4) },
      uWinChromaMax: { value: 0.6 },
      uMesopicKeep: { value: new THREE.Vector4(0.5, 0.85, -2.0, -0.8) },
      uNightChroma: { value: new THREE.Vector3(0.45, -1.5, 0.0) }, // 协调者合并时 0.6 → 0.45：雾芯留一点明暗层次
    },
    true,
  );

  constructor(private readonly pass: FullscreenPass) {
    EXPOSURE_STATE.value = this.adapted[0].texture;
  }

  /** 跳变（换地点、拖时间）后让眼睛直接适应到新亮度 */
  snap() {
    this.reset = true;
  }

  render(hdr: THREE.Texture, bloom: THREE.Texture, dt: number) {
    this.finalMat.uniforms.uBloom.value = bloom;
    this.meterMat.uniforms.uHdr.value = hdr;
    this.meterMat.uniforms.uPrevAdapted.value = this.adapted[0].texture; // 上一帧写入的适应结果
    this.meterMat.uniforms.uReset.value = this.reset;
    this.pass.render(this.meterMat, this.meter);

    const [prev, next] = this.adapted;
    this.adaptMat.uniforms.uPrev.value = prev.texture;
    this.adaptMat.uniforms.uDt.value = dt;
    this.adaptMat.uniforms.uReset.value = this.reset;
    this.pass.render(this.adaptMat, next);
    this.adapted = [next, prev];
    this.reset = false;
    EXPOSURE_STATE.value = next.texture;

    this.finalMat.uniforms.uHdr.value = hdr;
    this.finalMat.uniforms.uAdapted.value = next.texture;
    this.pass.render(this.finalMat, null);
  }
}
