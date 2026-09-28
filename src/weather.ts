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
  { id: "fuji-cap", name: "富士山笠云 + 吊し雲（演示，需在富士山附近）" },
];

/** 富士山剣ヶ峰（国土地理院：北纬 35°21′38″、东经 138°43′39″，标高 3775.6 m） */
export const FUJI_SUMMIT = { lat: 35.3606, lon: 138.7275, km: 3.776 } as const;

/**
 * 笠云 / 吊し雲的一次「过程」（SPEC-FUJI）：固定在山上（本地公里坐标），风向在一次过程里不变。
 * cap / chain 是此刻的强度（0..1，生消时盘从中心长大 / 缩回，由导演按模拟时间推进）
 */
export interface Lenticular {
  id: string;
  /** 山顶的本地坐标（km，x 东 z 南） */
  x: number;
  z: number;
  summitKm: number;
  /** 下风方向（本地坐标单位向量） */
  windX: number;
  windZ: number;
  /** 山顶高度的风速（m/s）：气流穿过云的速度（表面细纹流过去的快慢） */
  speed: number;
  /** 山地波波长（km） */
  wavelengthKm: number;
  cap: number;
  chain: number;
  /** 笠云叠盘片数 1..3 */
  capLayers: number;
  /** 笠云主盘中心海拔（km） */
  capKm: number;
  /** 吊し雲个数 0..5、基准海拔（km） */
  chainCount: number;
  chainKm: number;
  /** 形态随机数 0..1（每次过程不同） */
  seed: number;
}

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
  /** 富士山笠云 / 吊し雲（SPEC-FUJI）：null = 没有 */
  lenticular: Lenticular | null = null;
  /** 气流穿过透镜云的累计位移（km，按真实时间推进；冻结时 dt = 0 不动） */
  private lensFlowKm = 0;
  /** 经纬度 → 本地坐标（km）。导演（WeatherDirector）构造时挂上；面板「富士山笠云（演示）」预设要用 */
  toLocal: ((lat: number, lon: number) => [number, number]) | null = null;
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
    // 富士山笠云 + 吊し雲（SPEC-FUJI 演示）：固定在真实山顶上，典型的西南西风（Kusaka et al. 2025：笠云 / 吊し雲多在西南西风时出现）。
    // 不在富士山附近时照样摆在山顶（远处看不见）；toLocal 没挂上（导演还没建）时不摆
    this.lenticular = id === "fuji-cap" && this.toLocal ? lenticularDemo(this.toLocal(FUJI_SUMMIT.lat, FUJI_SUMMIT.lon)) : null;
    this.syncUniforms();
  }

  /** 放置 / 移除笠云 / 吊し雲（SPEC-FUJI）。强度的推进由调用方（导演）每帧写 cap / chain 后调 syncLens() */
  setLenticular(l: Lenticular | null) {
    this.lenticular = l;
    this.syncUniforms();
  }

  /** 只同步透镜云的 uniform（导演每帧推进强度时用，不重算外壳） */
  syncLens() {
    const u = this.u;
    const l = this.lenticular;
    if (!u.uLens) return;
    if (!l || (l.cap <= 0 && l.chain <= 0)) {
      u.uLens.value.w = 0;
      return;
    }
    u.uLens.value.set(l.x, l.z, l.summitKm, 1);
    u.uLensWind.value.set(l.windX, l.windZ, l.wavelengthKm, this.lensFlowKm);
    u.uLensCap.value.set(Math.min(Math.max(l.cap, 0), 1), l.capKm, l.capLayers, l.seed);
    u.uLensChain.value.set(Math.min(Math.max(l.chain, 0), 1), l.chainCount, l.chainKm, (l.seed * 7.31) % 1);
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
    if (this.lenticular) {
      this.lenticular.x -= dx;
      this.lenticular.z -= dz;
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
    this.syncLens();
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
    if (this.lenticular) {
      // 空气以山顶风速穿过透镜云（云不动，表面细纹顺风流过）；按纹理顺风方向的平铺周期（9 km，lensFlow）的整数倍取模，无缝，且浮点精度不随时间变差
      this.lensFlowKm = (this.lensFlowKm + (this.lenticular.speed * dt) / 1000) % 630;
      if (this.u.uLensWind) this.u.uLensWind.value.w = this.lensFlowKm;
    }
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
  /** 这一处的风廓线（WX11a）。惰性求值：第一次读时才算（约几微秒），小地图那种只要云型的批量取样不付这份钱 */
  readonly wind: WindProfile;
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
  /** 漂移速度（km/h，向东 / 向北）：出生时的引导气流（WX11a） */
  drift: { ve: number; vn: number };
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
/** vnoise 的标准差（实测 40 万点：均值 0.500、标准差 0.185、p10 / p90 = 0.254 / 0.746，接近正态）。(vnoise − 0.5) / VNOISE_SD ≈ 标准正态 */
const VNOISE_SD = 0.185;
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
/** 雷暴系统漂移速度上限（km/h）。[估算] 暖季对流系统常见 20–50 km/h；冬季急流下偶有更快的，截掉（也决定 stormsNear 的搜索半径） */
const STORM_MAX_DRIFT_KMH = 60;
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

// =====================================================================================
// 风场（WX11a）：地面（10 m）/ 850 / 500 / 250 hPa 四层风，按纬度 / 季节 / 天气型给气候态，叠种子确定、空间 / 时间相关的扰动。
// 设计与出处：research/WX11-DESIGN.md §1–§3；数据表与断言：handoff/WX11a.md；统计门禁：scripts/weather-stats.mts（--only wind）。
// 依据标注：[文献] 查过、有链接的来源；[教科书] Stull 1988 / Holton / Wallace & Hobbs 的共识内容（按记忆转述）；[估算] 推算或经验值。
//   [Zhang06] Zhang et al. 2006, GRL 33, L11708：东亚副热带西风急流 1 月轴在 32°N、最大纬向风 > 70 m/s（日本东南洋面上空），
//             4 月位置相近但明显减弱，7 月中心北移到 40°N 以北。https://agupubs.onlinelibrary.wiley.com/doi/10.1029/2006GL026377
//   [Kot58]   Koteswaram 1958, Tellus 10：热带东风急流核心 150 hPa、约 15°N、50–80°E、35–40 m/s。
//             https://onlinelibrary.wiley.com/doi/abs/10.1111/j.2153-3490.1958.tb01984.x
//   [LL90]    Lau & Lau 1990, Mon. Wea. Rev. 118：西太平洋夏季 850 hPa 经向风里的 2–8 天天气尺度扰动（东风波等）。只引用「存在且是主要变率」，量级未从原文核对
//   [Mon06]   Monahan 2006, J. Climate 19:497（SeaWinds 散射计）：海面风速近似两参数韦布尔分布，偏度随「平均 / 标准差」变。
//             https://journals.ametsoc.org/view/journals/clim/19/4/jcli3640.1.xml
//   [DD99]    Dai & Deser 1999, JGR 104(D24)：地面风速日变化陆上明显（午后最大）、海上很弱（按记忆转述，振幅未从原文核对）
//   [JMA平年] 气象厅 1991–2020 平年值（月平均风速）https://www.data.jma.go.jp/stats/etrn/ ；[HKO] 香港天文台横澜岛 1991–2020 平年值
//             https://www.hko.gov.hk/en/cis/normal/1991_2020/normals.htm 。对照表见 handoff/WX11a-b.md
// 坐标：风矢量一律是 (u 向东, v 向北)，m/s，表示「吹向」；风向（气象惯例的「来向」，0 = 北风、270 = 西风）用 windFromDeg 换算。
// 场景本地坐标是 x 东、z 南，所以换到场景里是 (x, z) = (u, −v)（windToLocal）。
// 都是示意性的气候态，不是真实天气数据；WX23 可以用 Open-Meteo 的 850 / 500 / 250 hPa 实测风替换 wind() 的输出（接口保持不变）。
// =====================================================================================

/** 一个风矢量：u 向东、v 向北，m/s（「吹向」） */
export interface Wind {
  u: number;
  v: number;
}
/** 一处一刻的风廓线：四个层次的风 + 边界层参数。windAt(profile, 高度) 在层次之间插值 */
export interface WindProfile {
  /** 地面 10 m 风（对数廓线 + 埃克曼转向，从 850 hPa 推出） */
  sfc: Wind;
  /** 850 hPa（≈ 1.5 km）：季风、信风、寒潮、梅雨低空急流 */
  p850: Wind;
  /** 500 hPa（≈ 5.5 km） */
  p500: Wind;
  /** 250 hPa（≈ 10.5 km）：副热带西风急流 / 夏季热带东风。数值按急流层（200–250 hPa）取 */
  p250: Wind;
  /** 地面粗糙度 z₀（m）：海面按 Charnock 关系随风速变，陆地取 0.1，海陆之间按陆地比例在对数上插值 */
  z0: number;
  /** 地面风相对边界层顶（850 hPa）风的偏角（度，正 = 逆时针「后退」，北半球） */
  ekman: number;
  /** 周围的陆地比例 0..1（0.5° 格点双线性插值，海岸不跳变） */
  land: number;
  /** 地面风速的日变化倍数（WX11a-b，陆上约 0.8–1.2、海上约 0.97–1.03，当地 14 时最大）；往上按 ln z 线性回到 1（边界层顶） */
  diurnal: number;
}

/** 各层次的代表高度（km）。250 hPa 以上保持 250 hPa 的值；边界层顶以下按对数廓线 + 埃克曼螺旋 */
export const WIND_LEVEL_KM = { p850: 1.5, p500: 5.5, p250: 10.5 } as const;
/** 边界层顶（km）。[教科书] 0.5–2 km；取 1 km：用对数律从 10 m 外推到这里，得到的 10 m / 边界层顶风速比恰好落在教科书的海上 0.6–0.8、陆上 0.3–0.5 */
export const WIND_BL_TOP_KM = 1.0;

/**
 * 东亚副热带西风急流（按月，1–12 月，值取在每月 15 日）：轴纬度（°N，140°E 附近）与急流层峰值（m/s，扰动前的气候态中心值）。
 * 1 月 32°N、4 月与 1 月相近而减弱、7 月 ≥ 40°N 是 [Zhang06]；峰值 1 月按「月均 > 70 m/s」反推（叠上扰动与槽脊摆动后，
 * 月均核心约 70，见 weather-stats）；夏季 30–40 m/s 是 [教科书，量级]；其余月份是 [估算]（相邻月份平滑过渡）
 */
const JET_LAT = [32, 32, 32.5, 33, 35, 38, 41, 42, 40, 36, 33, 32];
const JET_PEAK = [75, 73, 68, 57, 46, 38, 35, 33, 36, 46, 60, 72];

/** 冬季风的来向（气象惯例，度）：日本海 / 日本一带西北风（315°），东海 / 黄海偏北风（350°），之间线性过渡 [教科书，冬季风气候态]。寒潮云街（surgeGeo）也用它 */
function winterMonsoonFromDeg(lon: number) {
  return lon >= 128 ? 315 : lon <= 120 ? 350 : 350 - ((lon - 120) / 8) * 35;
}
/** 由来向（度）和风速得到风矢量 */
const fromDir = (deg: number, speed: number): Wind => ({ u: -speed * Math.sin(deg * D2R), v: -speed * Math.cos(deg * D2R) });
/** 把风矢量逆时针转 deg 度、再乘 k */
const rotScale = (w: Wind, deg: number, k: number): Wind => {
  const c = Math.cos(deg * D2R), s = Math.sin(deg * D2R);
  return { u: (w.u * c - w.v * s) * k, v: (w.u * s + w.v * c) * k };
};

/** 风速（m/s） */
export const windSpeed = (w: Wind) => Math.hypot(w.u, w.v);
/** 风向（气象惯例的来向，度，0..360：0 = 北风、90 = 东风、270 = 西风） */
export const windFromDeg = (w: Wind) => (((Math.atan2(-w.u, -w.v) / D2R) % 360) + 360) % 360;
/** 换到场景本地坐标（x 东、z 南），m/s */
export const windToLocal = (w: Wind) => ({ x: w.u, z: -w.v });

// ---------- 富士山笠云 / 吊し雲（SPEC-FUJI）----------
/**
 * 山地波的浮力频率 N（s⁻¹）：稳定的对流层中层约 0.01–0.012 [教科书：Durran 2003, Lee waves and mountain waves]。
 * 背风波波长 λ ≈ 2πU / N（U 是山顶高度的风速）：U = 15–25 m/s 时约 9–14 km，落在 METEOROLOGY.md W15 的 5–25 km 里
 */
const LENS_N = 0.011;
/** 条件分 → 出现的标定系数（handoff/SPEC-FUJI-stats.mts 按河口湖测候所的出现频度标定：笠云约 10%、吊し雲约 3% 的时刻） */
const LENS_K_CAP = 0.55;
const LENS_K_CHAIN = 0.2;
export const mountainWavelengthKm = (speed: number) => Math.min(Math.max((2 * Math.PI * speed) / LENS_N / 1000, 5), 25);
/** 笠云 / 吊し雲最常见的风向（气象来向，度）：西南西，大致垂直于富士山的长轴 [Kusaka et al. 2025, Weather, doi:10.1002/wea.7774] */
export const LENS_BEST_FROM_DEG = 247.5;

/** 天气场给的一处一刻的笠云 / 吊し雲条件（WeatherField.orographic） */
export interface OrographicSample {
  /** 0..1：此刻有没有笠云 / 吊し雲（过了抽签门槛的软值，导演 > 0.5 当作「有」） */
  cap: number;
  chain: number;
  /** 山顶高度（3.8 km）的风速 m/s、来向（度） */
  speed: number;
  fromDeg: number;
  /** 山顶到 6 km 的风速差（m/s）：吊し雲偏好竖直切变小的时候 [Kusaka 2025] */
  shear: number;
  wavelengthKm: number;
  /** 各项因子（调试 / 统计用） */
  fSpeed: number;
  fDir: number;
  moist: number;
  stable: number;
  score: number;
}

/** 由条件和山顶本地坐标拼一次过程；seed 决定这次的形态（叠几片、吊し雲的位置大小） */
export function lenticularFrom(o: { speed: number; fromDeg: number; wavelengthKm: number }, xz: [number, number], seed: number, strength = { cap: 1, chain: 1 }): Lenticular {
  const to = ((o.fromDeg + 180) * Math.PI) / 180;
  const h = (k: number) => {
    const v = Math.sin((seed + 1) * 12.9898 * (k + 1) + k * 78.233) * 43758.5453;
    return v - Math.floor(v);
  };
  return {
    id: `lens-${Math.floor(seed * 1e6)}`,
    x: xz[0],
    z: xz[1],
    summitKm: FUJI_SUMMIT.km,
    windX: Math.sin(to),
    windZ: -Math.cos(to),
    speed: o.speed,
    wavelengthKm: o.wavelengthKm,
    cap: strength.cap,
    chain: strength.chain,
    // 一片（接地笠）最常见，二重笠次之，三重笠少见 [Kusaka 2025 的主型是接地笠；比例是 [估算]]
    capLayers: h(1) < 0.55 ? 1 : h(1) < 0.87 ? 2 : 3,
    // 主盘中心在山顶上方 0.25–0.45 km：主盘中心的下表面比中面低 0.38–0.5 km，落在山顶附近、把山顶包进去（接地笠），帽檐往下罩着山的上半截
    capKm: FUJI_SUMMIT.km + 0.25 + 0.2 * h(2),
    // 2–5 个；吊し雲的湿层比笠云「略高」[Kusaka 2025]：基准 4.8–6.0 km [估算]
    chainCount: 2 + Math.floor(h(3) * 3.99),
    chainKm: 4.8 + 1.2 * h(4),
    seed,
  };
}

/** 演示用（面板预设「富士山笠云」、?fujiCap=1）：典型的西南西 20 m/s，二重笠 + 4 个吊し雲 */
export function lenticularDemo(xz: [number, number], seed = 0.37): Lenticular {
  const l = lenticularFrom({ speed: 20, fromDeg: LENS_BEST_FROM_DEG, wavelengthKm: mountainWavelengthKm(20) }, xz, seed);
  l.capLayers = 2;
  l.chainCount = 4;
  return l;
}

/**
 * 风廓线在高度 altKm 处的风（纯算术，约几十纳秒，可以每帧调用；wind() 本身才贵，应当按天气场取样的节奏缓存 profile）。
 *   · ≤ 10 m：返回 sfc（10 m 风）；
 *   · 10 m – 边界层顶（1 km）：风速按对数律 |G|·ln(z/z₀)/ln(h/z₀)（[教科书：Stull 1988 §9]，严格说只在近地层成立，外推到边界层顶是简化 [估算]），
 *     风向从地面的逆时针偏角 ekman 按 ln z 线性转回边界层顶的方向（埃克曼螺旋：往上顺时针转，[教科书]），
 *     风速的日变化倍数 diurnal 同样按 ln z 线性回到 1（10 m 处与 sfc 连续）；
 *   · 1–1.5 km：等于 850 hPa；1.5 / 5.5 / 10.5 km 之间分段线性；10.5 km 以上保持 250 hPa。
 */
export function windAt(p: WindProfile, altKm: number): Wind {
  const zm = altKm * 1000;
  const hm = WIND_BL_TOP_KM * 1000;
  if (zm <= 10) return { u: p.sfc.u, v: p.sfc.v };
  if (zm < hm) {
    const g = p.p850;
    const k = Math.log(zm / p.z0) / Math.log(hm / p.z0);
    const low = 1 - Math.log(zm / 10) / Math.log(hm / 10);
    const turn = p.ekman * low;
    return rotScale(g, turn, k * (1 + ((p.diurnal ?? 1) - 1) * low));
  }
  const L = WIND_LEVEL_KM;
  const lerp = (a: Wind, b: Wind, f: number): Wind => ({ u: a.u + (b.u - a.u) * f, v: a.v + (b.v - a.v) * f });
  if (altKm <= L.p850) return { u: p.p850.u, v: p.p850.v };
  if (altKm <= L.p500) return lerp(p.p850, p.p500, (altKm - L.p850) / (L.p500 - L.p850));
  if (altKm <= L.p250) return lerp(p.p500, p.p250, (altKm - L.p500) / (L.p250 - L.p500));
  return { u: p.p250.u, v: p.p250.v };
}
/** 风切变：windAt(z2) − windAt(z1)（m/s；除以高度差就是 1/s 量纲的切变） */
export function windShear(p: WindProfile, z1Km: number, z2Km: number): Wind {
  const a = windAt(p, z1Km), b = windAt(p, z2Km);
  return { u: b.u - a.u, v: b.v - a.v };
}
/** 引导气流：700 hPa（≈ 3 km）与 500 hPa 的平均，雷暴系统按它漂移 [教科书] */
export function steeringWind(p: WindProfile): Wind {
  const a = windAt(p, 3.0), b = windAt(p, WIND_LEVEL_KM.p500);
  return { u: (a.u + b.u) / 2, v: (a.v + b.v) / 2 };
}
/** 边界层平均风：0–1.5 km 按高度加权平均（梯形积分）。云街 / 卷轴的方向用它（WX11e） */
const BL_Z = [0.01, 0.05, 0.1, 0.2, 0.4, 0.7, 1.0, 1.5];
export function blMeanWind(p: WindProfile): Wind {
  let u = 0, v = 0, prev = windAt(p, BL_Z[0]);
  for (let i = 1; i < BL_Z.length; i++) {
    const w = windAt(p, BL_Z[i]);
    const dz = BL_Z[i] - BL_Z[i - 1];
    u += ((prev.u + w.u) / 2) * dz;
    v += ((prev.v + w.v) / 2) * dz;
    prev = w;
  }
  const h = BL_Z[BL_Z.length - 1] - BL_Z[0];
  return { u: u / h, v: v / h };
}

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
    const sh = this.subtropicalHigh(lat, lon, t);
    let base: number;
    if (land) base = (0.12 + 0.88 * circ(15, 3.2)) * (0.3 + 0.7 * summer) * (0.35 + 0.65 * trop);
    else {
      base = (0.3 + 0.25 * circ(5, 4)) * (0.35 + 0.65 * trop) * seaSeason;
      // TW01：夏季暖洋面的深对流。改前海上对流潜势只有陆地午后的一半，7–8 月南海 / 东海 / 冲绳午后「头顶浓积云」全是 0%，
      // 400 km 内有雷暴的时间只有 15–30%（research/TOWERING.md 表 1.3）；而西太暖池里浓积云占降水性对流云的一半以上
      // [气候，Johnson et al. 1999, J. Climate 12:2397]，那霸 7–8 月平均每月 3 个雷暴日、香港 8–9 个 [气候，JMA / HKO 1991–2020 平年值]。
      //   · 季风槽：南海—菲律宾海的夏季风区（约 5–22°N），洋面对流全天都有、清晨略强 [气候，TRMM 统计的海上清晨峰]；
      //   · 副热带暖洋面（26–33°N 以南、盛夏海温 ≥ 28 °C）：比季风槽弱，副高控制时被压住（见下面的 sh）。
      // 两项的量级都是 [估算]，按 weather-stats 的雷暴日对照（香港 / 那霸）与「海上夏季午后浓积云」断言定
      const mon = this.monsoonTrough(lat, lon, t);
      const warm = this.warmOcean(lat, lon, t);
      base += (0.42 * mon + 0.3 * warm) * (0.8 + 0.2 * circ(5, 5)) * (1 - 0.6 * sh);
      // 试过「近岸按周围陆地比例混入陆地午后对流」：华南沿海午后浓积云只从 41% 变到 49%，任何断言都分不出来（改坏实验无失败），删了。
      // 近岸看得见的午后塔来自岸上：陆地格子里出生的雷暴系统本来就会漂到 / 摆在海上航线的窗外
    }
    const n = fbm(lon / 3.5, lat / 3.5, t / H / 8, this.seed + 11);
    // 副高下沉区压制对流
    return clamp01(base * (0.35 + 1.3 * n) * (1 - 0.3 * sh));
  }

  /**
   * 夏季风槽 0..1（TW01）：6–9 月南海—菲律宾海 5–22°N、105–155°E 的季风区（西南季风与东风信风的辐合带，洋面深对流最多的地方）。
   * 这里没有信风逆温，信风积云让给季风对流。范围与季节是 [教科书] 的定性结论，边界的平滑宽度是 [估算]
   */
  monsoonTrough(lat: number, lon: number, t: number) {
    const s = smooth(0.6, 0.9, this.summer(t, lat));
    if (s <= 0) return 0;
    // 季风的活跃期 / 中断期（季节内振荡，一轮约 30–60 天 [教科书]）：几千公里、两三周的尺度上时强时弱，不是整个夏天一样
    const phase = 0.3 + 0.9 * rank(vnoise(lon / 40, lat / 25, t / H / 24 / 12, this.seed + 81));
    return clamp01(s * phase) * smooth(24, 19, lat) * smooth(2, 6, lat) * smooth(100, 106, lon) * smooth(162, 150, lon);
  }

  /**
   * 盛夏副热带暖洋面 0..1（TW01）：7–9 月 33°N 以南（黑潮、东海南部、冲绳—菲律宾海北部，盛夏海温 ≥ 28 °C [教科书]），季风槽里的部分不重复算。
   * 季节与纬度边界是 [估算]
   */
  warmOcean(lat: number, lon: number, t: number) {
    return smooth(0.7, 0.95, this.summer(t, lat)) * smooth(33, 26, lat) * (1 - this.monsoonTrough(lat, lon, t));
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
      // WX11a：上风方位角和风场 850 hPa 冬季风的来向是同一个函数（winterMonsoonFromDeg），不能出现两套「上风方向」
      const az = winterMonsoonFromDeg(lo0) * D2R;
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
    const pulse = smooth(0.22, 0.42, this.surgeDraw(lat, lon, t));
    const k = season * pulse;
    return { streets: geo.streets * k, lee: geo.lee * k };
  }

  /** 寒潮脉动的随机量 0..1（几天的节奏）。云街（coldSurge）和冬季风风速（wind）读同一个，保证「寒潮来了 = 云街出现 = 西北风加强」 */
  private surgeDraw(lat: number, lon: number, t: number) {
    return rank(vnoise(lon / 30, lat / 30, t / H / 60, this.seed + 51));
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
    const active = smooth(-0.1, 0.1, ax.activity - this.frontDraw(lon, t));
    return { strength: Math.exp(-(((lat - ax.lat) / 2.8) ** 2)) * active, north: lat > ax.lat };
  }

  /** 锋面「这一段此刻在不在」的随机抽签 0..1（活跃度高于它就算在）。风场的低空急流用同一个抽签，和锋面云系同进同退 */
  private frontDraw(lon: number, t: number) {
    // 这一处的噪声切片 z 取半整数，分布比三维值噪声更窄，拉伸系数 2.3（实测分位数）
    return clamp01(0.5 + (vnoise(lon / 20, t / H / 60, 3.5, this.seed + 23) - 0.5) * 2.3);
  }

  // ---------- 风场（WX11a） ----------

  /** 陆地比例 0..1：0.5° 格点上的 coarseLand 双线性插值（格点结果缓存）。海岸附近平滑过渡约 50 km，地面风不会在海岸线上一步跳变 */
  private readonly landGridCache = new Map<number, number>();
  landFraction(lat: number, lon: number) {
    const g = (i: number, j: number) => {
      const key = i * 100000 + j;
      let v = this.landGridCache.get(key);
      if (v === undefined) {
        v = coarseLand(i * 0.5, j * 0.5) ? 1 : 0;
        if (this.landGridCache.size > 50000) this.landGridCache.clear();
        this.landGridCache.set(key, v);
      }
      return v;
    };
    const x = lat * 2, y = lon * 2;
    const i = Math.floor(x), j = Math.floor(y);
    const fx = x - i, fy = y - j;
    return (g(i, j) * (1 - fy) + g(i, j + 1) * fy) * (1 - fx) + (g(i + 1, j) * (1 - fy) + g(i + 1, j + 1) * fy) * fx;
  }

  /**
   * 急流层（250 hPa）的西风部分（m/s，u 向东、v 向北）：背景西风 + 副热带西风急流（按月的轴纬度与峰值 [Zhang06]、140°E 附近最强），
   * 叠槽脊（急流轴南北摆动，向东传播）和风速扰动。v 由「风沿摆动后的轴走」得到：v = u × 轴线斜率。
   * 夏季热带东风不在这里（见 wind()），850 hPa 的热成风部分按这里的西风取一个比例
   */
  private jetWesterly(lat: number, lon: number, t: number): Wind {
    const doy = dayOfYear(t);
    const hours = t / H;
    const wint = 1 - this.summer(t, 30); // 冬季指数 0..1（1 月下旬最大）
    // 槽脊：轴纬度的南北摆动，几千公里波长（经度尺度 22°）、随时间东移约 8°/天（≈ 7 m/s，[估算]：槽脊东移 5–10 m/s 的量级）、
    // 几天内演变；冬季急流被青藏高原 / 日本上空的定常波锚住、摆动小，夏季大（幅度 [估算]）
    const amp = 2.5 + 1.5 * (1 - wint);
    const shift = (lo: number) => amp * Math.max(-1, Math.min(1, (vnoise((lo - hours / 3) / 22, hours / 72, 0.5, this.seed + 201) - 0.5) * 3.6));
    const axis = monthly(doy, JET_LAT) + shift(lon);
    // 急流轴线斜率（°纬 / °经 → 无量纲的 km/km），风沿轴走
    const slope = ((shift(lon + 0.25) - shift(lon - 0.25)) / 0.5) * (110.57 / (111.32 * Math.max(0.2, Math.cos(lat * D2R))));
    // 经向结构：南侧宽（冬季副热带西风一直伸到 15–20°N，[教科书]）、北侧窄；宽度 [估算]
    const d = lat - axis;
    const width = d < 0 ? 8 + 5 * wint : 8;
    const core = Math.exp(-((d / width) ** 2));
    // 急流北侧的中纬度背景西风（约 15–20 m/s，[估算]），高纬（> 65°N）减弱
    const bg = (12 + 8 * wint) * smooth(axis - 2, axis + 10, lat) * smooth(75, 62, lat);
    // 纬向不均匀：冬季核心在日本上空（130–150°E，[Zhang06]），上游（中国内陆）较弱；夏季沿纬圈更均匀 [估算]
    const lonF = 1 - 0.38 * (0.4 + 0.6 * wint) * (1 - Math.exp(-(((lon - 140) / 25) ** 2)));
    const peak = monthly(doy, JET_PEAK) * lonF;
    // 风速扰动 ×(0.8–1.2)：急流层的月际 / 天气尺度变化比低层小 [估算]
    const k = 0.8 + 0.4 * rank(vnoise(lon / 18, lat / 12, hours / 40, this.seed + 203));
    const u = (bg + (peak - bg) * core) * k;
    // 南半球 / 赤道以南没有这支急流（东亚航线用不到，简单压掉）
    const hemi = smooth(-2, 6, lat);
    return { u: u * hemi, v: u * slope * hemi };
  }

  /**
   * 一处一刻的风廓线（地面 / 850 / 500 / 250 hPa）。同样的 (lat, lon, t, seed) 永远给出同样的结果。
   * 约 3–5 µs 一次（见 handoff/WX11a.md）：导演按天气场取样的节奏调用（300 模拟秒一次），每帧只用 windAt(profile, 高度) 插值缓存的结果。
   */
  wind(lat: number, lon: number, t: number): WindProfile {
    const hours = t / H;
    const summer = this.summer(t, lat);

    // ---- 250 hPa：西风急流 + 夏季热带东风 ----
    const jet = this.jetWesterly(lat, lon, t);
    // 夏季南亚高压南侧的东风：核心 150 hPa、约 15°N [Kot58]；急流层（250 hPa）上更弱，华南 / 南海 25°N 以南约 5–20 m/s [估算]。
    // 6 月到 9 月（夏季指数高时），往东到西太平洋逐渐减弱 [估算]
    const eSeason = smooth(0.75, 0.93, summer);
    const easterly = eSeason > 0 ? -16 * eSeason * Math.exp(-(((lat - 15) / 9) ** 2)) * (0.3 + 0.7 * smooth(150, 120, lon)) : 0;
    // 急流层整体的方向扰动 ±10°（槽脊已经给了主要的南北摆动）
    const r250 = 10 * (2 * rank(vnoise(lon / 14, lat / 14, hours / 36, this.seed + 205)) - 1);
    const p250 = rotScale({ u: jet.u + easterly, v: jet.v }, r250, 1);

    // ---- 850 hPa：热成风部分 + 冬季风 + 信风 + 夏季西南季风 + 副高环流 + 梅雨低空急流 ----
    // 低层西风约为急流层的一成半 [估算]；只在中纬度（约 25°N 以北）有，以南是信风 / 季风的地盘（冬季 850 hPa 东西风分界约在 25–30°N，[教科书，量级]）
    const midLat = 0.15 * smooth(22, 32, lat);
    let u = midLat * jet.u, v = midLat * jet.v;
    const add = (w: Wind) => ((u += w.u), (v += w.v));
    // 冬季风：来向与寒潮云街同源（winterMonsoonFromDeg），25°N 以南转为东北季风（南海 / 菲律宾海冬季东北风，[教科书]）；
    // 风速随寒潮脉动（同一个随机量 surgeDraw），日本海寒潮时 850 hPa 西北风 10–20 m/s、平时 5–8 m/s（[教科书；量级]，WX11-DESIGN §1.2）
    const wN = smooth(0.55, 0.9, 1 - summer);
    const winW = wN * smooth(12, 18, lat) * smooth(50, 45, lat) * smooth(103, 110, lon) * smooth(155, 147, lon);
    if (winW > 0) {
      const ps = smooth(0.1, 0.6, this.surgeDraw(lat, lon, t)); // 比云街的阈值（0.22–0.42）软：风速连续变化，不在几小时内翻倍
      const from = winterMonsoonFromDeg(lon) + (45 + 360 - winterMonsoonFromDeg(lon)) * smooth(28, 22, lat);
      add(fromDir(from, winW * (4 + 8 * ps)));
    }
    // 夏季西南季风：华南到长江、锋面以南，约 5–10 m/s [教科书]；5 月下旬到 9 月 [估算]
    const fax = this.frontAxis(lon, t);
    const swSeason = smooth(0.7, 0.9, summer);
    const swM = swSeason * smooth(6, 12, lat) * smooth(fax.lat + 2, fax.lat - 1, lat) * smooth(97, 105, lon) * smooth(132, 122, lon);
    if (swM > 0) add(fromDir(225, 7 * swM));
    // 信风：18–28°N 洋面偏东—东北风 5–8 m/s [教科书]；夏季季风区（南海）让给西南季风
    const trade = smooth(6, 12, lat) * smooth(33, 27, lat) * smooth(100, 108, lon) * (1 - swM);
    if (trade > 0) add(fromDir(75, 6 * trade));
    // 西太平洋副高的反气旋环流：脊线以南东风、以北西风，西侧是偏南风（「副高西北侧的西南气流」，[教科书]）；
    // 脊线、西伸位置与 subtropicalHigh() 同源，强度 5 m/s [估算]
    const g = smooth(0.55, 0.85, summer);
    if (g > 0) {
      const ridge = seasonal(dayOfYear(t), FRONT_SCHEDULE, 1) - 8;
      const west = 128 - 10 * smooth(0.85, 1, summer);
      const ext = smooth(west - 10, west + 2, lon) * smooth(178, 168, lon);
      const dl = lat - ridge;
      add({
        u: 5 * g * ext * Math.tanh(dl / 4) * Math.exp(-((dl / 12) ** 2)),
        v: 5 * g * Math.exp(-(((lon - (west - 2)) / 9) ** 2)) * Math.exp(-(((dl - 4) / 7) ** 2)),
      });
    }
    // 梅雨低空急流：锋面南侧 2–3° 纬度、850 hPa ≥ 12 m/s 的西南风 [教科书]；和锋面云系同一个抽签（frontDraw），但门槛放软，
    // 急流不会在一两个小时里凭空出现 / 消失 [估算]
    const warm = smooth(0.6, 0.85, summer);
    if (warm > 0) {
      const act = smooth(-0.35, 0.35, fax.activity - this.frontDraw(lon, t));
      const llj = 9 * warm * act * Math.exp(-(((lat - (fax.lat - 2.5)) / 1.6) ** 2)) * smooth(103, 108, lon) * smooth(145, 138, lon);
      if (llj > 0) add(fromDir(235, llj));
    }
    // 天气尺度扰动：方向 ±25°、风速 ×(0.7–1.3)，千公里 / 一两天的尺度（WX11-DESIGN §1.2 的建议值 [估算]）
    const r850 = 25 * (2 * rank(vnoise(lon / 12, lat / 12, hours / 30, this.seed + 211)) - 1);
    const k850 = 0.7 + 0.6 * rank(vnoise(lon / 15, lat / 15, hours / 40, this.seed + 212));
    const pm = rotScale({ u, v }, r850, k850);
    // WX11a-b：天气尺度的加性扰动（随机风矢量，u、v 各自近似正态、互相独立）。上面的乘性扰动只能放大 / 转动气候态矢量，
    // 在气候态矢量平均接近 0 的地方（副高脊线、季风转换期、赤道无风带）造不出风：西太 30°N 7 月 850 hPa 中位只有 1.5–1.9 m/s，
    // 海面几乎总是镜面（WX11g 审查 D2）。真实大气里这些地方的「标量平均风速」远大于「矢量平均」，差的就是天气尺度扰动
    // （东风波、副高进退、锋面 / 低压过境；西太夏季 850 hPa 2–8 天扰动见 [LL90]），标量风速按矢量平均 + 各向扰动 ≈ 莱斯 / 韦布尔分布 [Mon06]。
    // 每个分量的标准差：基础 4.5 m/s，冬季中纬度（风暴路径）加到 6 m/s；气候态气流强而稳定的地方（信风、夏季风、寒潮西北风，|矢量| ≥ 9 m/s）
    // 减到六成——[Mon06]：信风 / 季风这类副高赤道一侧的气流「平均 / 标准差」最大，风最稳定；而且那里的乘性扰动已经给了变率。
    // 数值都是 [估算]（天气尺度 850 hPa 风分量日际标准差几 m/s 的量级，没查到逐点数值）；验收不看这个数，
    // 看海面风与测站平年值的对照（weather-stats 的「海面风」断言、handoff/WX11a-b.md）。
    // 空间尺度与乘性扰动同源（千公里级），时间尺度 48 h（天气尺度 2–8 天周期 [LL90] 的相关时间量级；30 h 时 850 hPa 1 小时连续性 p99 到 18%，超门限），
    // 用独立的种子偏移（213 / 214），同一 (lat, lon, t, seed) 结果确定
    const sigA = (4.5 + 1.5 * wN * smooth(25, 40, lat)) * (1 - 0.4 * smooth(3, 9, windSpeed(pm)));
    const nU = (vnoise(lon / 12, lat / 12, hours / 48, this.seed + 213) - 0.5) / VNOISE_SD;
    const nV = (vnoise(lon / 12, lat / 12, hours / 48, this.seed + 214) - 0.5) / VNOISE_SD;
    const p850 = { u: pm.u + sigA * nU, v: pm.v + sigA * nV };

    // ---- 500 hPa：急流层与 850 hPa 的加权（0.45 / 0.35，[估算]：按 WX11-DESIGN §1.2 表里日本 1 月 500 hPa 25–40、华南 7 月 < 5 m/s 定），再加 ±15° ----
    const r500 = 15 * (2 * rank(vnoise(lon / 13, lat / 13, hours / 32, this.seed + 221)) - 1);
    const p500 = rotScale({ u: 0.45 * p250.u + 0.35 * p850.u, v: 0.45 * p250.v + 0.35 * p850.v }, r500, 1);

    // ---- 地面：对数廓线 + 埃克曼转向 ----
    const land = this.landFraction(lat, lon);
    const G = windSpeed(p850);
    const hm = WIND_BL_TOP_KM * 1000;
    // 海面 z₀ 按 Charnock 关系 z₀ = α·u*²/g（α = 0.011，[教科书]）随风速变，下限 1e-5 m（光滑流）；陆地 0.2 m（农田、村镇、疏林混杂，[教科书] 量级 0.1–0.5 m；取 0.1 时 10 m / 边界层顶恰好 = 0.5，贴在教科书区间的边上）
    let z0s = 2e-4;
    for (let it = 0; it < 3; it++) {
      const s10 = (G * Math.log(10 / z0s)) / Math.log(hm / z0s);
      const ustar = (0.4 * s10) / Math.log(10 / z0s);
      z0s = Math.max(1e-5, (0.011 * ustar * ustar) / 9.81);
    }
    const z0 = Math.exp(Math.log(z0s) + (Math.log(0.2) - Math.log(z0s)) * land);
    // 埃克曼：地面风比边界层顶逆时针偏 海上约 15°、陆上约 35°（[教科书] 海上 10–20°、陆上 25–45°）；赤道附近科氏力趋零，偏角压掉
    const ekman = (15 + 20 * land) * Math.sign(lat || 1) * smooth(2, 8, Math.abs(lat));
    // 日变化（WX11a-b）：白天对流混合把上面的动量带下来，陆上地面风午后最大、夜里最小，海上很弱 [DD99]。
    // 振幅：陆上 ±20%（地面风 3–5 m/s 时约 ±0.6–1 m/s）、海上 ±3%，最大在当地 14 时（[估算]，量级按 [DD99]）
    const hourLocal = (((hours + lon / 15) % 24) + 24) % 24;
    const diurnal = 1 + (0.03 + 0.17 * land) * Math.cos((2 * Math.PI * (hourLocal - 14)) / 24);
    const k10 = Math.log(10 / z0) / Math.log(hm / z0);
    const sfc = rotScale(p850, ekman, k10 * diurnal);
    return { sfc, p850, p500, p250, z0, ekman, land, diurnal };
  }

  /** 便捷：一处一刻、某高度（km）的风。要反复查同一处时先 wind() 再 windAt(profile, 高度)，别重复算整条廓线 */
  windAt(lat: number, lon: number, t: number, altKm: number): Wind {
    return windAt(this.wind(lat, lon, t), altKm);
  }

  /**
   * 富士山的笠云 / 吊し雲条件（SPEC-FUJI；METEOROLOGY.md W15）。成因：稳定层结里足够强、大致垂直于山体的气流翻过孤立山峰，
   * 激起山地波，湿层在波峰处被抬到凝结高度 [FAA AC 00-6B 山地波一章；Durran 2003]。天气场没有湿度 / 稳定度，按现有量代理：
   *  - 风速：山顶高度（3.8 km，WX11a 的 windAt）≥ 约 15 m/s 才明显（W15），10 → 17 m/s 软门槛 [估算]；
   *  - 风向：西南西（247.5°，垂直于富士山长轴）最多 [Kusaka et al. 2025]，孤立山峰其他方向也有、少一些（×0.3 下限 [估算]）；
   *  - 湿：大尺度云量 cloudiness、锋面 front（低压 / 锋面接近：「笠雲がかかると雨」，出现后 24 h 内下雨的比例笠云 72%、吊し雲 82%，
   *    河口湖测候所 1933–52 年 [富士山NET〈富士山と気象〉山頂にかかる雲]）、暖季水汽多 [Kusaka 2025：笠云 / 吊し雲夏季最多]；
   *  - 稳定：对流潜势强时山地波被对流打乱（积云 / 雷暴天气里没有光滑的荚状云）[教科书]；
   *  - 早晨多 [Kusaka 2025]：当地 7 时峰值 ±40% [估算]；
   *  - 吊し雲另要竖直风切变小 [Kusaka 2025]：山顶到 6 km 风速差 6 → 16 m/s 渐减 [估算]。
   * 过程的有无按「条件分 × 标定系数 − 5 小时尺度的抽签」：出现时间比例标定到河口湖测候所 20 年观测的量级——
   * 笠云月平均 6.1 回、吊し雲 2.0 回（每天两次观测，约 60 次 / 月 → 约 10% / 3% 的观测时刻）[富士山NET，同上]；标定见 handoff/SPEC-FUJI.md。
   * 同样的 (t, seed) 永远给出同样的结果
   */
  orographic(t: number): OrographicSample {
    const { lat, lon, km } = FUJI_SUMMIT;
    const prof = this.wind(lat, lon, t);
    const w = windAt(prof, km + 0.05);
    const w6 = windAt(prof, 6.0);
    const speed = windSpeed(w);
    const fromDeg = windFromDeg(w);
    const shear = Math.hypot(w6.u - w.u, w6.v - w.v);
    const s = this.sample(lat, lon, t, true);
    const summer = this.summer(t, lat);
    const fSpeed = smooth(8, 16, speed);
    const dAng = Math.abs(((fromDeg - LENS_BEST_FROM_DEG + 540) % 360) - 180);
    const fDir = 0.3 + 0.7 * Math.max(0, Math.cos(dAng * D2R)) ** 1.5;
    const moist = clamp01(0.05 + 0.6 * summer + 0.7 * (s.cloudiness - 0.35) + 0.6 * s.front);
    const stable = 1 - smooth(0.45, 0.85, s.convection);
    const hourLocal = (((t / H + lon / 15) % 24) + 24) % 24;
    const morning = 1 + 0.4 * Math.cos((2 * Math.PI * (hourLocal - 7)) / 24);
    const score = fSpeed * fDir * moist * stable * morning;
    const hours = t / H;
    const dCap = rank(vnoise(hours / 3, 0.37, 0.71, this.seed + 301));
    const dChain = rank(vnoise(hours / 3, 1.93, 0.29, this.seed + 302));
    const cap = smooth(0, 0.08, LENS_K_CAP * score - dCap);
    const chain = smooth(0, 0.08, LENS_K_CHAIN * score * (1 - smooth(6, 16, shear)) - dChain);
    return { cap, chain, speed, fromDeg, shear, wavelengthKm: mountainWavelengthKm(speed), fSpeed, fDir, moist, stable, score };
  }

  /** 取样一处的云层。land 省略时按粗略海陆分布 */
  sample(lat: number, lon: number, t: number, land?: boolean): WeatherSample {
    const isLand = land ?? coarseLand(lat, lon);
    const hours = t / H;
    const conv = this.convection(lat, lon, t, isLand);
    const fr = this.front(lat, lon, t);
    const front = fr.strength;
    // TW01：夏季风槽里吹的是西南季风、没有信风逆温，信风积云的加分让给季风对流
    const trade = isLand ? 0 : smooth(28, 18, lat) * smooth(2, 8, lat) * (1 - 0.75 * this.monsoonTrough(lat, lon, t));
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
      // TW01：盛夏暖洋面上，副高边缘的信风逆温弱，对流稍强的地方就冲出几座浓积云塔（冲绳 7–8 月平均每月 3 个雷暴日 [JMA那霸]，
      // 浓积云比积雨云常见得多 [气候，Johnson 1999 的三峰分布]）；系数 [估算]，按「海上夏季午后浓积云」断言定
      towering: -0.2 + 1.05 * conv + 0.15 * trade * conv + 0.3 * sh * Math.max(0, nMid - 0.4) + (isLand ? 0 : 0.4 * this.warmOcean(lat, lon, t) * conv),
      stratocumulus: -0.15 + 0.95 * front * (fr.north ? 0.55 : 1) + 0.9 * Math.max(0, cl - 0.5) * (isLand ? 0.5 : 1) + 0.25 * cool - 0.2 * sh + 1.0 * ecs,
      altocumulus: -0.25 + 0.9 * front * (fr.north ? 1 : 0.4) + 0.8 * Math.max(0, nMid - 0.5) - 0.2 * sh,
      // 副高下的高云：远处对流吹来的砧残留 / 高空冷涡带来的卷云，夏季洋面常见 [估算]
      cirrus: -0.2 + 0.9 * Math.max(0, nHigh - 0.45) + 0.1 * cl + 0.4 * tyI + 1.0 * sh * Math.max(0, nHigh - 0.5),
    };
    let regime: CloudRegime = "clear";
    for (const k of Object.keys(scores) as CloudRegime[]) if (scores[k] > scores[regime]) regime = k;
    const field = this; // 给下面的惰性 getter 用（getter 里的 this 是 out 本身）
    let windCache: WindProfile | undefined;
    const out: WeatherSample = {
      regime, bottom: 1.2, top: 3.4, coverage: 0, type: 1, density: 1, scores, convection: conv, front, trade, cloudiness: cl, land: isLand,
      subHigh: sh, coldSurge: surge.streets, eastChinaSt: ecs,
      get wind() {
        return (windCache ??= field.wind(lat, lon, t));
      },
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

  /**
   * stormSeed 的结果只和 (i, j, k, seed) 有关，缓存起来（TW01）：stormsNear 每次要扫几百个格子—窗口，
   * 导演每 300 模拟秒、统计脚本逐时取样都在重复算同一批（出生概率要算对流、锋面，出生了还要算一次风廓线）
   */
  private readonly stormSeedCache = new Map<string, ReturnType<WeatherField["stormSeedRaw"]>>();
  private stormSeed(i: number, j: number, k: number) {
    const key = `${i},${j},${k}`;
    const hit = this.stormSeedCache.get(key);
    if (hit !== undefined) return hit;
    const v = this.stormSeedRaw(i, j, k);
    if (this.stormSeedCache.size > 50000) this.stormSeedCache.clear();
    this.stormSeedCache.set(key, v);
    return v;
  }

  /** 某个格子—窗口里有没有雷暴系统；有就返回它的静态描述（出生点、出生时刻、寿命、漂移、单体排布） */
  private stormSeedRaw(i: number, j: number, k: number) {
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
    // 漂移（WX11a）：随引导气流（700–500 hPa 平均风，出生点、出生时刻，[教科书]），再加每个系统自己的偏差——
    // 新塔总在上风 / 右前侧冒出，系统的移动和平均风差一个角度、偏慢（±20°、×0.7–1.0，[估算]）；上限 STORM_MAX_DRIFT_KMH。km/h
    const st = steeringWind(this.wind(lat, lon, tBirth));
    const dv = rotScale(st, (hash(i, j, k, s + 7) - 0.5) * 40, (0.7 + 0.3 * hash(i, j, k, s + 9)) * 3.6);
    const cap = Math.min(1, STORM_MAX_DRIFT_KMH / Math.max(windSpeed(dv), 1e-6));
    const ve = dv.u * cap, vn = dv.v * cap;
    const trop = smooth(40, 20, Math.abs(lat));
    // TW01：砧顶跟着对流层顶走。改前 11.2–14.4 km 只随纬度变；热带 / 盛夏副热带的对流层顶约 16 km
    // [气候，Johnson et al. 1999 的 COARE 稳定层]，砧在对流层顶下方铺开，上冲云顶再高出约 1 km（着色器的 STORM_OVERSHOOT）。
    // 对流层顶：西风急流轴以南是热带对流层顶（约 16.5 km），以北降到约 11.5 km（中纬度），急流轴随月份南北移（JET_LAT，[Zhang06]）[教科书]；
    // 砧顶比对流层顶低 3 km（热带）到 4 km（中纬度、对流弱），再加 0–1.8 km 的个体差异 [估算]。华南 / 南海盛夏中位约 14.4 km、p90 约 15 km
    const jet = monthly(dayOfYear(tBirth), JET_LAT);
    const tropopause = 11.5 + 5 * smooth(jet + 3, jet - 5, lat);
    const anvilBase = tropopause - 3 - (1 - trop);
    // 飑线（TW01）：单体数 3–4、间距 10–22 km 按系统随机（改前固定 4 个、间距 16 km，并排时像一排等距的桌腿，TOWERING §2.2 第 2 条）
    const sqN = kind === "squall" ? n - (hash(i, j, k, s + 12) < 0.4 ? 1 : 0) : n;
    const sqGap = 10 + 12 * hash(i, j, k, s + 13);
    const axis = hash(i, j, k, s + 8) * Math.PI;
    const cells: { dx: number; dz: number; radius: number; top: number }[] = [];
    for (let c = 0; c < sqN; c++) {
      const u = hash(i, j, k, s + 20 + c);
      const v = hash(i, j, k, s + 40 + c);
      // 飑线：一排、间距 sqGap，每个单体沿线再错开 ±30%；团簇：半径 15 km 内散开
      const along = kind === "squall" ? (c - (sqN - 1) / 2) * sqGap + (u - 0.5) * 0.6 * sqGap : kind === "cluster" ? (u - 0.5) * 30 : 0;
      const across = kind === "squall" ? (v - 0.5) * 8 : kind === "cluster" ? (v - 0.5) * 22 : 0;
      cells.push({
        dx: Math.cos(axis) * along - Math.sin(axis) * across,
        dz: Math.sin(axis) * along + Math.cos(axis) * across,
        radius: 4 + 2.5 * hash(i, j, k, s + 60 + c),
        top: anvilBase + 1.8 * hash(i, j, k, s + 80 + c),
      });
    }
    return { id: `s${i}_${j}_${k}`, lat, lon, tBirth, life, ve, vn, kind, cells };
  }

  /** 此刻在 (lat, lon) 周围 radiusKm 内、处于活跃期（强度 > 0.25）的雷暴系统，按距离排序 */
  stormsNear(lat: number, lon: number, t: number, radiusKm: number): StormSystemSample[] {
    const out: { d: number; s: StormSystemSample }[] = [];
    // 系统出生后会漂移（最快 STORM_MAX_DRIFT_KMH × 寿命上限 5.5 h ≈ 330 km），搜索范围放宽
    const reachKm = radiusKm + STORM_MAX_DRIFT_KMH * STORM_LIFE_H[1];
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
              drift: { ve: sd.ve, vn: sd.vn },
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
