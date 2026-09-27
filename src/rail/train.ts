import { Corridor, RAIL_CENTER_SPACING_MM } from "./corridor";
import { BodyVibration, MAX_SUBSTEP, type BodyMotion } from "./vibration";

/**
 * 列车运动（TR02）：里程 s(t) 按速度曲线积分；车体姿态由两个台车在线路上的位置决定（偏航、坡度俯仰），
 * 再叠加超高侧倾、悬挂在未平衡横加速度下的外倾、低频振动；最后给出窗边座位眼睛的世界位置与朝向。
 *
 * 坐标：全部在线路的局部 ENU（米，x 东、y 北、z 为国土地理院标高），走廊坐标 (s, d, h) 见 corridor.ts。
 * 换成 voyage 的本地公里坐标 / 航向 / 俯仰 / 滚转在 mode.ts 里做。
 *
 * 数值出处：标「估」的是按常识 / 同类车辆的量级取的，不是本线实测。
 */

/** 巡航速度（km/h）：TRAIN.md 第一期按 90 km/h；本区间营运最高 95 km/h（Wikipedia「大糸線」，二手出处，烘焙报告 §5） */
export const CRUISE_KMH = 90;
/** 台车中心距（米）：E231 系 13.8 m（TRAIN.md §6.1 引 Wikipedia E231 series）。车体方向 = 前后台车连线 */
export const BOGIE_SPACING_M = 13.8;
/** 眼睛离轨面的高度（米）：TRAIN.md「相机高度约 2.5 m」（地板面约 1.1–1.2 m + 坐姿眼高约 1.2–1.3 m，估） */
export const EYE_HEIGHT_M = 2.5;
/** 眼睛离车体中心线的横向距离（米，估：车体宽约 2.9–3.0 m，靠窗座位的眼睛离侧窗约 0.5 m） */
export const EYE_LATERAL_M = 0.95;
/** 起动加速度（m/s²，估：在来线电车约 2.0–3.0 km/h/s，取 2.2 km/h/s） */
export const ACCEL = 0.6;
/** 常用制动的舒适减速度（m/s²，估：约 2.5 km/h/s） */
export const BRAKE = 0.7;
/** 曲线上允许的未平衡横加速度（m/s²，估：超高不足量约 70 mm 的量级）。超过就按曲线限速减速 */
export const LAT_ACC_LIMIT = 0.65;
/** 车体在悬挂上的外倾系数（估：车体侧倾角 / 未平衡横加速度对应的角度，普通转向架约 0.1–0.3） */
export const ROLL_COEF = 0.2;
/** 终点站停车时间（秒，估）：到站、停稳、折返 */
export const TERMINAL_DWELL_S = 40;
/** 中间站停车时间（秒，估）：第一期不停中间站（stops 默认空），接口先留着（TR16） */
export const STATION_DWELL_S = 30;

const G = 9.80665;
const KMH = 1 / 3.6;

export type Seat = "left" | "right";
type Vec3 = [number, number, number];

export interface TrainPose {
  /** 车体中心的里程（米）与行驶方向（+1 往信濃大町，−1 往松本） */
  s: number;
  dir: 1 | -1;
  /** 车速（m/s，≥ 0） */
  speed: number;
  /** 眼睛的世界位置（ENU 米；z 是标高） */
  eye: Vec3;
  /** 车体坐标轴（ENU 单位向量）：forward = 行驶方向，right = 行驶方向的右侧，up = 车体的上方（含侧倾） */
  forward: Vec3;
  right: Vec3;
  up: Vec3;
  /** 车体偏航（弧度，ENU：从东向逆时针）、俯仰（弧度，+ = 车头抬起）、滚转（弧度，+ = 右侧下沉） */
  yaw: number;
  pitch: number;
  roll: number;
  /** 滚转的组成：超高（轨道平面的倾斜）、悬挂外倾、振动 */
  rollCant: number;
  rollSuspension: number;
  /** 估算的超高（mm，带符号：+ = 行驶方向的左转曲线） */
  cantMm: number;
  /** 眼睛的走廊坐标：s、d（+ = 往信濃大町方向的左侧）、h（离轨面） */
  eyeCorridor: { s: number; d: number; h: number };
  /** 振动（给舱内头部加上下的小晃动用） */
  vibration: BodyMotion;
  /** 正在停站：剩余秒数；行驶中 0 */
  dwell: number;
}

