/**
 * 头部左右限位（FOCUS-ZOOM 追加项）：头往舷窗前伸、再往两侧挪时，相机（总是看向窗板中心）斜着沿舱壁看出去，
 * 视锥边上的视线会越过已建模的范围——只建了侧壁（无限长）、本排与前一排座椅，前后更远的座椅、过道、舱顶都没有，
 * 露出来就是「空白的前后机舱」（远处只有光秃秃的侧壁一直延伸到消失点），视线平行或背离侧壁时干脆什么都打不到（纯黑）。
 *
 * 做法：按几何逐条检查视锥里的视线（四角 + 四条边 + 中心十字共 46 条），全部「只经过已建模区域」才算这个头部位置可用；
 * 对每个前伸量（z）、高度（y）、视场（聚焦时变窄）二分出头部 x 在每一侧的最大值。纯 CPU、每帧几百条射线，
 * 与着色器无关（不改任何 GLSL），几何常数与着色器一一对应（见各常数的出处）。
 *
 * 「已建模区域」的判据（视线从眼睛出发，到先碰到的已建模座椅或侧壁为止这一段）：
 *  ① 必须打到侧壁，且在水平面里与侧壁的夹角 ≥ MIN_GRAZE_DEG（再斜就是消失点附近无限重复的窗，平行 / 背离侧壁时纯黑）；
 *  ② 不能先穿过「真实客舱里该有、这里没建」的座椅：按同一排距把本排之后、前排之前的座椅外推几排，
 *     视线在碰到真有的两排或侧壁之前进了这些「幽灵座椅」的包围盒，就是看到了本该被座椅挡住的空白侧壁。
 * 座椅包围盒与 seats.glsl.ts 的 seatBox（靠背，后仰 16°）/ seatShellProfile（商务舱壳体的两段）同一套常数，经济舱没有壳体。
 * 包围盒比真实外形略大（头枕圆角、壳体圆弧都按方盒），所以判据对「挡住」略宽容、对「露馅」略严格。
 */

/** 座舱系：x 沿舱壁（右座朝机头为正），y 向上，z 朝窗外；u = seatSign·x 统一成「朝机头为正」 */
export interface LimitQuery {
  /** 头部高度、前伸（座舱系，米） */
  y: number;
  z: number;
  /** 垂直半视场的正切（聚焦时 = 默认 / 倍率） */
  tanHalfFov: number;
  /** 画面宽高比 */
  aspect: number;
  /** 右座 +1、左座 −1（与 uSeatSign 一致） */
  seatSign: number;
  economy: boolean;
}

// ---- 与着色器一致的几何常数 ----
/** 相机看向的点（main.ts cameraBasis：窗板中心） */
const TARGET: [number, number, number] = [0, -0.01, 0.075];
// seats.glsl.ts
const SEAT_PITCH = 0.78;
const SEAT_C = 0.96106, SEAT_S = 0.27636;
const PIVOT_U = -0.06, PIVOT_Y = -0.66;
const SEAT_TOP = 0.64, SEAT_BOTTOM = -0.5;
const SEAT_ZC = -0.3, SEAT_HW = 0.22;
const SHELL_ZC = -0.058, SHELL_HT = 0.011;

/** 「该有却没建」的座椅：本排后面、前排前面各外推几排（再远的视线早已先穿过近的这几排） */
const PHANTOM_ROWS = 4;
/** 视线与侧壁平面的最小夹角：再斜，侧壁上的窗在消失点附近挤成一片（无限重复、会闪），更斜就打不到侧壁（纯黑） */
const MIN_GRAZE_DEG = 12;

/** 头部 x 的硬范围（view-presets.ts HEAD_X_RANGE） */
export const HEAD_X_MAX = 0.45;

type V3 = [number, number, number];
const sub = (a: V3, b: V3): V3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const cross = (a: V3, b: V3): V3 => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const norm = (a: V3): V3 => {
  const l = Math.hypot(a[0], a[1], a[2]);
  return [a[0] / l, a[1] / l, a[2] / l];
};

