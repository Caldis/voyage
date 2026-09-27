import { gauss, makeBuffer, makeRng, rms, spectrumTotalDb, synthNoise, type Rng, type Spectrum } from "../audio";
import type { Corridor } from "./corridor";
import type { Train, TrainPose } from "./train";
import { EYE_HEIGHT_M } from "./train";
import {
  Announcer,
  BELL_ALTERNATE,
  BELL_FREQS_HZ,
  BELL_HOLD_S,
  BELL_WARN_MAX_M,
  BELL_WARN_S,
  JointTrack,
  RAIL_HALF_M,
  SOUND_SPEED_MS,
  consistAxles,
  consistEnds,
  crossingDevices,
  hash01,
  jointHits,
  turnoutsFromTracks,
  type Announcement,
  type Axle,
  type BellDevice,
  type JointMode,
} from "./sound-model";

/**
 * 火车的声音（TR07）：火车模式下代替飞机的舱内声场。和 audio.ts 同一套做法——噪声床用频域合成的可循环噪声、
 * 连续量用 setTargetAtTime 缓变、离散事件按确定时刻预排到音频时间轴上（只预排 0.3 s）。
 *
 * 声源（详细参数、出处 / 估值见 handoff/TR07.md）：
 * - 接缝「ガタンゴトン」：按 sound-model.ts 的几何（25 m 钢轨、台车中心距 13.8 m、轴距 2.1 m、3 辆编组坐中间）
 *   算出每根车轴过每处接缝的时刻；每下 = 车体低频共振 + 很短的金属声，左右轨稍错开，每处接缝强度 / 音色不同；
 * - 滚动噪声：宽带，约 30·lg(v) dB（Thompson 2009 的经验关系，按记忆引用、待核 → 估）；轮轨粗糙度的低频随里程起伏；
 * - 电机 / 变频器：音调随车速爬升、分段换挡（**示意**，不仿任何车型）；
 * - 弯道尖啸：半径 < 约 330 m 且车速够时，按弯道随机决定有没有，一阵一阵（估）；
 * - 空调底噪；制动（电制动时变频器音下行、低速时闸瓦摩擦、停稳一顿、排气「プシュ」）、停车后的静；
 * - 道口警报（700 / 750 Hz、每分钟 130 次，出处见 sound-model.ts）：按几何算传播延迟、多普勒（距离变化率）、距离衰减、车体隔声；
 * - 车内广播：只做听不清内容的喃喃声（随机元音的共振峰合成），不录制、不采样任何真实广播；站名走面板字幕。
 */

// ---------------------------------------------------------------------------------------------
// 频谱表（伪 dB，和 audio.ts 同一口径；这里整体参考是 ROLL 表 = ROLL_RMS）
// ---------------------------------------------------------------------------------------------

/** 90 km/h 车内的滚动噪声（估：在来线电车车内的典型形状——低频结构传声最强、500 Hz 以上逐渐下降） */
const ROLL: Spectrum = [[16, 52], [31.5, 62], [63, 68], [125, 70], [250, 70], [500, 68], [1000, 63], [2000, 57], [4000, 50], [8000, 41], [16000, 28]];
/** 轮轨粗糙度 / 轨道不平顺激起的车体低频（「ゴー」），随里程起伏 */
const RUMBLE: Spectrum = [[16, 58], [31.5, 66], [63, 69], [125, 64], [250, 55], [500, 45], [1000, 36]];
/** 车顶空调出风 + 风机（估：停车时是主要的声音） */
const AIRCON: Spectrum = [[63, 44], [125, 50], [250, 54], [500, 55], [1000, 54], [2000, 51], [4000, 46], [8000, 38], [16000, 26]];
/** 闸瓦 / 闸片摩擦的「シャー」 */
const FRICTION: Spectrum = [[500, 40], [1000, 50], [2000, 56], [4000, 55], [8000, 48], [16000, 36]];
/** 排气「プシュ」 */
const HISS: Spectrum = [[500, 40], [1000, 48], [2000, 55], [4000, 60], [8000, 60], [16000, 50]];

/** ROLL 表整体（90 km/h）对应的 RMS：−31 dBFS（音量 100%）。比飞机巡航底噪（−26）轻约 5 dB：电车车内本来比客机安静（估） */
const ROLL_RMS = 0.028;
/** 参考车速（m/s）：90 km/h */
const V_REF = 25;

/** 接缝撞击的峰值（本车最近一根轴、强度 1、90 km/h）。约 −21 dBFS，比滚动噪声的峰值高、但不碰压缩器 */
const IMPACT_PEAK = 0.09;
/** 撞击响度随车速：∝ (v/V_REF)^IMPACT_SPEED_EXP（估：冲击速度 ∝ v） */
const IMPACT_SPEED_EXP = 1.0;
/** 道口警报：离喇叭 3.5 m、车外时的峰值（相对满幅，估），再乘车体隔声 BELL_TL_DB。
 *  取值让经过的一两秒里警报在 500 Hz–1 kHz 比滚动噪声高出几 dB（坐在在来线车里经过道口时能清楚听到），50 m 外已埋进底噪 */
const BELL_PEAK_AT_3M5 = 0.6;
/** 车体 / 窗对 700 Hz 附近的隔声（dB，估：在来线车窗的隔声量级 25–30 dB） */
const BELL_TL_DB = -27;
/** 超过这个距离不排警报声（米）：已经比滚动噪声低 20 dB 以上 */
const BELL_MAX_R = 450;

/** 牵引：动轮直径（米，估：新品 860 mm）、齿轮比（估：通勤电车 6–7 的量级）、小齿轮齿数（估），4 极电机 */
const WHEEL_D_M = 0.86;
const GEAR_RATIO = 6.06;
const PINION_TEETH = 17;
const POLE_PAIRS = 2;
/** 变频器调制（**示意**）：[到这个车速（km/h）为止, 每个电周期的脉冲数（0 = 异步、载波固定）] */
const VVVF_STEPS: ReadonlyArray<readonly [number, number]> = [[25, 0], [35, 27], [50, 15], [65, 9], [75, 3], [999, 1]];
/** 异步段的固定载波（Hz，示意） */
const VVVF_ASYNC_HZ = 1000;

