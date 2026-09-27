import { effectiveTargetKm, outsideAirTempC } from "./flight";
import type { VoyageState } from "./state";

/**
 * 声音（T11）：Web Audio 程序化合成，不用任何音频素材文件。
 *
 * 设计要点（详细依据见 README「声音」一节与 handoff/T11.md）：
 * - **噪声床用频域合成**：按倍频程频谱表（伪 dB SPL，全部图层共用一个参考）给每个 FFT 频点定幅度、随机相位，
 *   逆 FFT 得到一段 5–11 秒的噪声。逆 FFT 的结果天然是周期的，循环播放没有接缝；各层长度 / 起点不同，合起来听不出循环。
 * - **左右声道按扩散声场的相干函数去相关**：γ(f) = sinc(2πf·d/c)（d ≈ 0.25 m，双耳间距量级），
 *   150 Hz 以下左右几乎一致（低频本来就是「压在身上」的），600 Hz 以上完全去相关（空间感来自这里）。
 * - **巡航客舱噪声的形状**：非计权频谱在 63–500 Hz 最高，500 Hz 以上约每倍频程 −6～−8 dB；A 计权后峰值落在 500 Hz–1 kHz，
 *   总声级按表算约 78 dBA（宽体机的量级；窄体约 80–84 dBA）。这是按公开测量的典型形状近似，不是某一架飞机的实测。
 * - 随状态变化的都是**增益 / 滤波参数的缓变**（setTargetAtTime），逐帧只做一次节流到 10 Hz 的参数更新，
 *   所有合成都在浏览器的音频线程里（原生节点），主线程几乎没有开销。
 * - 事件（颠簸闷响、机身咯吱、雷声、提示音）按泊松过程在参数更新时预排到音频时间轴上。
 *
 * 结构：`Soundscape` 是可以建在任意 BaseAudioContext 上的声音图（离线检查 scripts/audio-check.mjs 用 OfflineAudioContext
 * 渲染它）；`CabinAudio` 是给面板 / 主循环用的控制器（默认静音；用户点击后才创建 AudioContext）。
 */

// ---------------------------------------------------------------------------------------------
// 频谱表：倍频程中心频率 → 伪 dB SPL（非计权）。所有图层共用同一个参考，所以表里的数就是它们之间的相对响度
// ---------------------------------------------------------------------------------------------
type Spectrum = ReadonlyArray<readonly [number, number]>;

/** 气流 / 边界层噪声（巡航，q = 巡航动压时的 0 dB 状态）：能量集中在 125–1000 Hz */
const AIRFLOW: Spectrum = [[16, 50], [31.5, 62], [63, 70], [125, 75], [250, 78], [500, 77], [1000, 72], [2000, 65], [4000, 57], [8000, 47], [16000, 33]];
/** 发动机宽带低频（含经机翼 / 挂架传进来的结构噪声），巡航推力、座位在机翼上方附近时的 0 dB 状态 */
const RUMBLE: Spectrum = [[16, 55], [31.5, 68], [63, 75], [125, 73], [250, 64], [500, 54], [1000, 44], [2000, 34]];
/** 襟翼 / 缝翼的气动噪声（襟翼侧缘、缝翼凹腔），FULL 档 + 进近动压时的 0 dB 状态 */
const FLAP: Spectrum = [[63, 60], [125, 67], [250, 72], [500, 73], [1000, 70], [2000, 64], [4000, 56], [8000, 46]];
/** 扰流板上翻后的分离流抖振：低沉、成团的轰鸣 */
const SPOILER: Spectrum = [[16, 62], [31.5, 70], [63, 72], [125, 66], [250, 57], [500, 47], [1000, 38]];
/** 雨打窗的底噪（连续的「沙」声；另外叠一层离散的雨点，见 rainBuffer） */
const RAIN: Spectrum = [[250, 46], [500, 54], [1000, 60], [2000, 62], [4000, 59], [8000, 52], [16000, 40]];
/** 冰晶打在机身上的细沙声：只有高频 */
const ICE: Spectrum = [[1000, 46], [2000, 54], [4000, 58], [8000, 56], [16000, 46]];
/** 舱内空调出风（很轻）：柔和的中高频气流声 */
const AIRCON: Spectrum = [[125, 45], [250, 53], [500, 57], [1000, 58], [2000, 56], [4000, 51], [8000, 43], [16000, 31]];
/** 雷声 / 颠簸闷响的原料：接近棕噪（−6 dB/倍频程），每次事件再按距离低通 */
const BROWN: Spectrum = [[16, 80], [31.5, 80], [63, 78], [125, 74], [250, 68], [500, 61], [1000, 54], [2000, 47], [4000, 40], [8000, 33]];

/** 发动机低压轴基频的谐波（伪 dB SPL，巡航推力）。低压轴 100% ≈ 46 Hz（大涵道比宽体发动机 2700 rpm 量级）。
 *  笔记本扬声器放不出 40 Hz，靠 2、3 次谐波让人「听到」基频（缺失基频效应） */
const ENGINE_TONE_HARMONICS: ReadonlyArray<readonly [number, number]> = [[1, 66], [2, 67], [3, 63], [4, 56]];
const N1_100_HZ = 46;
/** 两台发动机转速差 0.45%：约 0.2 Hz 的拍频，客舱里那种很慢的「嗡——嗡——」 */
const ENGINE_DETUNE = 1.0045;

/** 座位相对机翼（state.wingRootLE，翼根前缘在窗口前方的米数）→ 发动机声的增减（dB）。
 *  机翼上方最靠近发动机；机翼后方在喷流一侧，宽带低频更多；机翼前方最安静 */
const WING_POS_DB: ReadonlyArray<readonly [number, number]> = [[-4, -5], [3, 2.5], [8, 1.5]];