// 侧壁轮廓（cabin-shading.glsl.ts wallZ / wallSlope / traceWall）
const wallZ = (y: number) => {
  const u = Math.max(y - 0.3, 0), l = Math.max(-0.3 - y, 0);
  return -0.5 * u * u - 0.15 * l * l;
};
const wallSlope = (y: number) => -Math.max(y - 0.3, 0) + 0.3 * Math.max(-0.3 - y, 0);
function traceWall(o: V3, d: V3): number {
  let t = -o[2] / d[2];
  for (let i = 0; i < 12; i++) {
    const py = o[1] + d[1] * t, pz = o[2] + d[2] * t;
    t -= (pz - wallZ(py)) / Math.max(d[2] - wallSlope(py) * d[1], 1e-3);
  }
  return t;
}

/** 轴对齐盒的进入距离（没打到返回 Infinity） */
function slab(o: V3, d: V3, lo: V3, hi: V3): number {
  let tn = -Infinity, tf = Infinity;
  for (let k = 0; k < 3; k++) {
    if (Math.abs(d[k]) < 1e-12) {
      if (o[k] < lo[k] || o[k] > hi[k]) return Infinity;
      continue;
    }
    const a = (lo[k] - o[k]) / d[k], b = (hi[k] - o[k]) / d[k];
    tn = Math.max(tn, Math.min(a, b));
    tf = Math.min(tf, Math.max(a, b));
  }
  return tf > Math.max(tn, 0) ? Math.max(tn, 0) : Infinity;
}

/** 视线先碰到第 row0 … row1 排座椅（包围盒）的距离（座舱系；o、d 已换成 u 坐标 = 朝机头为正）。
 *  row 0 / 1 是着色器里真的有的两排；其余排号是「真实客舱里该有、这里没建」的座椅，位置按同一排距外推 */
function seatHit(o: V3, d: V3, economy: boolean, row0: number, row1: number): number {
  let t = Infinity;
  for (let row = row0; row <= row1; row++) {
    // 靠背包围盒（seats.glsl.ts seatBox：靠背局部系 f / s / z）
    const a = o[0] - PIVOT_U - row * SEAT_PITCH, yy = o[1] - PIVOT_Y;
    const ol: V3 = [a * SEAT_C + yy * SEAT_S, -a * SEAT_S + yy * SEAT_C, o[2]];
    const dl: V3 = [d[0] * SEAT_C + d[1] * SEAT_S, -d[0] * SEAT_S + d[1] * SEAT_C, d[2]];
    t = Math.min(t, slab(ol, dl, [-0.075, SEAT_BOTTOM - 0.01, SEAT_ZC - SEAT_HW - 0.01], [0.075, SEAT_TOP + 0.01, SEAT_ZC + SEAT_HW + 0.01]));
    if (!economy) {
      // 壳体（seatShellProfile 的两段：高护翼 u −0.40…−0.20、顶 −0.03；扶手台面 u −0.40…0.24、顶 −0.40），不后仰
      const u0 = PIVOT_U + row * SEAT_PITCH;
      t = Math.min(t, slab(o, d, [u0 - 0.4, -1.12, SHELL_ZC - SHELL_HT], [u0 - 0.2, -0.03, SHELL_ZC + SHELL_HT]));
      t = Math.min(t, slab(o, d, [u0 - 0.4, -1.12, SHELL_ZC - SHELL_HT], [u0 + 0.24, -0.4, SHELL_ZC + SHELL_HT]));
    }
  }
  return t;
}

/** 一条视线（u 坐标）是否只经过已建模区域 */
function rayOk(o: V3, d: V3, economy: boolean): boolean {
  // ① 打到侧壁的点沿机身方向离眼睛不能太远：不超过「眼睛所在深度处、与侧壁成 MIN_GRAZE_DEG 的水平视线」打到侧壁的距离。
  //   侧壁沿机身无限长、窗无限重复，消失点只在这个方向上；上下方向侧壁是弯回来的（上接行李架、下面内收），
  //   陡峭朝下 / 朝上的视线很快就打到弯回来的侧壁，头在最高 / 最低、贴窗时的截图都没有露馅（handoff/FOCUS-ZOOM.md），不因俯仰受限
  if (d[2] <= 0) return false;
  const tWall = traceWall(o, d);
  if (!(tWall > 0) || Math.abs(d[0] * tWall) > -o[2] / Math.tan((MIN_GRAZE_DEG * Math.PI) / 180)) return false;
  // ② 在碰到真有的两排座椅或侧壁之前，穿过了「该有却没建」的座椅（前后各外推 PHANTOM_ROWS 排）
  const tEnd = Math.min(tWall, seatHit(o, d, economy, 0, 1));
  // 这一段始终高过所有座椅包围盒的顶（靠背盒顶约 y = −0.015）就不用查
  if (Math.min(o[1], o[1] + d[1] * Math.min(tEnd, 50)) > SEAT_BOX_TOP_Y) return true;
  // 眼睛在真有的两排之间（u ∈ [−0.45, 0.45]），朝机头的视线只可能碰到前面的幽灵排，朝机尾的只可能碰到后面的
  const tGhost = d[0] >= 0 ? seatHit(o, d, economy, 2, 1 + PHANTOM_ROWS) : seatHit(o, d, economy, -PHANTOM_ROWS, -1);
  return tGhost >= tEnd;
}