/** 弯道尖啸：半径在这个区间内渐强（米，估：尖啸多见于小半径曲线） */
const SQUEAL_R_START = 330;
const SQUEAL_R_FULL = 260;
/** 满足条件的弯道里有多大比例会尖啸（估）：不是每次都叫 */
const SQUEAL_CHANCE = 0.55;

// ---------------------------------------------------------------------------------------------
// 小工具
// ---------------------------------------------------------------------------------------------

const clamp = (x: number, a: number, b: number) => Math.min(b, Math.max(a, x));
const smoothstep = (x: number, a: number, b: number) => {
  const t = clamp((x - a) / (b - a), 0, 1);
  return t * t * (3 - 2 * t);
};
const db2 = (db: number) => Math.pow(10, db / 20);

/** 一维值噪声（里程上的轨道状况）：cell 米一格、相邻格 smoothstep 插值，输出 −1..1，确定性 */
function valueNoise(s: number, cell: number, salt: number) {
  const x = s / cell, i = Math.floor(x), t = x - i;
  const a = hash01(i, salt) * 2 - 1, b = hash01(i + 1, salt) * 2 - 1;
  return a + (b - a) * t * t * (3 - 2 * t);
}

// ---------------------------------------------------------------------------------------------
// 线路与每帧输入
// ---------------------------------------------------------------------------------------------

export interface RailTrackInfo {
  /** 道口里程（米，烘焙数据 levelCrossings） */
  crossings: number[];
  /** 道岔里程（米，推断） */
  turnouts: number[];
  /** 平均曲率（1/m，带符号） */
  curvature(s: number): number;
  /** 这里是不是桥 */
  bridge(s: number): boolean;
}

export interface RailFrame {
  /** 听者所在车厢中心的里程（米）、行驶方向 */
  s: number;
  dir: 1 | -1;
  /** 车速（m/s，模拟时间） */
  speed: number;
  /** 牵引 / 制动出力：+1 全力加速，−1 全力制动，巡航维持约 0.1 */
  effort: number;
  /** 停站剩余秒数（行驶中 0） */
  dwell: number;
  /** 眼睛的横向位置（米，+ = 往信濃大町方向左侧） */
  eyeD: number;
  /** 1 右座 / −1 左座 */
  seatSign: number;
}

export interface RailSoundOptions {
  aircon: boolean;
  joints: JointMode;
}

export interface RailTargets {
  rollDb: number;
  rumbleDb: number;
  motorHz: number;
  motorPulses: number;
  motorLin: number;
  gearHz: number;
  squealLin: number;
  frictionLin: number;
  rateEst: number;
  fastForward: boolean;
  jointsScheduled: number;
  bellStrikes: number;
  bellsOn: number;
}

interface BellState {
  on: boolean;
  tOn: number;
  /** 每台警报机下一次要排的断续序号 */
  next: number[];
  devices: BellDevice[];
}

/** 声音图：噪声床（滚动、低频、空调、摩擦）+ 音调（变频器、齿轮、尖啸、制动尖叫）+ 事件（接缝、道口、停车、广播）→ 主音量 → 压缩器 */
export class RailSoundscape {
  readonly ctx: BaseAudioContext;
  readonly master: GainNode;
  readonly output: AudioNode;
  readonly track: RailTrackInfo;
  readonly joints: JointTrack;
  options: RailSoundOptions;
  targets: RailTargets | null = null;
  /** 调试 / 检查：最近排程的接缝撞击（音频时刻、车轴、左右轨） */
  readonly log: { joints: { t: number; axle: number; rail: number; gain: number }[]; bells: { t: number; rate0: number; rate1: number; r: number }[] } = { joints: [], bells: [] };
  logEnabled = false;

  bed!: GainNode;
  events!: GainNode;
  private rng: Rng;
  private scale = 1;
  private axles: Axle[];
  private ends: [number, number];
  private roll!: { gain: GainNode; shelf: BiquadFilterNode };
  private rumble!: GainNode;
  private aircon!: GainNode;
  private friction!: GainNode;
  private hiss!: AudioBuffer;
  private motor!: { osc: OscillatorNode; gain: GainNode; sbA: OscillatorNode; sbB: OscillatorNode; sbGain: GainNode; gear: OscillatorNode; gearGain: GainNode };
  private squeal!: { a: OscillatorNode; b: OscillatorNode; gain: GainNode; pan: StereoPannerNode };
  private brakeSqueal!: { osc: OscillatorNode; gain: GainNode };
  private impacts: AudioBuffer[] = [];
  private railBus!: [StereoPannerNode, StereoPannerNode];
  private bellBuf!: [AudioBuffer, AudioBuffer];
  private bellBus!: [StereoPannerNode, StereoPannerNode];
  private sources: AudioScheduledSourceNode[] = [];

  // 状态
  private lastUpdate = -1;
  private lastU: number | null = null;
  private lastDir: 1 | -1 = 1;
  private watermark = -Infinity;
  private rateEst = 1;
  private effort = 0;
  private prevSpeed = 0;
  private prevDwell = 0;
  private pulses = -1;
  private squealState = 0;
  private bells = new Map<number, BellState>();

  constructor(ctx: BaseAudioContext, track: RailTrackInfo, options: RailSoundOptions, seed = 1) {
    this.ctx = ctx;
    this.track = track;
    this.options = { ...options };
    this.rng = makeRng(seed);
    this.joints = new JointTrack({ mode: options.joints, turnouts: track.turnouts });
    this.axles = consistAxles();
    this.ends = consistEnds();
    this.master = ctx.createGain();
    this.master.gain.value = 0;
    const comp = ctx.createDynamicsCompressor();
    // 和 audio.ts 一样只当兜底限幅（自带约 +1.7 dB 补偿增益，见 README 坑点）
    comp.threshold.value = -3;
    comp.knee.value = 3;
    comp.ratio.value = 20;
    comp.attack.value = 0.003;
    comp.release.value = 0.3;
    this.master.connect(comp);
    this.output = comp;
  }

