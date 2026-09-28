import * as THREE from "three";
import { WONDERS, wonderById, wonderVolumeCompiled, type WonderContext, type WonderDef } from "./catalog";
import { createWonderCloudUniforms } from "./wonder-cloud.glsl";
import { applyTetherUniforms, createTetherUniforms, tetherShape, type TetherShape } from "./tether-shape";
import { applyPillarUniforms, createPillarUniforms, pillarShape, type PillarShape } from "./pillar-shape";
import { applyRingUniforms, createRingUniforms, RING_SKIN, ringShape, type RingShape } from "./ring-shape";

/**
 * 奇观系统（W01）：触发、放置、编排，驱动着色器的 uniform。设计见 research/WONDERS.md §5。
 *
 * - 默认关（保证默认体验是真实的）；稀有度 = 每小时（模拟时间）期望出现几次。
 * - 触发：每 30 模拟秒掷一次骰子，p = 1 − exp(−λ·Δt)；命中后从满足条件的候选里按权重挑一个。
 *   随机数按「航程种子」（航线 + 当地日期）生成，同一趟航程可复现；同一趟航程里同一个奇观不重复
 *   （已出现的记进 localStorage，按航程分组；拿不到 localStorage 时只记在内存里）。
 * - 放置：固定在地面上的一个经纬度（不跟着飞机走），在座位一侧的窗外、略偏机头，随飞行慢慢转到窗口中间再往后退。
 * - 编排只输出一个 reveal（0..1）：浮现（真实秒）→ 停留（模拟秒）→ 退场（真实秒）。reveal 不控制透明度，
 *   控制「可见前沿」的高度——线从地平线的霾里往上长出来，前沿是一段很长的渐变；退场时反过来沉回去。
 *   加速播放时浮现 / 退场仍按真实秒走，免得一闪就没了。
 * - 给导演（T19b）留的接口：trigger() 直接召唤；candidates() / canTrigger() 条件查询；
 *   wantsCover() + onCover(kind)：「奇观之门」——穿云 / 入夜时由导演回调，奇观直接以 reveal = 1 出现，出了遮挡远方已是奇观。
 */

/** 稀有度档位：每小时（模拟时间）期望出现的次数 */
export const RARITY_LEVELS = [
  { perHour: 0.3, name: "罕见" },
  { perHour: 1, name: "偶尔" },
  { perHour: 3, name: "常见" },
  { perHour: 6, name: "奇观巡礼" },
] as const;

const ROLL_EVERY_SIM_S = 30;
/** 一个奇观结束后多久（真实秒）才允许下一个 */
const COOLDOWN_S = 120;
const EARTH_R_KM = 6371;
const STORAGE_KEY = "voyage.wonders.seen";
/** 可见前沿高度（km）：reveal = 0 → 12 km（藏在地平线的霾里）；reveal = 0.9 → 300 km（窗里能看到的那一段约 0–150 km，
 *  前沿在这之间按对数匀速爬过窗口）；reveal = 1 → 1 万 km（整根都在） */
const FRONT_MIN_KM = 12;
const FRONT_MID_KM = 300;
const FRONT_MAX_KM = 10000;

export type WonderPhase = "rising" | "holding" | "fading";

export interface ActiveWonder {
  def: WonderDef;
  lat: number;
  lon: number;
  phase: WonderPhase;
  /** 当前阶段已经过去的时间（浮现 / 退场：真实秒；停留：模拟秒） */
  elapsed: number;
  holdSimS: number;
  riseS: number;
  reveal: number;
  /** 云间层奇观：局部坐标原点离海平面的高度（km），默认取 volume.baseKm */
  baseKm: number;
  /** 是怎么来的：auto 随机触发、summon 面板 / 调试召唤、cover 借遮挡（奇观之门） */
  via: "auto" | "summon" | "cover";
  /** 本次出现的随机种子（0..1）：云间层奇观拿它换布局 / 朝向 / 纹理（uWonderParams.z，W02）；天梯拿它换塔高 / 退台 / 环站（WS01） */
  seed: number;
  /** 天梯（skin 0）按种子生成的巨构尺寸（WS01，tether-shape.ts） */
  tether?: TetherShape;
  /** 巨柱群（skin 2）按种子生成的根数 / 尺寸 / 摆放（WS07，pillar-shape.ts） */
  pillars?: PillarShape;
  /** 天环（skin 3 = RING_SKIN）按种子生成的环平面与尺寸（WS08，ring-shape.ts） */
  ring?: RingShape;
}

