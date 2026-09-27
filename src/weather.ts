import * as THREE from "three";
import type { CloudUniforms } from "./clouds/clouds";

/**
 * 天气系统：在普通云层之外叠加雷暴单体和台风，并调度闪电。
 * 雷暴、台风都固定在地面（本地公里坐标），飞机飞过时从窗外经过。
 *
 * 闪电按泊松过程发生（每个单体平均几秒一次）；一次闪电有 2–4 次回击，间隔几十毫秒，所以会连闪几下。
 * 云内闪电（约 70%）是云里一段 3–10 km 长、大致水平的放电通道（有时钻进砧状云里），照亮整团云；
 * 云地闪（约 30%）除了云里的一段竖直通道，还生成一条从云底到地面的折线主通道（带一条分叉），由场景着色器画出来。
 * 云内闪 : 云地闪的比例因地区而异，常见的全球平均估计约 2–3 : 1，这里取 7 : 3。
 */

export interface WeatherPreset {
  id: string;
  name: string;
}

export const WEATHER_PRESETS: WeatherPreset[] = [
  { id: "fair", name: "无特殊天气（只有云层）" },
  { id: "storm", name: "孤立雷暴（积雨云）" },
  { id: "squall", name: "飑线（一排雷暴）" },
  { id: "typhoon-bands", name: "台风外围螺旋雨带" },
  { id: "typhoon-eye", name: "台风眼内（体育场效应）" },
  { id: "typhoon-outer", name: "台风外围（在卷云盖外缘下俯看雨带）" },
];

export interface Storm {
  /** 天气场放进来的单体带 id（「系统 id#序号」，T19b）；面板预设放的没有 id */
  id?: string;
  /** 安静的单体：不打闪电（奇观之门的云墙，T19b） */
  quiet?: boolean;
  x: number;
  z: number;
  radius: number;
  top: number;
  nextFlash: number;
}

interface Stroke {
  t0: number;
  intensity: number;
}

const MAX_BOLT_POINTS = 16;

export class WeatherSystem {
  storms: Storm[] = [];
  hurricane: { id?: string; x: number; z: number; eye: number } | null = null;
  private strokes: Stroke[] = [];
  private flashPos = new THREE.Vector3();
  private flashEnd = new THREE.Vector3();
  /** 调试 / 截图：true 时闪光亮度保持在 heldIntensity，不衰减、不触发新的闪电 */
  hold = false;
  heldIntensity = 0;
  /** 云地闪的主通道（本地公里坐标，y 是高度），给场景着色器 */
  readonly bolt = Array.from({ length: MAX_BOLT_POINTS }, () => new THREE.Vector3());
  boltCount = 0;
  boltIntensity = 0;
  /** 闪电事件回调（T11 声音：按距离延迟打雷）。start / end 是放电通道两端（本地坐标 km，y 为海拔），cg：云地闪 */
  onFlash: ((start: THREE.Vector3, end: THREE.Vector3, cg: boolean) => void) | null = null;
  private time = 0;

  constructor(private readonly u: CloudUniforms) {}

  /** 按预设在飞机附近摆放天气。pos：飞机本地坐标；fwd / out：航向与窗外方向（水平单位向量，x 东 z 南） */
  apply(id: string, pos: THREE.Vector2, fwd: THREE.Vector3, out: THREE.Vector3) {
    this.storms = [];
    this.hurricane = null;
    const at = (ahead: number, side: number) => ({ x: pos.x + fwd.x * ahead + out.x * side, z: pos.y + fwd.z * ahead + out.z * side });
    const storm = (ahead: number, side: number, radius: number, top: number) => {
      const p = at(ahead, side);
      this.storms.push({ ...p, radius, top, nextFlash: this.time + Math.random() * 3 });
    };
    // 窗户的视野左右各约 25°：天气主要摆在窗外侧，稍微偏前，随着飞机前进慢慢移过窗前
    if (id === "storm") storm(4, 60, 6.5, 13.5);
    if (id === "squall") {
      // 一排雷暴，和航线大致平行，间距约 12 km
      for (let i = 0; i < 4; i++) storm(-15 + i * 16, 55 + i * 5, 4 + Math.random() * 2, 11.5 + Math.random() * 3);
    }
    // 台风眼：飞机在眼里偏向一侧（离中心约 12 km），窗外隔着整个眼看对面的眼壁，两侧的眼壁弧形地围过来
    if (id === "typhoon-bands") this.hurricane = { ...at(40, 180), eye: 20 };
    if (id === "typhoon-eye") this.hurricane = { ...at(0, 12), eye: 20 };
    // 外围：离中心约 220 km，卷云盖外缘只剩一层薄卷云，下面是一条条弯向中心的雨带
    if (id === "typhoon-outer") this.hurricane = { ...at(30, 220), eye: 20 };
    this.syncUniforms();
  }

