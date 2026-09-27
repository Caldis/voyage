import { RAIL_CENTER_SPACING_MM } from "./corridor";
import { BOGIE_SPACING_M } from "./train";

/**
 * 火车声音的几何与规格模型（TR07）：纯计算，不碰 Web Audio / DOM，node 里能直接跑
 * （`scripts/audio-check.mjs --rail` 打印节奏时间表、多普勒理论值；`src/rail/audio-rail.ts` 用它排程）。
 *
 * 标注约定：有出处的写出处；「估」= 按同类量级取的数，不是本线实测；「示例」= 本线状况未核实、为了能听到而设的取值；
 * 「示意」= 只表现机理、不追求和某一车型一致。
 */

// ---------------------------------------------------------------------------------------------
// 车辆与钢轨几何
// ---------------------------------------------------------------------------------------------

/** 定尺钢轨长（米）：25 m（民鉄協 鉄道用語「レール」，TRAIN.md §6.1）。**本线是否仍是定尺钢轨未核实**（烘焙报告 §5） */
export const RAIL_LENGTH_M = 25;
/** 台车内两轴的轴距（米，估：常见值，TRAIN.md §6.1「待按车型核对」） */
export const AXLE_BASE_M = 2.1;
/** 车长（米）：E233 系连结面间距 20,000 mm（TRAIN.md §6.1 引 Wikipedia）；本区间 E127 / 211 / E353 系也是 20 m 级，未逐车型核对 */
export const CAR_LENGTH_M = 20;
/** 编组辆数（示例）：取 3 辆、坐中间一辆。本区间实际运用 E127 系 2 辆、211 系 3 / 6 辆等，没有核对具体列车 */
export const CONSIST_CARS = 3;
export const LISTENER_CAR = 1;
/** 听者耳朵到钢轨面的高度差（米，估：地板约 1.15 m + 坐姿耳高约 1.2 m），只用来算撞击点到耳朵的距离 */
export const EAR_ABOVE_RAIL_M = 2.4;
/** 别的车厢的撞击隔着两道端墙 / 贯通道再衰减多少（dB，估） */
export const OTHER_CAR_DB = -6;
/** 左右钢轨中心到线路中心的横距（米）：轨头中心间距 1130 mm 的一半（corridor.ts，估） */
export const RAIL_HALF_M = RAIL_CENTER_SPACING_MM / 2000;

/** 声速（m/s）：331.3·√(1 + T/273.15)，T = 25°C（盛夏，估）≈ 346 m/s */
export const SOUND_SPEED_MS = 331.3 * Math.sqrt(1 + 25 / 273.15);

export interface Axle {
  /** 车轴相对听者所在车厢中心的纵向位置（米，+ = 行驶方向前方） */
  a: number;
  /** 0 = 最前一辆 */
  car: number;
  /** 相对「6 m 外的本车车轴」的响度（dB）：按到耳朵的距离 20·lg + 隔着端墙的衰减 */
  gainDb: number;
}

/** 整列车所有车轴相对听者的位置（听者在 LISTENER_CAR 车厢中部，即两台车中点，和 train.ts 的眼睛一致） */
export function consistAxles(cars = CONSIST_CARS, listenerCar = LISTENER_CAR): Axle[] {
  const out: Axle[] = [];
  for (let c = 0; c < cars; c++) {
    const center = (listenerCar - c) * CAR_LENGTH_M;
    for (const b of [1, -1]) {
      for (const x of [1, -1]) {
        const a = center + (b * BOGIE_SPACING_M) / 2 + (x * AXLE_BASE_M) / 2;
        const r = Math.hypot(a, EAR_ABOVE_RAIL_M);
        out.push({ a, car: c, gainDb: 20 * Math.log10(6 / r) + (c === listenerCar ? 0 : OTHER_CAR_DB) });
      }
    }
  }
  return out.sort((p, q) => q.a - p.a);
}

/** 列车最前端 / 最后端相对听者的位置（米）：道口警报的开、关按车头 / 车尾算 */
export function consistEnds(cars = CONSIST_CARS, listenerCar = LISTENER_CAR): [number, number] {
  return [(listenerCar + 0.5) * CAR_LENGTH_M, -(cars - listenerCar - 0.5) * CAR_LENGTH_M];
}