export interface TriggerOptions {
  /** 绝对方位角（度）；省略时按座位一侧 + forwardOffsetDeg 放 */
  bearingDeg?: number;
  /** 相对窗口正对方向往机头偏多少度（bearingDeg 没给时用） */
  forwardOffsetDeg?: number;
  distKm?: number;
  /** 起始 reveal：0 = 走浮现编排；1 = 直接显形（借遮挡、截图） */
  reveal?: number;
  /** 浮现时长（真实秒），省略用奇观自己的 */
  riseS?: number;
  via?: ActiveWonder["via"];
  /** 云间层奇观：局部坐标原点离海平面的高度（km），省略用 volume.baseKm（测试时用来把同一个体摆到不同高度） */
  baseKm?: number;
  /** 本次出现的随机种子（0..1），省略按航程种子生成（截图 / 回归时写死，画面可复现） */
  seed?: number;
}

// ---------- 小工具 ----------
function hashString(s: string) {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}
/** mulberry32：给一个 32 位种子，返回 [0, 1) 的随机数 */
function rand01(seed: number) {
  let t = (seed + 0x6d2b79f5) >>> 0;
  t = Math.imul(t ^ (t >>> 15), t | 1);
  t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
}
const rad = THREE.MathUtils.degToRad;
const deg = THREE.MathUtils.radToDeg;

/** 从 (lat, lon) 沿大圆走 distKm、初始方位 bearingDeg，到达的点 */
export function geoDestination(lat: number, lon: number, bearingDeg: number, distKm: number): [number, number] {
  const d = distKm / EARTH_R_KM;
  const b = rad(bearingDeg);
  const p1 = rad(lat);
  const l1 = rad(lon);
  const p2 = Math.asin(Math.sin(p1) * Math.cos(d) + Math.cos(p1) * Math.sin(d) * Math.cos(b));
  const l2 = l1 + Math.atan2(Math.sin(b) * Math.sin(d) * Math.cos(p1), Math.cos(d) - Math.sin(p1) * Math.sin(p2));
  return [deg(p2), ((deg(l2) + 540) % 360) - 180];
}

/** 从 (lat1, lon1) 看 (lat2, lon2)：大圆距离（km）与初始方位角（度） */
export function geoBearingDistance(lat1: number, lon1: number, lat2: number, lon2: number): { distKm: number; bearingDeg: number } {
  const p1 = rad(lat1);
  const p2 = rad(lat2);
  const dl = rad(lon2 - lon1);
  const a = Math.sin((p2 - p1) / 2) ** 2 + Math.cos(p1) * Math.cos(p2) * Math.sin(dl / 2) ** 2;
  const distKm = 2 * EARTH_R_KM * Math.asin(Math.min(1, Math.sqrt(a)));
  const y = Math.sin(dl) * Math.cos(p2);
  const x = Math.cos(p1) * Math.sin(p2) - Math.sin(p1) * Math.cos(p2) * Math.cos(dl);
  return { distKm, bearingDeg: (deg(Math.atan2(y, x)) + 360) % 360 };
}

/** 窗口正对的方位角：右座 = 航向 + 90°，左座 = 航向 − 90° */
export function outwardBearing(ctx: Pick<WonderContext, "heading" | "seat">) {
  return (ctx.heading + (ctx.seat === "right" ? 90 : -90) + 360) % 360;
}

/** 方位差，折到 (−180, 180] */
function angleDiff(a: number, b: number) {
  return ((((a - b) % 360) + 540) % 360) - 180;
}

const ease = (x: number) => x * x * (3 - 2 * x);
/** 渲染用的地球半径（km），与着色器的 BOTTOM 一致 */
const RENDER_R_KM = 6360;
const _v0 = new THREE.Vector3();
const _v1 = new THREE.Vector3();
const _v2 = new THREE.Vector3();
const _v3 = new THREE.Vector3();
const _v4 = new THREE.Vector3();

