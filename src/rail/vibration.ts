/**
 * 车体低频振动（TR02）：「轨道不平顺」激励 → 悬挂（二阶弹簧阻尼）→ 车体的上下、侧滚、点头、摇头。
 *
 * - 激励是里程 s 的函数（轨道的几何不平顺是固定在地上的），所以同一段线路每次经过都一样，停车时不再变化；
 *   车速决定激励的频率（v / 波长），车速越高越接近悬挂的共振频率，晃得越明显。
 * - 激励用带哈希梯度的一维噪声，几个互不成整数比的波长叠加，没有周期（不会出现「每隔几公里重复一遍」）。
 * - 输出经过二阶系统，是连续可导的平滑曲线，不会闪、不会抖（每帧的变化量受悬挂频率限制）。
 *
 * 数值都是**估值**（TRAIN.md §1.3：空气弹簧上下约 1–1.5 Hz、横摆约 0.5–1 Hz，待核）：
 * 振幅按「在来线电车坐着看窗外，几乎察觉不到、但地平线有一点活气」来定，90 km/h 时的均方根约为
 * 上下 2 mm、侧滚 0.1°、点头 0.03°、摇头 0.03°（node 单测 `src/rail/rail.test.mjs` 会量出实际值并检查范围）。
 */

/** 整数哈希 → [-1, 1)（splitmix 风格） */
function hash1(i: number, seed: number): number {
  let h = (Math.imul(i | 0, 0x9e3779b1) ^ Math.imul(seed | 0, 0x85ebca77)) >>> 0;
  h = Math.imul(h ^ (h >>> 16), 0x7feb352d) >>> 0;
  h = Math.imul(h ^ (h >>> 15), 0x846ca68b) >>> 0;
  h = (h ^ (h >>> 16)) >>> 0;
  return h / 2147483648 - 1;
}

/** 一维梯度噪声（五次插值，C2 连续），值域约 ±0.5 */
function gradNoise(x: number, seed: number): number {
  const i = Math.floor(x);
  const f = x - i;
  const a = hash1(i, seed) * f;
  const b = hash1(i + 1, seed) * (f - 1);
  const u = f * f * f * (f * (f * 6 - 15) + 10);
  return a + (b - a) * u;
}

/** 轨道不平顺：几个波长（米）叠加，长波振幅大（不平顺的功率谱随波长增大） */
const WAVELENGTHS = [6.7, 11.3, 19.1, 33.7, 57.9];
export function trackIrregularity(s: number, seed: number): number {
  let v = 0;
  for (let j = 0; j < WAVELENGTHS.length; j++) {
    const lam = WAVELENGTHS[j];
    v += Math.sqrt(lam / 20) * gradNoise(s / lam + j * 17.31, seed + j * 1013);
  }
  return v;
}

/** 二阶弹簧阻尼：x'' + 2ζω x' + ω² x = ω² u */
export class Oscillator {
  x = 0;
  v = 0;
  readonly omega: number;
  readonly zeta: number;
  constructor(freqHz: number, zeta: number) {
    this.omega = 2 * Math.PI * freqHz;
    this.zeta = zeta;
  }
  reset(x = 0) {
    this.x = x;
    this.v = 0;
  }
  /** 半隐式欧拉，dt 要小于约 1/(2ω)（调用方按 MAX_SUBSTEP 拆步） */
  step(u: number, dt: number) {
    const w = this.omega;
    const a = w * w * (u - this.x) - 2 * this.zeta * w * this.v;
    this.v += a * dt;
    this.x += this.v * dt;
  }
}

/** 拆步的最大步长（秒）：最高的悬挂频率 1.4 Hz，ω·dt ≈ 0.15，半隐式欧拉稳定且误差小 */
export const MAX_SUBSTEP = 1 / 60;
/** 振幅以这个车速（m/s，90 km/h）为参考；低速时激励按车速线性减弱（停车时车体静止） */
const V_REF = 25;

export interface BodyMotion {
  /** 上下（米，+ = 上） */
  heave: number;
  /** 侧滚（弧度，+ = 右侧下沉，与 voyage 的 rollDeg 同号） */
  roll: number;
  /** 点头（弧度，+ = 车头抬起） */
  pitch: number;
  /** 摇头（弧度，+ = 车头向左偏，逆时针） */
  yaw: number;
}

/** 各通道：[悬挂频率 Hz, 阻尼比, 激励增益, 噪声种子] —— 全部是估值 */
const CHANNELS = {
  heave: [1.2, 0.3, 0.0055, 11],
  roll: [0.8, 0.22, 0.0036, 23],
  pitch: [1.4, 0.3, 0.0013, 37],
  yaw: [0.9, 0.3, 0.0012, 51],
} as const;

export class BodyVibration {
  private readonly osc = {
    heave: new Oscillator(CHANNELS.heave[0], CHANNELS.heave[1]),
    roll: new Oscillator(CHANNELS.roll[0], CHANNELS.roll[1]),
    pitch: new Oscillator(CHANNELS.pitch[0], CHANNELS.pitch[1]),
    yaw: new Oscillator(CHANNELS.yaw[0], CHANNELS.yaw[1]),
  };

  /** 某里程、某车速下的激励（稳态时车体就停在这个值上） */
  private input(ch: keyof typeof CHANNELS, s: number, speed: number) {
    const [, , gain, seed] = CHANNELS[ch];
    return gain * Math.min(Math.abs(speed) / V_REF, 1.3) * trackIrregularity(s, seed);
  }

  /** 跳变（进入火车模式、折返）：直接落在稳态值上，不从 0 弹过去 */
  reset(s: number, speed: number) {
    for (const ch of Object.keys(this.osc) as (keyof typeof CHANNELS)[]) this.osc[ch].reset(this.input(ch, s, speed));
  }

  /** 推进一个小步（dt ≤ MAX_SUBSTEP） */
  step(s: number, speed: number, dt: number) {
    for (const ch of Object.keys(this.osc) as (keyof typeof CHANNELS)[]) this.osc[ch].step(this.input(ch, s, speed), dt);
  }

  get motion(): BodyMotion {
    return { heave: this.osc.heave.x, roll: this.osc.roll.x, pitch: this.osc.pitch.x, yaw: this.osc.yaw.x };
  }
}