/** 气流噪声参考：巡航 10.7 km、250 m/s 的动压（Pa） */
const Q_REF = dynamicPressure(10.7, 0.25);
/** 所有噪声层的参考：AIRFLOW 表整体（能量和）对应的 RMS。音量 100% 时巡航约 −22 dBFS：
 *  高斯噪声的峰值因数约 4–5 σ，留出 12 dB 以上的余量，噪声床不碰压缩器（只有近雷会碰） */
const AIRFLOW_RMS = 0.05;
/** 声速（m/s）：雷声延迟。按题设取海平面 340（高空实际约 295，差别听不出来） */
const SOUND_SPEED = 340;
/** 超过这个距离的闪电不打雷（km）。面板的「孤立雷暴 / 飑线」摆在窗外 55–75 km，所以放宽到 90 km：
 *  那么远只剩 90 Hz 以下、低于底噪约 12 dB 的闷响，延迟近三分钟——一个活跃的雷暴在远处就是一片断断续续的低沉滚动 */
const THUNDER_MAX_KM = 90;
/** 同一时刻最多几声雷重叠（排程是按时间段数的，不是按「还没响完的」数：远雷的延迟长达几分钟） */
const THUNDER_MAX_OVERLAP = 4;

// ---------------------------------------------------------------------------------------------
// 小工具
// ---------------------------------------------------------------------------------------------

/** 可复现的伪随机数（mulberry32），离线检查每次结果一样 */
export function makeRng(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
type Rng = () => number;
function gauss(rng: Rng) {
  const u = Math.max(rng(), 1e-12);
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * rng());
}
const clamp = (x: number, a: number, b: number) => Math.min(b, Math.max(a, x));
const smoothstep = (x: number, a: number, b: number) => {
  const t = clamp((x - a) / (b - a), 0, 1);
  return t * t * (3 - 2 * t);
};
const dbToLin = (db: number) => Math.pow(10, db / 20);

/** 国际标准大气的空气密度（kg/m³） */
function airDensity(altKm: number) {
  if (altKm <= 11) {
    const T = 288.15 - 6.5 * altKm;
    const p = 101325 * Math.pow(T / 288.15, 5.2559);
    return p / (287.05 * T);
  }
  const p = 22632 * Math.exp(-(altKm - 11) / 6.3416);
  return p / (287.05 * 216.65);
}
/** 动压 q = ½ρv²（Pa）；速度按 km/s 给（flight.ts 的 speedAt） */
function dynamicPressure(altKm: number, speedKms: number) {
  const v = speedKms * 1000;
  return 0.5 * airDensity(altKm) * v * v;
}

/** 在倍频程表上按 log 频率线性插值（dB）；表外按 −12 dB/倍频程滚降 */
function spectrumDb(table: Spectrum, f: number) {
  const n = table.length;
  if (f <= table[0][0]) return table[0][1] - 12 * Math.log2(table[0][0] / f);
  if (f >= table[n - 1][0]) return table[n - 1][1] - 12 * Math.log2(f / table[n - 1][0]);
  for (let i = 1; i < n; i++) {
    if (f <= table[i][0]) {
      const t = Math.log2(f / table[i - 1][0]) / Math.log2(table[i][0] / table[i - 1][0]);
      return table[i - 1][1] + (table[i][1] - table[i - 1][1]) * t;
    }
  }
  return table[n - 1][1];
}
/** 表的总能量（dB） */
function spectrumTotalDb(table: Spectrum) {
  return 10 * Math.log10(table.reduce((s, [, db]) => s + Math.pow(10, db / 10), 0));
}
function interp(table: ReadonlyArray<readonly [number, number]>, x: number) {
  if (x <= table[0][0]) return table[0][1];
  for (let i = 1; i < table.length; i++) {
    if (x <= table[i][0]) return table[i - 1][1] + ((table[i][1] - table[i - 1][1]) * (x - table[i - 1][0])) / (table[i][0] - table[i - 1][0]);
  }
  return table[table.length - 1][1];
}

/** 原地复数 FFT（基 2，迭代）。inverse = true 时做逆变换（不除 n，调用方自己归一） */
function fft(re: Float64Array, im: Float64Array, inverse: boolean) {
  const n = re.length;
  for (let i = 1, j = 0; i < n; i++) {
    let bit = n >> 1;
    for (; j & bit; bit >>= 1) j ^= bit;
    j ^= bit;
    if (i < j) {
      let t = re[i]; re[i] = re[j]; re[j] = t;
      t = im[i]; im[i] = im[j]; im[j] = t;
    }
  }
  for (let len = 2; len <= n; len <<= 1) {
    const ang = ((inverse ? 2 : -2) * Math.PI) / len;
    const wr = Math.cos(ang), wi = Math.sin(ang);
    const half = len >> 1;
    for (let i = 0; i < n; i += len) {
      let cr = 1, ci = 0;
      for (let k = 0; k < half; k++) {
        const a = i + k, b = a + half;
        const xr = re[b] * cr - im[b] * ci;
        const xi = re[b] * ci + im[b] * cr;
        re[b] = re[a] - xr; im[b] = im[a] - xi;
        re[a] += xr; im[a] += xi;
        const nr = cr * wr - ci * wi;
        ci = cr * wi + ci * wr;
        cr = nr;
      }
    }
  }
}

/** 扩散声场里相距 d 米两点的相干函数 sinc(kd)，取第一个零点以内的正值部分（再往上当作完全不相干） */
function diffuseCoherence(f: number, d = 0.25) {
  const x = (2 * Math.PI * f * d) / 343;
  return x < 1e-6 ? 1 : x < Math.PI ? Math.sin(x) / x : 0;
}

/**
 * 频域合成一段可无缝循环的噪声：幅度 ∝ 10^(dB/20)/√f（这样每个倍频程的能量就等于表上的 dB），相位随机。
 * 左右声道 R = γ·L + √(1−γ²)·N（γ 由 coherence 给出）。两个实信号打包成一个复数逆 FFT 一次算完。
 * 返回的幅度已经乘了 scale（全局参考，见 Soundscape.scale）。
 */