// ---------------------------------------------------------------------------------------------
// 接缝
// ---------------------------------------------------------------------------------------------

/**
 * 接缝模式：
 * - "jointed"：定尺 25 m（**示例**：本线是否长轨化未核实，默认用它是为了能听到 TRAIN.md 第一期要求的「ガタンゴトン」，面板上标示例）；
 * - "welded"：长轨化——只剩道岔（站场）和伸缩接头的零星撞击。
 */
export type JointMode = "jointed" | "welded";

/** 可复现的整数哈希 → [0, 1) */
export function hash01(i: number, salt = 0) {
  let h = Math.imul((i | 0) ^ Math.imul(salt + 0x9e3779b9, 0x85ebca6b), 0xc2b2ae35);
  h ^= h >>> 15;
  h = Math.imul(h, 0x2c1b3c6d);
  h ^= h >>> 12;
  h = Math.imul(h, 0x297a2d39);
  h ^= h >>> 15;
  return (h >>> 0) / 4294967296;
}

export interface Joint {
  /** 左轨（d > 0 一侧）接缝的里程（米） */
  s: number;
  /** 右轨接缝相对左轨错开的距离（米，带符号） */
  stagger: number;
  /** 这一处接缝「坏」的程度（相对强度，高低差 / 轨缝宽度的代理，同一处接缝对每根车轴一样） */
  strength: number;
  /** 撞击音色变体编号（0..） */
  variant: number;
  kind: "joint" | "turnout" | "expansion";
}

/** 定尺钢轨接缝的里程相位（米，示例：本线接缝位置没有数据） */
const JOINT_PHASE_M = 7.3;
/** 接缝位置的随机误差（米，估）：钢轨长度公差、轨缝、铺设误差 */
const JOINT_JITTER_M = 0.04;
/** 伸缩接头（长轨两端）的间距（米，示例 / 估：长轨 200 m 以上，本线实际布置未知） */
const EXPANSION_SPACING_M = 1200;

export interface JointTrackOptions {
  mode: JointMode;
  /** 道岔位置（里程，米）：从烘焙数据的股道数变化处推断，见 turnoutsFromTracks */
  turnouts?: number[];
  /** false：没有随机误差、强度全 1（节奏检查用，和 TRAIN.md 的几何推导逐项对照） */
  jitter?: boolean;
  variants?: number;
}

export class JointTrack {
  mode: JointMode;
  readonly turnouts: number[];
  readonly jitter: boolean;
  readonly variants: number;

  constructor(opts: JointTrackOptions) {
    this.mode = opts.mode;
    this.turnouts = [...(opts.turnouts ?? [])].sort((a, b) => a - b);
    this.jitter = opts.jitter ?? true;
    this.variants = opts.variants ?? 16;
  }

