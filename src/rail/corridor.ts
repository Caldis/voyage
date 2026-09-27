import type { RailData, RailStation } from "./data";

/**
 * 走廊坐标（TR02）：沿本线中心线的里程 s、横向偏移 d、高程。
 *
 * 约定（与 `research/RAIL_BAKE_REPORT.md` §2 一致）：
 * - 平面坐标 x / y：以松本站为切点的局部 ENU，米，x 东、y 北；高程 z：国土地理院标高（米，东京湾平均海面起算）。
 * - s：里程（米），0 = 松本站节点的投影，往信濃大町方向增大。中心线每 2 m 一个采样点，这里按下标线性插值。
 * - d：横向偏移（米），+ = 「往信濃大町方向」的左侧（与列车实际行驶方向无关）。
 * - 曲率 k：1/m，+ = 往信濃大町方向左转。由 OSM 折线求导（σ = 15 m 平滑），不是设计值。
 * - 坡度 grade：‰，+ = 往信濃大町方向上坡。由 DEM 推出，不是设计纵断面。
 * - 平面位置：烘焙的 center.x / y 是 OSM 折线按 2 m 重采样的原样，节点处有几度的折角（弯道上节点间隔约 20 m）。直接当相机轨迹，
 *   车体会「转一下、直一段、再转一下」。这里按 σ = 15 m 高斯平滑（和烘焙的 heading / curvature 同一口径）后再用，
 *   折角处离原折线约 0.3–0.5 m（OSM 本身的位置精度比这差）。后续近景 / 中景要和相机对齐，也用这里的 position()。
 *
 * 超高（カント）：烘焙产物里没有（OSM 没有 cant 标签，本线也没有公开资料，见烘焙报告 §5），这里按规范公式**估算**：
 *   国土交通省「鉄道に関する技術上の基準を定める省令等の解釈基準」Ⅲ－４ 第 15 条：
 *   标准值 C = G·V² / (127·R)，上限 C ≤ G² / (6·H)（G 轨距 mm，V 通过该曲线的列车平均速度 km/h，R 半径 m，H 轨面到车辆重心的高度 mm）。
 *   其中 V、H 都没有本线的实测 / 设计值，取下面标「估」的常数；「在来线最大 105 mm」这个数没有核实，**没有用**。
 */

/** 轨距（mm）：OSM `gauge=1067` 覆盖全线（烘焙报告 §3.1） */
export const GAUGE_MM = 1067;
/** 左右钢轨头部中心的间距（mm，估：轨距 1067 + 轨头宽约 65 mm）：超高换算成侧倾角用 */
export const RAIL_CENTER_SPACING_MM = 1130;
/** 超高公式里的 V（km/h，估）：通过该曲线的列车平均速度。本线没有资料，取本模拟的巡航速度 */
export const CANT_DESIGN_SPEED_KMH = 90;
/** 车辆重心离轨面的高度 H（mm，估，通勤 / 近郊电车的量级）：只用来按公式算超高上限 G²/(6H) ≈ 146 mm */
export const CG_HEIGHT_MM = 1300;
/** 超高按 ±30 m 的平均曲率算（估）：模拟缓和曲线上超高逐渐变化（逓減），也压掉 OSM 折线在站场咽喉区的小折角 */
export const CANT_WINDOW_M = 30;
/** 超高沿线的变化率上限（mm/m，估）：超高在缓和曲线上逐渐加上去（逓減），逓減长取超高的约 600 倍。
 *  站场咽喉区的道岔、反向曲线在 OSM 里是一串短促的弯，没有这个限制时超高会在十几米内从一侧翻到另一侧，车体一秒转好几度 */
export const CANT_GRADIENT_MM_PER_M = 1 / 0.6;
/** 曲率小于这个量级按直线（估）：OSM 折线的平滑残差在直线段约 1/14 km，不能让它产生可见的侧倾 */
const CANT_DEADBAND_LO = 1 / 10000;
const CANT_DEADBAND_HI = 1 / 4000;