export interface TrainOptions {
  s?: number;
  dir?: 1 | -1;
  /** 初速（m/s）；不给时按巡航速度（进入火车模式时已经在跑） */
  speed?: number;
  /** 中间停车点（里程，米）；第一期不停站，默认空 */
  stops?: number[];
}

const norm = (v: Vec3): Vec3 => {
  const l = Math.hypot(v[0], v[1], v[2]) || 1;
  return [v[0] / l, v[1] / l, v[2] / l];
};
const cross = (a: Vec3, b: Vec3): Vec3 => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];

export class Train {
  readonly corridor: Corridor;
  s: number;
  dir: 1 | -1;
  speed: number;
  cruise = CRUISE_KMH * KMH;
  stops: number[];
  dwell = 0;
  private readonly vib = new BodyVibration();
  /** 两个方向各一条「曲线限速包络」（m/s，按 2 m 采样）：已经把提前制动算进去了 */
  private readonly envelope: Record<"1" | "-1", Float32Array>;
  /** 两端终点的停车位置 */
  readonly terminalS: [number, number];

  constructor(corridor: Corridor, opts: TrainOptions = {}) {
    this.corridor = corridor;
    const st = corridor.stations;
    this.terminalS = [corridor.stopPoint(st[0]), corridor.stopPoint(st[st.length - 1])];
    this.s = opts.s ?? 12500;
    this.dir = opts.dir ?? 1;
    this.speed = opts.speed ?? this.cruise;
    this.stops = opts.stops ?? [];
    this.envelope = { "1": this.buildEnvelope(1), "-1": this.buildEnvelope(-1) };
    this.vib.reset(this.s, this.speed);
  }

  /** 曲线限速：v²·|k| − g·|C|/Gc ≤ LAT_ACC_LIMIT；再按 BRAKE 反推「前方有限速时何时开始减速」 */
  private buildEnvelope(dir: 1 | -1): Float32Array {
    const c = this.corridor.data.center;
    const lim = new Float32Array(c.n);
    for (let i = 0; i < c.n; i++) {
      const s = c.s0 + i * c.ds;
      const k = Math.abs(this.corridor.curvatureAvg(s));
      const cantAcc = (G * Math.abs(this.corridor.cantMm(s))) / RAIL_CENTER_SPACING_MM;
      const vCurve = k > 1e-6 ? Math.sqrt((LAT_ACC_LIMIT + cantAcc) / k) : Infinity;
      lim[i] = Math.min(this.cruise * 1.2, vCurve);
    }
    // 车长方向上：车体中心前后各半个车长（取 10 m）都要满足限速
    const half = Math.round(10 / c.ds);
    const lim2 = new Float32Array(c.n);
    for (let i = 0; i < c.n; i++) {
      let m = Infinity;
      for (let j = Math.max(0, i - half); j <= Math.min(c.n - 1, i + half); j++) m = Math.min(m, lim[j]);
      lim2[i] = m;
    }
    // 提前制动：沿行驶方向从远往近推 v(i) ≤ sqrt(v(i+1)² + 2·B·ds)
    if (dir > 0) for (let i = c.n - 2; i >= 0; i--) lim2[i] = Math.min(lim2[i], Math.sqrt(lim2[i + 1] ** 2 + 2 * BRAKE * c.ds));
    else for (let i = 1; i < c.n; i++) lim2[i] = Math.min(lim2[i], Math.sqrt(lim2[i - 1] ** 2 + 2 * BRAKE * c.ds));
    return lim2;
  }