  async build() {
    const ctx = this.ctx;
    const sr = ctx.sampleRate;
    const yieldNow = () => new Promise<void>((r) => setTimeout(r, 0));
    const N = 1 << 18;
    const rollCh = synthNoise(ROLL, 1 << 19, sr, true, this.rng, 1);
    this.scale = ROLL_RMS / Math.sqrt((rms(rollCh[0]) ** 2 + rms(rollCh[1]) ** 2) / 2);
    for (const c of rollCh) for (let i = 0; i < c.length; i++) c[i] *= this.scale;
    const s = this.scale;
    await yieldNow();

    this.bed = ctx.createGain();
    this.bed.connect(this.master);
    this.events = ctx.createGain();
    this.events.connect(this.master);

    {
      const shelf = ctx.createBiquadFilter();
      shelf.type = "highshelf";
      shelf.frequency.value = 2000;
      const gain = ctx.createGain();
      gain.gain.value = 0;
      this.loop(makeBuffer(ctx, rollCh), shelf);
      shelf.connect(gain).connect(this.bed);
      this.roll = { gain, shelf };
    }
    // 低频：左右几乎完全相干（整节车体一起振）
    this.rumble = this.noiseLayer(synthNoise(RUMBLE, N, sr, true, this.rng, s, (f) => (f < 200 ? 0.97 : 0.6)));
    await yieldNow();
    this.aircon = this.noiseLayer(synthNoise(AIRCON, N, sr, true, this.rng, s));
    await yieldNow();
    this.friction = this.noiseLayer(synthNoise(FRICTION, 1 << 17, sr, true, this.rng, s));
    this.hiss = makeBuffer(ctx, synthNoise(HISS, 1 << 17, sr, true, this.rng, s, () => 0.3));
    await yieldNow();

    // 变频器 / 齿轮（示意）：主音 + 异步段的两条边带（载波 ± 2 倍电频率）
    {
      const refDb = spectrumTotalDb(ROLL);
      const wave = (harm: [number, number][]) => {
        const real = new Float32Array(harm.length + 1), imag = new Float32Array(harm.length + 1);
        for (const [h, a] of harm) imag[h] = a;
        return ctx.createPeriodicWave(real, imag, { disableNormalization: true });
      };
      // 幅度按 ROLL 参考：主音伪 58 dB（明显但不刺耳，只在出力大时）
      const a0 = Math.SQRT2 * ROLL_RMS * db2(58 - refDb);
      const osc = ctx.createOscillator();
      osc.setPeriodicWave(wave([[1, a0], [2, a0 * 0.25], [3, a0 * 0.12]]));
      const gain = ctx.createGain();
      gain.gain.value = 0;
      osc.connect(gain).connect(this.bed);
      const sbGain = ctx.createGain();
      sbGain.gain.value = 0;
      const sbA = ctx.createOscillator(), sbB = ctx.createOscillator();
      const sbWave = wave([[1, a0 * 0.5]]);
      sbA.setPeriodicWave(sbWave);
      sbB.setPeriodicWave(sbWave);
      sbA.connect(sbGain);
      sbB.connect(sbGain);
      sbGain.connect(this.bed);
      const gear = ctx.createOscillator();
      gear.setPeriodicWave(wave([[1, Math.SQRT2 * ROLL_RMS * db2(50 - refDb)], [2, Math.SQRT2 * ROLL_RMS * db2(40 - refDb)]]));
      const gearGain = ctx.createGain();
      gearGain.gain.value = 0;
      gear.connect(gearGain).connect(this.bed);
      for (const o of [osc, sbA, sbB, gear]) {
        o.frequency.value = 100;
        o.start();
        this.sources.push(o);
      }
      this.motor = { osc, gain, sbA, sbB, sbGain, gear, gearGain };

      // 弯道尖啸：两条相近的纯音（车轮的轴向振型），隔着窗和地板
      const sqA = ctx.createOscillator(), sqB = ctx.createOscillator();
      const sqW = wave([[1, Math.SQRT2 * ROLL_RMS * db2(60 - refDb)], [2, Math.SQRT2 * ROLL_RMS * db2(46 - refDb)]]);
      sqA.setPeriodicWave(sqW);
      sqB.setPeriodicWave(sqW);
      const sqGain = ctx.createGain();
      sqGain.gain.value = 0;
      const sqPan = ctx.createStereoPanner();
      sqA.connect(sqGain);
      sqB.connect(sqGain);
      sqGain.connect(sqPan).connect(this.bed);
      for (const o of [sqA, sqB]) {
        o.frequency.value = 3000;
        o.start();
        this.sources.push(o);
      }
      this.squeal = { a: sqA, b: sqB, gain: sqGain, pan: sqPan };
      // 停车前的闸瓦尖叫「キー」
      const bs = ctx.createOscillator();
      bs.setPeriodicWave(sqW);
      bs.frequency.value = 3300;
      const bsGain = ctx.createGain();
      bsGain.gain.value = 0;
      bs.connect(bsGain).connect(this.bed);
      bs.start();
      this.sources.push(bs);
      this.brakeSqueal = { osc: bs, gain: bsGain };
    }

    // 接缝撞击的音色库 + 左右轨两条总线（靠窗那条轨略偏窗侧）
    for (let i = 0; i < this.joints.variants; i++) this.impacts.push(makeBuffer(ctx, [impactBuffer(sr, this.rng)]));
    this.railBus = [ctx.createStereoPanner(), ctx.createStereoPanner()];
    for (const b of this.railBus) b.connect(this.events);
    // 道口警报：700 / 750 Hz 两种原始断续音，每台警报机按自己的频率改播放速率
    this.bellBuf = [makeBuffer(ctx, [bellBuffer(sr, BELL_FREQS_HZ[0])]), makeBuffer(ctx, [bellBuffer(sr, BELL_FREQS_HZ[1])])];
    this.bellBus = [ctx.createStereoPanner(), ctx.createStereoPanner()];
    for (const b of this.bellBus) b.connect(this.events);
  }

  private loop(buf: AudioBuffer, dest: AudioNode) {
    const src = this.ctx.createBufferSource();
    src.buffer = buf;
    src.loop = true;
    src.connect(dest);
    src.start(0, this.rng() * buf.duration);
    this.sources.push(src);
  }

  private noiseLayer(chans: Float32Array[]) {
    const gain = this.ctx.createGain();
    gain.gain.value = 0;
    this.loop(makeBuffer(this.ctx, chans), gain);
    gain.connect(this.bed);
    return gain;
  }