export interface TrackPoint {
  s: number;
  x: number;
  y: number;
  /** 轨面高程（米） */
  z: number;
  /** 曲率（1/m，+ = 往信濃大町方向左转） */
  k: number;
  /** 坡度（‰，+ = 往信濃大町方向上坡） */
  grade: number;
  /** center.flags 的位标志（最近的采样点） */
  flags: number;
}

const smoothstep = (a: number, b: number, x: number) => {
  const t = Math.min(Math.max((x - a) / (b - a), 0), 1);
  return t * t * (3 - 2 * t);
};

/** 中心线平面位置的平滑尺度（米），见文件头 */
export const POSITION_SMOOTH_SIGMA_M = 15;

/** 一维高斯平滑（σ 以采样点计）；两端窗口对称收窄，不把端点往里拉 */
function gaussianSmooth(src: Float32Array, sigma: number): Float32Array {
  const r = Math.ceil(sigma * 3);
  const w = new Float64Array(r + 1);
  for (let j = 0; j <= r; j++) w[j] = Math.exp(-0.5 * (j / sigma) ** 2);
  const out = new Float32Array(src.length);
  for (let i = 0; i < src.length; i++) {
    const rr = Math.min(r, i, src.length - 1 - i);
    let acc = src[i] * w[0], ws = w[0];
    for (let j = 1; j <= rr; j++) {
      acc += (src[i - j] + src[i + j]) * w[j];
      ws += 2 * w[j];
    }
    out[i] = acc / ws;
  }
  return out;
}

export class Corridor {
  readonly data: RailData;
  readonly sMin: number;
  readonly sMax: number;
  readonly stations: RailStation[];
  /** 平滑后的中心线平面位置（ENU 米） */
  readonly px: Float32Array;
  readonly py: Float32Array;
  /** 超高（mm，带符号），按 2 m 采样、已做变化率限制 */
  private readonly cant: Float32Array;
  /** 曲率的前缀和（算滑动平均用） */
  private readonly kPrefix: Float64Array;

  constructor(data: RailData) {
    this.data = data;
    const c = data.center;
    this.sMin = c.s0;
    this.sMax = c.s0 + (c.n - 1) * c.ds;
    this.stations = [...data.meta.stations].sort((a, b) => a.s - b.s);
    this.px = gaussianSmooth(c.x, POSITION_SMOOTH_SIGMA_M / c.ds);
    this.py = gaussianSmooth(c.y, POSITION_SMOOTH_SIGMA_M / c.ds);
    this.kPrefix = new Float64Array(c.n + 1);
    for (let i = 0; i < c.n; i++) this.kPrefix[i + 1] = this.kPrefix[i] + c.curvature[i];
    this.cant = this.buildCant();
  }

  get flags() {
    return this.data.meta.format.flags;
  }

  /** s → (采样下标 i, 插值系数 t)，s 夹在线路范围内 */
  private locate(s: number): [number, number] {
    const c = this.data.center;
    const u = Math.min(Math.max((s - c.s0) / c.ds, 0), c.n - 1 - 1e-9);
    const i = Math.floor(u);
    return [i, u - i];
  }

  private lerp(arr: Float32Array, s: number) {
    const [i, t] = this.locate(s);
    return arr[i] + (arr[i + 1] - arr[i]) * t;
  }

  /** 中心线上里程 s 处的点（ENU 米 + 轨面高程）。Catmull-Rom 插值（一阶导连续）：
   *  线性插值时车体方向（两个台车的连线）每过一个 2 m 采样点，转向速度就跳一下（约 12 Hz 的细小顿挫） */
  position(s: number, out: [number, number, number] = [0, 0, 0]): [number, number, number] {
    const c = this.data.center;
    const [i, t] = this.locate(s);
    const i0 = Math.max(i - 1, 0), i3 = Math.min(i + 2, c.n - 1);
    const t2 = t * t, t3 = t2 * t;
    const h00 = 2 * t3 - 3 * t2 + 1, h10 = t3 - 2 * t2 + t, h01 = -2 * t3 + 3 * t2, h11 = t3 - t2;
    const cr = (a: ArrayLike<number>) => {
      const p1 = a[i], p2 = a[i + 1];
      const m1 = (p2 - a[i0]) / (i + 1 - i0), m2 = (a[i3] - p1) / (i3 - i);
      return h00 * p1 + h10 * m1 + h01 * p2 + h11 * m2;
    };
    out[0] = cr(this.px);
    out[1] = cr(this.py);
    out[2] = cr(c.zRail);
    return out;
  }