export class WonderSystem {
  /** 面板「奇观模式」开关 */
  enabled = false;
  /** 开发者开关（WS01，默认关）：天梯锚塔的塔身灯格（夜里按楼层积分成暗暖色横纹）。调试台 `__voyage.wonders.tetherWindows = true` */
  tetherWindows = false;
  /** 每小时（模拟时间）期望出现的次数 */
  rarityPerHour: number = RARITY_LEVELS[1].perHour;
  active: ActiveWonder | null = null;

  /** 着色器 uniform（main.ts 合并进场景 / 窗外共用的 uniforms） */
  readonly uniforms = {
    uWonderOn: { value: 0 },
    uWonderAxis: { value: new THREE.Vector3(0, 1, 0) },
    uWonderShape: { value: new THREE.Vector4(0.35, FRONT_MIN_KM, 0, 0) },
    uWonderAlbedo: { value: new THREE.Vector3(0.3, 0.3, 0.3) },
    // 天梯的锚塔 / 环站尺寸（WS01，只有窗外程序的 OUTSIDE_WONDER 变体读）
    ...createTetherUniforms(),
    // 巨柱群（WS07，只有窗外程序的 OWP 变体读）
    ...createPillarUniforms(),
    // 天环（WS08，只有窗外程序的 OUTSIDE_WONDER 变体读）：开关另立 uRingOn，不经 uWonderOn（那会让天梯 / 建木那段也跑）
    ...createRingUniforms(),
    // 云间层（W00）：云步进程序读这一组（经 main.ts 合进场景 uniforms，Clouds 构造时共用同一批对象）
    ...createWonderCloudUniforms(),
  };
  /** 给云间层着色器的时间（真实秒，循环） */
  private clock = 0;
  /** 手动召唤的次数（给方位随机偏移换种子） */
  private summonCount = 0;
  /** 相机的 uniform（uCamBasis、uCabinToWorld），attachView 之后才有：手动召唤按相机视线的方位放 */
  private view: { uCamBasis?: { value: THREE.Matrix3 }; uCabinToWorld?: { value: THREE.Matrix3 } } | null = null;

  /** main.ts 接入：把场景共用的 uniforms 给进来（只读其中的 uCamBasis、uCabinToWorld） */
  attachView(uniforms: Record<string, { value: unknown }>) {
    this.view = uniforms as typeof this.view;
  }

  /** 相机视线（屏幕中心）的水平方位角（度，从正北顺时针）；没接入或视线接近竖直时返回 null */
  viewBearing(): number | null {
    const cb = this.view?.uCamBasis?.value;
    const c2w = this.view?.uCabinToWorld?.value;
    if (!cb || !c2w) return null;
    // 屏幕中心的视线在座舱系里是 uCamBasis 的 −z 列（列：右、上、后），再转到窗外坐标（x 东、y 天顶、−z 北）
    const e = cb.elements;
    const d = _v4.set(-e[6], -e[7], -e[8]).applyMatrix3(c2w);
    if (d.x * d.x + d.z * d.z < 1e-6) return null;
    return (deg(Math.atan2(d.x, -d.z)) + 360) % 360;
  }

  private ctx: WonderContext | null = null;
  private rollClock = 0;
  private rollIndex = 0;
  private cooldown = 0;
  /** 本趟航程已经出现过的奇观 id（按航程分组） */
  private seen = new Map<string, Set<string>>();
  /** 挑中了、但要等遮挡（奇观之门）才出现的奇观 */
  private pendingGate: WonderDef | null = null;
  /** 导演（T19b）接入后设成 true：随机触发时不直接浮现，而是排队等 onCover */
  preferGate = false;
  /** 最近一次召唤 / 结束的记录（调试） */
  readonly log: { atSimTime?: number; id: string; event: string; via?: string }[] = [];

  constructor() {
    try {
      const raw = globalThis.localStorage?.getItem(STORAGE_KEY);
      if (raw) {
        const obj = JSON.parse(raw) as Record<string, string[]>;
        for (const [k, v] of Object.entries(obj)) this.seen.set(k, new Set(v));
      }
    } catch {
      // 隐私模式等拿不到 localStorage：只记在内存里
    }
  }

  // ---------- 条件查询（导演用） ----------