  /** 同一时刻最多几个雷暴单体（uStorms 的长度） */
  static readonly MAX_STORMS = 4;

  /** 加一个单体（T19b：导演按天气场摆放，本地公里坐标）。满了返回 false */
  addStorm(s: { id: string; x: number; z: number; radius: number; top: number; quiet?: boolean }) {
    if (this.storms.length >= WeatherSystem.MAX_STORMS) return false;
    this.storms.push({ ...s, nextFlash: s.quiet ? Infinity : this.time + Math.random() * 3 });
    this.syncUniforms();
    return true;
  }

  /** 移除满足条件的单体 */
  removeStorms(pred: (s: Storm) => boolean) {
    const n = this.storms.length;
    this.storms = this.storms.filter((s) => !pred(s));
    if (this.storms.length !== n) this.syncUniforms();
  }

  /** 放置 / 移除台风（T19b）。id 用来和天气场里的台风对应 */
  setHurricane(h: { id?: string; x: number; z: number; eye: number } | null) {
    this.hurricane = h;
    this.syncUniforms();
  }

  /** 本地坐标换原点时整体平移（main.ts 的 rebaseFrame） */
  translate(dx: number, dz: number) {
    for (const s of this.storms) {
      s.x -= dx;
      s.z -= dz;
    }
    if (this.hurricane) {
      this.hurricane.x -= dx;
      this.hurricane.z -= dz;
    }
    for (const b of this.bolt) {
      b.x -= dx;
      b.z -= dz;
    }
    this.flashPos.x -= dx;
    this.flashPos.z -= dz;
    this.flashEnd.x -= dx;
    this.flashEnd.z -= dz;
    this.syncUniforms();
  }

  syncUniforms() {
    const u = this.u;
    u.uStormCount.value = this.storms.length;
    this.storms.forEach((s, i) => u.uStorms.value[i].set(s.x, s.z, s.radius, s.top));
    if (this.hurricane) u.uHurricane.value.set(this.hurricane.x, this.hurricane.z, this.hurricane.eye, 1);
    else u.uHurricane.value.w = 0;
    this.updateShell();
  }

  /** 步进的外壳高度范围：层状云、雷暴、台风合起来 */
  updateShell() {
    const u = this.u;
    let bottom = u.uCloudBottom.value;
    let top = u.uCloudTop.value;
    if (this.storms.length) {
      bottom = 0.0; // 雨幡一直落到地面
      // 上冲云顶高出砧顶约 0.9 km，再加上表面的隆起
      top = Math.max(top, ...this.storms.map((s) => s.top + 1.8));
    }
    if (this.hurricane) {
      bottom = Math.min(bottom, 0.5);
      top = Math.max(top, 20.5); // 卷云盖顶 16.2 km；眼壁顶沿最高约 17.4 km，上冲的对流塔顶封顶在 20.4 km（T26）
    }
    u.uShellBottom.value = bottom;
    u.uShellTop.value = top;
  }

  update(dt: number) {
    this.time += dt;
    if (this.hold) {
      this.u.uFlash.value.set(this.flashPos.x, this.flashPos.y, this.flashPos.z, this.heldIntensity);
      this.u.uFlashB.value.copy(this.flashEnd);
      this.boltIntensity = this.boltCount > 0 ? this.heldIntensity : 0;
      return;
    }
    // 触发新的闪电
    for (const s of this.storms) {
      if (this.time < s.nextFlash) continue;
      s.nextFlash = this.time + -Math.log(1 - Math.random()) * 5; // 平均 5 秒一次
      this.trigger(s);
    }
    // 回击序列：每次回击亮度按 ~50 ms 衰减
    let intensity = 0;
    this.strokes = this.strokes.filter((k) => this.time - k.t0 < 0.4);
    for (const k of this.strokes) {
      const age = this.time - k.t0;
      if (age >= 0) intensity += k.intensity * Math.exp(-age / 0.05);
    }
    this.u.uFlash.value.set(this.flashPos.x, this.flashPos.y, this.flashPos.z, intensity);
    this.u.uFlashB.value.copy(this.flashEnd);
    this.boltIntensity = this.boltCount > 0 ? intensity : 0;
    if (intensity < 1e-3) this.boltCount = 0;
  }

  /** 调试：立刻在第 i 个雷暴里触发一次闪电。hold = true 时亮度停在 intensity（截图用），把 hold 改回 false 恢复 */
  flashNow(i = 0, cg = false, hold = false, intensity = 300) {
    const s = this.storms[i];
    if (!s) return;
    this.trigger(s, cg);
    this.hold = hold;
    this.heldIntensity = intensity;
  }