  sample(s: number): TrackPoint {
    const c = this.data.center;
    const [x, y, z] = this.position(s);
    const [i, t] = this.locate(s);
    return { s, x, y, z, k: this.lerp(c.curvature, s), grade: this.lerp(c.grade, s), flags: c.flags[t < 0.5 ? i : i + 1] };
  }

  /** 中心线切向（单位向量，往 s 增大方向；按前后 2 m 的点差分） */
  tangent(s: number): [number, number] {
    const a = this.position(s - 2), b = this.position(s + 2);
    const dx = b[0] - a[0], dy = b[1] - a[1];
    const l = Math.hypot(dx, dy) || 1;
    return [dx / l, dy / l];
  }

  /** 走廊坐标 (s, d, h) → ENU（h 是离轨面的高度，米；d + = 往信濃大町方向左侧） */
  toEnu(s: number, d: number, h = 0): [number, number, number] {
    const p = this.position(s);
    const [tx, ty] = this.tangent(s);
    // 左法线 = 切向逆时针转 90°
    return [p[0] - ty * d, p[1] + tx * d, p[2] + h];
  }

  /**
   * ENU (x, y) → 走廊坐标 (s, d)：在 sHint 附近 ±window 米内找最近的中心线线段（逐段投影）。
   * 走廊只有 35 km、中心线不自交，局部搜索足够；给远离线路的点时结果没有意义。
   */
  project(x: number, y: number, sHint: number, window = 200): { s: number; d: number } {
    const c = this.data.center;
    const i0 = Math.max(0, Math.floor((sHint - window - c.s0) / c.ds));
    const i1 = Math.min(c.n - 2, Math.ceil((sHint + window - c.s0) / c.ds));
    let best = Infinity, bs = sHint, bd = 0;
    for (let i = i0; i <= i1; i++) {
      const ax = this.px[i], ay = this.py[i];
      const ex = this.px[i + 1] - ax, ey = this.py[i + 1] - ay;
      const l2 = ex * ex + ey * ey || 1e-9;
      const t = Math.min(Math.max(((x - ax) * ex + (y - ay) * ey) / l2, 0), 1);
      const px = ax + ex * t, py = ay + ey * t;
      const dist2 = (x - px) ** 2 + (y - py) ** 2;
      if (dist2 < best) {
        best = dist2;
        bs = c.s0 + (i + t) * c.ds;
        // 叉积判左右：切向 × (点 − 投影点) 的 z 分量 > 0 在左
        bd = Math.sign(ex * (y - py) - ey * (x - px)) * Math.sqrt(dist2);
      }
    }
    return { s: bs, d: bd };
  }

  /** ±halfWindow 米内的平均曲率（1/m）。在两个相邻采样点为中心的窗口之间线性插值：
   *  只按最近的采样点取窗口的话，结果每 2 m 跳一级，超高（侧倾）会一帧一帧地跳 */
  curvatureAvg(s: number, halfWindow = CANT_WINDOW_M): number {
    const c = this.data.center;
    const h = Math.max(1, Math.round(halfWindow / c.ds));
    const u = Math.min(Math.max((s - c.s0) / c.ds, 0), c.n - 1);
    const i = Math.min(Math.floor(u), c.n - 2);
    const t = u - i;
    const win = (j: number) => {
      const a = Math.max(0, j - h), b = Math.min(c.n - 1, j + h);
      return (this.kPrefix[b + 1] - this.kPrefix[a]) / (b - a + 1);
    };
    return win(i) * (1 - t) + win(i + 1) * t;
  }

  /**
   * 估算的超高（mm，带符号：+ = 往信濃大町方向左转的曲线，外轨是右轨）。
   * C = G·V²/(127·R)，夹到 G²/(6H)；直线段（|k| 很小）按 0；再限制沿线的变化率（CANT_GRADIENT_MM_PER_M）。
   * **全部是按公式估的，不是本线的实际超高。**
   */
  cantMm(s: number): number {
    return this.lerp(this.cant, s);
  }