  /** 此刻满足出现条件的候选（已按「同一趟航程不重复」过滤），附带权重 */
  candidates(ctx: WonderContext | null = this.ctx): { def: WonderDef; weight: number }[] {
    if (!ctx) return [];
    const seen = this.seen.get(ctx.flightKey);
    const outward = outwardBearing(ctx);
    const out: { def: WonderDef; weight: number }[] = [];
    for (const def of WONDERS) {
      if (!wonderVolumeCompiled(def)) continue; // 云间层：种类没编进奇观 pass 就不出现
      if (seen?.has(def.id)) continue;
      if (ctx.altitudeKm < def.minAltitudeKm) continue;
      const w = def.sunWeight(ctx.sunAltDeg) * (def.facingWeight?.(outward) ?? 1);
      if (w > 0) out.push({ def, weight: w });
    }
    return out;
  }

  /** 此刻能不能开始一个新奇观（开关、冷却、没有在场的、有候选） */
  canTrigger(ctx: WonderContext | null = this.ctx) {
    return this.enabled && !this.active && this.cooldown <= 0 && this.candidates(ctx).length > 0;
  }

  /** 有奇观在等遮挡（奇观之门）：导演看到这个可以优先安排穿云 */
  wantsCover() {
    return this.pendingGate !== null;
  }

  /** 导演回调：遮挡开始了（穿云时窗外全白、深夜）。有在等门的奇观就直接以 reveal = 1 摆好，出了遮挡远方已是奇观 */
  onCover(kind: "cloud" | "night") {
    if (!this.pendingGate || !this.enabled || this.active) return;
    const def = this.pendingGate;
    this.pendingGate = null;
    this.trigger(def.id, { reveal: 1, via: "cover" });
    this.log.push({ id: def.id, event: `借遮挡出现（${kind === "cloud" ? "穿云" : "入夜"}）` });
  }

  // ---------- 召唤与清除 ----------

  /** 召唤一个奇观（省略 id 时按条件和权重挑）。成功返回 true。不检查「同一趟航程不重复」和冷却：那是随机触发的规则 */
  trigger(id?: string, opts: TriggerOptions = {}): boolean {
    const ctx = this.ctx;
    if (!ctx) return false;
    let def: WonderDef | undefined;
    if (id) def = wonderById(id);
    else {
      const list = this.candidates(ctx);
      def = list.length ? this.pick(list, rand01(hashString(ctx.flightKey) + 7919 * ++this.rollIndex)) : WONDERS[0];
    }
    if (!def) return false;
    const seed = hashString(ctx.flightKey + def.id) + this.rollIndex * 131;
    const outward = outwardBearing(ctx);
    // 往机头偏：右座机头在方位减小的方向，左座相反
    const side = ctx.seat === "right" ? 1 : -1;
    const fwd = opts.forwardOffsetDeg ?? THREE.MathUtils.lerp(def.forwardOffsetDeg[0], def.forwardOffsetDeg[1], rand01(seed));
    let bearing = opts.bearingDeg ?? outward - side * fwd;
    // 手动召唤（面板「立即召唤」：没给方位、也没给距离）：放在相机此刻视线的水平方位上，±10° 以内随机偏一点（偏向中间），
    // 保证舷窗里一眼能看到。面板传的 forwardOffsetDeg 在这里不用。自动出场（auto / 借遮挡）、调试脚本（给了距离或方位）照旧
    const view = this.viewBearing();
    if ((opts.via ?? "summon") === "summon" && opts.bearingDeg === undefined && opts.distKm === undefined && view !== null) {
      const u = rand01(seed + 17 + ++this.summonCount) + rand01(seed + 29 + this.summonCount) - 1; // 三角分布，−1..1
      bearing = view + 10 * u;
    }
    const dist = opts.distKm ?? THREE.MathUtils.lerp(def.distanceKm[0], def.distanceKm[1], rand01(seed + 1));
    const [lat, lon] = geoDestination(ctx.lat, ctx.lon, bearing, dist);
    const reveal = THREE.MathUtils.clamp(opts.reveal ?? 0, 0, 1);
    this.active = {
      def,
      lat,
      lon,
      phase: reveal >= 1 ? "holding" : "rising",
      elapsed: 0,
      holdSimS: THREE.MathUtils.lerp(def.holdSimS[0], def.holdSimS[1], rand01(seed + 2)),
      riseS: opts.riseS ?? def.riseS,
      reveal,
      baseKm: opts.baseKm ?? def.volume?.baseKm ?? 0,
      via: opts.via ?? "summon",
      seed: opts.seed ?? rand01(seed + 5 + this.summonCount * 7),
    };
    if (def.look?.skin === 0) this.active.tether = tetherShape(this.active.seed);
    if (def.look?.skin === 2) this.active.pillars = pillarShape(this.active.seed, bearing);
    // 天环：环平面按种子取（在这个方位上横贯 / 斜贯天空），锚点换成环在窗口方向上的星下点（小地图、飞过判断用）
    if (def.look?.skin === RING_SKIN) {
      const ring = (this.active.ring = ringShape(this.active.seed, ctx.lat, ctx.lon, ctx.altitudeKm, bearing));
      [this.active.lat, this.active.lon] = ring.anchor;
    }
    this.markSeen(ctx.flightKey, def.id);
    this.log.push({ id: def.id, event: "出现", via: this.active.via });
    return true;
  }