function synthNoise(table: Spectrum, n: number, sr: number, stereo: boolean, rng: Rng, scale: number, coherence: (f: number) => number = diffuseCoherence) {
  const re = new Float64Array(n);
  const im = new Float64Array(n);
  const df = sr / n;
  for (let k = 1; k < n / 2; k++) {
    const f = k * df;
    const a = dbToLin(spectrumDb(table, f)) / Math.sqrt(f);
    const lr = gauss(rng) * a, li = gauss(rng) * a;
    let rr = 0, ri = 0;
    if (stereo) {
      const g = coherence(f);
      const s = Math.sqrt(1 - g * g);
      rr = g * lr + s * gauss(rng) * a;
      ri = g * li + s * gauss(rng) * a;
    }
    // Z = XL + i·XR；XL、XR 都满足共轭对称（X[n−k] = conj X[k]）
    re[k] = lr - ri;
    im[k] = li + rr;
    re[n - k] = lr + ri;
    im[n - k] = -li + rr;
  }
  fft(re, im, true);
  const L = new Float32Array(n);
  const R = stereo ? new Float32Array(n) : null;
  for (let i = 0; i < n; i++) {
    L[i] = re[i] * scale;
    if (R) R[i] = im[i] * scale;
  }
  return R ? [L, R] : [L];
}

function rms(x: Float32Array) {
  let s = 0;
  for (let i = 0; i < x.length; i++) s += x[i] * x[i];
  return Math.sqrt(s / x.length);
}

function makeBuffer(ctx: BaseAudioContext, chans: Float32Array[]) {
  const buf = ctx.createBuffer(chans.length, chans[0].length, ctx.sampleRate);
  chans.forEach((c, i) => buf.copyToChannel(c as Float32Array<ArrayBuffer>, i));
  return buf;
}

// ---------------------------------------------------------------------------------------------
// 声音图
// ---------------------------------------------------------------------------------------------

/** 每帧交给声音的状态（和 VoyageState 解耦，离线检查可以直接构造） */
export interface AudioInput {
  altitudeKm: number;
  /** 空速（km/s，flight.ts 的 speedAt） */
  speedKms: number;
  /** 1 爬升 / 0 平飞 / −1 下降 */
  climb: number;
  /** 0..1 */
  turbulence: number;
  /** clouds.cameraDensity：飞机所在处的云密度（在云里约 0.3–1） */
  inCloud: number;
  /** 外界气温（°C）：决定打在窗上的是雨（液态水）还是冰晶 */
  airTempC: number;
  slatDeg: number;
  flapDeg: number;
  spoilerDeg: number;
  /** 翼根前缘在窗口前方的米数（state.wingRootLE） */
  wingRootLE: number;
  /** 1 右座 / −1 左座（窗在哪只耳朵一侧） */
  seatSign: number;
}

export interface SoundOptions {
  /** 舱内空调出风（很轻），默认开 */
  aircon: boolean;
  /** 偶尔的客舱提示音（很少、很轻），默认关 */
  chime: boolean;
}

export const DEFAULT_SOUND_OPTIONS: SoundOptions = { aircon: true, chime: false };

/** 从主循环的状态取声音输入 */
export function audioInputFrom(state: VoyageState, inCloud: number, speedKms: number, climbing: boolean): AudioInput {
  return {
    altitudeKm: state.altitudeKm,
    speedKms,
    climb: climbing ? Math.sign(effectiveTargetKm(state) - state.altitudeKm) : 0,
    turbulence: state.turbulence,
    inCloud,
    airTempC: outsideAirTempC(state.altitudeKm),
    slatDeg: state.slatDeg,
    flapDeg: state.flapDeg,
    spoilerDeg: state.spoilerDeg,
    wingRootLE: state.wingRootLE,
    seatSign: state.seat === "right" ? 1 : -1,
  };
}

/** 一次参数更新算出来的各层目标（离线检查也把它写进报告） */
export interface SoundTargets {
  airDb: number;
  tiltDb: number;
  thrust: number;
  n1Hz: number;
  engineDb: number;
  flapLin: number;
  spoilerLin: number;
  rainLin: number;
  iceLin: number;
  airconLin: number;
  thumpRate: number;
  creakRate: number;
}

/**
 * 声音图：噪声床（气流、发动机宽带、发动机谐波、襟翼、扰流板、雨、冰晶、空调）+ 事件总线（闷响、咯吱、雷、提示音）
 * → 主音量 → 压缩器（兜底防削波）→ 输出。
 */
export class Soundscape {
  readonly ctx: BaseAudioContext;
  readonly master: GainNode;
  readonly output: AudioNode;
  options: SoundOptions;
  /** 最近一次 update 算出的目标（调试 / 检查用） */
  targets: SoundTargets | null = null;

  private rng: Rng;
  /** 噪声合成的全局幅度参考：使 AIRFLOW 表整体的 RMS = AIRFLOW_RMS */
  private scale = 1;
  /** 噪声床总线（离线检查单独听事件时把它静音） */
  bed!: GainNode;
  private events!: GainNode;
  private air!: { gain: GainNode; shelf: BiquadFilterNode; pan: StereoPannerNode };
  private rumble!: GainNode;
  private tones: { osc: OscillatorNode; gain: GainNode; pan: StereoPannerNode }[] = [];
  private flap!: GainNode;
  private spoiler!: GainNode;
  private rain!: { gain: GainNode; pan: StereoPannerNode };
  private ice!: { gain: GainNode; pan: StereoPannerNode };
  private aircon!: GainNode;
  private brown!: AudioBuffer;
  private creaks: AudioBuffer[] = [];
  private chime!: AudioBuffer;
  private sources: AudioScheduledSourceNode[] = [];

  // 缓变状态
  private thrust = 0.8;
  private gust = 0;
  private iceMod = 1;
  private lastUpdate = -1;
  private nextThump = Infinity;
  private nextCreak = Infinity;
  private nextChime = Infinity;
  /** 已排程的雷声时间段 [开始, 结束]（音频时间） */
  private thunderSlots: [number, number][] = [];