  private set(p: AudioParam, v: number, tau: number, immediate: boolean) {
    const t = this.ctx.currentTime;
    if (immediate) {
      p.cancelScheduledValues(t);
      p.setValueAtTime(v, t);
    } else p.setTargetAtTime(v, t, tau);
  }

  /** 换接缝模式（面板开关） */
  setJointMode(mode: JointMode) {
    this.options.joints = mode;
    this.joints.mode = mode;
  }

  /**
   * 每帧（节流到 10 Hz）。immediate：连续量直接跳到目标；horizon：事件预排多远（秒）
   */
  update(f: RailFrame, opts: { immediate?: boolean; horizon?: number; force?: boolean } = {}) {
    const ctx = this.ctx;
    const now = ctx.currentTime;
    const im = opts.immediate ?? false;
    if (!im && !opts.force && now - this.lastUpdate < 0.1) return;
    const dtA = this.lastUpdate < 0 ? 0 : now - this.lastUpdate;
    this.lastUpdate = now;
    const horizon = opts.horizon ?? 0.3;
    const rng = this.rng;
    const v = Math.max(f.speed, 0);
    const u = f.dir * f.s;

    // 模拟时间流速的估计：面板加速播放时，列车在一个音频秒里走了好几秒的路——节奏类的声音没有意义，静掉事件（连续层照常）
    if (this.lastU !== null && f.dir === this.lastDir && dtA > 0.04 && v > 1) {
      const r = (u - this.lastU) / (dtA * v);
      if (isFinite(r)) this.rateEst += (clamp(r, 0, 100) - this.rateEst) * 0.4;
    }
    if (f.dir !== this.lastDir || this.lastU === null || Math.abs(u - this.lastU) > 500) {
      // 折返、跳位置：重新开始排程
      this.watermark = u;
      this.bells.clear();
    }
    this.lastU = u;
    this.lastDir = f.dir;
    const fast = this.rateEst > 1.6;

    // 出力缓变（牵引 / 制动的建立约 0.4 s）
    this.effort += (f.effort - this.effort) * (im ? 1 : 1 - Math.exp(-dtA / 0.4));
    const eff = this.effort;
    const vr = Math.max(v, 0.05) / V_REF;
    const moving = smoothstep(v, 0.3, 2.5);

    // 滚动噪声 ≈ 30·lg(v/v_ref)（估）；高频随车速变亮
    const rollDb = clamp(30 * Math.log10(vr), -40, 3);
    const tilt = clamp(10 * Math.log10(vr), -9, 1);
    // 轮轨粗糙度：里程上 35 m / 160 m 两个尺度的起伏 ±3 dB；桥上 +4 dB（估，示意）
    const rough = 2.2 * valueNoise(f.s, 35, 41) + 1.2 * valueNoise(f.s, 160, 42);
    const bridge = this.track.bridge(f.s) ? 4 : 0;
    const rumbleDb = clamp(30 * Math.log10(vr), -40, 3) + rough + bridge;
    this.set(this.roll.gain.gain, moving * db2(rollDb), 0.3, im);
    this.set(this.roll.shelf.gain, tilt, 1, im);
    this.set(this.rumble.gain, moving * db2(rumbleDb), 0.35, im);
    this.set(this.aircon.gain, this.options.aircon ? 1 : 0, 1.5, im);

    // 电机 / 变频器（示意）
    const kmh = v * 3.6;
    const rev = (v / (Math.PI * WHEEL_D_M)) * GEAR_RATIO; // 电机转速（转 / 秒）
    const fe = POLE_PAIRS * rev; // 电频率（Hz，忽略转差）
    let pulses = 1;
    for (const [lim, p] of VVVF_STEPS) {
      if (kmh <= lim) {
        pulses = p;
        break;
      }
    }
    const motorHz = pulses === 0 ? VVVF_ASYNC_HZ : Math.max(pulses * fe, 20);
    const load = Math.abs(eff);
    // 1 脉冲区（高速）只剩电机本身的电磁音，很轻
    const motorLin = v < 0.2 ? 0 : load * (pulses === 1 ? 0.35 : 1) * smoothstep(v, 0.2, 1.2);
    if (pulses !== this.pulses) {
      // 换挡：音高一下子跳（特征），不缓变
      this.motor.osc.frequency.cancelScheduledValues(now);
      this.motor.osc.frequency.setValueAtTime(motorHz, now);
      this.pulses = pulses;
    } else this.set(this.motor.osc.frequency, motorHz, 0.06, im);
    this.set(this.motor.gain.gain, motorLin, 0.12, im);
    this.set(this.motor.sbA.frequency, VVVF_ASYNC_HZ + 2 * fe, 0.06, im);
    this.set(this.motor.sbB.frequency, Math.max(VVVF_ASYNC_HZ - 2 * fe, 50), 0.06, im);
    this.set(this.motor.sbGain.gain, pulses === 0 ? motorLin : 0, 0.08, im);
    const gearHz = Math.max(PINION_TEETH * rev, 20);
    this.set(this.motor.gear.frequency, gearHz, 0.06, im);
    this.set(this.motor.gearGain.gain, moving * Math.min(vr * vr, 1.4) * (0.4 + 0.6 * load), 0.2, im);

    // 弯道尖啸：小半径 + 车速够，按弯道（每 120 m 一段）随机决定会不会叫，叫起来一阵一阵
    const k = Math.abs(this.track.curvature(f.s));
    const R = k > 1e-6 ? 1 / k : Infinity;
    const seg = Math.floor(f.s / 120);
    const may = hash01(seg, 51) < SQUEAL_CHANCE ? smoothstep(R, SQUEAL_R_START, SQUEAL_R_FULL) * smoothstep(v, 3, 8) : 0;
    // 马尔可夫开关：叫着的时候 75% 继续，停着的时候 30% 开始
    this.squealState = may > 0 && rng() < (this.squealState > 0 ? 0.75 : 0.3) ? 0.5 + 0.5 * rng() : 0;
    const squealLin = fast ? 0 : may * this.squealState;
    const sqF = 2400 + 1800 * hash01(seg, 52);
    this.set(this.squeal.a.frequency, sqF * (1 + (rng() - 0.5) * 0.006), 0.05, im);
    this.set(this.squeal.b.frequency, sqF * 1.013 * (1 + (rng() - 0.5) * 0.006), 0.05, im);
    this.set(this.squeal.gain.gain, squealLin, 0.04, im);
    this.set(this.squeal.pan.pan, 0.3 * f.seatSign, 0.5, im);

    // 制动：低速时闸瓦摩擦「シャー」（电制动在约 8 km/h 以下失效、换成空气制动，估）
    const braking = eff < -0.2 ? clamp(-eff, 0, 1) : 0;
    const frictionLin = braking * smoothstep(v, 7, 2.2) * smoothstep(v, 0.05, 0.6) * 0.9;
    this.set(this.friction.gain, frictionLin, 0.15, im);

    // 停稳 / 起步事件
    if (!fast && this.prevSpeed > 0.25 && v <= 0.02 && f.dwell > 0) this.onStop(now, f.seatSign);
    if (!fast && this.prevDwell > 0 && f.dwell <= 0) this.onDepart(now);
    // 停稳前 1 s 左右，约一半的停车有一声「キー」
    if (!fast && braking > 0 && v < 1.6 && this.prevSpeed >= 1.6 && rng() < 0.5) this.brakeSquealAt(now + (v / 0.7) * 0.2, (v / 0.7) * 0.9);
    this.prevSpeed = v;
    this.prevDwell = f.dwell;

    // 事件：接缝、道口
    let jointsScheduled = 0, bellStrikes = 0;
    // 左轨在 d > 0；眼睛在 eyeD 一侧，离得近的那条轨响一点（1/r，r 取到耳朵的直线距离），声像偏窗侧
    const rNear = [Math.hypot(f.eyeD - RAIL_HALF_M, 2.4), Math.hypot(f.eyeD + RAIL_HALF_M, 2.4)];
    const railGain = [Math.min(rNear[0], rNear[1]) / rNear[0], Math.min(rNear[0], rNear[1]) / rNear[1]];
    for (const r of [0, 1]) this.railBus[r].pan.value = (rNear[r] <= rNear[1 - r] ? 0.22 : -0.08) * f.seatSign;
    if (v > 1 && !fast) {
      const uEnd = u + v * horizon;
      let from = Math.max(this.watermark, u);
      // 落后太多（卡顿）：不补排，免得一串撞击挤在一起
      if (this.watermark < u - 2) from = u;
      const hits = jointHits(from, uEnd, f.dir, this.axles, this.joints);
      const speedF = Math.pow(vr, IMPACT_SPEED_EXP);
      for (const h of hits) {
        const t = now + Math.max(h.u - u, 0) / v;
        const ax = this.axles[h.axle];
        const g = IMPACT_PEAK * speedF * db2(ax.gainDb + gauss(rng) * 1.2) * h.joint.strength * railGain[h.rail];
        if (g < IMPACT_PEAK * 0.03) continue;
        // 同一处接缝的音色一样（variant），每根轴再有 ±3% 的音高差；慢的时候整体偏闷一点
        const buf = this.impacts[(h.joint.variant + (ax.car === 1 ? 0 : 1)) % this.impacts.length];
        const rate = (0.97 + 0.06 * rng()) * (0.9 + 0.1 * Math.min(vr, 1));
        this.playAt(buf, t, g, rate, this.railBus[h.rail]);
        if (this.logEnabled) this.log.joints.push({ t, axle: h.axle, rail: h.rail, gain: g });
        jointsScheduled++;
      }
      this.watermark = uEnd;
    } else this.watermark = u;

    const bellsOn = this.updateBells(now, u, f, v, horizon, fast);
    bellStrikes = this.lastBellStrikes;

    this.targets = { rollDb, rumbleDb, motorHz, motorPulses: pulses, motorLin, gearHz, squealLin, frictionLin, rateEst: +this.rateEst.toFixed(2), fastForward: fast, jointsScheduled, bellStrikes, bellsOn };
  }