  /** 此处（按行驶方向）允许的速度，不含停站 */
  curveLimit(s = this.s, dir = this.dir): number {
    const c = this.corridor.data.center;
    const env = this.envelope[dir > 0 ? "1" : "-1"];
    const u = Math.min(Math.max((s - c.s0) / c.ds, 0), c.n - 1.001);
    const i = Math.floor(u), t = u - i;
    return env[i] + (env[i + 1] - env[i]) * t;
  }

  /** 行驶方向上下一个停车点（终点总是停；中间站只停 stops 里的） */
  nextStop(s = this.s, dir = this.dir): number {
    const term = dir > 0 ? this.terminalS[1] : this.terminalS[0];
    let best = term;
    for (const p of this.stops) if ((p - s) * dir > 0.5 && (p - best) * dir < 0) best = p;
    return best;
  }

  /** 目标速度：巡航、曲线限速、到下一个停车点的制动曲线三者取小 */
  targetSpeed(): number {
    const dStop = (this.nextStop() - this.s) * this.dir;
    return Math.min(this.cruise, this.curveLimit(), Math.sqrt(2 * BRAKE * Math.max(dStop, 0)));
  }

  /** 换位置（调试 / 进入火车模式）：落在稳态，不从 0 晃起 */
  teleport(s: number, dir: 1 | -1 = this.dir, speed?: number) {
    this.s = Math.min(Math.max(s, this.corridor.sMin), this.corridor.sMax);
    this.dir = dir;
    this.dwell = 0;
    this.speed = speed ?? Math.min(this.cruise, this.curveLimit());
    this.vib.reset(this.s, this.speed);
  }

  /** 推进 dt 秒（模拟时间）；内部按 MAX_SUBSTEP 拆步，振动滤波器才稳定、平滑 */
  update(dt: number) {
    if (!(dt > 0)) return;
    const n = Math.ceil(dt / MAX_SUBSTEP);
    // 加速播放时一帧可能是好几秒：步数封顶，超过的部分只推进运动学、振动直接落到稳态
    const maxSteps = 600;
    const h = dt / Math.min(n, maxSteps);
    for (let i = 0; i < Math.min(n, maxSteps); i++) this.step(h);
    if (n > maxSteps) this.vib.reset(this.s, this.speed);
  }

  private step(h: number) {
    if (this.dwell > 0) {
      this.dwell -= h;
      if (this.dwell <= 0) {
        this.dwell = 0;
        // 终点折返：车体里的乘客不动，行驶方向反过来（窗外换成另一侧的风景）
        const atTerminal = Math.abs(this.s - this.terminalS[0]) < 1 || Math.abs(this.s - this.terminalS[1]) < 1;
        if (atTerminal) this.dir = this.dir > 0 ? -1 : 1;
      }
      this.vib.step(this.s, 0, h);
      return;
    }
    const target = this.targetSpeed();
    // 加速按 ACCEL；减速允许略大于 BRAKE（包络本身按 BRAKE 算，这里留余量防止越过）
    this.speed = this.speed < target ? Math.min(target, this.speed + ACCEL * h) : Math.max(target, this.speed - 1.5 * BRAKE * h);
    const stop = this.nextStop();
    const before = (stop - this.s) * this.dir;
    this.s += this.dir * this.speed * h;
    const after = (stop - this.s) * this.dir;
    // 到站：停稳、开始停站计时（接近到 5 cm 内或者越过了停车点）
    if (before > 0 && (after <= 0.05 || this.speed < 0.02) && before < 5) {
      this.s = stop;
      this.speed = 0;
      const terminal = stop === this.terminalS[0] || stop === this.terminalS[1];
      this.dwell = terminal ? TERMINAL_DWELL_S : STATION_DWELL_S;
    }
    this.s = Math.min(Math.max(this.s, this.corridor.sMin), this.corridor.sMax);
    this.vib.step(this.s, this.speed, h);
  }