  constructor(ctx: BaseAudioContext, options: SoundOptions = DEFAULT_SOUND_OPTIONS, seed = 1) {
    this.ctx = ctx;
    this.options = { ...options };
    this.rng = makeRng(seed);
    this.master = ctx.createGain();
    this.master.gain.value = 0;
    const comp = ctx.createDynamicsCompressor();
    // 兜底限幅：只有近雷这种峰值会碰到，噪声床远低于阈值。
    // 注意 Web Audio 规范的压缩器自带补偿增益（按阈值 / 比率算，这组参数约 +1.7 dB），所有输出都会被整体抬一点
    comp.threshold.value = -3;
    comp.knee.value = 3;
    comp.ratio.value = 20;
    comp.attack.value = 0.003;
    comp.release.value = 0.3;
    this.master.connect(comp);
    this.output = comp;
  }

  /** 生成所有缓冲、连好图、启动循环源。会让出主线程几次（每段噪声几十毫秒） */
  async build() {
    const ctx = this.ctx;
    const sr = ctx.sampleRate;
    const yieldNow = () => new Promise<void>((r) => setTimeout(r, 0));
    // 长度：气流是最显眼的一层，取 2^19（48 kHz 下约 11 秒）；其余 2^18。长度 / 起点各不相同，合起来听不出循环
    const N_AIR = 1 << 19;
    const N = 1 << 18;

    // 先合成气流层，按它定全局参考
    const airCh = synthNoise(AIRFLOW, N_AIR, sr, true, this.rng, 1);
    this.scale = AIRFLOW_RMS / Math.sqrt((rms(airCh[0]) ** 2 + rms(airCh[1]) ** 2) / 2);
    for (const c of airCh) for (let i = 0; i < c.length; i++) c[i] *= this.scale;
    const s = this.scale;
    await yieldNow();

    this.bed = ctx.createGain();
    this.bed.connect(this.master);
    this.events = ctx.createGain();
    this.events.connect(this.master);

    // 气流：高搁架滤波随动压改变「亮度」；窗那一侧略响
    {
      const shelf = ctx.createBiquadFilter();
      shelf.type = "highshelf";
      shelf.frequency.value = 1200;
      shelf.gain.value = 0;
      const gain = ctx.createGain();
      const pan = ctx.createStereoPanner();
      this.loop(makeBuffer(ctx, airCh), shelf);
      shelf.connect(gain).connect(pan).connect(this.bed);
      this.air = { gain, shelf, pan };
    }
    // 发动机宽带低频：左右高度相干
    this.rumble = this.noiseLayer(synthNoise(RUMBLE, N, sr, true, this.rng, s));
    await yieldNow();
    // 发动机谐波：两台发动机各一组，窗那一侧的那台略靠近
    {
      const totalRef = spectrumTotalDb(AIRFLOW);
      const real = new Float32Array(ENGINE_TONE_HARMONICS.length + 1);
      const imag = new Float32Array(ENGINE_TONE_HARMONICS.length + 1);
      // 各谐波的 RMS（相对 AIRFLOW_RMS）→ 正弦幅度；PeriodicWave 不归一化，幅度按原样
      for (const [h, db] of ENGINE_TONE_HARMONICS) imag[h] = Math.SQRT2 * AIRFLOW_RMS * dbToLin(db - totalRef);
      const wave = ctx.createPeriodicWave(real, imag, { disableNormalization: true });
      for (let i = 0; i < 2; i++) {
        const osc = ctx.createOscillator();
        osc.setPeriodicWave(wave);
        osc.frequency.value = N1_100_HZ * 0.84 * (i ? ENGINE_DETUNE : 1);
        const gain = ctx.createGain();
        const pan = ctx.createStereoPanner();
        osc.connect(gain).connect(pan).connect(this.bed);
        osc.start();
        this.sources.push(osc);
        this.tones.push({ osc, gain, pan });
      }
    }
    this.flap = this.noiseLayer(synthNoise(FLAP, N, sr, true, this.rng, s));
    await yieldNow();
    this.spoiler = this.noiseLayer(synthNoise(SPOILER, N, sr, true, this.rng, s));
    await yieldNow();
    {
      const gain = this.noiseLayer(this.rainBuffer(N, sr, s), false);
      const pan = ctx.createStereoPanner();
      gain.connect(pan).connect(this.bed);
      this.rain = { gain, pan };
    }
    await yieldNow();
    {
      const gain = this.noiseLayer(synthNoise(ICE, N, sr, true, this.rng, s), false);
      const pan = ctx.createStereoPanner();
      gain.connect(pan).connect(this.bed);
      this.ice = { gain, pan };
    }
    await yieldNow();
    this.aircon = this.noiseLayer(synthNoise(AIRCON, N, sr, true, this.rng, s));
    await yieldNow();
    this.brown = makeBuffer(ctx, synthNoise(BROWN, N, sr, false, this.rng, s));
    await yieldNow();
    for (let i = 0; i < 4; i++) this.creaks.push(this.creakBuffer(sr));
    this.chime = this.chimeBuffer(sr);
  }

  /** 循环播放一段缓冲，从随机位置开始 */
  private loop(buf: AudioBuffer, dest: AudioNode) {
    const src = this.ctx.createBufferSource();
    src.buffer = buf;
    src.loop = true;
    src.connect(dest);
    src.start(0, this.rng() * buf.duration);
    this.sources.push(src);
  }

  /** 噪声层：循环源 → 增益（初始 0）；connect = true 时直接接进噪声床 */
  private noiseLayer(chans: Float32Array[], connect = true) {
    const gain = this.ctx.createGain();
    gain.gain.value = 0;
    this.loop(makeBuffer(this.ctx, chans), gain);
    if (connect) gain.connect(this.bed);
    return gain;
  }