  /** 里程 [s0, s1) 内的全部接缝（按左轨里程升序） */
  jointsIn(s0: number, s1: number): Joint[] {
    const out: Joint[] = [];
    const j = this.jitter;
    if (this.mode === "jointed") {
      const k0 = Math.floor((s0 - JOINT_PHASE_M) / RAIL_LENGTH_M) - 1;
      const k1 = Math.ceil((s1 - JOINT_PHASE_M) / RAIL_LENGTH_M) + 1;
      for (let k = k0; k <= k1; k++) {
        const s = JOINT_PHASE_M + k * RAIL_LENGTH_M + (j ? (hash01(k, 1) - 0.5) * 2 * JOINT_JITTER_M : 0);
        if (s < s0 || s >= s1) continue;
        // 强度：对数正态（σ ≈ 0.25），约 4% 的接缝明显「坏」（×1.8）
        const g = Math.sqrt(-2 * Math.log(Math.max(hash01(k, 2), 1e-9))) * Math.cos(2 * Math.PI * hash01(k, 3));
        const strength = j ? Math.exp(0.25 * g) * (hash01(k, 4) < 0.04 ? 1.8 : 1) : 1;
        // 左右轨：相对式（对齐）还是相互式（错开半根）未核实——取相对式，再按铺设误差「稍错开」0.05–0.35 m（估）
        const stagger = j ? (0.05 + 0.3 * hash01(k, 5)) * (hash01(k, 6) < 0.5 ? -1 : 1) : 0;
        out.push({ s, stagger, strength, variant: Math.floor(hash01(k, 7) * this.variants), kind: "joint" });
      }
    } else {
      const k0 = Math.floor(s0 / EXPANSION_SPACING_M) - 1, k1 = Math.ceil(s1 / EXPANSION_SPACING_M) + 1;
      for (let k = k0; k <= k1; k++) {
        const s = k * EXPANSION_SPACING_M + hash01(k, 11) * 300;
        if (s < s0 || s >= s1) continue;
        // 伸缩接头是斜接的，撞击很轻（估）
        out.push({ s, stagger: 0.4, strength: 0.3, variant: Math.floor(hash01(k, 12) * this.variants), kind: "expansion" });
      }
    }
    // 道岔（两种模式都有）：尖轨端、跟端接缝、辙叉（固定辙叉的鼻端撞击最重），相对位置 0 / 9 / 16 m（估）
    for (let t = 0; t < this.turnouts.length; t++) {
      const base = this.turnouts[t];
      if (base + 20 < s0 || base - 20 >= s1) continue;
      const parts: [number, number][] = [[0, 0.7], [9, 0.9], [16, 1.5]];
      parts.forEach(([off, st], i) => {
        const s = base + off;
        if (s < s0 || s >= s1) return;
        out.push({ s, stagger: 0.02 + 0.1 * hash01(t * 7 + i, 21), strength: st * (0.85 + 0.3 * hash01(t * 7 + i, 22)), variant: Math.floor(hash01(t * 7 + i, 23) * this.variants), kind: "turnout" });
      });
    }
    return out.sort((a, b) => a.s - b.s);
  }
}

/** 从烘焙的「法线 ±12 m 内股道数」推断道岔位置（**推断，估**：单线变成多股道的地方一般有道岔；数据里没有道岔节点）。
 *  只取变化前后都稳定 ≥ 20 m 的地方，两处之间至少隔 30 m */
export function turnoutsFromTracks(tracks: ArrayLike<number>, s0: number, ds: number): number[] {
  const out: number[] = [];
  const n = tracks.length;
  const w = Math.max(1, Math.round(20 / ds));
  for (let i = w; i < n - w; i++) {
    const a = tracks[i - 1] >= 2 ? 1 : 0, b = tracks[i] >= 2 ? 1 : 0;
    if (a === b) continue;
    let stable = true;
    for (let k = 1; k <= w && stable; k++) stable = (tracks[i - k] >= 2 ? 1 : 0) === a && (tracks[i + k - 1] >= 2 ? 1 : 0) === b;
    if (!stable) continue;
    const s = s0 + i * ds;
    if (out.length && s - out[out.length - 1] < 30) continue;
    out.push(s);
  }
  return out;
}

export interface JointHit {
  /** 撞击发生时听者的「行进坐标」u = dir·s（米） */
  u: number;
  axle: number;
  /** 0 = 左轨（d > 0），1 = 右轨 */
  rail: 0 | 1;
  joint: Joint;
}

/**
 * 行进坐标 u ∈ [u0, u1) 内所有「车轴过接缝」事件。车轴 a 经过里程 J 的接缝时，听者的行进坐标 u = dir·J − a。
 * 时刻 = (u − u_now) / v（TRAIN.md §6.1：t = (J − a)/v）。
 */
export function jointHits(u0: number, u1: number, dir: 1 | -1, axles: Axle[], track: JointTrack): JointHit[] {
  if (!(u1 > u0)) return [];
  let amin = Infinity, amax = -Infinity;
  for (const x of axles) {
    amin = Math.min(amin, x.a);
    amax = Math.max(amax, x.a);
  }
  // 需要的里程范围（留 1 m 给错开量）
  const ua = u0 + amin - 1, ub = u1 + amax + 1;
  const [s0, s1] = dir > 0 ? [ua, ub] : [-ub, -ua];
  const joints = track.jointsIn(s0, s1);
  const out: JointHit[] = [];
  for (const jt of joints) {
    for (const r of [0, 1] as const) {
      const sj = jt.s + (r ? jt.stagger : 0);
      for (let i = 0; i < axles.length; i++) {
        const u = dir * sj - axles[i].a;
        if (u >= u0 && u < u1) out.push({ u, axle: i, rail: r, joint: jt });
      }
    }
  }
  return out.sort((a, b) => a.u - b.u);
}