  /** 让在场的奇观退场（走退场编排）；立即清掉用 clear() */
  dismiss() {
    if (this.active && this.active.phase !== "fading") {
      this.active.phase = "fading";
      this.active.elapsed = 0;
    }
  }

  clear() {
    this.active = null;
    this.pendingGate = null;
    this.syncUniforms(null);
  }

  // ---------- 每帧 ----------

  /** dt：真实秒；simDt：模拟秒（加速播放时更大） */
  update(dt: number, simDt: number, ctx: WonderContext) {
    this.ctx = ctx;
    this.clock = (this.clock + dt) % 3600;
    if (!this.enabled) {
      if (this.active || this.pendingGate) this.clear();
      this.uniforms.uWonderOn.value = 0;
      this.uniforms.uWonderVol.value = 0;
      this.uniforms.uRingOn.value = 0;
      return;
    }
    if (this.cooldown > 0) this.cooldown -= dt;

    const a = this.active;
    if (a) this.advance(a, dt, simDt, ctx);
    else this.roll(simDt, ctx);
    this.syncUniforms(ctx);
  }

  private advance(a: ActiveWonder, dt: number, simDt: number, ctx: WonderContext) {
    // 飞过去了（转到窗口后方很远）、或者飞机降到霾里：提前退场
    const { bearingDeg, distKm } = geoBearingDistance(ctx.lat, ctx.lon, a.lat, a.lon);
    const off = Math.abs(angleDiff(bearingDeg, outwardBearing(ctx)));
    if (a.phase !== "fading" && (off > 100 || distKm > 1500 || ctx.altitudeKm < a.def.minAltitudeKm - 1.5)) {
      a.phase = "fading";
      a.elapsed = 0;
    }
    if (a.phase === "rising") {
      a.elapsed += dt;
      a.reveal = Math.min(1, Math.max(a.reveal, a.elapsed / a.riseS));
      if (a.reveal >= 1) {
        a.phase = "holding";
        a.elapsed = 0;
      }
    } else if (a.phase === "holding") {
      a.reveal = 1;
      a.elapsed += simDt;
      if (a.elapsed >= a.holdSimS) {
        a.phase = "fading";
        a.elapsed = 0;
      }
    } else {
      a.elapsed += dt;
      a.reveal = Math.max(0, 1 - a.elapsed / a.def.fadeS);
      if (a.reveal <= 0) {
        this.log.push({ id: a.def.id, event: "退场" });
        this.active = null;
        this.cooldown = COOLDOWN_S;
      }
    }
  }

  private roll(simDt: number, ctx: WonderContext) {
    if (this.cooldown > 0 || this.pendingGate) return;
    this.rollClock += simDt;
    while (this.rollClock >= ROLL_EVERY_SIM_S) {
      this.rollClock -= ROLL_EVERY_SIM_S;
      const seed = hashString(ctx.flightKey) + 7919 * ++this.rollIndex;
      const p = 1 - Math.exp(-this.rarityPerHour * (ROLL_EVERY_SIM_S / 3600));
      if (rand01(seed) >= p) continue;
      // 在云里窗外全白时不开始浮现（看不见，白白浪费了浮现的编排），等下一次骰子
      if (ctx.inCloud > 0.3) continue;
      const list = this.candidates(ctx);
      if (!list.length) continue;
      const def = this.pick(list, rand01(seed + 3));
      if (this.preferGate) this.pendingGate = def;
      else this.trigger(def.id, { via: "auto" });
      this.rollClock = 0;
      return;
    }
  }