  /** 雨：连续的「沙」声 + 离散的雨点。每个雨点是一声 1.2–4.5 kHz、0.4–1.2 ms 衰减的「嗒」（衰减正弦，不是白噪脉冲，
   *  免得 8 kHz 以上刺耳），左右位置随机，按泊松过程排布（循环缓冲，绕回开头处也无缝） */
  private rainBuffer(n: number, sr: number, s: number) {
    const [L, R] = synthNoise(RAIN, n, sr, true, this.rng, s, () => 0);
    const hissRms = rms(L);
    const rate = 700; // 雨点 / 秒（高速下是很密的一片）
    const dropL = new Float32Array(n), dropR = new Float32Array(n);
    let t = 0;
    for (;;) {
      t += -Math.log(1 - this.rng()) / rate;
      const i0 = Math.floor(t * sr);
      if (i0 >= n) break;
      const amp = Math.pow(this.rng(), 2.5);
      const tau = (0.0004 + this.rng() * 0.0008) * sr;
      const w = (2 * Math.PI * (1200 + this.rng() * 3300)) / sr;
      const ph = this.rng() * Math.PI * 2;
      const pan = this.rng();
      const len = Math.min(Math.ceil(tau * 6), 600);
      for (let k = 0; k < len; k++) {
        const v = amp * Math.min(k / 8, 1) * Math.exp(-k / tau) * Math.sin(w * k + ph);
        const j = (i0 + k) % n;
        dropL[j] += v * Math.sqrt(1 - pan);
        dropR[j] += v * Math.sqrt(pan);
      }
    }
    const k = (hissRms * 0.9) / Math.max(rms(dropL), 1e-9);
    for (let i = 0; i < n; i++) {
      L[i] += dropL[i] * k;
      R[i] += dropR[i] * k;
    }
    return [L, R];
  }

  /** 机身 / 内饰板的一声咯吱：一串不规则的粘滑微脉冲（间隔 6–25 ms，逐渐变疏）激励两个板共振（0.9–1.6 kHz、2.2–3.4 kHz） */
  private creakBuffer(sr: number) {
    const n = Math.floor(0.6 * sr);
    const out = new Float32Array(n);
    const f1 = 900 + this.rng() * 700, f2 = 2200 + this.rng() * 1200;
    const d1 = 0.006 * sr, d2 = 0.003 * sr;
    const pulses = 6 + Math.floor(this.rng() * 12);
    let t = 0.01 * sr;
    for (let p = 0; p < pulses && t < n; p++) {
      const amp = (0.4 + this.rng() * 0.6) * (1 - p / (pulses + 2));
      const i0 = Math.floor(t);
      for (let k = 0; k < 0.04 * sr && i0 + k < n; k++) {
        out[i0 + k] += amp * (Math.exp(-k / d1) * Math.sin((2 * Math.PI * f1 * k) / sr) + 0.6 * Math.exp(-k / d2) * Math.sin((2 * Math.PI * f2 * k) / sr));
      }
      t += (0.006 + this.rng() * 0.012 + p * 0.0015) * sr;
    }
    let peak = 0;
    for (let i = 0; i < n; i++) peak = Math.max(peak, Math.abs(out[i]));
    for (let i = 0; i < n; i++) out[i] /= peak;
    return makeBuffer(this.ctx, [out]);
  }

  /** 客舱提示音：柔和的两声下行（E5 → C5），钟形泛音、1.5 秒余音。通用的「叮—咚」，不仿任何机型 / 厂商的提示音 */
  private chimeBuffer(sr: number) {
    const n = Math.floor(3.5 * sr);
    const L = new Float32Array(n), R = new Float32Array(n);
    const note = (t0: number, f: number, amp: number) => {
      const partials: [number, number, number][] = [[1, 1, 1.6], [2, 0.18, 0.7], [3, 0.05, 0.4], [4.2, 0.025, 0.25]];
      const i0 = Math.floor(t0 * sr);
      for (let i = i0; i < n; i++) {
        const t = (i - i0) / sr;
        const att = Math.min(t / 0.006, 1);
        let v = 0;
        for (const [m, a, dec] of partials) v += a * Math.exp(-t / dec) * Math.sin(2 * Math.PI * f * m * t);
        // 左右声道略微错开相位，像从头顶面板的扬声器传来、被舱壁反射过
        L[i] += amp * att * v;
        R[i] += amp * att * v * 0.92;
      }
    };
    note(0, 659.26, 1);
    note(0.62, 523.25, 0.9);
    // 很短的早期反射（舱内吸声强，只加两次）
    for (const [dl, g] of [[0.011, 0.25], [0.023, 0.15]] as const) {
      const d = Math.floor(dl * sr);
      for (let i = n - 1; i >= d; i--) {
        R[i] += g * L[i - d];
        L[i] += g * 0.7 * R[i - d];
      }
    }
    let peak = 0;
    for (let i = 0; i < n; i++) peak = Math.max(peak, Math.abs(L[i]), Math.abs(R[i]));
    for (let i = 0; i < n; i++) {
      L[i] /= peak;
      R[i] /= peak;
    }
    return makeBuffer(this.ctx, [L, R]);
  }

  /** 设参数：immediate 时直接跳到目标（离线检查、刚启用时），否则按时间常数 tau 缓变 */
  private set(p: AudioParam, v: number, tau: number, immediate: boolean) {
    const t = this.ctx.currentTime;
    if (immediate) {
      p.cancelScheduledValues(t);
      p.setValueAtTime(v, t);
    } else p.setTargetAtTime(v, t, tau);
  }

