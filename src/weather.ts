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
//   · 台风：按 12 小时窗口生成，月生成率取气象厅平年值（年约 25 个、8 月最多），生成区含南海；直行 / 转向两类路径，
//     转向纬度随月份变化，登陆减弱、北上变性（WX10）。
// WX10 起按东亚气候态校准：冬季风寒潮（日本海雪云街、日本海一侧阴雪、太平洋一侧背风晴空）、中国东部冷季层云、
// 锋面带季节时间表（华南前汛期 → 梅雨 → 七下八上北跳 → 秋雨锋）、副高下晴空 / 淡积云、雷暴的季节性。
// 统计与断言：scripts/weather-stats.mts；依据出处：handoff/WX10.md。
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
  /** WX10 气候态项（调试 / 统计用）：副高 0..1、寒潮云街 0..1、中国东部冷季层云 0..1 */
  subHigh: number;
  coldSurge: number;
  eastChinaSt: number;
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

/**
 * 日本的脊梁山脉（主分水岭）折线，西南 → 东北，(纬度, 经度)：九州山地 → 中国山地 → 飞騨 / 三国山脉 → 奥羽山脉 → 日高 / 大雪山。
 * [估算] 按地图目测取点，误差几十公里；只用来分「日本海一侧 / 太平洋一侧」，决定冬季风寒潮下阴雪还是背风晴空
 */
