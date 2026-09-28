import * as THREE from "three";
import { sunPosition } from "../astro";
import type { VoyageState } from "../state";

/**
 * 罕见光学现象（T17）的 CPU 端：按条件 + 随机性决定宝光、本机影子、幻日 / 22° 晕、绿闪的强度，写进 uOptics*。
 * 着色器在 render/optics.glsl.ts。物理依据与参数来源见 handoff/T17.md。
 *
 * 「稀有才珍贵」：每种现象先过物理条件（云在哪、什么相态、太阳多高），条件满足时再按「episode」掷骰子——
 * 模拟时间切成一段一段（宝光 20 分钟、晕 30 分钟），每段独立决定出不出现、多强、云滴多大、出哪一侧的幻日，
 * 段与段之间用最后 15% 的时间平滑过渡，不会突然跳变。随机数按页面打开时的种子 + 段号生成。
 * 绿闪的物理条件（太阳上缘正好在地平线上、地平线没被云挡住）本身就只有一两秒，随机的是有没有近地逆温层的蜃景把绿边放大到看得见。
 *
 * 调试：URL `?optics=glory,halo,flash`（或 `all`）强制出现、`?optics=off` 全关；运行时 `__voyage.optics.force.glory = true`。
 * `__voyage.optics.pinGreenFlash(phase)` 把模拟时间钉在绿闪的那一刻（phase 0 = 红色日像上缘刚好落到海平线，
 * 1 = 绿色日像上缘落到海平线，0.5 是只剩一丝绿的中间时刻；飞机在动，每帧重新对准），`pinGreenFlash(null)` 解除。
 */

const R_EARTH = 6360; // 与着色器的 BOTTOM 一致
const SUN_RADIUS_DEG = 0.2667;
/** 绿色日像比红色高多少（度，地平线处、放大倍数 1）：0.55% × 约 60 角分的擦海面折射（估算，见 optics.glsl.ts） */
const GREEN_LIFT_DEG = 0.00549 * 1.0;

export interface OpticsForce {
  glory?: boolean;
  halo?: boolean;
  flash?: boolean;
  /** SPEC-BOW：云虹（有云海时）+ 演示雨区（摆在虹圈上、窗外一侧）+ 环地平弧 / 日柱（卷云里、太阳高度合适时） */
  bow?: boolean;
}

/** SPEC-BOW：雨区的来源之一——雷暴单体（weather.storms 的元素，只读这几个字段） */
export interface OpticsStorm {
  x: number;
  z: number;
  radius: number;
}

/** 一个高斯雨柱（云坐标 km）：中心、高斯半径、中心消光（/km）、雨顶高度、是否由光学画雨幕（阵雨雨区）、雨丝种子 */
interface RainColumn {
  x: number;
  z: number;
  r: number;
  sigma: number;
  top: number;
  veil: number;
  seed: number;
  /** 排序用：强度 / 距离 */
  rank: number;
}

/**
 * 云虹的 Mie 拟合表（handoff/SPEC-BOW-optics.py：BHMIE，伽马分布有效方差 0.1，10 个代表波长 → 线性 sRGB，与太阳圆盘卷积后
 * 每个通道拟合 p(θ) = b_out + (b_in − b_out)·σ((θc − θ)/s) + P·exp(−((θ − θc)/s)²)）。
 * 列：有效半径 µm、θc（R, G, B，度）、s（度）、P（/sr）、b_in、b_out（/sr，三通道平均）。
 * 读法：云滴越大，云虹越窄、越靠外（接近雨虹的 42°）、越亮；5 µm 时宽约 7°、中心 37°。红的中心比蓝靠外约 0.5–0.8°（外缘微红、内缘微蓝）
 */
const CLOUDBOW_TABLE: [number, number[], number[], number[], number, number][] = [
  [5, [37.8, 37.4, 37.0], [5.0, 5.0, 5.0], [0.0136, 0.0144, 0.0157], 0.0132, 0.0042],
  [7, [38.0, 38.0, 37.3], [5.0, 4.8, 4.0], [0.0149, 0.0164, 0.019], 0.0123, 0.0034],
  [10, [38.6, 38.6, 38.2], [4.2, 3.9, 3.3], [0.0179, 0.0194, 0.0217], 0.0117, 0.0033],
  [14, [39.3, 39.2, 38.7], [3.4, 3.1, 2.6], [0.0212, 0.0213, 0.0272], 0.0116, 0.0032],
  [20, [39.9, 39.6, 39.2], [2.7, 2.5, 2.1], [0.0242, 0.0259, 0.0303], 0.0115, 0.0032],
];