/** 一个钢轨长周期内（从某接缝被最前一根轴压到开始）的撞击时刻表：节奏检查、文档对照用 */
export function rhythmTable(speedKmh: number, cars = CONSIST_CARS, listenerCar = LISTENER_CAR) {
  const v = speedKmh / 3.6;
  const axles = consistAxles(cars, listenerCar);
  const period = RAIL_LENGTH_M / v;
  // 相位：以「听者正好在接缝上方」为 t = 0，车轴 a 的撞击相位 = ((−a) mod L)/v
  const rows = axles.map((x) => {
    const ph = ((((-x.a) % RAIL_LENGTH_M) + RAIL_LENGTH_M) % RAIL_LENGTH_M) / v;
    return { a: +x.a.toFixed(2), car: x.car, own: x.car === listenerCar, gainDb: +x.gainDb.toFixed(1), t: +ph.toFixed(3) };
  });
  rows.sort((p, q) => p.t - q.t);
  return { speedKmh, periodS: +period.toFixed(4), hits: rows };
}

// ---------------------------------------------------------------------------------------------
// 多普勒
// ---------------------------------------------------------------------------------------------

/** 静止声源、运动的听者（空气静止）：f'/f = (c + v·cosθ)/c，θ 为听者速度与「听者→声源」方向的夹角。
 *  注意 TRAIN.md §6.2 用的是声源运动的公式 c/(c ∓ v)，这里听者在动，改为观察者运动的公式（90 km/h 时差 0.6%） */
export function observerDoppler(vListener: number, cosTheta: number, c = SOUND_SPEED_MS) {
  return (c + vListener * cosTheta) / c;
}

/** 按距离变化率求接收频率比：f'/f = 1 − ṙ/c（ṙ < 0 靠近）。对任意几何都成立（静止声源） */
export function rangeRateDoppler(rDot: number, c = SOUND_SPEED_MS) {
  return 1 - rDot / c;
}

// ---------------------------------------------------------------------------------------------
// 道口警报
// ---------------------------------------------------------------------------------------------

/**
 * 电子音式警报机：「発振周波数の750 Hzと700 Hzの電気信号を変調周波数により1分間に130回断続して警報音を発生させる」
 * （[Wikipedia 踏切警報機](https://ja.wikipedia.org/wiki/%E8%B8%8F%E5%88%87%E8%AD%A6%E5%A0%B1%E6%A9%9F)，TR07 时查阅）。
 * 公差 ±15 Hz、±5 次 / 分转引自 TRAIN.md §6.2（同一出处 + 鉄道総研 人間科学ニュース 2015-11），没有逐字核对。
 * 两个频率是「交替」还是「同时」：TRAIN.md 写交替，上面这句原文没说，**未核实**；这里取同时发声（BELL_ALTERNATE = false，
 * 两音相差 50 Hz，听起来是粗糙的「カンカン」），改成 true 就是交替。
 */
export const BELL_FREQS_HZ: readonly [number, number] = [700, 750];
export const BELL_TOL_HZ = 15;
export const BELL_STRIKES_PER_MIN = 130;
export const BELL_RATE_TOL = 5;
export const BELL_ALTERNATE = false;
/** 警报在列车到达前多久开始（秒，估）：同一 Wikipedia 条目写「40～50秒程前」，语境未核实，取下限 40 s */
export const BELL_WARN_S = 40;
/** 按本区间营运最高 95 km/h（烘焙报告 §5，二手出处）反推的警报起点距离上限（米，估） */
export const BELL_WARN_MAX_M = (95 / 3.6) * BELL_WARN_S;
/** 车尾通过道口后警报再响多久（秒，估） */
export const BELL_HOLD_S = 1.5;