  private pick(list: { def: WonderDef; weight: number }[], u: number) {
    const total = list.reduce((s, c) => s + c.weight, 0);
    let x = u * total;
    for (const c of list) {
      x -= c.weight;
      if (x <= 0) return c.def;
    }
    return list[list.length - 1].def;
  }

  private markSeen(flightKey: string, id: string) {
    let set = this.seen.get(flightKey);
    if (!set) this.seen.set(flightKey, (set = new Set()));
    set.add(id);
    try {
      // 只留最近 30 趟航程，免得无限增长
      const entries = [...this.seen.entries()].slice(-30).map(([k, v]) => [k, [...v]]);
      globalThis.localStorage?.setItem(STORAGE_KEY, JSON.stringify(Object.fromEntries(entries)));
    } catch {
      // 忽略：只记在内存里
    }
  }

  /** 忘掉某趟（省略 = 当前这趟）航程已出现过的奇观（调试用） */
  resetSeen(flightKey = this.ctx?.flightKey) {
    if (!flightKey) return;
    this.seen.delete(flightKey);
    try {
      const entries = [...this.seen.entries()].map(([k, v]) => [k, [...v]]);
      globalThis.localStorage?.setItem(STORAGE_KEY, JSON.stringify(Object.fromEntries(entries)));
    } catch {
      // 忽略
    }
  }

  private syncUniforms(ctx: WonderContext | null) {
    const u = this.uniforms;
    const a = this.active;
    u.uWonderOn.value = 0;
    u.uWonderVol.value = 0;
    u.uRingOn.value = 0;
    if (!ctx || !a || a.reveal <= 0) return;
    if (a.ring) {
      applyRingUniforms(u, a.ring, ctx.lat, ctx.lon, a.reveal, a.seed);
      return;
    }
    // 基座相对飞机的方位与地面距离 → 窗外坐标里「地心 → 基座」的单位向量（x 东、y 天顶、−z 北）
    const { bearingDeg, distKm } = geoBearingDistance(ctx.lat, ctx.lon, a.lat, a.lon);
    const th = distKm / EARTH_R_KM;
    const b = rad(bearingDeg);
    u.uWonderAxis.value.set(Math.sin(b) * Math.sin(th), Math.cos(th), -Math.cos(b) * Math.sin(th)).normalize();
    if (a.def.layer === "cloud") {
      this.syncVolume(a, ctx, u.uWonderAxis.value);
      return;
    }
    if (!a.def.look) return;
    const r = a.reveal;
    const front =
      r < 0.9 ? FRONT_MIN_KM * Math.pow(FRONT_MID_KM / FRONT_MIN_KM, ease(r / 0.9)) : FRONT_MID_KM * Math.pow(FRONT_MAX_KM / FRONT_MID_KM, (r - 0.9) / 0.1);
    const look = a.def.look;
    // w：有航标灯的（天梯）= 1；没有的（建木）= −种子（WS05：建木的尺寸按种子在着色器里取）
    u.uWonderShape.value.set(look.radiusKm, front, look.skin, look.beacons ? 1 : -a.seed);
    u.uWonderAlbedo.value.set(...look.albedo);
    if (a.tether) applyTetherUniforms(u, a.tether, this.tetherWindows);
    if (a.pillars) applyPillarUniforms(u, a.pillars, u.uWonderAxis.value, ctx.lat, a.seed);
    u.uWonderOn.value = 1;
  }