  /** 当前的车体姿态与眼睛位置 */
  pose(seat: Seat): TrainPose {
    const cor = this.corridor;
    const L2 = BOGIE_SPACING_M / 2;
    const sF = this.s + this.dir * L2, sR = this.s - this.dir * L2;
    const pF = cor.position(sF), pR = cor.position(sR);
    const center: Vec3 = [(pF[0] + pR[0]) / 2, (pF[1] + pR[1]) / 2, (pF[2] + pR[2]) / 2];
    const chord: Vec3 = [pF[0] - pR[0], pF[1] - pR[1], pF[2] - pR[2]];
    const horiz = Math.hypot(chord[0], chord[1]) || 1;
    const vib = this.vib.motion;
    const yaw = Math.atan2(chord[1], chord[0]) + vib.yaw;
    const pitch = Math.atan2(chord[2], horiz) + vib.pitch;

    // 超高：两个台车处的平均（车体架在两个台车上）。corridor 的符号以「往信濃大町左转」为正，换到行驶方向
    const cantMm = this.dir * 0.5 * (cor.cantMm(sF) + cor.cantMm(sR));
    const cantAng = Math.asin(Math.min(Math.max(cantMm / RAIL_CENTER_SPACING_MM, -1), 1));
    // 左转曲线（cantMm > 0）内侧是左侧：左侧低 → 右侧高 → 滚转为负
    const rollCant = -cantAng;
    // 未平衡横加速度（+ = 指向曲线内侧的加速度超出超高能抵消的部分）：车体在悬挂上向外倾，外侧下沉
    const kTravel = this.dir * 0.5 * (cor.curvatureAvg(sF) + cor.curvatureAvg(sR));
    const aUnbal = this.speed * this.speed * kTravel - (G * cantMm) / RAIL_CENTER_SPACING_MM;
    // 左转（kTravel > 0）且欠超高（aUnbal > 0）：向右（外侧）倾 → 滚转为正
    const rollSuspension = ROLL_COEF * (aUnbal / G);
    const roll = rollCant + rollSuspension + vib.roll;

    // 车体坐标轴：先按偏航、俯仰得到 forward，再绕 forward 转 roll
    const cy = Math.cos(yaw), sy = Math.sin(yaw), cp = Math.cos(pitch), sp = Math.sin(pitch);
    const forward: Vec3 = [cy * cp, sy * cp, sp];
    const right0 = norm(cross(forward, [0, 0, 1]));
    const up0 = cross(right0, forward);
    const cr = Math.cos(roll), sr = Math.sin(roll);
    // 右侧下沉：up 往右偏
    const up: Vec3 = [up0[0] * cr + right0[0] * sr, up0[1] * cr + right0[1] * sr, up0[2] * cr + right0[2] * sr];
    const right: Vec3 = [right0[0] * cr - up0[0] * sr, right0[1] * cr - up0[1] * sr, right0[2] * cr - up0[2] * sr];

    // 眼睛：从两轨中点（侧倾近似绕这里转）沿车体 up 抬 EYE_HEIGHT_M、沿车体横向挪到靠窗座位，再加上下振动
    const side = seat === "right" ? 1 : -1;
    const hEye = EYE_HEIGHT_M + vib.heave;
    const eye: Vec3 = [
      center[0] + up[0] * hEye + right[0] * EYE_LATERAL_M * side,
      center[1] + up[1] * hEye + right[1] * EYE_LATERAL_M * side,
      center[2] + up[2] * hEye + right[2] * EYE_LATERAL_M * side,
    ];
    const pr = cor.project(eye[0], eye[1], this.s, 30);
    const zr = cor.position(pr.s)[2];
    return {
      s: this.s,
      dir: this.dir,
      speed: this.speed,
      eye,
      forward,
      right,
      up,
      yaw,
      pitch,
      roll,
      rollCant,
      rollSuspension,
      cantMm,
      eyeCorridor: { s: pr.s, d: pr.d, h: eye[2] - zr },
      vibration: vib,
      dwell: this.dwell,
    };
  }
}