const JAPAN_SPINE: [number, number][] = [
  [31.8, 130.9], [32.6, 131.1], [33.3, 131.3], [34.5, 131.9], [35.0, 132.9], [35.2, 133.9], [35.3, 134.7], [35.4, 135.5], [35.6, 136.3], [36.0, 137.4],
  [36.7, 138.7], [37.5, 139.8], [38.4, 140.4], [39.7, 140.9], [40.7, 140.9], [42.3, 142.9], [43.0, 142.8], [43.7, 142.9], [44.4, 143.0], [45.2, 142.3],
];
/** 日本陆地上的点在脊梁哪一侧：windward = 西北（日本海）一侧 0..1，lee = 东南（太平洋）一侧 0..1。不在日本范围返回 null */
function japanSpineSide(lat: number, lon: number) {
  if (lat < 31 || lat > 46 || lon < 129.5 || lon > 146) return null;
  const kx = 111.32 * Math.cos(lat * D2R);
  let best = Infinity, side = 0;
  for (let i = 0; i + 1 < JAPAN_SPINE.length; i++) {
    const [a0, o0] = JAPAN_SPINE[i], [a1, o1] = JAPAN_SPINE[i + 1];
    const ax = (o0 - lon) * kx, ay = (a0 - lat) * 110.57;
    const dx = (o1 - o0) * kx, dy = (a1 - a0) * 110.57;
    const t = clamp01(-(ax * dx + ay * dy) / (dx * dx + dy * dy));
    const d = Math.hypot(ax + dx * t, ay + dy * t);
    if (d < best) {
      best = d;
      // 叉积 (b − a) × (p − a)：正 = 在折线左侧（西北）
      side = Math.sign(dx * -ay - dy * -ax) || 1;
    }
  }
  const signed = side * best;
  return { windward: smooth(-15, 10, signed) * smooth(260, 170, best), lee: smooth(5, 35, -signed) };
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
/** 台风：生成窗口（小时）、寿命范围（天）。每个窗口至多生成一个，概率 = 该月平年生成数 ÷ 该月窗口数 */
const TY_WINDOW_H = 12;
const TY_LIFE_D: [number, number] = [4, 10];

// ---------- 气候态时间表（WX10）。出处与估算的界线见 handoff/WX10.md；统计与断言见 scripts/weather-stats.mts ----------

/**
 * 台风月平均生成数：气象厅 1991–2020 平年值（1–12 月，年 25.1 个）。
 * https://www.data.jma.go.jp/typhoon/statistics/average/average.html
 */
export const TY_GENESIS_PER_MONTH = [0.3, 0.3, 0.3, 0.6, 1.0, 1.7, 3.7, 5.7, 5.0, 3.4, 2.2, 1.0];
/**
 * 台风转向纬度（°N，按月）。[估算] 气候上盛夏在 25–30°N 转向、秋冬转向点南移到 20°N 前后甚至不转向（教科书 / 气象厅解说的定性结论），
 * 具体数值是量级估计，不是统计值
 */
const TY_RECURVE_LAT = [15, 15, 16, 17, 19, 23, 27, 29, 26, 22, 18, 16];
/** 直行（西北偏西一路走、不转向）路径的比例，按月。[估算] 盛夏多「西北行扑台湾 / 华南」，秋季转向为主，晚秋冬季低纬直行进菲律宾 / 越南 */
const TY_STRAIGHT_FRAC = [0.55, 0.55, 0.5, 0.45, 0.4, 0.4, 0.45, 0.4, 0.3, 0.35, 0.5, 0.55];
/** 在南海生成的比例，按月。[估算] 南海台风集中在 6–9 月，量级约两成 */
const TY_SCS_FRAC = [0.05, 0.05, 0.05, 0.08, 0.15, 0.22, 0.2, 0.2, 0.18, 0.15, 0.12, 0.06];

/**
 * 锋面带（梅雨锋 / 秋雨锋 / 华南前汛期 / 冷季静止锋）按年内日数的中心纬度（120°E 处）与活跃度（出现的时间比例）。
 * 依据：长江中下游常年 6/14 入梅、7/16 前后出梅（国家气候中心）；日本各地梅雨入り・明け平年值（气象厅 1991–2020：
 * 沖縄 5/10–6/21、九州北部 6/4–7/19、関東甲信 6/7–7/19、東北北部 6/15–7/28）；华北雨季「七下八上」；
 * 华南前汛期 4–6 月、秋雨前线 9 月到 10 月上旬（气候常识）。节点纬度与活跃度本身是 [估算]
 */
const FRONT_SCHEDULE: [number, number, number][] = [
  // [年内日数, 中心纬度, 活跃度]
  [0, 24, 0.35], // 冷季：华南—台湾附近的静止锋，常有常无
  [45, 24.5, 0.4],
  [75, 26, 0.5], // 江南春雨
  [105, 24.5, 0.6], // 华南前汛期
  [130, 24.5, 0.8], // 沖縄梅雨（5/10 起）
  [155, 28, 0.85], // 九州南部 / 九州北部入梅
  [166, 31, 0.9], // 长江中下游入梅（6/14）、本州梅雨
  [192, 33, 0.9], // 梅雨末期
  [201, 36.5, 0.7], // 梅雨明け（7/19 前后）、北跳
  [210, 39, 0.6], // 华北雨季「七下八上」、东北北部梅雨明け（7/28）
  [222, 40, 0.45],
  [236, 40, 0.15], // 8 月下旬基本消失
  [250, 36, 0.45], // 秋雨前线
  [265, 35, 0.6],
  [285, 31, 0.45],
  [310, 27, 0.35],
  [340, 24.5, 0.35],
  [365.25, 24, 0.35],
];

/**
 * 中国东部冷季层云的季节强度（按月，0..1）。依据 Klein & Hartmann (1993, J. Climate 6:1587) 的摘要：中国东部（青藏高原下游）
 * 是唯一在陆上的层云区，层云最多的季节就是低层静力稳定度最大的季节（冷季）。
 * 「2 月、10 月双峰，7 月最少」出自研究报告对检索摘要的转述，摘要本身没有这一句，全文未核。
 * 西段（四川盆地—贵州—湖南）用 WEST 表（冷季多、10 月华西秋雨也多）；东段（长江下游—上海）用 EAST 表，按上海徐家汇日照时数定形：
 * 1 月 114 h、2 月 120 h 最少，10 月 161 h 明显较多（中国气象局 1981–2010，经维基百科「Shanghai」气候表转引），所以东段 10 月不设峰。
 * 两张表的逐月数值都是 [估算]
 */
const EAST_CHINA_ST_WEST = [0.85, 1.0, 0.9, 0.6, 0.4, 0.25, 0.05, 0.1, 0.4, 0.95, 0.85, 0.8];
const EAST_CHINA_ST_EAST = [0.85, 0.95, 0.8, 0.55, 0.4, 0.3, 0.05, 0.05, 0.25, 0.4, 0.6, 0.75];

/** 分段线性的年周期表插值：table 按年内日数升序，首尾相接 */
function seasonal(doy: number, table: [number, ...number[]][], col: number) {
  for (let i = 1; i < table.length; i++) {
    if (doy <= table[i][0]) {
      const a = table[i - 1], b = table[i];
      const f = (doy - a[0]) / (b[0] - a[0]);
      return a[col] + (b[col] - a[col]) * f;
    }
  }
  return table[table.length - 1][col];
}
/** 按月表在月中之间线性插值（值取在每月 15 日） */
function monthly(doy: number, table: number[]) {
  const m = (doy - 15) / 30.44; // 0 = 1 月 15 日
  const i = Math.floor(m);
  const f = m - i;
  const a = table[((i % 12) + 12) % 12], b = table[(((i + 1) % 12) + 12) % 12];
  return a + (b - a) * f;
}
/** 把三维值噪声（集中在 0.5 附近）拉成近似均匀的 0..1（按实测分位数：p10 ≈ 0.25、p90 ≈ 0.75） */
const rank = (v: number) => clamp01(0.5 + (v - 0.5) * 1.85);

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
    // WX10：副热带洋面的深对流季节性很强（冬季几乎没有，1 月冲绳以东原来 15 时有 21% 的雷暴）；只有 12°N 以南的深热带常年都有
    const deepTrop = smooth(20, 12, Math.abs(lat));
    const seaSeason = 0.08 + 0.92 * summer + (0.47 - 0.47 * summer) * deepTrop;
    const base = land
      ? (0.12 + 0.88 * circ(15, 3.2)) * (0.3 + 0.7 * summer) * (0.35 + 0.65 * trop)
      : (0.3 + 0.25 * circ(5, 4)) * (0.35 + 0.65 * trop) * seaSeason;
    const n = fbm(lon / 3.5, lat / 3.5, t / H / 8, this.seed + 11);
    // 副高下沉区压制对流
    return clamp01(base * (0.35 + 1.3 * n) * (1 - 0.3 * this.subtropicalHigh(lat, lon, t)));
  }

  /** 锋面带此刻在经度 lon 处的中心纬度与季节活跃度（按 FRONT_SCHEDULE，东北—西南走向，沿经度和时间起伏） */
  frontAxis(lon: number, t: number) {
    const hours = t / H;
    const doy = dayOfYear(t);
    // 梅雨锋大致东北—西南走向：日本一侧比华中偏北 1–2°（[估算]）
    const lat =
      seasonal(doy, FRONT_SCHEDULE, 1) + 0.06 * (lon - 120) + 2.5 * (vnoise(lon / 15, hours / 48, 0.5, this.seed + 21) - 0.5) * 2 + 1.5 * Math.sin(lon * 0.15 + hours / 30);
    // 秋季（9 月中到 11 月）中国东部（长江中下游—华东，112–124°E）受大陆高压控制、秋高气爽，秋雨锋主要在日本一侧；
    // 这一段的锋面活跃度压到四成（[估算]；[上海日照] 10 月 161 h 明显多于 1 月 114 h）。四川盆地的华西秋雨在 105°E 附近，不受影响
    const autumnEast = smooth(250, 270, doy) * smooth(335, 310, doy) * smooth(110, 114, lon) * smooth(126, 121, lon);
    return { lat, activity: seasonal(doy, FRONT_SCHEDULE, 2) * (1 - 0.6 * autumnEast) };
  }

  /**
   * 西太平洋副热带高压（0..1）：脊线在锋面带以南约 8°（6 月中约 23°N、7 月上中旬 25°N、盛夏 30°N 以北，与「副高脊线两次北跳」一致，节点为 [估算]），
   * 6–9 月存在，盛夏西伸到约 118°E。下沉气流：晴空或信风积云，压制对流与层云
   */
  subtropicalHigh(lat: number, lon: number, t: number) {
    const summer = this.summer(t, lat);
    const g = smooth(0.55, 0.85, summer);
    if (g <= 0) return 0;
    const ridge = seasonal(dayOfYear(t), FRONT_SCHEDULE, 1) - 8;
    const west = 128 - 10 * smooth(0.85, 1, summer);
    // 副高时强时弱、时进时退（几天的尺度），不是一块常年不变的晴空
    const wobble = 0.55 + 0.45 * rank(vnoise(lon / 25, lat / 25, t / H / 96, this.seed + 71));
    return g * wobble * Math.exp(-(((lat - ridge) / 6) ** 2)) * smooth(west - 6, west + 4, lon) * smooth(178, 168, lon);
  }

  /** 冬季风寒潮的地理项（只和位置有关，按 0.25° 缓存）：streets = 下风海面的雪云街 / 日本海一侧沿岸阴雪，lee = 越过脊梁山脉后的背风晴空 */
  private readonly surgeGeoCache = new Map<number, { streets: number; lee: number }>();
  private surgeGeo(lat: number, lon: number, land: boolean) {
    const key = (Math.round(lat * 4) * 100000 + Math.round(lon * 4)) * 2 + (land ? 1 : 0);
    const hit = this.surgeGeoCache.get(key);
    if (hit) return hit;
    const la0 = Math.round(lat * 4) / 4, lo0 = Math.round(lon * 4) / 4;
    const win = smooth(25, 31, la0) * smooth(48, 43, la0) * smooth(115, 119, lo0) * smooth(155, 147, lo0);
    let out = { streets: 0, lee: 0 };
    if (win > 0 && !land) {
      // 海面：沿上风方向找最近的陆地（日本海 / 日本一带吹西北风，东海 / 黄海偏北风，冬季风气候态 [教科书]）。
      // 离岸几十公里内是无云区（冷空气刚出海，还没被加热加湿），之后是顺风的云街、再往下游转开放单体（[教科书；距离为量级]）
      const az = (lo0 >= 128 ? 315 : lo0 <= 120 ? 350 : 350 - ((lo0 - 120) / 8) * 35) * D2R;
      const STEP = 20, MAX = 1000;
      let fetch = MAX, la = la0, lo = lo0;
      for (let d = STEP; d <= MAX; d += STEP) {
        la += (Math.cos(az) * STEP) / 110.57;
        lo += (Math.sin(az) * STEP) / (111.32 * Math.cos(la * D2R));
        if (coarseLand(la, lo)) {
          fetch = d;
          break;
        }
      }
      out = { streets: win * smooth(20, 110, fetch), lee: 0 };
    } else if (win > 0) {
      // 陆地：只有日本（大陆上吹来的是干冷空气，不成云）。按脊梁山脉分两侧：上风（西北）一侧阴雪，下风（东南）一侧背风晴空（焚风）
      const s = japanSpineSide(la0, lo0);
      if (s) out = { streets: win * s.windward, lee: win * s.lee };
    }
    if (this.surgeGeoCache.size > 20000) this.surgeGeoCache.clear();
    this.surgeGeoCache.set(key, out);
    return out;
  }

  /**
   * 冬季风寒潮（冷空气爆发）0..1：12 月到次年 2 月最强、11 月和 3 月较弱，按几天的节奏一阵一阵（按脉动阈值，隆冬约六到七成时间处在寒潮中，[估算]）。
   * 返回下风海面 / 沿岸的云街强度与背风晴空强度
   */
  coldSurge(lat: number, lon: number, t: number, land: boolean) {
    const season = smooth(0.55, 0.9, 1 - this.summer(t, lat));
    if (season <= 0) return { streets: 0, lee: 0 };
    const geo = this.surgeGeo(lat, lon, land);
    if (geo.streets <= 0 && geo.lee <= 0) return { streets: 0, lee: 0 };
    const pulse = smooth(0.22, 0.42, rank(vnoise(lon / 30, lat / 30, t / H / 60, this.seed + 51)));
    const k = season * pulse;
    return { streets: geo.streets * k, lee: geo.lee * k };
  }

  /** 中国东部冷季层云 0..1（Klein & Hartmann 1993），25–35°N、102–122°E 的陆地；按天气尺度时有时无 */
  eastChinaStratus(lat: number, lon: number, t: number, land: boolean) {
    if (!land) return 0;
    // 西段（四川盆地—贵州—湖南，103–115°E）最多，往沿海减弱到约一半（[估算]：长江下游、上海秋季多晴）
    const r = smooth(21, 25, lat) * smooth(36, 32.5, lat) * smooth(101, 105, lon) * smooth(124, 121.5, lon) * (0.5 + 0.5 * smooth(120, 112, lon));
    if (r <= 0) return 0;
    const u = rank(vnoise(lon / 8, lat / 8, t / H / 36, this.seed + 61));
    const doy = dayOfYear(t);
    const e = smooth(112, 119, lon);
    const season = monthly(doy, EAST_CHINA_ST_WEST) * (1 - e) + monthly(doy, EAST_CHINA_ST_EAST) * e;
    return r * season * (0.15 + 0.9 * u);
  }

  /**
   * 锋面带：按 FRONT_SCHEDULE 的季节时间表南北移动（冷季 ~24°N → 5 月华南 / 冲绳 → 6 月中到 7 月中 30–34°N 梅雨锋 →
   * 7 月下旬北跳 37–40°N → 8 月下旬基本消失 → 9 月秋雨锋 35–36°N → 秋冬退回南方），沿经度起伏、时有时无（出现的时间比例 ≈ 活跃度）
   */
  front(lat: number, lon: number, t: number) {
    const ax = this.frontAxis(lon, t);
    // 这一处的噪声切片 z 取半整数，分布比三维值噪声更窄，拉伸系数 2.3（实测分位数）
    const u = clamp01(0.5 + (vnoise(lon / 20, t / H / 60, 3.5, this.seed + 23) - 0.5) * 2.3);
    const active = smooth(-0.1, 0.1, ax.activity - u);
    return { strength: Math.exp(-(((lat - ax.lat) / 2.8) ** 2)) * active, north: lat > ax.lat };
  }

  /** 取样一处的云层。land 省略时按粗略海陆分布 */
  sample(lat: number, lon: number, t: number, land?: boolean): WeatherSample {
    const isLand = land ?? coarseLand(lat, lon);
    const hours = t / H;
    const conv = this.convection(lat, lon, t, isLand);
    const fr = this.front(lat, lon, t);
    const front = fr.strength;
    const trade = isLand ? 0 : smooth(28, 18, lat) * smooth(2, 8, lat);
    // WX10 气候态项：副高（晴空 / 信风积云）、冬季风寒潮（雪云街 / 背风晴空）、中国东部冷季层云
    // 台风周围几百公里是外围雨带和卷云盖，不会是副高下的晴空
    const tyI = this.typhoonInfluence(lat, lon, t);
    const sh = this.subtropicalHigh(lat, lon, t) * (1 - tyI);
    const surge = this.coldSurge(lat, lon, t, isLand);
    const ecs = this.eastChinaStratus(lat, lon, t, isLand);
    const cl = fbm(lon / 5, lat / 5, hours / 18, this.seed + 31) * (1 - 0.35 * sh);
    const nHigh = fbm(lon / 7 + 3.1, lat / 7, hours / 24, this.seed + 41);
    const nMid = fbm(lon / 6, lat / 6 + 2.3, hours / 20, this.seed + 43);
    const cool = !isLand && lat > 26 ? 1 - this.summer(t, lat) * 0.6 : 0;
    const scores: Record<CloudRegime, number> = {
      clear: 0.78 - 0.95 * cl - 0.7 * front - 0.55 * conv + 0.15 * sh - 0.9 * surge.streets + 0.5 * surge.lee - 0.5 * ecs - 0.8 * tyI,
      // 副高下是晴空或零散的淡积云（信风积云），所以副高同时给积云加分
      cumulus: 0.08 + 0.45 * trade + 0.55 * Math.min(conv, 0.5) + 0.3 * (cl - 0.5) + 0.35 * sh + 1.2 * surge.streets + 0.3 * tyI,
      // 副高下暖洋面上午后也会长出零星浓积云（盖在信风逆温下的对流），[估算]
      towering: -0.2 + 1.05 * conv + 0.15 * trade * conv + 0.3 * sh * Math.max(0, nMid - 0.4),
      stratocumulus: -0.15 + 0.95 * front * (fr.north ? 0.55 : 1) + 0.9 * Math.max(0, cl - 0.5) * (isLand ? 0.5 : 1) + 0.25 * cool - 0.2 * sh + 1.0 * ecs,
      altocumulus: -0.25 + 0.9 * front * (fr.north ? 1 : 0.4) + 0.8 * Math.max(0, nMid - 0.5) - 0.2 * sh,
      // 副高下的高云：远处对流吹来的砧残留 / 高空冷涡带来的卷云，夏季洋面常见 [估算]
      cirrus: -0.2 + 0.9 * Math.max(0, nHigh - 0.45) + 0.1 * cl + 0.4 * tyI + 1.0 * sh * Math.max(0, nHigh - 0.5),
    };
    let regime: CloudRegime = "clear";
    for (const k of Object.keys(scores) as CloudRegime[]) if (scores[k] > scores[regime]) regime = k;
    const out: WeatherSample = {
      regime, bottom: 1.2, top: 3.4, coverage: 0, type: 1, density: 1, scores, convection: conv, front, trade, cloudiness: cl, land: isLand,
      subHigh: sh, coldSurge: surge.streets, eastChinaSt: ecs,
    };
    // 各云型的参数：高度与 CLOUD_PRESETS 同源，云量 / 云顶随驱动量连续变化
    const cu = smooth(0.3, 0.85, conv);
    switch (regime) {
      case "clear":
        out.coverage = 0;
        break;
      case "cumulus":
      case "towering": {
        // 积状云族：云顶随对流潜势从 ~3 km（淡积云）长到 ~6.8 km（浓积云），云量随大尺度云量与信风
        out.bottom = 1.2 + 0.25 * cu;
        out.top = 3.0 + 3.8 * cu;
        out.coverage = clamp01(0.18 + 0.3 * cl + 0.12 * trade + 0.1 * cu);
        out.density = 1 + 0.2 * cu;
        // 寒潮下风的雪云街 / 开放单体：云底低（约 0.8 km）、云顶受冬季边界层逆温限制在 2–3.5 km、云量高（[教科书；量级]）
        const k = smooth(0.15, 0.6, surge.streets);
        if (k > 0) {
          const mix = (a: number, b: number) => a + (b - a) * k;
          out.bottom = mix(out.bottom, 0.8);
          out.top = mix(out.top, 2.2 + 1.3 * surge.streets);
          out.coverage = mix(out.coverage, clamp01(0.42 + 0.38 * surge.streets + 0.12 * cl));
          out.density = mix(out.density, 1.1);
        }
        break;
      }
      case "stratocumulus":
        // 中国东部冷季层云：连成片（云量 0.75–0.95）
        Object.assign(out, { bottom: 1.0, top: 2.2, type: 0.2, density: 0.8, coverage: clamp01(Math.max(0.58 + 0.28 * Math.max(front, cl), ecs > 0.05 ? 0.7 + 0.25 * ecs : 0)) });
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
    // 出生概率：成熟时刻的对流潜势 + 锋面上的嵌入对流（梅雨锋、华南前汛期；WX10：只在暖季，冷季的静止锋是层状云、几乎不嵌深对流）
    const conv = this.convection(lat, lon, tBirth + life / 2, land);
    const warm = smooth(0.3, 0.6, this.summer(tBirth, lat));
    // 副高下也偶有孤立的午后 / 局地对流（小笠原、南西诸岛盛夏也有雷阵雨），不能一整月零雷暴：留一个很小的出生率 [估算]
    const popup = 0.035 * this.subtropicalHigh(lat, lon, tBirth + life / 2);
    const p = clamp01((conv - 0.35) * 1.8) * 0.8 + 0.35 * warm * this.front(lat, lon, tBirth).strength + popup;
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

  /**
   * 第 k 个生成窗口（12 小时）里有没有台风生成；有就返回它的静态描述。
   * 生成概率 = 该月平年生成数 ÷ 该月窗口数（气象厅 1991–2020 平年值，年 25.1 个、8 月最多）；
   * 生成区：主体 125–160°E（偏向西侧，中位约 137°E）、纬度随季节（冬季约 9°N、盛夏约 17°N，±5°），另有一部分在南海（12–20°N、111–119°E）；
   * 路径两类：直行（西北偏西一路走，扑菲律宾 / 台湾 / 华南 / 越南）和转向（西北行，到转向纬度附近折向东北并加速），比例和转向纬度按月（[估算]）
   */
  private typhoonSeed(k: number) {
    const s = this.seed + 301;
    const tBirth = (k + hash(k, 0, 0, s + 3)) * TY_WINDOW_H * H;
    const d = new Date(tBirth);
    const mon = d.getUTCMonth();
    const days = new Date(Date.UTC(d.getUTCFullYear(), mon + 1, 0)).getUTCDate();
    if (hash(k, 0, 0, s) >= TY_GENESIS_PER_MONTH[mon] / (days * (24 / TY_WINDOW_H))) return null;
    let lat0: number, lon0: number;
    if (hash(k, 0, 0, s + 6) < TY_SCS_FRAC[mon]) {
      lat0 = 12 + 8 * hash(k, 0, 0, s + 1);
      lon0 = 111 + 8 * hash(k, 0, 0, s + 2);
    } else {
      lat0 = Math.max(5, 9 + 8 * this.summer(tBirth, 15) + (hash(k, 0, 0, s + 1) - 0.5) * 10);
      // 经度偏向西侧（中位约 137°E，125–160°E），[估算]
      lon0 = 125 + 35 * hash(k, 0, 0, s + 2) ** 1.5;
    }
    if (coarseLand(lat0, lon0)) return null;
    return {
      id: `ty${k}`,
      tBirth,
      lat0,
      lon0,
      life: (TY_LIFE_D[0] + (TY_LIFE_D[1] - TY_LIFE_D[0]) * hash(k, 0, 0, s + 4)) * 24 * H,
      straight: hash(k, 0, 0, s + 7) < TY_STRAIGHT_FRAC[mon],
      recurve: TY_RECURVE_LAT[mon] + (hash(k, 0, 0, s + 8) - 0.5) * 6,
      eye: 16 + 8 * hash(k, 0, 0, s + 5),
    };
  }

  /**
   * 台风整条路径（按 2 小时步长积分，[纬度, 经度, 累计陆上小时] × 步数），只和生成窗口 k 有关，算一次缓存。
   * 登陆后按陆上时间衰减（e 折约 12 小时，[估算]），北上 35–41°N 变性消失
   */
  private readonly tyTrackCache = new Map<number, { sd: NonNullable<ReturnType<WeatherField["typhoonSeed"]>>; track: Float64Array } | null>();
  private typhoonTrack(k: number) {
    if (this.tyTrackCache.has(k)) return this.tyTrackCache.get(k)!;
    const sd = this.typhoonSeed(k);
    let out: { sd: NonNullable<typeof sd>; track: Float64Array } | null = null;
    if (sd) {
      const n = Math.floor(sd.life / H / 2) + 1;
      const track = new Float64Array(n * 3);
      let lat = sd.lat0, lon = sd.lon0, landH = 0;
      for (let h = 0; h < n; h++) {
        track[h * 3] = lat;
        track[h * 3 + 1] = lon;
        track[h * 3 + 2] = landH;
        let east: number, north: number, spd: number;
        if (sd.straight) {
          // 西北偏西，约 20 km/h
          east = -0.9;
          north = 0.35;
          spd = 20;
        } else {
          // 西北行 → 在转向纬度附近折向东北并加速（西风带）
          const rc = smooth(sd.recurve - 2, sd.recurve + 4, lat);
          east = -0.65 + 1.4 * rc;
          north = 0.72;
          spd = 21 + 24 * rc;
        }
        lon += (east * spd * 2) / (111.32 * Math.cos(lat * D2R));
        lat += (north * spd * 2) / 110.57;
        if (coarseLand(lat, lon)) landH += 2;
      }
      out = { sd, track };
    }
    if (this.tyTrackCache.size > 4000) this.tyTrackCache.clear();
    this.tyTrackCache.set(k, out);
    return out;
  }

  /** 台风此刻的位置与强度（路径按 2 小时一步，步与步之间线性插值） */
  private typhoonAt(k: number, t: number): TyphoonSample | null {
    const tr = this.typhoonTrack(k);
    if (!tr) return null;
    const { sd, track } = tr;
    const age = t - sd.tBirth;
    if (age < 0 || age > sd.life) return null;
    const x = age / H / 2;
    const i = Math.min(Math.floor(x), track.length / 3 - 2);
    const f = clamp01(x - i);
    const at = (c: number) => track[i * 3 + c] + (track[(i + 1) * 3 + c] - track[i * 3 + c]) * f;
    const lat = at(0), lon = at(1), landH = at(2);
    const strength = Math.sin((Math.PI * age) / sd.life) ** 0.6 * Math.exp(-landH / 12) * smooth(41, 35, lat);
    if (strength < 0.35) return null; // 太弱、登陆减弱或已经北上变性
    return { id: sd.id, lat, lon, eye: sd.eye, strength };
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

  /** 台风的影响 0..1：中心 400 km 内满、900 km 外为 0，乘强度。按 10 模拟分钟缓存台风列表（小地图一帧取样几百次） */
  private tyCache: { key: number; list: TyphoonSample[] } = { key: NaN, list: [] };
  typhoonInfluence(lat: number, lon: number, t: number) {
    const key = Math.floor(t / (10 * 60e3));
    if (key !== this.tyCache.key) this.tyCache = { key, list: this.activeTyphoons(key * 10 * 60e3) };
    let v = 0;
    for (const ty of this.tyCache.list) v = Math.max(v, ty.strength * smooth(900, 400, haversine(lat, lon, ty.lat, ty.lon)));
    return v;
  }

  /** 此刻全海域活跃的台风（统计脚本 scripts/weather-stats.mts 也用它） */
  activeTyphoons(t: number): TyphoonSample[] {
    const out: TyphoonSample[] = [];
    const kMax = Math.floor(t / (TY_WINDOW_H * H));
    const kMin = Math.floor((t - TY_LIFE_D[1] * 24 * H) / (TY_WINDOW_H * H));
    for (let k = kMin; k <= kMax; k++) {
      const ty = this.typhoonAt(k, t);
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