  private lastBellStrikes = 0;

  /** 道口：按车头 / 车尾决定哪些道口在响；把在响的警报机的断续音排到 horizon 内（按接收时刻） */
  private updateBells(now: number, u: number, f: RailFrame, v: number, horizon: number, fast: boolean) {
    let on = 0;
    this.lastBellStrikes = 0;
    const [headA, rearA] = this.ends;
    const head = u + headA, rear = u + rearA;
    const list = this.track.crossings;
    for (let i = 0; i < list.length; i++) {
      const Uc = f.dir * list[i];
      if (Uc < rear - 200 || Uc > head + BELL_WARN_MAX_M + 50) {
        this.bells.delete(i);
        continue;
      }
      let st = this.bells.get(i);
      const ahead = Uc - head;
      if (!st?.on) {
        // 开始：到达前 BELL_WARN_S 秒（按当前车速），最远 BELL_WARN_MAX_M；停着的车不触发
        if (rear < Uc && ahead <= Math.min(BELL_WARN_MAX_M, v * BELL_WARN_S) && v > 0.5) {
          const devices = crossingDevices(i);
          st = { on: true, tOn: now + 0.05, next: devices.map(() => 0), devices };
          this.bells.set(i, st);
        } else continue;
      }
      // 结束：车尾过了道口再响 BELL_HOLD_S
      if (rear > Uc + Math.max(v, 1) * BELL_HOLD_S) {
        this.bells.delete(i);
        continue;
      }
      on++;
      if (fast) continue;
      for (let d = 0; d < st.devices.length; d++) this.scheduleBell(now, u, f, v, horizon, list[i], st, d);
    }
    return on;
  }

  /** 听者在时刻 t 的走廊位置（按当前车速外推；只用于未来零点几秒） */
  private listenerAt(t: number, now: number, u: number, f: RailFrame, v: number): [number, number, number] {
    return [f.dir * (u + v * (t - now)), f.eyeD, EYE_HEIGHT_M];
  }