/** 按云滴有效半径在拟合表里线性插值 */
function cloudbowParams(reffUm: number) {
  const T = CLOUDBOW_TABLE;
  const r = Math.min(Math.max(reffUm, T[0][0]), T[T.length - 1][0]);
  let i = 0;
  while (i < T.length - 2 && r > T[i + 1][0]) i++;
  const a = T[i];
  const b = T[i + 1];
  const w = (r - a[0]) / (b[0] - a[0]);
  const lerp = (x: number, y: number) => x + (y - x) * w;
  const v3 = (k: 1 | 2 | 3) => [0, 1, 2].map((c) => lerp(a[k][c], b[k][c]));
  return { c: v3(1), s: v3(2), p: v3(3), bIn: lerp(a[4], b[4]), bOut: lerp(a[5], b[5]) };
}

/** 雷暴雨幡折算成高斯雨柱（与 clouds.glsl.ts 的 rainDensity 同形）：中心在塔下偏下风 0.25R、再被低层风吹斜（取雨层中部 0.6 km 处） */
const LOW_WIND_R = [0.94, 0.34];
const STORM_RAIN_TOP = 1.2;
/** 阵雨雨区：世界格子边长（km）、离本机多远以内才放进 4 个槽（外缘 30 km 淡出） */
const SHOWER_CELL_KM = 80;
const SHOWER_RANGE_KM = 110;

export interface OpticsInput {
  state: VoyageState;
  sunAltDeg: number;
  lat: number;
  lon: number;
  /** 云层参数（cloudUniforms 的值）：底 / 顶（km）、云量、类型（0 层状 … 1 积状）、密度倍率 */
  cloud: { bottom: number; top: number; coverage: number; type: number; density: number };
  /** 相机处的云密度（在云里时宝光和影子都没有意义） */
  inCloud: number;
  /** 场上有雷暴 / 台风时，云层参数描述的不是全部云，宝光按层状云算照样可以，但幻日不按卷云盖算（它是厚云） */
  stormy: boolean;
  /**
   * SPEC-BOW（可选，不给就没有雨虹 / 阵雨雨区）：这一帧的太阳方向（世界系单位向量，y 向上）、雷暴单体、高空风方向、
   * 本机的云坐标（uCloudOffset）、窗外方向（世界系，演示把雨区摆到窗外看得见的那段虹圈上）
   */
  sunDir?: readonly number[];
  storms?: readonly OpticsStorm[];
  upperWind?: { x: number; y: number };
  cloudOffset?: { x: number; y: number };
  outward?: { x: number; y: number; z: number };
}

/** 太阳角半径（弧度，与 atmosphere/common.glsl.ts 的 SUN_ANGULAR_RADIUS 一致） */
const SUN_ANGULAR_RADIUS_RAD = 0.004654;
/**
 * 本机影子的遮挡面积上界（m²）：optics.glsl.ts 的 opticsPlaneShadow 那 6 段带厚度线段各取最厚时的 Σ 2w·(长 + 2w)
 * （机身 168、两翼 137、两侧平尾 27、垂尾 22）。
 */
const PLANE_SHADOW_AREA_M2 = 360;
/** 影子最多压暗云辐亮度的比例低于这个值就当看不出来（0.2%，白云上不到 0.5/255） */
const SHADOW_VISIBLE_MIN = 0.002;

/**
 * 这一帧罕见光学（宝光 / 本机影子 / 幻日 / 22° 晕）会不会画出看得出的东西（PERF-13）。
 * 窗外程序只在 OUTSIDE_OPTICS 变体里有这几项；这里返回 false 时默认程序与变体逐像素相同（宝光 = 0、晕 = 0 时着色器的
 * 因子是精确的 1 和 0），返回 true 时 outside-pass.ts 的 wantedOutsideKey 要光学变体。只读 uniform 的值（u 传共用的 uniforms）。
 * 影子是纯物理、只要云在下面就开着，但远了只挡住太阳圆盘的一小点：按着色器的覆盖公式取上界——每段带子挡住圆盘（半影半径 b）
 * 的比例 ≤ 0.75·2w/b × (长 + 2w)/(2b)，合起来 ≤ 0.375·面积 / b²（这里取 0.4），再乘「最多压暗多少」。
 */