  private trigger(s: Storm, forceCg?: boolean) {
    const cg = forceCg ?? Math.random() < 0.3;
    const ang = Math.random() * Math.PI * 2;
    const rr = Math.random() * s.radius * 0.6;
    const fx = s.x + Math.cos(ang) * rr;
    const fz = s.z + Math.sin(ang) * rr;
    const dir = Math.random() * Math.PI * 2;
    if (cg) {
      // 云地闪：云里的一段从云底往上走到 4–6 km（光主要在云的中下部）
      const lean = 1 + Math.random() * 2;
      this.flashPos.set(fx, 1.3, fz);
      this.flashEnd.set(fx + Math.cos(dir) * lean, 4 + Math.random() * 2, fz + Math.sin(dir) * lean);
    } else {
      // 云内闪电：中上部一段大致水平的通道；约三分之一往下风方钻进砧状云（「蜘蛛闪电」）
      const len = 3 + Math.random() * 7;
      const alt = 5 + Math.random() * 4;
      this.flashPos.set(fx, alt, fz);
      if (Math.random() < 0.35) {
        const w = this.u.uUpperWind.value;
        this.flashEnd.set(fx + w.x * len * 1.5, s.top - 1.5, fz + w.y * len * 1.5);
      } else {
        this.flashEnd.set(fx + Math.cos(dir) * len, alt + (Math.random() - 0.5) * 2, fz + Math.sin(dir) * len);
      }
    }
    const n = 2 + Math.floor(Math.random() * 3);
    for (let i = 0; i < n; i++) this.strokes.push({ t0: this.time + i * (0.05 + Math.random() * 0.08), intensity: 300 * (i === 0 ? 1 : 0.5 + Math.random() * 0.5) });
    this.boltCount = 0;
    if (cg) this.makeBolt(fx, fz);
    this.onFlash?.(this.flashPos, this.flashEnd, cg);
  }

  /** 云地闪主通道：从云底往下走的折线，每段随机偏折；中途分出一条短分叉（用剩余的点） */
  private makeBolt(x: number, z: number) {
    const main = 11;
    let px = x;
    let pz = z;
    for (let i = 0; i < main; i++) {
      const alt = 1.2 * (1 - i / (main - 1));
      this.bolt[i].set(px, alt, pz);
      px += (Math.random() - 0.5) * 0.35;
      pz += (Math.random() - 0.5) * 0.35;
    }
    // 分叉：从主通道第 3 个点斜着往下，不落地
    const b0 = this.bolt[3];
    let bx = b0.x;
    let bz = b0.z;
    let balt = b0.y;
    const dir = Math.random() * Math.PI * 2;
    for (let i = main; i < MAX_BOLT_POINTS; i++) {
      bx += Math.cos(dir) * 0.25 + (Math.random() - 0.5) * 0.15;
      bz += Math.sin(dir) * 0.25 + (Math.random() - 0.5) * 0.15;
      balt -= 0.12;
      this.bolt[i].set(bx, balt, bz);
    }
    this.boltCount = MAX_BOLT_POINTS;
  }
}

// =====================================================================================
// 天气场（T19b）：按经纬度 + 时间取样的低频、可重复的场。给连续航程的导演用：
//   · 云型与云量：大尺度噪声 + 季节 / 纬度 / 海陆 / 当地时段的倾向（夏季午后陆地对流、海上信风积云、锋面带层积云 / 高积云）；
//   · 雷暴系统：按「2.5° 格子 × 3 小时窗口」哈希出生，有出生时刻、寿命、漂移速度（西风带往东、副热带往西），
//     飞机从它们旁边经过，而不是跟着飞机的预设；
//   · 台风：按「8° 格子 × 4 天窗口」在西北太平洋生成，向西北移动、过 25°N 后转向东北（示意性的转向路径）。
// 同样的 (lat, lon, t, seed) 永远给出同样的结果：重开页面、来回飞同一处，天气一致。
// 都是示意性的气候倾向，不是真实天气数据（没有接任何气象服务）。
// =====================================================================================

/** 天气场里的云型（regime）。cumulus / towering 同属积状云族，之间连续过渡；其他族之间的切换要借遮挡或「晴空间隙」 */
export type CloudRegime = "clear" | "cumulus" | "towering" | "stratocumulus" | "altocumulus" | "cirrus";
export const REGIME_NAMES: Record<CloudRegime, string> = {
  clear: "晴空",
  cumulus: "晴天积云",
  towering: "浓积云（对流）",
  stratocumulus: "层积云",
  altocumulus: "高积云",
  cirrus: "卷云",
};
/** 云型所属的族：同族之间参数连续插值，不同族之间要换云层高度，得借遮挡 */
export const REGIME_FAMILY: Record<CloudRegime, string> = {
  clear: "none",
  cumulus: "cumuliform",
  towering: "cumuliform",
  stratocumulus: "stratocumulus",
  altocumulus: "altocumulus",
  cirrus: "cirrus",
};