  /**
   * 按状态更新各层（节流到 10 Hz）。immediate：直接跳到稳态（离线检查、刚启用）；
   * horizon：事件预排到当前时刻之后多少秒（实时 0.25 s；离线检查设成渲染时长）
   */
  update(s: AudioInput, opts: { immediate?: boolean; horizon?: number; force?: boolean } = {}) {
    const now = this.ctx.currentTime;
    const immediate = opts.immediate ?? false;
    if (!immediate && !opts.force && now - this.lastUpdate < 0.1) return;
    const dt = this.lastUpdate < 0 || immediate ? 1e3 : clamp(now - this.lastUpdate, 0, 1);
    this.lastUpdate = now;
    const rng = this.rng;

    // 气流：约 13·lg(q/q_ref) dB（边界层压力脉动 ∝ q，隔着壁板和内饰传进来，响度增长比 20·lg 慢），高频随 q 变亮
    const q = dynamicPressure(s.altitudeKm, s.speedKms) / Q_REF;
    this.gust = this.gust * 0.8 + gauss(rng) * 0.6; // AR(1)，方差 1
    const airDb = clamp(13 * Math.log10(Math.max(q, 1e-3)), -18, 3) + s.turbulence * 2.2 * this.gust;
    const tiltDb = clamp(8 * Math.log10(Math.max(q, 1e-3)), -8, 2);

    // 推力：爬升 1.0、下降慢车 0.3、平飞随高度（低空带襟翼约 0.62，巡航 0.8）；发动机加减速很慢（τ ≈ 3 s）
    const level = 0.62 + 0.18 * smoothstep(s.altitudeKm, 2, 9);
    const thrustTarget = s.climb > 0 ? 1 : s.climb < 0 ? 0.3 : level;
    this.thrust += (thrustTarget - this.thrust) * (1 - Math.exp(-dt / 3));
    const n1 = 0.22 + 0.78 * this.thrust;
    const engineDb = 30 * Math.log10(Math.max(this.thrust, 0.05) / 0.8) + interp(WING_POS_DB, s.wingRootLE);

    // 襟翼 / 缝翼：按偏角（襟翼为主）× 动压（相对进近动压 ≈ 巡航的 0.25）
    const flapAmt = clamp((s.flapDeg / 40) * 0.8 + (s.slatDeg / 27) * 0.2, 0, 1);
    const qApp = Math.max(q, 0.02) / 0.25;
    const flapLin = flapAmt * Math.sqrt(qApp);
    // 扰流板：抖振是一阵一阵的
    const spoilerLin = clamp(s.spoilerDeg / 30, 0, 1) * Math.sqrt(qApp) * (0.55 + 0.9 * rng());

    // 云里：液态水 → 雨打窗；过冷 / 冰晶 → 细沙声。响度随云密度与空速
    const cloud = smoothstep(s.inCloud, 0.01, 0.1) * (0.5 + 0.5 * clamp(s.inCloud / 0.5, 0, 1));
    const liquid = smoothstep(s.airTempC, -15, -8);
    const speedF = Math.sqrt(clamp(s.speedKms / 0.25, 0.2, 1.2));
    const rainLin = cloud * liquid * speedF;
    this.iceMod = this.iceMod * 0.7 + (0.4 + rng() * 0.9) * 0.3;
    const iceLin = cloud * (1 - liquid) * speedF * this.iceMod;
    const airconLin = this.options.aircon ? 1 : 0;

    const tb = clamp(s.turbulence, 0, 1);
    const thumpRate = tb < 0.12 ? 0 : 1.6 * Math.pow(tb, 1.5);
    const creakRate = 0.12 * Math.max(0, tb - 0.25);
    this.targets = { airDb, tiltDb, thrust: this.thrust, n1Hz: N1_100_HZ * n1, engineDb, flapLin, spoilerLin, rainLin, iceLin, airconLin, thumpRate, creakRate };

    const im = immediate;
    this.set(this.air.gain.gain, dbToLin(airDb), 0.25, im);
    this.set(this.air.shelf.gain, tiltDb, 1.5, im);
    this.set(this.air.pan.pan, 0.12 * s.seatSign, 0.5, im);
    this.set(this.rumble.gain, dbToLin(engineDb), 1.2, im);
    this.tones.forEach((t, i) => {
      this.set(t.osc.frequency, N1_100_HZ * n1 * (i ? ENGINE_DETUNE : 1), 2.5, im);
      // 窗这一侧的那台（i = 0）更近
      this.set(t.gain.gain, dbToLin(engineDb + (i ? -3 : 0)), 1.2, im);
      this.set(t.pan.pan, (i ? -0.25 : 0.35) * s.seatSign, 0.5, im);
    });
    this.set(this.flap.gain, flapLin, 1.5, im);
    this.set(this.spoiler.gain, spoilerLin, 0.08, im);
    this.set(this.rain.gain.gain, rainLin, 0.6, im);
    this.set(this.rain.pan.pan, 0.45 * s.seatSign, 0.5, im);
    this.set(this.ice.gain.gain, iceLin, 0.15, im);
    this.set(this.ice.pan.pan, 0.3 * s.seatSign, 0.5, im);
    this.set(this.aircon.gain, airconLin, 1.5, im);

    // 事件：泊松过程，预排到 horizon 内
    const horizon = now + (opts.horizon ?? 0.25);
    const exp = (rate: number) => -Math.log(1 - rng()) / rate;
    if (thumpRate <= 0) this.nextThump = Infinity;
    else if (!isFinite(this.nextThump)) this.nextThump = now + exp(thumpRate);
    while (this.nextThump < horizon) {
      this.thump(this.nextThump, tb);
      this.nextThump += exp(thumpRate);
    }
    if (creakRate <= 0) this.nextCreak = Infinity;
    else if (!isFinite(this.nextCreak)) this.nextCreak = now + exp(creakRate);
    while (this.nextCreak < horizon) {
      this.creak(this.nextCreak, s.seatSign);
      this.nextCreak += exp(creakRate);
    }
    // 提示音：平均 25 分钟一次，至少隔 8 分钟
    if (!this.options.chime) this.nextChime = Infinity;
    else if (!isFinite(this.nextChime)) this.nextChime = now + 480 + exp(1 / 1020);
    while (this.nextChime < horizon) {
      this.chimeAt(this.nextChime);
      this.nextChime += 480 + exp(1 / 1020);
    }
  }

