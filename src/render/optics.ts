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
}

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
  };
  /** 调试：强制出现（仍要满足几何条件：宝光要有云在下面、太阳在地平线以上；幻日要有卷云） */
  force: OpticsForce = {};
  /** 调试：全部关掉（对照用） */
  disabled = false;
  /** 当前状态（调试看） */
  readonly status = { glory: 0, dropletUm: 0, shadowGapKm: 0, parhelionA: 0, parhelionB: 0, halo22: 0, flashMagnify: 1 };
  private seed = Math.floor(Math.random() * 0x7fffffff);
  private pin: number | null = null;

  constructor() {
    const q = new URLSearchParams(location.search).get("optics");
    if (q !== null) {
      const set = new Set(q.split(","));
      if (set.has("off")) this.disabled = true;
      const all = set.has("all") || q === "";
      this.force = { glory: all || set.has("glory"), halo: all || set.has("halo"), flash: all || set.has("flash") };
    }
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
    if (this.force.glory) {
      glory = 0.9 * geo * Math.max(typeW, 0.8) * distW;
      radius = 10;
      spread = 0.1;
    }
    if (this.disabled) glory = 0;
    u.uOpticsGlory.value.set(glory, radius, spread, 0);

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