/** 一次取样的结果：云层参数（和 CloudPreset 同义）+ 解释用的中间量 */
export interface WeatherSample {
  regime: CloudRegime;
  bottom: number;
  top: number;
  coverage: number;
  type: number;
  density: number;
  /** 各云型的得分（调试 / 滞回用） */
  scores: Record<CloudRegime, number>;
  /** 对流潜势 0..1、锋面强度 0..1、信风 0..1、大尺度云量 0..1、是否陆地 */
  convection: number;
  front: number;
  trade: number;
  cloudiness: number;
  land: boolean;
}

export interface StormCellSample {
  /** 「系统 id#序号」 */
  id: string;
  lat: number;
  lon: number;
  radius: number;
  top: number;
}
export interface StormSystemSample {
  id: string;
  lat: number;
  lon: number;
  /** 生命周期强度 0..1（出生—成熟—消散的正弦包络） */
  strength: number;
  kind: "isolated" | "cluster" | "squall";
  cells: StormCellSample[];
}
export interface TyphoonSample {
  id: string;
  lat: number;
  lon: number;
  eye: number;
  strength: number;
}

const D2R = Math.PI / 180;
const clamp01 = (v: number) => Math.min(Math.max(v, 0), 1);
const smooth = (a: number, b: number, x: number) => {
  const t = clamp01((x - a) / (b - a));
  return t * t * (3 - 2 * t);
};

/** 整数哈希 → [0, 1) */
function hash(i: number, j: number, k: number, seed: number) {
  let h = Math.imul(i | 0, 0x27d4eb2d) ^ Math.imul(j | 0, 0x165667b1) ^ Math.imul(k | 0, 0x1b873593) ^ Math.imul(seed | 0, 0x85ebca6b);
  h = Math.imul(h ^ (h >>> 15), 0x2c1b3c6d);
  h = Math.imul(h ^ (h >>> 12), 0x297a2d39);
  h ^= h >>> 15;
  return (h >>> 0) / 4294967296;
}

/** 三维值噪声（三线性 + smoothstep），输出 [0, 1) */
function vnoise(x: number, y: number, z: number, seed: number) {
  const xi = Math.floor(x), yi = Math.floor(y), zi = Math.floor(z);
  const f = (t: number) => t * t * (3 - 2 * t);
  const fx = f(x - xi), fy = f(y - yi), fz = f(z - zi);
  const l = (a: number, b: number, t: number) => a + (b - a) * t;
  const c = (dx: number, dy: number, dz: number) => hash(xi + dx, yi + dy, zi + dz, seed);
  return l(
    l(l(c(0, 0, 0), c(1, 0, 0), fx), l(c(0, 1, 0), c(1, 1, 0), fx), fy),
    l(l(c(0, 0, 1), c(1, 0, 1), fx), l(c(0, 1, 1), c(1, 1, 1), fx), fy),
    fz,
  );
}
/** 两个倍频叠加，再拉开对比（值噪声叠加后挤在 0.5 附近） */
const fbm = (x: number, y: number, z: number, seed: number) =>
  clamp01(0.5 + (0.65 * vnoise(x, y, z, seed) + 0.35 * vnoise(x * 2.1 + 5.3, y * 2.1 + 1.7, z * 1.9, seed + 7) - 0.5) * 1.8);