  private scheduleBell(now: number, u: number, f: RailFrame, v: number, horizon: number, sc: number, st: BellState, di: number) {
    const dev = st.devices[di];
    const T = 60 / dev.perMin;
    const src: [number, number, number] = [sc + dev.ds, dev.d, dev.h];
    const dist = (t: number) => {
      const p = this.listenerAt(t, now, u, f, v);
      return Math.hypot(p[0] - src[0], p[1] - src[1], p[2] - src[2]);
    };
    const c = SOUND_SPEED_MS;
    for (;;) {
      const k = st.next[di];
      const te = st.tOn + dev.phase * T + k * T;
      // 接收时刻：tr = te + r(tr)/c（迭代）
      let tr = te + dist(te) / c;
      for (let it = 0; it < 4; it++) tr = te + dist(tr) / c;
      if (tr > now + horizon) break;
      st.next[di] = k + 1;
      if (tr < now - 0.005) continue; // 已经错过（刚开始排程时的积压）
      const r0 = dist(tr);
      if (r0 > BELL_MAX_R) continue;
      const D = 0.3; // 一次断续的长度
      const n = 16;
      const tones = BELL_ALTERNATE ? [k % 2] : [0, 1];
      const rateC = [new Float32Array(n), new Float32Array(n)];
      const gainC = new Float32Array(n);
      const eps = 0.01;
      for (let j = 0; j < n; j++) {
        const tau = tr + (j / (n - 1)) * D;
        const r = dist(tau);
        const rDot = (dist(tau + eps) - dist(tau - eps)) / (2 * eps);
        const dop = 1 - rDot / c; // 静止声源、运动听者：f'/f = 1 − ṙ/c
        for (const tn of [0, 1]) rateC[tn][j] = (dev.f[tn] / BELL_FREQS_HZ[tn]) * dop;
        // 球面扩散 1/r（3.5 m 处为 1），再乘车体隔声
        gainC[j] = BELL_PEAK_AT_3M5 * (3.5 / Math.max(r, 1.5)) * db2(BELL_TL_DB);
      }
      // 喇叭在窗这一侧还是另一侧
      const windowSide = Math.sign(dev.d) === Math.sign(f.eyeD || 1);
      const bus = this.bellBus[windowSide ? 0 : 1];
      this.bellBus[0].pan.value = 0.4 * f.seatSign;
      this.bellBus[1].pan.value = -0.1 * f.seatSign;
      for (const tn of tones) {
        const s = this.ctx.createBufferSource();
        s.buffer = this.bellBuf[tn];
        const g = this.ctx.createGain();
        g.gain.value = 0;
        s.playbackRate.setValueCurveAtTime(rateC[tn], tr, D);
        g.gain.setValueCurveAtTime(gainC, tr, D);
        s.connect(g).connect(bus);
        s.start(tr);
        s.stop(tr + D + 0.02);
      }
      if (this.logEnabled) this.log.bells.push({ t: tr, rate0: rateC[0][0], rate1: rateC[0][n - 1], r: r0 });
      this.lastBellStrikes++;
    }
  }

  /** 播放一个缓冲（自带包络），固定增益 */
  private playAt(buf: AudioBuffer, when: number, gain: number, rate: number, dest: AudioNode) {
    const s = this.ctx.createBufferSource();
    s.buffer = buf;
    s.playbackRate.value = rate;
    const g = this.ctx.createGain();
    g.gain.value = gain;
    s.connect(g).connect(dest);
    s.start(when);
  }

  /** 停稳：车体前后一顿（低频「カクン」），约 1.2 s 后排一次气「プシュッ」 */
  private onStop(now: number, seatSign: number) {
    const sr = this.ctx.sampleRate;
    const n = Math.floor(0.5 * sr);
    const x = new Float32Array(n);
    const f1 = 9 + this.rng() * 3, f2 = 55 + this.rng() * 15;
    for (let i = 0; i < n; i++) {
      const t = i / sr;
      x[i] = Math.min(t / 0.01, 1) * (Math.exp(-t / 0.18) * Math.sin(2 * Math.PI * f1 * t) * 0.6 + Math.exp(-t / 0.06) * Math.sin(2 * Math.PI * f2 * t));
    }
    this.playAt(makeBuffer(this.ctx, [x]), now + 0.02, IMPACT_PEAK * 0.7, 1, this.events);
    this.hissAt(now + 1.1 + this.rng() * 0.6, 0.7, 1.6, seatSign);
  }

  /** 起步：缓解制动的排气「プシュー」 */
  private onDepart(now: number) {
    this.hissAt(now + 0.05, 1.4, 1.8, 0);
  }

  private hissAt(when: number, dur: number, level: number, pan: number) {
    const s = this.ctx.createBufferSource();
    s.buffer = this.hiss;
    s.loop = true;
    const g = this.ctx.createGain();
    g.gain.value = 0;
    const env = new Float32Array(32);
    for (let i = 0; i < env.length; i++) {
      const t = (i / (env.length - 1)) * dur;
      env[i] = level * Math.min(t / 0.03, 1) * Math.exp(-t / (dur * 0.45));
    }
    env[env.length - 1] = 0;
    g.gain.setValueCurveAtTime(env, when, dur);
    const p = this.ctx.createStereoPanner();
    p.pan.value = pan * 0.3;
    s.connect(g).connect(p).connect(this.events);
    s.start(when, this.rng() * this.hiss.duration);
    s.stop(when + dur + 0.05);
  }

  private brakeSquealAt(when: number, dur: number) {
    const d = Math.max(dur, 0.4);
    const g = this.brakeSqueal.gain.gain, f = this.brakeSqueal.osc.frequency;
    const f0 = 2800 + this.rng() * 1200;
    f.setValueAtTime(f0, when);
    f.linearRampToValueAtTime(f0 * 0.97, when + d);
    g.setValueAtTime(0, when);
    g.linearRampToValueAtTime(0.45, when + 0.08);
    g.setValueAtTime(0.45, when + d * 0.7);
    g.linearRampToValueAtTime(0, when + d);
  }