/** 座椅包围盒的最高点（靠背盒 s = SEAT_TOP + 0.01、f = 0.075 处，约 −0.015；壳体顶 −0.03） */
const SEAT_BOX_TOP_Y = PIVOT_Y + 0.075 * SEAT_S + (SEAT_TOP + 0.01) * SEAT_C;

/** 视锥上取样的视线：四个角、四条边上各 7 个点、中心十字共 46 条。① ② 最先失败的都在视锥边上（最斜、最低的视线），
 *  边界取样足够；取样间隔约为视场的 1/8，二分找到的限位对应边上某条取样视线刚好到判据边界 */
const SAMPLES: [number, number][] = (() => {
  const s: [number, number][] = [[-1, -1], [1, -1], [-1, 1], [1, 1]];
  for (let i = 1; i < 8; i++) {
    const t = (i / 8) * 2 - 1;
    s.push([t, -1], [t, 1], [-1, t], [1, t], [t, 0], [0, t]);
  }
  return s;
})();

/** 头部在 (x, y, z) 时整个视锥是否都只看到已建模区域 */
export function frustumOk(x: number, q: LimitQuery): boolean {
  const eye: V3 = [x, q.y, q.z];
  const back = norm(sub(eye, TARGET));
  const right = norm(cross([0, 1, 0], back));
  const up = cross(back, right);
  // 换成 u 坐标（朝机头为正）：只翻 x 分量
  const s = q.seatSign;
  const o: V3 = [s * eye[0], eye[1], eye[2]];
  for (const [nx, ny] of SAMPLES) {
    const a = nx * q.aspect * q.tanHalfFov, b = ny * q.tanHalfFov;
    const d = norm([right[0] * a + up[0] * b - back[0], right[1] * a + up[1] * b - back[1], right[2] * a + up[2] * b - back[2]]);
    if (!rayOk(o, [s * d[0], d[1], d[2]], q.economy)) return false;
  }
  return true;
}

/**
 * ③ 本窗窗板开口近侧边缘的斜看角上限（与视场无关，只看头的位置）。
 * 现象（FOCUS-ZOOM 实测，README 坑点）：从很斜的角度看本窗时，窗板开口近侧（靠眼睛那一侧）出现一条竖直的纯黑带，
 * 越斜越宽——着色器在这里的合成有缺陷（窗洞内衬挡住窗板的那一条没有正确着色），不在本任务归属内，先在相机上避开。
 * 网格实测（默认视场、正午，z = −0.03 … −0.42，偏航每 3°）：眼睛到窗板开口近侧边缘（x = ±PANE_HALF_X、z = PANE_DEPTH）
 * 的视线与窗板法线夹角 ≥ 35.4° 时出现黑带，≤ 31° 时各前伸量都没有（中间 35.5–37° 有的有、有的没有），取 33°。
 */
const PANE_HALF_X = 0.12, PANE_DEPTH = 0.075;
const PANE_EDGE_MAX_DEG = 33;
function paneEdgeOk(x: number, z: number): boolean {
  return Math.abs(x) - PANE_HALF_X <= (PANE_DEPTH - z) * Math.tan((PANE_EDGE_MAX_DEG * Math.PI) / 180);
}

/** 头部在 (x, y, z) 时是否可用：窗板斜看角 + 整个视锥都只看到已建模区域 */
export function headOk(x: number, q: LimitQuery): boolean {
  return paneEdgeOk(x, q.z) && frustumOk(x, q);
}