// ---------- 粗略的东亚海陆分布（示意，误差几十公里级；只用于气候倾向，不用于画面） ----------
/** 大陆（中国东部、朝鲜半岛、中南半岛、马来半岛）的海岸线折线，(纬度, 经度) */
const MAINLAND: [number, number][] = [
  [53, 95], [53, 135], [48, 135], [43, 131.5], [42.3, 130.7], [40, 128.5], [38.2, 128.6], [35.5, 129.4], [34.8, 128.5], [34.5, 126.4],
  [35.8, 126.5], [37.5, 126.5], [38.8, 125.1], [39.8, 124.2], [39, 121.3], [40.8, 121.9], [40, 119.5], [39, 117.8], [38, 118.8], [37.4, 119.3],
  [37.5, 122.5], [36.3, 120.6], [35, 119.3], [33, 120.8], [31.8, 121.7], [30.8, 121.9], [30, 122.2], [28, 121.2], [26.5, 120], [25, 119.1],
  [23.5, 116.8], [22.5, 114.6], [21.8, 112.2], [21.5, 109.8], [21.6, 108.3], [20.8, 106.8], [19, 105.8], [17, 107.1], [16, 108.3], [13.5, 109.3],
  [11.5, 109.2], [10.4, 107.2], [8.6, 104.8], [10.3, 104.4], [11.5, 103], [12.6, 101.4], [13.4, 100.9], [12.2, 99.9], [9.5, 99.2], [7, 100.4],
  [5.5, 100.4], [3, 101.4], [1.4, 103.8], [1.5, 104.2], [3.5, 103.4], [6.2, 102.3], [4, 100.6], [6.5, 99.7], [8, 98.3], [10, 98.5],
  [13, 98.6], [16.5, 97.6], [16, 95],
];
/** 岛屿：点或折线加半宽（km）。日本、台湾、海南、菲律宾、婆罗洲 */
const ISLANDS: { pts: [number, number][]; halfKm: number }[] = [
  { pts: [[34.0, 131.0], [34.7, 135.2], [35.2, 137.2], [35.6, 139.6], [37.5, 140.9], [40.0, 141.3], [41.2, 140.9]], halfKm: 85 },
  { pts: [[32.6, 130.8]], halfKm: 105 },
  { pts: [[33.7, 133.4]], halfKm: 70 },
  { pts: [[43.3, 142.7]], halfKm: 170 },
  { pts: [[25.1, 121.6], [23.6, 121.1], [22.2, 120.8]], halfKm: 55 },
  { pts: [[19.2, 109.8]], halfKm: 85 },
  { pts: [[18.3, 121.0], [16.0, 120.8], [14.3, 121.2], [13.6, 123.4]], halfKm: 70 },
  { pts: [[11.0, 123.3], [10.2, 124.4]], halfKm: 110 },
  { pts: [[7.6, 124.9]], halfKm: 160 },
  { pts: [[1.0, 114.0]], halfKm: 520 },
];

function inPolygon(lat: number, lon: number, poly: [number, number][]) {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const [ai, oi] = poly[i];
    const [aj, oj] = poly[j];
    if (ai > lat !== aj > lat && lon < ((oj - oi) * (lat - ai)) / (aj - ai) + oi) inside = !inside;
  }
  return inside;
}

/** 粗略判断 (lat, lon) 是不是陆地（东亚范围外一律按海） */
export function coarseLand(lat: number, lon: number) {
  if (lat < -5 || lat > 55 || lon < 94 || lon > 150) return false;
  if (inPolygon(lat, lon, MAINLAND)) return true;
  const kx = 111.32 * Math.cos(lat * D2R);
  for (const isl of ISLANDS) {
    const p = isl.pts;
    for (let i = 0; i < p.length; i++) {
      const a = p[i], b = p[Math.min(i + 1, p.length - 1)];
      // 点到线段的距离（局部等距投影，km）
      const ax = (a[1] - lon) * kx, az = (a[0] - lat) * 110.57;
      const bx = (b[1] - lon) * kx, bz = (b[0] - lat) * 110.57;
      const dx = bx - ax, dz = bz - az;
      const len2 = dx * dx + dz * dz;
      const t = len2 > 0 ? clamp01(-(ax * dx + az * dz) / len2) : 0;
      if (Math.hypot(ax + dx * t, az + dz * t) < isl.halfKm) return true;
    }
  }
  return false;
}

/** 一年中的第几天（UTC） */
function dayOfYear(t: number) {
  const y = new Date(t).getUTCFullYear();
  return (t - Date.UTC(y, 0, 1)) / 8.64e7;
}

const H = 3.6e6; // 一小时的毫秒数
/** 雷暴系统：格子大小（度）、时间窗口（小时）、寿命范围（小时） */
const STORM_CELL_DEG = 2.5;
const STORM_WINDOW_H = 3;
const STORM_LIFE_H: [number, number] = [2.5, 5.5];
/** 台风：格子（度）、窗口（小时）、寿命（小时） */
const TY_CELL_DEG = 8;
const TY_WINDOW_H = 96;
const TY_LIFE_H = 7 * 24;

export class WeatherField {
  constructor(public seed = 20260927) {}

  /** 季节：北半球夏季指数 0..1（7 月下旬最大） */
  summer(t: number, lat: number) {
    const s = 0.5 + 0.5 * Math.cos((2 * Math.PI * (dayOfYear(t) - 205)) / 365.25);
    return lat >= 0 ? s : 1 - s;
  }