  /** 车内广播（示意）：when 时刻放一段听不清内容的喃喃声 */
  announceAt(when: number, a: Announcement) {
    const [L, R] = murmurBuffer(this.ctx.sampleRate, a.durationS, this.rng);
    this.playAt(makeBuffer(this.ctx, [L, R]), when, ROLL_RMS * 1.1, 1, this.events);
  }

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
// 合成的一次性声音（JS 里直接算样本，建图时做一次）
// ---------------------------------------------------------------------------------------------

/** 一声接缝撞击（归一到峰值 1）：车体 / 地板的几个低频共振（主体，「ガタン」的「ドン」）+ 很短的金属声（车轮振型，隔着地板已经弱了） */
function impactBuffer(sr: number, rng: Rng) {
  const n = Math.floor(0.4 * sr);
  const x = new Float32Array(n);
  const modes: [number, number, number][] = [
    [48 + rng() * 22, 0.09 + rng() * 0.04, 1],
    [95 + rng() * 45, 0.045, 0.55],
    [180 + rng() * 80, 0.025, 0.35],
    [330 + rng() * 150, 0.012, 0.2],
    // 金属：车轮 / 钢轨的几个振型（1.1–1.5 kHz、2.4–3.2 kHz，估）
    [1100 + rng() * 400, 0.015, 0.1],
    [2400 + rng() * 800, 0.008, 0.07],
  ];
  const ph = modes.map(() => rng() * 0.4);
  let lp = 0;
  const aLp = 1 - Math.exp((-2 * Math.PI * 150) / sr);
  for (let i = 0; i < n; i++) {
    const t = i / sr;
    const att = t < 0.0015 ? 0.5 - 0.5 * Math.cos((Math.PI * t) / 0.0015) : 1;
    let v = 0;
    for (let m = 0; m < modes.length; m++) {
      const [f, tau, a] = modes[m];
      v += a * Math.exp(-t / tau) * Math.sin(2 * Math.PI * f * t + ph[m]);
    }
    // 低频冲击噪声（闷）+ 1 ms 的金属「チ」
    const w = rng() * 2 - 1;
    lp += aLp * (w - lp);
    v += 1.6 * lp * Math.exp(-t / 0.02) + 0.22 * w * Math.exp(-t / 0.0012);
    x[i] = att * v;
  }
  let peak = 0;
  for (let i = 0; i < n; i++) peak = Math.max(peak, Math.abs(x[i]));
  for (let i = 0; i < n; i++) x[i] /= peak;
  return x;
}

/** 一次警报的「断」：约 0.28 s 的音（基音 + 喇叭带出的几个谐波），首尾 5 ms 渐变。多普勒靠播放速率改 */
function bellBuffer(sr: number, f: number) {
  const n = Math.floor(0.3 * sr);
  const x = new Float32Array(n);
  const on = 0.28;
  const harm: [number, number][] = [[1, 1], [2, 0.3], [3, 0.22], [4, 0.08], [5, 0.05]];
  for (let i = 0; i < n; i++) {
    const t = i / sr;
    const e = t < 0.005 ? t / 0.005 : t > on ? Math.max(0, 1 - (t - on) / 0.012) : 1;
    let v = 0;
    for (const [h, a] of harm) v += a * Math.sin(2 * Math.PI * f * h * t);
    x[i] = (e * v * Math.exp(-t / 0.9)) / 1.6;
  }
  return x;
}

/**
 * 车内广播的喃喃声（示意）：声门脉冲串（基频 190–235 Hz、整句下倾）→ 按「拍」随机换元音的三个共振峰 → 车内扬声器的带通（350–3500 Hz）
 * → 车厢里的几次早期反射。元音是随机的，天然听不出内容。不录制 / 不采样 / 不模仿任何真实广播。
 */
function murmurBuffer(sr: number, dur: number, rng: Rng): [Float32Array, Float32Array] {
  const n = Math.floor((dur + 0.4) * sr);
  const y = new Float32Array(n);
  const VOWELS: [number, number, number][] = [[800, 1200, 2500], [300, 2300, 3000], [350, 1300, 2400], [500, 1900, 2600], [500, 900, 2500]];
  // 拍的时间表：每拍 0.12–0.16 s，句中两处短停顿
  const moras: { t0: number; t1: number; v: number; cons: boolean }[] = [];
  let t = 0.05;
  const pauses = [dur * (0.25 + rng() * 0.1), dur * (0.6 + rng() * 0.1)];
  while (t < dur - 0.1) {
    const d = 0.12 + rng() * 0.04;
    moras.push({ t0: t, t1: t + d, v: Math.floor(rng() * VOWELS.length), cons: rng() < 0.6 });
    t += d;
    if (pauses.length && t > pauses[0]) {
      t += 0.18 + rng() * 0.1;
      pauses.shift();
    }
  }
  // 三个二阶共振器（逐拍换系数，拍间 15 ms 线性过渡）
  const st = [[0, 0], [0, 0], [0, 0]];
  let phase = 0, mi = 0;
  const f0base = 190 + rng() * 45;
  for (let i = 0; i < n; i++) {
    const tt = i / sr;
    while (mi < moras.length - 1 && tt > moras[mi].t1) mi++;
    const m = moras[mi];
    const inM = tt >= m.t0 && tt <= m.t1;
    const u = inM ? (tt - m.t0) / (m.t1 - m.t0) : 0;
    const env = inM ? Math.sin(Math.PI * Math.min(u * 1.3, 1)) ** 0.7 : 0;
    const f0 = f0base * (1.12 - 0.25 * (tt / dur)) * (1 + 0.04 * Math.sin(mi * 1.7));
    phase += f0 / sr;
    let src = 0;
    if (phase >= 1) {
      phase -= 1;
      src = 1; // 声门脉冲（冲激，经共振峰滤波）
    }
    let exc = src * env;
    if (m.cons && inM && u < 0.25) exc += (rng() * 2 - 1) * 0.08 * (1 - u / 0.25);
    const fm = VOWELS[m.v];
    let out = 0;
    for (let k = 0; k < 3; k++) {
      const f = fm[k], bw = 80 + 40 * k;
      const r = Math.exp((-Math.PI * bw) / sr);
      const a1 = 2 * r * Math.cos((2 * Math.PI * f) / sr), a2 = -r * r;
      const s = exc + a1 * st[k][0] + a2 * st[k][1];
      st[k][1] = st[k][0];
      st[k][0] = s;
      out += s * (k === 0 ? 1 : k === 1 ? 0.6 : 0.3);
    }
    y[i] = out;
  }
  // 扬声器带通：一阶高通 350 Hz + 一阶低通 3500 Hz，再一次低通 2800 Hz（隔着车厢、远处的扬声器）
  const hp = Math.exp((-2 * Math.PI * 350) / sr), lp1 = 1 - Math.exp((-2 * Math.PI * 3500) / sr), lp2 = 1 - Math.exp((-2 * Math.PI * 2800) / sr);
  let px = 0, hy = 0, l1 = 0, l2 = 0;
  for (let i = 0; i < n; i++) {
    hy = hp * (hy + y[i] - px);
    px = y[i];
    l1 += lp1 * (hy - l1);
    l2 += lp2 * (l1 - l2);
    y[i] = l2;
  }
  // 扬声器的一点点饱和：按峰值归一后过 tanh（驱动 1.5，只压最响的几个峰）
  let pk = 1e-9;
  for (let i = 0; i < n; i++) pk = Math.max(pk, Math.abs(y[i]));
  for (let i = 0; i < n; i++) y[i] = Math.tanh((1.5 * y[i]) / pk);
  // 车厢早期反射（左右不同），模拟顶棚扬声器 + 车窗 / 地板反射
  const L = new Float32Array(n), R = new Float32Array(n);
  const taps: [number, number, number][] = [[0, 1, 0.9], [0.011, 0.45, 0.6], [0.019, 0.35, 0.55], [0.031, 0.3, 0.35], [0.047, 0.22, 0.3], [0.071, 0.14, 0.2]];
  for (const [dl, gl, gr] of taps) {
    const d = Math.floor(dl * sr), dr = Math.floor(dl * 1.13 * sr);
    for (let i = n - 1; i >= 0; i--) {
      if (i - d >= 0) L[i] += gl * y[i - d];
      if (i - dr >= 0) R[i] += gr * y[i - dr];
    }
  }
  const norm = Math.max(rms(L), 1e-9);
  for (let i = 0; i < n; i++) {
    L[i] /= norm;
    R[i] /= norm;
  }
  return [L, R];
}

// ---------------------------------------------------------------------------------------------
// 控制器：从 RailMode 取状态、广播时机与字幕
// ---------------------------------------------------------------------------------------------

/** RailMode（rail/mode.ts）满足这个接口；声音只读它 */
export interface RailSoundSource {
  readonly active: boolean;
  readonly train: Train | null;
  readonly corridor: Corridor | null;
  readonly pose: TrainPose | null;
}

/** 从线路数据取声音要用的东西（道口、推断的道岔、曲率、桥） */
export function trackInfoFrom(cor: Corridor): RailTrackInfo {
  const c = cor.data.center;
  const bridgeBit = cor.flags.bridge ?? 1;
  return {
    crossings: cor.data.meta.levelCrossings.map((x) => x.s).sort((a, b) => a - b),
    turnouts: turnoutsFromTracks(c.tracks, c.s0, c.ds),
    curvature: (s) => cor.curvatureAvg(s),
    bridge: (s) => {
      const i = Math.round((s - c.s0) / c.ds);
      return i >= 0 && i < c.n && (c.flags[i] & bridgeBit) !== 0;
    },
  };
}

/** 从列车状态算这一帧的输入 */
export function railFrameFrom(train: Train, pose: TrainPose, seatSign: number): RailFrame {
  const target = train.targetSpeed();
  const v = train.speed;
  const effort = train.dwell > 0 ? 0 : v < target - 0.05 ? clamp(0.5 + (target - v) / 2, 0, 1) : v > target + 0.05 ? -clamp(0.5 + (v - target) / 2, 0, 1) : 0.12;
  return { s: train.s, dir: train.dir, speed: v, effort, dwell: train.dwell, eyeD: pose.eyeCorridor.d, seatSign };
}

/**
 * 火车声音的控制器（CabinAudio 持有一个）：广播时机与字幕（声音关着也照常更新字幕）、声音图的懒创建。
 */
export class RailAudio {
  scape: RailSoundscape | null = null;
  /** 面板字幕（空串 = 不显示） */
  caption = "";
  private captionUntil = 0;
  private announcer = new Announcer();
  private building: Promise<void> | null = null;
  private corridor: Corridor | null = null;
  options: RailSoundOptions;