  /** 公式给出的超高（不含变化率限制） */
  cantFormulaMm(s: number): number {
    const k = this.curvatureAvg(s);
    const ak = Math.abs(k) * smoothstep(CANT_DEADBAND_LO, CANT_DEADBAND_HI, Math.abs(k));
    const c = (GAUGE_MM * CANT_DESIGN_SPEED_KMH ** 2 * ak) / 127;
    return Math.sign(k) * Math.min(c, CANT_MAX_MM);
  }

  /** 逐点按公式算，再把左、右两侧的超高分别削成「变化率 ≤ CANT_GRADIENT_MM_PER_M」的梯形（前后各推一遍，不产生滞后） */
  private buildCant(): Float32Array {
    const c = this.data.center;
    const g = CANT_GRADIENT_MM_PER_M * c.ds;
    const pos = new Float32Array(c.n), neg = new Float32Array(c.n);
    for (let i = 0; i < c.n; i++) {
      const v = this.cantFormulaMm(c.s0 + i * c.ds);
      pos[i] = Math.max(v, 0);
      neg[i] = Math.max(-v, 0);
    }
    for (const a of [pos, neg]) {
      a[0] = 0;
      a[c.n - 1] = 0;
      for (let i = 1; i < c.n; i++) a[i] = Math.min(a[i], a[i - 1] + g);
      for (let i = c.n - 2; i >= 0; i--) a[i] = Math.min(a[i], a[i + 1] + g);
    }
    const out = new Float32Array(c.n);
    for (let i = 0; i < c.n; i++) out[i] = pos[i] - neg[i];
    return out;
  }

  /** 超高带来的车体（轨道平面）侧倾角（弧度，带符号同 cantMm） */
  cantAngle(s: number): number {
    return Math.asin(Math.min(Math.max(this.cantMm(s) / RAIL_CENTER_SPACING_MM, -1), 1));
  }

  /** 走廊高程网格（DEM 地表，米）：双线性；超出网格返回 null */
  groundZ(s: number, d: number): number | null {
    const g = this.data.meta.format.grid;
    const z = this.data.arrays["grid.z"] as Int16Array;
    const u = (s - g.s0) / g.ds, v = (d - g.d0) / g.dd;
    if (u < 0 || v < 0 || u > g.rows - 1 || v > g.cols - 1) return null;
    const r = Math.min(Math.floor(u), g.rows - 2), q = Math.min(Math.floor(v), g.cols - 2);
    const tu = u - r, tv = v - q;
    const at = (rr: number, cc: number) => z[rr * g.cols + cc];
    const a = at(r, q), b = at(r, q + 1), cc = at(r + 1, q), dd = at(r + 1, q + 1);
    if (a === g.nodata || b === g.nodata || cc === g.nodata || dd === g.nodata) return null;
    return ((a * (1 - tv) + b * tv) * (1 - tu) + (cc * (1 - tv) + dd * tv) * tu) * g.unit;
  }

  /** 行驶方向上（dir = +1 往信濃大町、−1 往松本）下一个车站；已经过了终点返回 null */
  nextStation(s: number, dir: 1 | -1): RailStation | null {
    if (dir > 0) return this.stations.find((st) => st.s > s + 1) ?? null;
    for (let i = this.stations.length - 1; i >= 0; i--) if (this.stations[i].s < s - 1) return this.stations[i];
    return null;
  }

  /** 离 s 最近的车站 */
  nearestStation(s: number): RailStation {
    let best = this.stations[0];
    for (const st of this.stations) if (Math.abs(st.s - s) < Math.abs(best.s - s)) best = st;
    return best;
  }

  /** 站台区间的中点（没有站台几何时用车站节点的投影） */
  stopPoint(st: RailStation): number {
    const p = st.platforms?.[0];
    const s = p ? (p.s0 + p.s1) / 2 : st.s;
    return Math.min(Math.max(s, this.sMin + 15), this.sMax - 15);
  }
}

/** 超高上限 G²/(6H)（mm）：H 是估值，所以上限也是估值（约 146 mm） */
export const CANT_MAX_MM = GAUGE_MM ** 2 / (6 * CG_HEIGHT_MM);