  /** 播放一次性的缓冲：源 → （可选滤波）→ 增益包络 → 事件总线 */
  private oneShot(buf: AudioBuffer, when: number, dur: number, env: Float32Array, peak: number, opts: { offset?: number; rate?: number; filters?: BiquadFilterNode[]; pan?: number; loop?: boolean } = {}) {
    const ctx = this.ctx;
    const src = ctx.createBufferSource();
    src.buffer = buf;
    src.loop = opts.loop ?? false;
    if (opts.rate) src.playbackRate.value = opts.rate;
    const g = ctx.createGain();
    g.gain.value = 0;
    const scaled = env.map((v) => v * peak);
    g.gain.setValueCurveAtTime(scaled, when, dur);
    let node: AudioNode = src;
    for (const f of opts.filters ?? []) node = node.connect(f);
    node.connect(g);
    if (opts.pan) {
      const p = ctx.createStereoPanner();
      p.pan.value = opts.pan;
      g.connect(p).connect(this.events);
    } else g.connect(this.events);
    src.start(when, opts.offset ?? 0);
    src.stop(when + dur + 0.05);
    return src;
  }

  private lowpass(f: number, q = 0.707) {
    const b = this.ctx.createBiquadFilter();
    b.type = "lowpass";
    b.frequency.value = f;
    b.Q.value = q;
    return b;
  }

  /** 颠簸闷响：棕噪经 70–110 Hz 低通，20 ms 起、约 0.2 s 衰减 */
  private thump(when: number, tb: number) {
    const dur = 0.7;
    const env = new Float32Array(64);
    for (let i = 0; i < env.length; i++) {
      const t = (i / (env.length - 1)) * dur;
      env[i] = Math.min(t / 0.02, 1) * Math.exp(-Math.max(t - 0.02, 0) / 0.2);
    }
    env[env.length - 1] = 0;
    const peak = (0.7 + 0.8 * this.rng()) * tb;
    this.oneShot(this.brown, when, dur, env, peak, { offset: this.rng() * this.brown.duration,
      loop: true, filters: [this.lowpass(70 + this.rng() * 40, 0.9)] });
  }

  /** 一声轻微的咯吱（很克制：峰值约为气流层 RMS 的 0.2–0.35 倍，但落在气流层本来很弱的 1–3 kHz） */
  private creak(when: number, seatSign: number) {
    const buf = this.creaks[Math.floor(this.rng() * this.creaks.length)];
    const dur = buf.duration;
    const env = new Float32Array([1, 1, 1, 1, 0]);
    this.oneShot(buf, when, dur, env, AIRFLOW_RMS * (0.2 + 0.15 * this.rng()), { rate: 0.85 + this.rng() * 0.3, pan: (0.2 + this.rng() * 0.5) * seatSign * (this.rng() < 0.7 ? 1 : -1) });
  }

  /** 在 when 时刻放一次提示音 */
  chimeAt(when: number) {
    const env = new Float32Array([1, 1, 1, 1, 0]);
    this.oneShot(this.chime, when, this.chime.duration, env, AIRFLOW_RMS * 1.0);
  }

  /** 雷声延迟（秒）：距离 / 声速 */
  static thunderDelay(distanceKm: number) {
    return (distanceKm * 1000) / SOUND_SPEED;
  }

  /** 闪电：按距离延迟后打雷。distanceKm：闪电通道到飞机的距离；cg：云地闪（近处多一声炸裂） */
  lightning(distanceKm: number, cg: boolean) {
    if (distanceKm > THUNDER_MAX_KM) return;
    this.thunderAt(this.ctx.currentTime + Soundscape.thunderDelay(distanceKm), distanceKm, cg);
  }

  /**
   * 在 when 时刻打一次雷。响度随距离按 16·lg 衰减（比球面扩散的 20·lg 缓，远雷拉长后能量更分散，听感上补一点；2 km 处 +12 dB，参考为 BROWN 表）。
   * 离线检查：3 km 的雷在 150 Hz 以下高出巡航底噪约 9 dB，10 km 与底噪相当，30 km 低约 10 dB，两级低通的截止频率随距离下降
   * （空气吸收 + 机舱隔声都更吃高频）：2 km ≈ 1.2 kHz、10 km ≈ 380 Hz、30 km ≈ 140 Hz。
   * 包络：近处是 15 ms 的炸裂 + 几团翻滚；远处是慢慢涌起的几团低沉滚动，时长随距离变长（通道各段到飞机的距离差越拉越开）
   */
  thunderAt(when: number, distanceKm: number, cg: boolean) {
    const rng = this.rng;
    const d = Math.max(distanceKm, 1.5);
    const dur = 3.5 + Math.min(d, 30) * 0.18 + (cg ? 1 : 0);
    const now = this.ctx.currentTime;
    this.thunderSlots = this.thunderSlots.filter(([, t1]) => t1 > now);
    if (this.thunderSlots.filter(([t0, t1]) => t0 < when + dur && t1 > when).length >= THUNDER_MAX_OVERLAP) return;
    this.thunderSlots.push([when, when + dur]);
    const n = 512;
    const env = new Float32Array(n);
    const near = d < 5;
    const rise = near ? 0.015 : 0.15 + d * 0.03;
    const lobes = 3 + Math.floor(rng() * 4) + (cg ? 1 : 0);
    const lobeT: number[] = [], lobeA: number[] = [], lobeW: number[] = [];
    for (let i = 0; i < lobes; i++) {
      lobeT.push(rise + rng() * dur * 0.55);
      lobeA.push(0.35 + rng() * 0.65);
      lobeW.push(0.25 + rng() * (0.4 + d * 0.03));
    }
    let peak = 0;
    for (let i = 0; i < n; i++) {
      const t = (i / (n - 1)) * dur;
      let v = 0;
      for (let k = 0; k < lobes; k++) v += lobeA[k] * Math.exp(-(((t - lobeT[k]) / lobeW[k]) ** 2));
      if (near) v += (cg ? 1.6 : 1.0) * Math.exp(-Math.max(t - rise, 0) / 0.12);
      v *= smoothstep(t, 0, rise) * Math.exp(-t / (dur * 0.45));
      env[i] = v;
      peak = Math.max(peak, v);
    }
    for (let i = 0; i < n; i++) env[i] /= peak;
    env[n - 1] = 0;
    const fc = clamp(3000 / (1 + d * 0.7), 90, 2000);
    const gainDb = 12 - 16 * Math.log10(d / 2) + (cg ? 2 : 0);
    this.oneShot(this.brown, when, dur, env, dbToLin(gainDb), {
      offset: rng() * this.brown.duration,
      loop: true, // 雷声可能比棕噪缓冲（约 5.5 s）长
      filters: [this.lowpass(fc, 0.6), this.lowpass(fc * 1.3, 0.6)],
      pan: (rng() - 0.5) * 0.4,
    });
  }