  constructor(options: RailSoundOptions) {
    this.options = { ...options };
  }

  /** 第一次在火车模式下出声时建图（约 0.2–0.4 s，分段让出主线程） */
  ensure(ctx: BaseAudioContext, dest: AudioNode, cor: Corridor): Promise<void> {
    if (this.scape && this.corridor === cor) return Promise.resolve();
    if (!this.building) {
      const scape = new RailSoundscape(ctx, trackInfoFrom(cor), this.options, (Math.random() * 2 ** 32) >>> 0);
      scape.output.connect(dest);
      this.building = scape.build().then(() => {
        this.scape?.dispose();
        this.scape = scape;
        this.corridor = cor;
        this.building = null;
      });
    }
    return this.building;
  }

  setOptions(o: Partial<RailSoundOptions>) {
    Object.assign(this.options, o);
    if (this.scape) {
      this.scape.options.aircon = this.options.aircon;
      this.scape.setJointMode(this.options.joints);
    }
  }

  /** 每帧：playing = 声音开着且火车声音图已建好。返回是否在火车模式 */
  frame(src: RailSoundSource | null, seatSign: number, playing: boolean): boolean {
    const nowMs = performance.now();
    if (!src?.active || !src.train || !src.pose || !src.corridor) {
      this.caption = "";
      this.announcer.reset();
      return false;
    }
    const t = src.train, cor = src.corridor;
    const next = cor.nextStation(t.s, t.dir);
    const stopS = t.nextStop();
    const stopSt = cor.nearestStation(stopS);
    const a = this.announcer.update(
      nowMs / 1000,
      t.speed,
      next ? { name: next.name, s: next.s, dist: Math.abs(next.s - t.s) } : null,
      { name: stopSt.name, dist: Math.abs(stopS - t.s), terminal: stopS === t.terminalS[0] || stopS === t.terminalS[1] },
    );
    const fast = (this.scape?.targets?.fastForward ?? false) && playing;
    if (a && !fast) {
      this.caption = `${a.text}（车内广播 · 示意）`;
      this.captionUntil = nowMs + (a.durationS + 3) * 1000;
      if (playing && this.scape) this.scape.announceAt(this.scape.ctx.currentTime + 0.3, a);
    }
    if (nowMs > this.captionUntil) this.caption = "";
    if (playing && this.scape) this.scape.update(railFrameFrom(t, src.pose, seatSign));
    return true;
  }
}