  /** 对流潜势 0..1：陆地午后（当地太阳时 15 点前后）最强、海上清晨略强；夏季与热带放大；再乘大尺度噪声 */
  convection(lat: number, lon: number, t: number, land: boolean) {
    const summer = this.summer(t, lat);
    const hourLocal = (((t / H + lon / 15) % 24) + 24) % 24;
    const circ = (h0: number, w: number) => {
      const d = Math.abs(((hourLocal - h0 + 36) % 24) - 12);
      return Math.exp(-((d / w) ** 2));
    };
    const trop = smooth(42, 18, Math.abs(lat));
    const base = land
      ? (0.12 + 0.88 * circ(15, 3.2)) * (0.3 + 0.7 * summer) * (0.35 + 0.65 * trop)
      : (0.3 + 0.25 * circ(5, 4)) * (0.35 + 0.65 * trop) * (0.55 + 0.45 * summer);
    const n = fbm(lon / 3.5, lat / 3.5, t / H / 8, this.seed + 11);
    return clamp01(base * (0.35 + 1.3 * n));
  }

  /** 锋面带：一条随季节南北移动（冬 ~24°N，盛夏 ~33°N）、沿经度起伏、时有时无的带 */
  front(lat: number, lon: number, t: number) {
    const hours = t / H;
    const summer = this.summer(t, lat);
    const phiF = 24 + 9 * summer + 5 * (vnoise(lon / 15, hours / 48, 0.5, this.seed + 21) - 0.5) * 2 + 2.5 * Math.sin(lon * 0.15 + hours / 30);
    const active = smooth(0.25, 0.55, vnoise(lon / 20, hours / 60, 3.5, this.seed + 23));
    return { strength: Math.exp(-(((lat - phiF) / 2.8) ** 2)) * active, north: lat > phiF };
  }

  /** 取样一处的云层。land 省略时按粗略海陆分布 */
  sample(lat: number, lon: number, t: number, land?: boolean): WeatherSample {
    const isLand = land ?? coarseLand(lat, lon);
    const hours = t / H;
    const conv = this.convection(lat, lon, t, isLand);
    const fr = this.front(lat, lon, t);
    const front = fr.strength;
    const trade = isLand ? 0 : smooth(28, 18, lat) * smooth(2, 8, lat);
    const cl = fbm(lon / 5, lat / 5, hours / 18, this.seed + 31);
    const nHigh = fbm(lon / 7 + 3.1, lat / 7, hours / 24, this.seed + 41);
    const nMid = fbm(lon / 6, lat / 6 + 2.3, hours / 20, this.seed + 43);
    const cool = !isLand && lat > 26 ? 1 - this.summer(t, lat) * 0.6 : 0;
    const scores: Record<CloudRegime, number> = {
      clear: 0.78 - 0.95 * cl - 0.7 * front - 0.55 * conv,
      cumulus: 0.08 + 0.45 * trade + 0.55 * Math.min(conv, 0.5) + 0.3 * (cl - 0.5),
      towering: -0.2 + 1.05 * conv + 0.15 * trade * conv,
      stratocumulus: -0.15 + 0.95 * front * (fr.north ? 0.55 : 1) + 0.9 * Math.max(0, cl - 0.5) * (isLand ? 0.5 : 1) + 0.25 * cool,
      altocumulus: -0.25 + 0.9 * front * (fr.north ? 1 : 0.4) + 0.8 * Math.max(0, nMid - 0.5),
      cirrus: -0.2 + 0.9 * Math.max(0, nHigh - 0.45) + 0.1 * cl,
    };
    let regime: CloudRegime = "clear";
    for (const k of Object.keys(scores) as CloudRegime[]) if (scores[k] > scores[regime]) regime = k;
    const out: WeatherSample = { regime, bottom: 1.2, top: 3.4, coverage: 0, type: 1, density: 1, scores, convection: conv, front, trade, cloudiness: cl, land: isLand };
    // 各云型的参数：高度与 CLOUD_PRESETS 同源，云量 / 云顶随驱动量连续变化
    const cu = smooth(0.3, 0.85, conv);
    switch (regime) {
      case "clear":
        out.coverage = 0;
        break;
      case "cumulus":
      case "towering":
        // 积状云族：云顶随对流潜势从 ~3 km（淡积云）长到 ~6.8 km（浓积云），云量随大尺度云量与信风
        out.bottom = 1.2 + 0.25 * cu;
        out.top = 3.0 + 3.8 * cu;
        out.coverage = clamp01(0.18 + 0.3 * cl + 0.12 * trade + 0.1 * cu);
        out.density = 1 + 0.2 * cu;
        break;
      case "stratocumulus":
        Object.assign(out, { bottom: 1.0, top: 2.2, type: 0.2, density: 0.8, coverage: clamp01(0.58 + 0.28 * Math.max(front, cl)) });
        break;
      case "altocumulus":
        Object.assign(out, { bottom: 4.5, top: 6.0, type: 0.45, density: 0.7, coverage: clamp01(0.45 + 0.25 * Math.max(front, nMid)) });
        break;
      case "cirrus":
        Object.assign(out, { bottom: 11.5, top: 12.5, type: 0, density: 0.12, coverage: clamp01(0.25 + 0.3 * nHigh) });
        break;
    }
    return out;
  }