/**
 * 头部 x 在 side（+1 / −1，座舱系 x 的正 / 负方向）一侧能到的最远处（≥ 0 的距离，二分到 LIMIT_EPS）。
 * x = 0（正对窗口）本身都不行时返回 0：那是 y / z / 视场组合本身的问题（例如极宽的画面），不在这里处理。
 * prior：上一帧的结果（热启动：输入每帧只变一点，先在它附近 ±1 mm 找括号，再二分，平均 5–6 次判断）
 */
export function headXLimit(side: 1 | -1, q: LimitQuery, prior?: number): number {
  const ok = (m: number) => headOk(side * m, q);
  let lo: number, hi: number;
  if (prior !== undefined && prior > 0 && prior < HEAD_X_MAX) {
    const w = 0.001;
    if (ok(prior)) {
      lo = prior;
      hi = Math.min(prior + w, HEAD_X_MAX);
      while (ok(hi)) {
        if (hi >= HEAD_X_MAX) return HEAD_X_MAX;
        lo = hi;
        hi = Math.min(hi + 4 * (hi - prior), HEAD_X_MAX);
      }
    } else {
      hi = prior;
      lo = Math.max(prior - w, 0);
      while (!ok(lo)) {
        if (lo <= 0) return 0;
        hi = lo;
        lo = Math.max(lo - 4 * (prior - lo), 0);
      }
    }
  } else {
    if (ok(HEAD_X_MAX)) return HEAD_X_MAX;
    if (!ok(0)) return 0;
    lo = 0;
    hi = HEAD_X_MAX;
  }
  while (hi - lo > LIMIT_EPS) {
    const m = 0.5 * (lo + hi);
    if (ok(m)) lo = m;
    else hi = m;
  }
  return lo;
}

/** 限位的求解精度（米）：0.05 mm。限位每帧随前伸 / 视场连续变化，太粗的话被它夹住的头部会一格一格地跳（放大 8 倍时 1 mm ≈ 0.2°） */
const LIMIT_EPS = 0.00005;

/**
 * 每帧维护的左右限位（座舱系 x 的正 / 负两侧，都是 ≥ 0 的距离）。输入没变就不重算；变了用上一帧的结果热启动。
 */
export class HeadLimiter {
  pos = HEAD_X_MAX;
  neg = HEAD_X_MAX;
  private key = "";

  update(q: LimitQuery) {
    // 头部平滑跟随是指数逼近，y / z 每帧都还在变最后几位：按 0.01 mm、视场按 1e-6 取整，收敛后就不再重算
    const key = `${Math.round(q.y * 1e5)}|${Math.round(q.z * 1e5)}|${Math.round(q.tanHalfFov * 1e6)}|${q.aspect.toFixed(4)}|${q.seatSign}|${q.economy}`;
    if (key === this.key) return;
    const first = this.key === "";
    this.key = key;
    this.pos = headXLimit(1, q, first ? undefined : this.pos);
    this.neg = headXLimit(-1, q, first ? undefined : this.neg);
  }

  /** 把 x 夹进限位（硬夹） */
  clamp(x: number) {
    return Math.min(Math.max(x, -this.neg), this.pos);
  }

  /**
   * 拖动一步（弹性阻尼）：x 是当前目标位置，delta 是这一步手拖出来的位移。往外推时，进入离限位 SOFT_ZONE 的区域后
   * 位移按 (1 − 进入深度 / SOFT_ZONE)² 打折，越靠近限位越推不动、渐近地停在限位上（没有硬停的「撞墙」）；
   * 往回拉不打折（没有死区）。结果再夹进限位。
   */
  drag(x: number, delta: number) {
    const L = x + delta >= 0 ? this.pos : this.neg;
    const knee = Math.max(L - SOFT_ZONE, 0);
    const outward = Math.sign(delta) === Math.sign(x) || x === 0;
    let step = delta;
    if (outward && Math.abs(x) > knee && L > knee) {
      const r = Math.max(0, 1 - (Math.abs(x) - knee) / (L - knee));
      step *= r * r;
    }
    return this.clamp(x + step);
  }
}

/** 软限位区的宽度（米）：离限位 3 cm 开始有阻尼 */
const SOFT_ZONE = 0.03;