export function opticsWanted(u: Record<string, THREE.IUniform>): boolean {
  const glory = u.uOpticsGlory?.value as THREE.Vector4 | undefined;
  const halo = u.uOpticsHalo?.value as THREE.Vector4 | undefined;
  const shadow = u.uOpticsShadow?.value as THREE.Vector4 | undefined;
  if (!glory || !halo || !shadow) return false;
  if (glory.x > 0 || halo.x + halo.y + halo.z > 0) return true;
  // SPEC-BOW：雨区（雨虹 / 阵雨雨幕）、云虹、环地平弧 / 日柱（CPU 端已按几何条件判过，非 0 就是看得出）
  const bow = u.uBowOn?.value as THREE.Vector4 | undefined;
  const arc = u.uOpticsArc?.value as THREE.Vector4 | undefined;
  if ((bow && (bow.x > 0 || bow.y > 0)) || (arc && arc.x + arc.y > 0)) return true;
  if (shadow.x <= 0 || shadow.y <= 0) return false;
  const sunY = (u.uSunDir?.value as THREE.Vector3 | undefined)?.y ?? 1;
  // 影子落点在反日点方向上：视线朝下的分量 = 太阳高度的正弦（着色器里按像素取 max(−rd.y, 0.02)）
  const b = ((shadow.x * 1000) / Math.max(sunY, 0.02)) * SUN_ANGULAR_RADIUS_RAD;
  return (shadow.y * 0.4 * PLANE_SHADOW_AREA_M2) / (b * b) > SHADOW_VISIBLE_MIN;
}

function hash01(a: number, b: number): number {
  let h = Math.imul(a ^ 0x9e3779b9, 0x85ebca6b) ^ Math.imul((b | 0) + 0x7f4a7c15, 0xc2b2ae35);
  h ^= h >>> 16;
  h = Math.imul(h, 0x7feb352d);
  h ^= h >>> 15;
  h = Math.imul(h, 0x846ca68b);
  h ^= h >>> 16;
  return (h >>> 0) / 4294967296;
}
const smooth = (a: number, b: number, x: number) => {
  const t = Math.min(Math.max((x - a) / (b - a), 0), 1);
  return t * t * (3 - 2 * t);
};

/** 分段随机：段号 k 的取值由 fn(k) 给出，段尾 15% 平滑过渡到下一段 */
function episode<T extends number[]>(tMin: number, lenMin: number, fn: (k: number) => T): T {
  const x = tMin / lenMin;
  const k = Math.floor(x);
  const a = fn(k);
  const w = smooth(0.85, 1, x - k);
  if (w <= 0) return a;
  const b = fn(k + 1);
  return a.map((v, i) => v + (b[i] - v) * w) as T;
}

export class Optics {
  readonly uniforms = {
    uOpticsGlory: { value: new THREE.Vector4() },
    uOpticsShadow: { value: new THREE.Vector4() },
    uOpticsHalo: { value: new THREE.Vector4() },
    uOpticsFlash: { value: new THREE.Vector4(1, 0, 0, 0) },
    // SPEC-BOW（见 optics.glsl.ts 的声明）
    uBowRain: { value: Array.from({ length: 4 }, () => new THREE.Vector4()) },
    uBowRainB: { value: Array.from({ length: 4 }, () => new THREE.Vector4()) },
    uBowOn: { value: new THREE.Vector4() },
    uBowCloudC: { value: new THREE.Vector4(0.67, 0.67, 0.67, 0) },
    uBowCloudS: { value: new THREE.Vector4(0.07, 0.07, 0.07, 0) },
    uBowCloudP: { value: new THREE.Vector4() },
    uOpticsArc: { value: new THREE.Vector4() },
  };
  /** 调试：强制出现（仍要满足几何条件：宝光要有云在下面、太阳在地平线以上；幻日要有卷云） */
  force: OpticsForce = {};
  /** 调试：全部关掉（对照用） */
  disabled = false;
  /** 当前状态（调试看） */
  readonly status = {
    glory: 0, dropletUm: 0, shadowGapKm: 0, parhelionA: 0, parhelionB: 0, halo22: 0, flashMagnify: 1,
    // SPEC-BOW：云虹强度、雨区（槽里的雨柱：来源、离本机 km、中心消光、雨虹方向相对对日点的角距°）、环地平弧 / 日柱份额
    cloudBow: 0, rain: [] as { kind: string; km: number; sigma: number; antiDeg: number }[], cha: 0, pillar: 0,
  };
  private seed = Math.floor(Math.random() * 0x7fffffff);
  private pin: number | null = null;
  /** 演示雨区（?bow=1 / force.bow）：摆好后固定在云坐标上（飞机飞走了就留在原地，离开 SHOWER_RANGE_KM 后下一帧重摆） */
  private demoRain: RainColumn | null = null;