  /** 某个格子—窗口里有没有雷暴系统；有就返回它的静态描述（出生点、出生时刻、寿命、漂移、单体排布） */
  private stormSeed(i: number, j: number, k: number) {
    const s = this.seed + 101;
    const r0 = hash(i, j, k, s);
    const lat = (j + hash(i, j, k, s + 1)) * STORM_CELL_DEG;
    const lon = (i + hash(i, j, k, s + 2)) * STORM_CELL_DEG;
    const tBirth = (k + hash(i, j, k, s + 3)) * STORM_WINDOW_H * H;
    const life = (STORM_LIFE_H[0] + (STORM_LIFE_H[1] - STORM_LIFE_H[0]) * hash(i, j, k, s + 4)) * H;
    const land = coarseLand(lat, lon);
    // 出生概率：成熟时刻的对流潜势 + 锋面上的嵌入对流（梅雨锋）
    const conv = this.convection(lat, lon, tBirth + life / 2, land);
    const p = clamp01((conv - 0.35) * 1.8) * 0.8 + 0.35 * this.front(lat, lon, tBirth).strength;
    if (r0 >= p) return null;
    const rk = hash(i, j, k, s + 5);
    const kind: StormSystemSample["kind"] = rk < 0.55 ? "isolated" : rk < 0.82 ? "cluster" : "squall";
    const n = kind === "isolated" ? 1 : kind === "cluster" ? 2 + Math.floor(hash(i, j, k, s + 6) * 2) : 4;
    // 漂移：25°N 以北随西风带往东（偏北），以南随副热带东风往西；km/h
    const ve = lat > 25 ? 25 + 15 * hash(i, j, k, s + 7) : -(10 + 10 * hash(i, j, k, s + 7));
    const vn = lat > 25 ? 5 : 3;
    const trop = smooth(40, 20, Math.abs(lat));
    const cells: { dx: number; dz: number; radius: number; top: number }[] = [];
    const axis = hash(i, j, k, s + 8) * Math.PI;
    for (let c = 0; c < n; c++) {
      const u = hash(i, j, k, s + 20 + c);
      const v = hash(i, j, k, s + 40 + c);
      // 飑线：一排、间距约 16 km；团簇：半径 15 km 内散开
      const along = kind === "squall" ? (c - 1.5) * 16 + (u - 0.5) * 4 : kind === "cluster" ? (u - 0.5) * 30 : 0;
      const across = kind === "squall" ? (v - 0.5) * 6 : kind === "cluster" ? (v - 0.5) * 22 : 0;
      cells.push({
        dx: Math.cos(axis) * along - Math.sin(axis) * across,
        dz: Math.sin(axis) * along + Math.cos(axis) * across,
        radius: 4 + 2.5 * hash(i, j, k, s + 60 + c),
        top: 11.2 + 1.6 * trop + 1.6 * hash(i, j, k, s + 80 + c),
      });
    }
    return { id: `s${i}_${j}_${k}`, lat, lon, tBirth, life, ve, vn, kind, cells };
  }

  /** 此刻在 (lat, lon) 周围 radiusKm 内、处于活跃期（强度 > 0.25）的雷暴系统，按距离排序 */
  stormsNear(lat: number, lon: number, t: number, radiusKm: number): StormSystemSample[] {
    const out: { d: number; s: StormSystemSample }[] = [];
    // 系统出生后会漂移（最快约 40 km/h × 5.5 h ≈ 220 km），搜索范围放宽
    const reachKm = radiusKm + 250;
    const dj = Math.ceil(reachKm / 110.57 / STORM_CELL_DEG);
    const di = Math.ceil(reachKm / (111.32 * Math.max(0.3, Math.cos(lat * D2R))) / STORM_CELL_DEG);
    const i0 = Math.floor(lon / STORM_CELL_DEG), j0 = Math.floor(lat / STORM_CELL_DEG);
    const kMax = Math.floor(t / (STORM_WINDOW_H * H));
    const kMin = Math.floor((t - STORM_LIFE_H[1] * H) / (STORM_WINDOW_H * H));
    for (let i = i0 - di; i <= i0 + di; i++)
      for (let j = j0 - dj; j <= j0 + dj; j++)
        for (let k = kMin; k <= kMax; k++) {
          const sd = this.stormSeed(i, j, k);
          if (!sd) continue;
          const age = t - sd.tBirth;
          if (age < 0 || age > sd.life) continue;
          const strength = Math.sin((Math.PI * age) / sd.life);
          if (strength < 0.25) continue;
          const ageH = age / H;
          const cLat = sd.lat + (sd.vn * ageH) / 110.57;
          const cLon = sd.lon + (sd.ve * ageH) / (111.32 * Math.cos(sd.lat * D2R));
          const d = haversine(lat, lon, cLat, cLon);
          if (d > radiusKm) continue;
          const kx = 111.32 * Math.cos(cLat * D2R);
          out.push({
            d,
            s: {
              id: sd.id,
              lat: cLat,
              lon: cLon,
              strength,
              kind: sd.kind,
              cells: sd.cells.map((c, n) => ({ id: `${sd.id}#${n}`, lat: cLat - c.dz / 110.57, lon: cLon + c.dx / kx, radius: c.radius, top: c.top })),
            },
          });
        }
    return out.sort((a, b) => a.d - b.d).map((o) => o.s);
  }