export interface BellDevice {
  /** 相对道口中心的纵向偏移（米，沿里程）、横向位置（米，d）、离轨面高度（米） */
  ds: number;
  d: number;
  h: number;
  /** 本机的两个频率（Hz）与每分钟次数（公差内随机） */
  f: [number, number];
  perMin: number;
  /** 本机闪断相位（秒） */
  phase: number;
}

/** 每处道口 1–2 台警报机（估：OSM 大多没有 crossing:bell 标签），摆在道路两侧、线路两边。确定性（同一道口每次一样） */
export function crossingDevices(index: number): BellDevice[] {
  const n = hash01(index, 31) < 0.6 ? 2 : 1;
  const out: BellDevice[] = [];
  for (let i = 0; i < n; i++) {
    const k = index * 4 + i;
    const side = (i === 0 ? 1 : -1) * (hash01(index, 32) < 0.5 ? 1 : -1);
    out.push({
      ds: (i === 0 ? -1 : 1) * (2.5 + 1.5 * hash01(k, 33)), // 道路半宽约 2.5–4 m（估）
      d: side * (2.6 + 1.0 * hash01(k, 34)), // 警报柱离线路中心 2.6–3.6 m（估）
      h: 2.2 + 0.6 * hash01(k, 35), // 警报音喇叭离轨面约 2.2–2.8 m（估）
      f: [BELL_FREQS_HZ[0] + (hash01(k, 36) * 2 - 1) * BELL_TOL_HZ, BELL_FREQS_HZ[1] + (hash01(k, 37) * 2 - 1) * BELL_TOL_HZ],
      perMin: BELL_STRIKES_PER_MIN + (hash01(k, 38) * 2 - 1) * BELL_RATE_TOL,
      phase: hash01(k, 39),
    });
  }
  return out;
}

// ---------------------------------------------------------------------------------------------
// 车内广播（示意）
// ---------------------------------------------------------------------------------------------

export interface StationRef {
  name: string;
  s: number;
}

export interface Announcement {
  text: string;
  kind: "next" | "arriving";
  /** 喃喃声的时长（秒） */
  durationS: number;
}

/**
 * 广播时机（示意）：驶过 / 驶离一个车站约 6 s 后报「次は ○○」（离下一站还有 600 m 以上才报）；
 * 离要停的车站（终点或 stops）不到 450 m、正在减速时报「まもなく ○○」。只给字幕与喃喃声的时长，内容不合成任何真实广播。
 */
export class Announcer {
  private lastNext: string | null = null;
  private pending: { at: number; a: Announcement } | null = null;
  private arrivingFor: string | null = null;

  reset() {
    this.lastNext = null;
    this.pending = null;
    this.arrivingFor = null;
  }

  /** now：秒（任意单调时钟）。next：行驶方向下一个车站及其距离；stop：下一个停车点（名字、距离、是否终点） */
  update(now: number, speed: number, next: (StationRef & { dist: number }) | null, stop: { name: string; dist: number; terminal: boolean } | null): Announcement | null {
    if (next && next.name !== this.lastNext) {
      const first = this.lastNext === null;
      this.lastNext = next.name;
      if (next.dist > 600) this.pending = { at: now + (first ? 3 : 6), a: { text: `次は ${next.name}`, kind: "next", durationS: dur(next.name, 3) } };
    }
    if (stop && stop.dist < 450 && speed > 1 && this.arrivingFor !== stop.name) {
      this.arrivingFor = stop.name;
      this.pending = { at: now + 0.5, a: { text: `まもなく ${stop.terminal ? "終点 " : ""}${stop.name}`, kind: "arriving", durationS: dur(stop.name, stop.terminal ? 4.5 : 3.5) } };
    }
    if (stop && stop.dist > 1000) this.arrivingFor = null;
    if (this.pending && now >= this.pending.at) {
      const a = this.pending.a;
      this.pending = null;
      return a;
    }
    return null;
  }
}

/** 喃喃声时长：固定部分 + 站名每个字约 0.28 s（汉字约 2 拍、每拍约 0.14 s，估） */
function dur(name: string, base: number) {
  return base + [...name].length * 0.28;
}