  constructor() {
    const q = new URLSearchParams(location.search).get("optics");
    if (q !== null) {
      const set = new Set(q.split(","));
      if (set.has("off")) this.disabled = true;
      const all = set.has("all") || q === "";
      this.force = { glory: all || set.has("glory"), halo: all || set.has("halo"), flash: all || set.has("flash"), bow: all || set.has("bow") };
    }
    // SPEC-BOW 演示入口：?bow=1（= ?optics=bow）
    if (/^(1|on|true)$/.test(new URLSearchParams(location.search).get("bow") ?? "")) this.force.bow = true;
  }

  /** 调试：丢掉演示雨区，下一帧按当前机位 / 太阳重摆（换了时间或航向后用） */
  resetBowDemo() {
    this.demoRain = null;
  }

  /**
   * 调试：某个窗外方向（默认反日点）落在屏幕的哪个像素（左上角为原点）；u 传 __voyage.sceneMat.uniforms。
   * 用来找「宝光 / 幻日在窗里」的时刻和头位，null 表示在身后
   */
  pixelOf(u: Record<string, THREE.IUniform>, dirW?: THREE.Vector3) {
    const d = dirW ?? (u.uSunDir.value as THREE.Vector3).clone().negate();
    const c = (u.uCabinToWorld.value as THREE.Matrix3).clone().transpose();
    const v = d.clone().applyMatrix3(c).applyMatrix3((u.uCamBasis.value as THREE.Matrix3).clone().transpose());
    if (v.z > -1e-6) return null;
    const res = u.uResolution.value as THREE.Vector2;
    const t = u.uTanHalfFov.value as number;
    const nx = v.x / -v.z / t / (res.x / res.y);
    const ny = v.y / -v.z / t;
    return [Math.round((nx + 1) * 0.5 * res.x), Math.round((1 - (ny + 1) * 0.5) * res.y)];
  }

  /** 把模拟时间钉在绿闪那一刻（见文件头），null 解除 */
  pinGreenFlash(phase: number | null) {
    this.pin = phase;
  }