  /** 台风位置：出生后向西北移动约 18 km/h，过 25°N 逐渐转向东北并加速（示意性的转向路径） */
  private typhoonAt(i: number, j: number, k: number, t: number): TyphoonSample | null {
    const s = this.seed + 301;
    const lat0 = 8 + (j + hash(i, j, k, s + 1)) * TY_CELL_DEG;
    const lon0 = (i + hash(i, j, k, s + 2)) * TY_CELL_DEG;
    if (lat0 > 22 || lon0 < 125 || lon0 > 155) return null; // 西北太平洋的生成区
    const tBirth = (k + hash(i, j, k, s + 3)) * TY_WINDOW_H * H;
    const age = t - tBirth;
    if (age < 0 || age > TY_LIFE_H * H) return null;
    const season = this.summer(tBirth, 20) ** 1.5;
    if (hash(i, j, k, s) >= 0.22 * season) return null;
    // 按 2 小时步长积分路径（最多 84 步，只在调用时算）：西北行，纬度过 22–30°N 时转向东北并加速
    let lat = lat0, lon = lon0;
    const steps = Math.floor(age / H / 2);
    for (let h = 0; h < steps; h++) {
      const rc = smooth(22, 30, lat);
      const spd = (18 + 22 * rc) * 2; // km / 2 h
      const east = -0.8 + 1.5 * rc; // 西北（东分量 −0.8）→ 东北（+0.7）
      const north = 0.6 + 0.1 * rc;
      lon += (east * spd) / (111.32 * Math.cos(lat * D2R));
      lat += (north * spd) / 110.57;
    }
    const strength = Math.sin((Math.PI * age) / (TY_LIFE_H * H));
    if (strength < 0.35 || lat > 38) return null; // 太弱或已经北上变性
    return { id: `ty${i}_${j}_${k}`, lat, lon, eye: 16 + 8 * hash(i, j, k, s + 5), strength };
  }

  /** radiusKm 内最近的活跃台风（没有返回 null） */
  typhoonNear(lat: number, lon: number, t: number, radiusKm: number): TyphoonSample | null {
    let best: TyphoonSample | null = null;
    let bestD = radiusKm;
    for (const ty of this.activeTyphoons(t)) {
      const d = haversine(lat, lon, ty.lat, ty.lon);
      if (d < bestD) {
        bestD = d;
        best = ty;
      }
    }
    return best;
  }

  /** 此刻全海域活跃的台风（统计脚本 scripts/weather-stats.mts 也用它） */
  activeTyphoons(t: number): TyphoonSample[] {
    const out: TyphoonSample[] = [];
    const kMax = Math.floor(t / (TY_WINDOW_H * H));
    const kMin = Math.floor((t - TY_LIFE_H * H) / (TY_WINDOW_H * H));
    for (let i = Math.floor(125 / TY_CELL_DEG); i <= Math.floor(155 / TY_CELL_DEG); i++)
      for (let j = 0; j <= 1; j++)
        for (let k = kMin; k <= kMax; k++) {
          const ty = this.typhoonAt(i, j, k, t);
          if (ty) out.push(ty);
        }
    return out;
  }
}

/** 大圆距离（km）。flight.ts 也有一份，这里不引入依赖 */
function haversine(lat1: number, lon1: number, lat2: number, lon2: number) {
  const a = Math.sin(((lat2 - lat1) * D2R) / 2) ** 2 + Math.cos(lat1 * D2R) * Math.cos(lat2 * D2R) * Math.sin(((lon2 - lon1) * D2R) / 2) ** 2;
  return 2 * 6371 * Math.asin(Math.min(1, Math.sqrt(a)));
}