  /** 淡入 / 淡出主音量 */
  setMaster(v: number, tau = 0.8) {
    this.master.gain.setTargetAtTime(v, this.ctx.currentTime, tau);
  }

  dispose() {
    for (const s of this.sources) {
      try {
        s.stop();
      } catch {
        /* 已停 */
      }
    }
    this.master.disconnect();
  }
}

// ---------------------------------------------------------------------------------------------
// 控制器：面板开关 / 音量、主循环每帧调用
// ---------------------------------------------------------------------------------------------

const STORAGE_KEY = "voyage.sound";

/** 面板与主循环用的声音控制器。默认静音；enable() 必须在用户手势（点击 / 按键）里调用，浏览器才允许出声 */
export class CabinAudio {
  enabled = false;
  /** 0..1，面板滑块；实际增益取平方（感知上更均匀） */
  volume = 0.6;
  options: SoundOptions = { ...DEFAULT_SOUND_OPTIONS };
  private ctx: AudioContext | null = null;
  private scape: Soundscape | null = null;
  private building: Promise<void> | null = null;
  private suspendTimer = 0;
  private lastInput: AudioInput | null = null;
  /** 主线程上 update 的累计耗时（毫秒）与调用次数：量 CPU 开销用 */
  readonly cost = { ms: 0, calls: 0 };
  /** 状态变化时通知面板（例如按 M 键切换） */
  onChange: (() => void) | null = null;

  constructor() {
    try {
      const saved = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? "null") as { volume?: number; aircon?: boolean; chime?: boolean } | null;
      if (saved) {
        if (typeof saved.volume === "number") this.volume = clamp(saved.volume, 0, 1);
        if (typeof saved.aircon === "boolean") this.options.aircon = saved.aircon;
        if (typeof saved.chime === "boolean") this.options.chime = saved.chime;
      }
    } catch {
      /* 无痕模式 / 存储被禁：用默认值 */
    }
  }

  private save() {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify({ volume: this.volume, ...this.options }));
    } catch {
      /* 忽略 */
    }
  }

  private gain() {
    return this.volume * this.volume;
  }

  /** 开启声音：第一次调用时创建 AudioContext 并合成缓冲（约几百毫秒），之后淡入 */
  async enable() {
    this.enabled = true;
    window.clearTimeout(this.suspendTimer);
    this.onChange?.();
    try {
      if (!this.ctx) {
        // playback：让浏览器用更大的音频缓冲，CPU 更省（背景声不需要低延迟）
        this.ctx = new AudioContext({ latencyHint: "playback" });
        const scape = new Soundscape(this.ctx, this.options, (Math.random() * 2 ** 32) >>> 0);
        scape.output.connect(this.ctx.destination);
        this.building = scape.build().then(() => {
          this.scape = scape;
        });
      }
      await this.ctx.resume();
      await this.building;
    } catch (err) {
      console.warn("声音启用失败（浏览器不支持 Web Audio？）", err);
      this.enabled = false;
      this.onChange?.();
      return;
    }
    if (!this.enabled || !this.scape) return;
    if (this.lastInput) this.scape.update(this.lastInput, { immediate: true });
    this.scape.setMaster(this.gain(), 0.9);
  }

  /** 关闭：淡出后挂起 AudioContext（挂起后音频线程不再消耗 CPU） */
  disable() {
    this.enabled = false;
    this.onChange?.();
    if (!this.ctx || !this.scape) return;
    this.scape.setMaster(0, 0.15);
    const ctx = this.ctx;
    this.suspendTimer = window.setTimeout(() => {
      if (!this.enabled) void ctx.suspend();
    }, 900);
  }

  toggle() {
    if (this.enabled) this.disable();
    else void this.enable();
  }

  setVolume(v: number) {
    this.volume = clamp(v, 0, 1);
    this.save();
    if (this.enabled && this.scape) this.scape.setMaster(this.gain(), 0.1);
  }

  setOption(key: keyof SoundOptions, on: boolean) {
    this.options[key] = on;
    this.save();
    if (this.scape) {
      this.scape.options[key] = on;
      if (this.lastInput) this.scape.update(this.lastInput, { force: true });
    }
  }

  /** 每帧调用（内部节流到 10 Hz）。没开声音时只记下输入 */
  update(input: AudioInput) {
    this.lastInput = input;
    if (!this.enabled || !this.scape) return;
    const t0 = performance.now();
    this.scape.update(input);
    this.cost.ms += performance.now() - t0;
    this.cost.calls++;
  }

  /** 闪电事件（weather.onFlash）：distanceKm 为闪电到飞机的距离 */
  lightning(distanceKm: number, cg: boolean) {
    if (!this.enabled || !this.scape) return;
    this.scape.lightning(distanceKm, cg);
  }

  /** 调试：音频上下文、当前目标 */
  debug() {
    return { state: this.ctx?.state ?? "none", sampleRate: this.ctx?.sampleRate, baseLatency: this.ctx?.baseLatency, targets: this.scape?.targets ?? null, cost: this.cost };
  }
}