  /**
   * SPEC-BOW：这一帧放进 4 个槽的雨柱（按「强度 / 距离」排序取前 4）。三种来源：
   * 1. 雷暴雨幡（weather.storms）：云步进已经画了雨幕，这里只为雨虹，所以只在「虹可能落在它上面」时才放（雨柱中心方向离对日点 25°–62°，
   *    再放宽雨柱的角半径）。从巡航高度看，雨幡大半被自己的塔身 / 砧挡住，常只剩边上一段虹（物理如此）。
   * 2. 阵雨雨区：浓积云（积状云、层厚 ≥ 约 3.5 km）下的一片阵雨。世界上按 80 km 的格子放，每格每 50 分钟一段、约三成的段有雨
   *    （估算；西太暖池浓积云占降水性对流云的一半以上，research/TOWERING.md），段内按 sin² 生消（段首段尾为 0，换段不跳）。
   *    高斯半径 5–12 km、中心消光 0.3–1.2 /km（中到大阵雨的能见度 1–10 km，按 Koschmieder σ = 3.9 / V 折算，估算），雨顶在云底。
   * 3. 演示雨区（force.bow）：摆在虹圈上窗外看得见的那一段（见 placeDemoRain）。
   */
  private rainColumns(inp: OpticsInput, tMin: number): RainColumn[] {
    const { cloud, state } = inp;
    const off = inp.cloudOffset;
    const sd = inp.sunDir;
    if (!off || !sd) return [];
    const alt = state.altitudeKm;
    const cols: RainColumn[] = [];
    const s = this.seed;
    // 雨柱中心（雨层中部）的方向离对日点多远（度）、角半径（度）、距离（km）
    const geom = (x: number, z: number, r: number) => {
      const dx = x - off.x;
      const dy = 0.6 - alt;
      const dz = z - off.y;
      const d = Math.hypot(dx, dy, dz);
      const anti = (Math.acos(Math.min(Math.max(-(dx * sd[0] + dy * sd[1] + dz * sd[2]) / d, -1), 1)) * 180) / Math.PI;
      return { anti, ang: (Math.atan((2.2 * r) / d) * 180) / Math.PI, d, h: Math.hypot(dx, dz) };
    };
    // 1. 雷暴雨幡
    const uw = inp.upperWind ?? { x: 0.8, y: 0.6 };
    for (const st of inp.storms ?? []) {
      const x = st.x + uw.x * st.radius * 0.25 + LOW_WIND_R[0] * (STORM_RAIN_TOP - 0.6) * 0.35;
      const z = st.z + uw.y * st.radius * 0.25 + LOW_WIND_R[1] * (STORM_RAIN_TOP - 0.6) * 0.35;
      // rainDensity：半径 R·(0.4 + 0.35n)、core = 1 − smoothstep(0.1, 1.2, rr)（rr ≈ 0.65 处减半）→ 高斯半径约 0.45R；
      // 中心消光 1.8 × (0.5 + 0.9 × 0.5) ≈ 1.7 /km，再乘云的密度倍率（与云步进一致）
      const r = 0.45 * st.radius;
      const g = geom(x, z, r);
      if (g.anti - g.ang > 62 || g.anti + g.ang < 25 || g.h > 250) continue;
      cols.push({ x, z, r, sigma: 1.7 * cloud.density, top: STORM_RAIN_TOP, veil: 0, seed: 0, rank: 1 / (g.d + 10) });
    }
    // 2. 阵雨雨区
    const showers = smooth(0.6, 0.9, cloud.type) * smooth(3.0, 4.5, cloud.top - cloud.bottom) * smooth(0.15, 0.3, cloud.coverage) * smooth(3.5, 2.5, cloud.bottom);
    if (showers > 0) {
      const C = SHOWER_CELL_KM;
      const R = SHOWER_RANGE_KM;
      for (let ix = Math.floor((off.x - R) / C); ix <= Math.floor((off.x + R) / C); ix++) {
        for (let iz = Math.floor((off.y - R) / C); iz <= Math.floor((off.y + R) / C); iz++) {
          const key = (ix * 92821) ^ (iz * 68917);
          const phase = hash01(s + 41, key);
          const x = tMin / 50 + phase;
          const k = Math.floor(x);
          const env = Math.sin(Math.PI * (x - k)) ** 2;
          if (hash01(s + 42 + key, k) > 0.3 * showers || env < 0.02) continue;
          const cx = (ix + 0.15 + 0.7 * hash01(s + 43 + key, k)) * C;
          const cz = (iz + 0.15 + 0.7 * hash01(s + 44 + key, k)) * C;
          const r = 5 + 7 * hash01(s + 45 + key, k);
          const g = geom(cx, cz, r);
          const fade = smooth(R, R - 30, g.h);
          if (fade <= 0) continue;
          const sigma = (0.3 + 0.9 * hash01(s + 46 + key, k)) * env * fade;
          cols.push({ x: cx, z: cz, r, sigma, top: cloud.bottom, veil: 1, seed: 100 * hash01(s + 47 + key, k), rank: sigma / (g.h + 10) });
        }
      }
    }
    // 3. 演示雨区
    if (this.force.bow) {
      if (this.demoRain && Math.hypot(this.demoRain.x - off.x, this.demoRain.z - off.y) > SHOWER_RANGE_KM) this.demoRain = null;
      if (!this.demoRain) this.demoRain = this.placeDemoRain(inp);
      if (this.demoRain) cols.push({ ...this.demoRain, rank: 1e3 });
    } else this.demoRain = null;
    cols.sort((a, b) => b.rank - a.rank);
    return cols.slice(0, 4);
  }

  /**
   * 演示雨区：在「对日点外 42°」那一圈上挑一个点——视线朝下（打得到地面）、离窗外视线方向（窗外、往下约 25°）最近，
   * 雨柱中心放在这条视线穿过雨层中部的地方；半径 10 km、中心消光 0.9 /km（中到大阵雨，估算）。太阳不在身后（整圈虹都在地平线以上
   * 或背窗那一侧）时摆不出来，返回 null
   */
  private placeDemoRain(inp: OpticsInput): RainColumn | null {
    const sd = inp.sunDir;
    const off = inp.cloudOffset;
    const o = inp.outward;
    if (!sd || !off || !o) return null;
    const alt = inp.state.altitudeKm;
    const A = new THREE.Vector3(-sd[0], -sd[1], -sd[2]);
    const v0 = new THREE.Vector3(o.x, 0, o.z).normalize().multiplyScalar(Math.cos(0.44)).setY(-Math.sin(0.44));
    // 圈上的两个正交方向
    const e1 = new THREE.Vector3(0, 1, 0).cross(A);
    if (e1.lengthSq() < 1e-6) e1.set(1, 0, 0);
    e1.normalize();
    const e2 = A.clone().cross(e1).normalize();
    const R42 = (42 * Math.PI) / 180;
    let best: THREE.Vector3 | null = null;
    let bestDot = -2;
    const d = new THREE.Vector3();
    for (let i = 0; i < 144; i++) {
      const a = (i / 144) * Math.PI * 2;
      d.copy(A).multiplyScalar(Math.cos(R42)).addScaledVector(e1, Math.sin(R42) * Math.cos(a)).addScaledVector(e2, Math.sin(R42) * Math.sin(a));
      if (d.y > -0.12) continue;
      const dot = d.dot(v0);
      if (dot > bestDot) {
        bestDot = dot;
        best = d.clone();
      }
    }
    if (!best || bestDot < 0.5) return null;
    const t = (alt - 0.6) / -best.y;
    return { x: off.x + best.x * t, z: off.y + best.z * t, r: 10, sigma: 0.9, top: Math.min(Math.max(inp.cloud.bottom, 1.5), 3), veil: 1, seed: 17.3, rank: 1e3 };
  }