  /**
   * 云间层奇观（W00）：局部坐标系（锚点处的东、天顶、南）、相机在局部坐标里的位置、包围盒、投影椭球。
   * 渲染用的地球半径是 RENDER_R_KM（与着色器的 BOTTOM 一致）；方位 / 距离按大圆（6371 km）算的只是方向，差别可以忽略。
   * 全部在 CPU 上用双精度做减法：着色器里只拿到「相机 − 锚点」这个小量，不会有 6000 km 大数相减的精度问题
   */
  private syncVolume(a: ActiveWonder, ctx: WonderContext, axis: THREE.Vector3) {
    const u = this.uniforms;
    const v = a.def.volume;
    if (!v) return;
    // 地轴（北极方向）在窗外坐标里：飞机处的天顶是 y、北是 −z
    const phi = rad(ctx.lat);
    const pole = _v0.set(0, Math.sin(phi), -Math.cos(phi));
    const east = _v1.crossVectors(pole, axis);
    // 锚点正好在极点上时东向无定义：随便取一个水平方向
    if (east.lengthSq() < 1e-12) east.set(1, 0, 0);
    east.normalize();
    const south = _v2.crossVectors(east, axis).normalize();
    u.uWonderToLocal.value.set(east.x, east.y, east.z, axis.x, axis.y, axis.z, south.x, south.y, south.z);
    // 相机（窗外坐标原点在地心，相机在 (0, R + 高度, 0)）− 局部原点（锚点方向 × (R + baseKm)）
    const rel = _v3.set(0, RENDER_R_KM + ctx.altitudeKm, 0).addScaledVector(axis, -(RENDER_R_KM + a.baseKm));
    u.uWonderCam.value.set(rel.dot(east), rel.dot(axis), rel.dot(south));
    u.uWonderBoxMin.value.set(...v.box[0]);
    u.uWonderBoxMax.value.set(...v.box[1]);
    u.uWonderUse.value.set(v.surface ? 1 : 0, v.medium ? 1 : 0);
    u.uWonderStep.value = v.stepKm;
    u.uWonderParams.value.set(a.reveal, this.clock, a.seed, v.params?.[0] ?? 0);
    if (v.caster) {
      u.uWonderCaster.value.set(...v.caster.center, Math.max(0.5, Math.min(1, v.caster.strength ?? 1)));
      u.uWonderCasterR.value.set(...v.caster.radii);
    } else u.uWonderCaster.value.w = 0;
    u.uWonderVol.value = v.kind;
  }

  /** 面板 / 信息栏用的一行状态 */
  describe(): string {
    const a = this.active;
    if (!this.enabled) return "";
    if (!a) return this.pendingGate ? `等遮挡：${this.pendingGate.name.split("（")[0]}` : "";
    const phase = a.phase === "rising" ? "浮现中" : a.phase === "holding" ? "停留" : "退场中";
    const name = a.def.name.split("（")[0];
    if (!this.ctx) return `${name} · ${phase}`;
    const { bearingDeg, distKm } = geoBearingDistance(this.ctx.lat, this.ctx.lon, a.lat, a.lon);
    const size = a.tether
      ? ` · 塔高 ${a.tether.towerH.toFixed(1)} km · 环站 ${a.tether.rings.length} 只`
      : a.pillars
        ? ` · ${a.pillars.pillars.length} 根 · 最高 ${Math.max(...a.pillars.pillars.map((p) => p[3])).toFixed(0)} km`
        : a.ring
          ? ` · 环高 ${a.ring.hKm.toFixed(0)} km · 宽 ${(2 * a.ring.halfW).toFixed(0)} km · 仰角 ${a.ring.elevDeg.toFixed(0)}° · 倾斜 ${a.ring.tiltDeg.toFixed(0)}°`
          : "";
    return `${name} · ${phase} · 方位 ${bearingDeg.toFixed(0)}° · ${distKm.toFixed(0)} km${size}`;
  }

  /** 调试：当前状态快照 */
  get state() {
    const a = this.active;
    return {
      enabled: this.enabled,
      rarityPerHour: this.rarityPerHour,
      active: a ? { id: a.def.id, phase: a.phase, reveal: +a.reveal.toFixed(3), lat: a.lat, lon: a.lon, via: a.via } : null,
      pendingGate: this.pendingGate?.id ?? null,
      cooldown: Math.max(0, this.cooldown),
      flightKey: this.ctx?.flightKey,
      seen: this.ctx ? [...(this.seen.get(this.ctx.flightKey) ?? [])] : [],
    };
  }
}