  update(inp: OpticsInput) {
    const { state, cloud } = inp;
    const alt = state.altitudeKm;
    const tMin = state.simTime / 60000;
    const u = this.uniforms;
    // 海平线的俯角（度，负数）
    const horizonDeg = -Math.acos(R_EARTH / (R_EARTH + alt)) * (180 / Math.PI);
    const sunUp = smooth(horizonDeg - SUN_RADIUS_DEG, horizonDeg + SUN_RADIUS_DEG, inp.sunAltDeg);
    const s = this.seed;
    const clear = 1 - smooth(0.02, 0.2, inp.inCloud);

    // ---- 宝光 ----
    // 条件：云顶在本机下面（至少几百米）、云顶是液态水滴（ISA 下约 −35°C 以上，冰晶云没有宝光）、云量够成片、
    // 太阳在地平线以上且反日点落在海平线以下（投到云上）、本机不在云里。
    const gap = alt - cloud.top;
    const below = smooth(0.1, 0.5, gap);
    const liquid = smooth(8.2, 7.0, cloud.top);
    const deck = smooth(0.2, 0.55, cloud.coverage);
    const thick = smooth(0.15, 0.6, (cloud.top - cloud.bottom) * cloud.density);
    const sunOk = smooth(-horizonDeg + 0.5, -horizonDeg + 2.5, inp.sunAltDeg) * smooth(75, 60, inp.sunAltDeg);
    // 层状云的云滴大小更均匀、环更清楚；积云顶的宝光也有，但更破碎（估算的权重）
    const typeW = 1 - 0.4 * cloud.type;
    // 越远，中间的霾把彩环的对比度冲得越淡（估算：高度差 15 km 时减半）
    const distW = 1 / (1 + Math.max(gap, 0) / 15);
    const geo = below * deck * thick * sunOk * clear;
    const [gAmp, gRadius, gSpread] = episode(tMin, 20, (k) => {
      const on = hash01(s + 11, k) < 0.55 ? 1 : 0;
      return [on * (0.45 + 0.55 * hash01(s + 12, k)), 6 + 9 * hash01(s + 13, k), 0.08 + 0.12 * hash01(s + 14, k)];
    });
    let glory = 0.9 * geo * liquid * typeW * distW * gAmp;
    let radius = gRadius;
    let spread = gSpread;
    if (this.force.glory || this.force.bow) {
      glory = 0.9 * geo * Math.max(typeW, 0.8) * distW;
      radius = this.force.bow ? 12 : 10;
      spread = 0.1;
    }
    if (this.disabled) glory = 0;
    u.uOpticsGlory.value.set(glory, radius, spread, 0);

    // ---- 云虹 / 雾虹（SPEC-BOW）----
    // 和宝光同一片水滴云、同一段的云滴半径（宝光出现说明云顶云滴谱窄、够均匀）；宝光这一段开着时再掷一次，约六成同时有云虹（估算）。
    // 强度 1 = 着色器里按单次散射份额算出的物理量（亮带只比云海亮百分之几到十几）；云滴越大、虹越窄越亮（拟合表里已含）
    const [cbOn] = episode(tMin, 20, (k) => [hash01(s + 15, k) < 0.6 ? 1 : 0]);
    let cloudBow = geo * liquid * typeW * distW * cbOn * Math.min(gAmp / 0.45, 1);
    if (this.force.bow) cloudBow = geo * Math.max(typeW, 0.8) * distW;
    if (this.disabled) cloudBow = 0;
    const cb = cloudbowParams(radius);
    const pRef = 0.5 * (cb.bIn + cb.bOut);
    const D2R = Math.PI / 180;
    u.uBowCloudC.value.set(cb.c[0] * D2R, cb.c[1] * D2R, cb.c[2] * D2R, cb.bIn - pRef);
    u.uBowCloudS.value.set(cb.s[0] * D2R, cb.s[1] * D2R, cb.s[2] * D2R, cb.bOut - pRef);
    u.uBowCloudP.value.set(cb.p[0], cb.p[1], cb.p[2], 0);

    // ---- 本机影子：纯物理，不掷骰子（远了自然看不见；着色器按半影算） ----
    // 影子落点取云顶往下一点（云顶起伏，视线常先碰到云顶以下的云塔侧面）
    const shadowGap = alt - (cloud.top - 0.15 * (cloud.top - cloud.bottom));
    const shadowOn = !this.disabled && gap > 0.05 && cloud.coverage > 0.05 && sunUp > 0 && clear > 0;
    u.uOpticsShadow.value.set(shadowOn ? shadowGap : 0, 0.7 * clear, 0, 0);

    // ---- 幻日 / 22° 晕 ----
    // 条件：卷云（冰晶）层，太阳在地平线以上、不太高（高于约 61° 幻日消失，晕仍在）
    const cirrus = inp.stormy ? 0 : smooth(8.5, 10, cloud.bottom) * smooth(0.05, 0.25, cloud.coverage);
    const [pa, pb, ph, tilt] = episode(tMin, 30, (k) => {
      if (hash01(s + 21, k) > 0.6) return [0, 0, 0, 0.01];
      const pattern = hash01(s + 22, k);
      const sideA = hash01(s + 23, k) < 0.5;
      const strong = 0.35 + 0.65 * hash01(s + 24, k);
      const other = strong * (0.2 + 0.8 * hash01(s + 25, k));
      // 45% 只出一侧、35% 两侧不一样亮、20% 只有晕
      let a = 0;
      let b = 0;
      if (pattern < 0.45) (sideA ? (a = strong) : (b = strong));
      else if (pattern < 0.8) (sideA ? ((a = strong), (b = other)) : ((b = strong), (a = other)));
      const halo = hash01(s + 26, k) < 0.55 ? 0.3 + 0.7 * hash01(s + 27, k) : 0;
      const tiltRad = ((0.3 + 1.5 * hash01(s + 28, k)) * Math.PI) / 180;
      return [a, b, halo, tiltRad];
    });
    // 份额上限（估算）：卷云的散射约一半是前向衍射峰；水平片状冰晶只占冰晶的约 1%，每个幻日分到它们散射的约 10%
    // → 约 5e-4。定标：亮幻日约是周围卷云亮度的几倍（实测的亮幻日约 1e4 cd/m² 量级，蓝天约 5e3），不是刺眼的光斑。
    // 22° 晕：随机取向冰晶的最小偏向焦散，比周围卷云亮 30–50%（常见的晕都很淡）→ 份额约 5e-3（铺在整圈上）
    const F_PARHELION = 5e-4;
    const F_HALO = 5e-3;
    const hGate = cirrus * sunUp * clear * (this.disabled ? 0 : 1);
    if (this.disabled) u.uOpticsHalo.value.set(0, 0, 0, 0.01);
    else if (this.force.halo) u.uOpticsHalo.value.set(F_PARHELION * cirrus, F_PARHELION * 0.45 * cirrus, F_HALO * 0.7 * cirrus, (0.8 * Math.PI) / 180);
    else u.uOpticsHalo.value.set(F_PARHELION * pa * hGate, F_PARHELION * pb * hGate, F_HALO * ph * hGate, tilt);

    // ---- 环地平弧 / 日柱（SPEC-BOW）：和幻日同一群水平片状冰晶（这一段出了幻日就说明有），只是太阳高度条件不同 ----
    // 环地平弧：光从侧面进、底面出，n = 1.311 时要 cos²h ≤ 2 − n²，即太阳高于约 58°（这时幻日已经没了，Bravais 等效折射率 n'·sin30° ≥ 1 在 61° 附近）。
    // 日柱：底面反射，太阳低（≲ 6°）时最常见。份额（估算，与幻日同一定标）：弧约 2 倍幻日（整条弧上铺开，峰值仍只是几倍卷云亮度），
    // 日柱约 0.8 倍（外反射率随掠射角升高，太阳低时反而亮）
    const plates = this.force.bow ? 1 : Math.max(pa, pb);
    const chaGate = smooth(57.9, 60, inp.sunAltDeg);
    const pillarGate = smooth(-1, 0.5, inp.sunAltDeg) * smooth(9, 4, inp.sunAltDeg);
    const F_CHA = 1e-3;
    const F_PILLAR = 4e-4;
    const arcGate = cirrus * sunUp * clear * (this.disabled ? 0 : 1) * plates;
    u.uOpticsArc.value.set(F_CHA * arcGate * chaGate, F_PILLAR * arcGate * pillarGate, this.force.bow ? (1.2 * Math.PI) / 180 : tilt, 0);

    // ---- 雨区与雨虹（SPEC-BOW）----
    const cols = this.disabled ? [] : this.rainColumns(inp, tMin);
    const rainOut: typeof this.status.rain = [];
    for (let i = 0; i < 4; i++) {
      const c = cols[i];
      if (c) {
        u.uBowRain.value[i].set(c.x, c.z, c.r, c.sigma);
        u.uBowRainB.value[i].set(c.top, c.veil, c.seed, 0);
        const off = inp.cloudOffset!;
        const sd = inp.sunDir!;
        const v = new THREE.Vector3(c.x - off.x, 0.6 - alt, c.z - off.y);
        const km = v.length();
        v.normalize();
        rainOut.push({ kind: c.veil > 0.5 ? (c.rank >= 1e3 ? "演示阵雨" : "阵雨") : "雷暴雨幡", km: +km.toFixed(1), sigma: +c.sigma.toFixed(2), antiDeg: +((Math.acos(-(v.x * sd[0] + v.y * sd[1] + v.z * sd[2])) * 180) / Math.PI).toFixed(1) });
      } else u.uBowRain.value[i].set(0, 0, 1, 0);
    }
    // 太阳在地平线以下（加暮光）就不画雨区：阳光照不到，雨幕在夜里也几乎看不见
    const rainOn = cols.length > 0 && inp.sunAltDeg > -6 ? 1 : 0;
    u.uBowOn.value.set(rainOn, cloudBow, 0, 0);

    // ---- 绿闪 ----
    // 色散本身每次日落都有，但只有几十角秒（亚像素、肉眼也难分辨）；看得见的绿闪靠近地逆温层的蜃景把地平线附近放大。
    // 按当地日期每天掷一次：约 70% 的日落没有像样的逆温（放大 1–1.5 倍，绿边看不见），约 30% 有（4–12 倍，估算）
    const day = Math.floor(state.simTime / 86400000 + inp.lon / 360);
    const r = hash01(s + 31, day);
    let magnify = r < 0.7 ? 1 + 0.5 * (r / 0.7) : 4 + 8 * ((r - 0.7) / 0.3);
    if (this.force.flash) magnify = 8;
    if (this.disabled) magnify = 1;
    u.uOpticsFlash.value.set(magnify, this.disabled ? 0 : 1, 0, 0);

    Object.assign(this.status, {
      glory: +glory.toFixed(3),
      dropletUm: +radius.toFixed(1),
      shadowGapKm: shadowOn ? +shadowGap.toFixed(2) : 0,
      parhelionA: +u.uOpticsHalo.value.x.toFixed(4),
      parhelionB: +u.uOpticsHalo.value.y.toFixed(4),
      halo22: +u.uOpticsHalo.value.z.toFixed(4),
      flashMagnify: +magnify.toFixed(2),
      cloudBow: +cloudBow.toFixed(3),
      rain: rainOut,
      cha: +u.uOpticsArc.value.x.toExponential(2),
      pillar: +u.uOpticsArc.value.y.toExponential(2),
    });

    // 调试：把模拟时间钉在绿闪那一刻。目标：太阳中心的几何高度 = 海平线 − 半径 − phase × 绿色抬升量。
    // 飞机在动，太阳高度随位置变，所以每帧用割线法把时间往目标挪一步（下一帧生效）
    if (this.pin !== null) {
      const target = horizonDeg - SUN_RADIUS_DEG - this.pin * GREEN_LIFT_DEG;
      const f = (ms: number) => sunPosition(new Date(ms), inp.lat, inp.lon, alt * 1000).altitude - target;
      let t = state.simTime;
      for (let i = 0; i < 3; i++) {
        const y = f(t);
        const slope = (f(t + 1000) - y) / 1000; // 度 / 毫秒
        if (Math.abs(slope) < 1e-12) break;
        t -= Math.max(-3.6e6, Math.min(3.6e6, y / slope));
      }
      state.simTime = t;
    }
  }
}
