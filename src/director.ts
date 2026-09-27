import * as THREE from "three";
import { haversineKm, speedAt } from "./flight";
import { AIRPORTS, airportAhead, makeLeg, nearestAirport, pickNextLeg, type Airport, type Leg } from "./routes";
import type { Preset, VoyageState } from "./state";
import type { CloudParams } from "./clouds/clouds";
import { WeatherDirector } from "./weather-director";
import type { WeatherSystem } from "./weather";

/**
 * 导演（T19a）：连续航程 / 背景板模式的编排层。回答两件事：
 *   1. 接下来飞哪、怎么飞：航段接力（到达终点上空直接接下一段，不落地、不瞬移）、每段的爬升—巡航—下降剖面、时间流逝；
 *   2. 什么时候、借什么遮挡做「会跳一下」的切换：切换以「请求」排队（SwitchRequest），等到指定的遮挡（穿云时窗外全白、深夜）
 *      出现并持续一会儿才执行；等太久且允许强制时才硬切（记进 telemetry，便于发现）。
 *
 * 本阶段用到遮挡的切换只有一种：本地坐标换原点（rebase）。地面 clipmap 用的是以预设起点为中心的正弦投影，
 * 连续飞几千公里后离中央经线越远形变越大、着色器里的公里坐标精度也变差；换原点会让云场 / 海浪的噪声原点跳一下，
 * 所以要借穿云遮住。第二阶段（天气场、奇观之门）直接复用 request() 与 onCover()。
 *
 * DOM 不在这里：背景板模式的面板 / 光标隐藏在 ui.ts，这里只持有开关和数据。
 */

// ---------- 可调参数 ----------
/** 真实客机爬升 / 下降率（km/s）：约 12 m/s ≈ 2400 ft/min、10 m/s ≈ 2000 ft/min */
export const CLIMB_RATE_KMS = 0.012;
export const DESCENT_RATE_KMS = 0.01;
/** 「到达上空」的目标高度（km）：不真的落地；陆地上还会被 T18 的离地下限抬高 */
export const ARRIVAL_ALT_KM = 3.0;
/** 离终点多远算到达、开始接下一段（与 flight.ts 里 onReachDest 的 40 km 一致） */
const ARRIVE_KM = 40;
/** 本地坐标离原点超过这么远，就排一个「换原点」请求等穿云；超过 FORCE 仍没等到就在深夜或直接硬切 */
const REBASE_SOFT_KM = 1200;
const REBASE_NIGHT_OK_KM = 2000;
const REBASE_FORCE_KM = 3000;
/** 判定「在云里、窗外全白」的云密度（clouds.cameraDensity，1/km 的归一化值，in-cloud 场景约 0.5–1） */
const CLOUD_COVER_DENSITY = 0.35;
/** 判定「深夜」的太阳高度角（度）：天文晨昏蒙影以下，窗外只剩星光与城市灯光 */
const NIGHT_SUN_ALT = -12;
/** 航程流速档位 */
export const VOYAGE_RATES = [1, 10, 60] as const;

/** 遮挡种类：穿云（窗外全白）、深夜 */
export type CoverKind = "cloud" | "night";

/** 一次「会跳一下」的切换：等 covers 里任一遮挡持续 minCoverS 秒（真实时间）再执行 */
export interface SwitchRequest {
  id: string;
  covers: CoverKind[];
  /** 遮挡至少持续多久（真实秒）才动手，免得刚进云边就切 */
  minCoverS: number;
  /** 硬切条件：返回 true 时不再等遮挡（例如离原点太远）；省略则永远等 */
  force?: () => boolean;
  run: (how: CoverKind | "forced") => void;
}

/** 导演需要从渲染系统拿到的东西（main.ts 实现） */
export interface DirectorHost {
  state: VoyageState;
  /** 飞机当前经纬度 */
  geo(): [number, number];
  /** 飞机离本地坐标原点的距离（km） */
  offsetKm(): number;
  /** 本地坐标原点挪到飞机正下方：地面重建、云场 / 海浪噪声原点跳变。只应在遮挡下调用 */
  rebase(): void;
  /** 飞机所在处的云密度（clouds.cameraDensity） */
  cloudDensity(): number;
  /** 当前太阳高度角（度） */
  sunAltDeg(): number;
  /** 切换舱灯档位（面板下拉的值：true 开 / false 睡眠 / off 全关），面板同步由 main / ui 负责 */
  setCabinLight(mode: "true" | "false"): void;
  // ---- 天气（T19b） ----
  weather: WeatherSystem;
  /** 云层参数：读当前值；写入时 gradual = 连续推进的一小步（不清时间累积），false = 借遮挡的硬切。实现里要顺带 weather.updateShell() */
  cloudParams(): CloudParams;
  setCloudParams(p: Partial<CloudParams>, gradual: boolean): void;
  /** 经纬度 → 本地公里坐标（x 东、z 南） */
  toLocal(lat: number, lon: number): [number, number];
  /** 飞机的本地坐标 */
  localPos(): [number, number];
  /** 正下方是陆地 / 海（地形数据还没到时 null，天气场改用粗略海陆分布） */
  landBelow(): boolean | null;
}

export interface DirectorTelemetry {
  frames: number;
  /** 每帧大圆位移 / 期望位移（地速 × 模拟时间步）的最大值；> 3 说明发生了瞬移 */
  maxJumpRatio: number;
  maxJumpKm: number;
  /** 高度变化率的最大值（km / 模拟秒）；爬升率上限 0.012，明显超过说明高度跳了 */
  maxAltRate: number;
  /** 航向变化率的最大值（度 / 模拟秒）；客机 25° 坡度转弯约 1–3 °/s */
  maxTurnRate: number;
  legs: { from: string; to: string; distKm: number; cruiseKm: number; atSimTime: number }[];
  switches: { id: string; how: string; atSimTime: number; offsetKm: number }[];
}

type Phase = "climb" | "cruise" | "descent";

export class Director {
  /** 连续航程：时间与飞行按 rate 流逝、自动管高度剖面 */
  active = false;
  /** 背景板模式（ui.ts 负责面板与光标；开启时一定 active） */
  backdrop = false;
  rate: number = 1;
  /** 连续航程时按太阳高度自动调舱灯：入夜（太阳 < −4°）切睡眠档，天亮（> −2°）开灯。真实红眼航班夜里也会调暗客舱；
   *  也避免夜里开着主灯时窗板的舱内反射把窗外罩成一片灰（T24 在修的问题） */
  autoCabin = true;
  private cabinNight: boolean | null = null;
  leg: Leg | null = null;
  phase: Phase = "cruise";
  readonly visits = new Map<string, number>();
  readonly telemetry: DirectorTelemetry = { frames: 0, maxJumpRatio: 0, maxJumpKm: 0, maxAltRate: 0, maxTurnRate: 0, legs: [], switches: [] };

  /** 天气驱动（T19b，weather-director.ts）：连续航程开着时按天气场推云量 / 云型、摆放雷暴与台风、奇观之门的云墙 */
  readonly weather: WeatherDirector;

  private pending: SwitchRequest[] = [];
  private coverSince: Record<CoverKind, number> = { cloud: -1, night: -1 };
  private coverListeners: ((kind: CoverKind) => void)[] = [];
  private realTime = 0;
  private prevGeo: [number, number] | null = null;
  private prevAlt = 0;
  private prevHeading = 0;
  /** 平滑过的地区霾（写进当前航段预设的 haze） */
  private haze = -1;

  constructor(private readonly host: DirectorHost) {
    this.weather = new WeatherDirector(this, host);
  }

  // ---------- 时间 ----------

  /** 这一帧的模拟时间步（秒）：连续航程时按流速加速，否则就是真实时间 */
  simDt(dtReal: number) {
    return this.active ? dtReal * this.rate : dtReal;
  }

  // ---------- 遮挡与切换 ----------

  /** 排一个切换请求（同 id 只保留一个） */
  request(req: SwitchRequest) {
    if (this.pending.some((r) => r.id === req.id)) return;
    this.pending.push(req);
  }

  /** 某种遮挡开始时回调（穿云、入夜）：第二阶段的天气场 / 奇观之门在这里挂钩 */
  onCover(fn: (kind: CoverKind) => void) {
    this.coverListeners.push(fn);
  }

  /** 此刻有哪些遮挡、各持续了多久（真实秒） */
  covers(): Partial<Record<CoverKind, number>> {
    const out: Partial<Record<CoverKind, number>> = {};
    for (const k of ["cloud", "night"] as const) if (this.coverSince[k] >= 0) out[k] = this.realTime - this.coverSince[k];
    return out;
  }

  /** 撤掉一个还没执行的请求（天气场改主意了：例如目标云型又回到当前这一族） */
  cancel(id: string) {
    this.pending = this.pending.filter((r) => r.id !== id);
  }

  hasPending(id: string) {
    return this.pending.some((r) => r.id === id);
  }

  get pendingIds() {
    return this.pending.map((r) => r.id);
  }

  private updateCovers() {
    const now: Record<CoverKind, boolean> = {
      cloud: this.host.cloudDensity() > CLOUD_COVER_DENSITY,
      night: this.host.sunAltDeg() < NIGHT_SUN_ALT,
    };
    for (const k of ["cloud", "night"] as const) {
      if (now[k] && this.coverSince[k] < 0) {
        this.coverSince[k] = this.realTime;
        for (const fn of this.coverListeners) fn(k);
      } else if (!now[k]) this.coverSince[k] = -1;
    }
    const cov = this.covers();
    this.pending = this.pending.filter((r) => {
      const hit = r.covers.find((k) => (cov[k] ?? -1) >= r.minCoverS);
      if (hit || r.force?.()) {
        const how = hit ?? "forced";
        const offsetKm = +this.host.offsetKm().toFixed(1);
        r.run(how);
        this.telemetry.switches.push({ id: r.id, how, atSimTime: this.host.state.simTime, offsetKm });
        return false;
      }
      return true;
    });
  }

  /** 离原点远了就排「换原点」：先只等穿云；再远一些深夜也行；太远且高度安全时硬切 */
  private maybeRequestRebase() {
    const off = this.host.offsetKm();
    if (off < REBASE_SOFT_KM) return;
    const s = this.host.state;
    // 高度要在下限之上留余量：换原点后地形数据重新到达时，低于新下限会被直接抬上去（flight.ts 的 updateAltitudeFloor）
    const safe = () => s.altitudeKm >= (s.floor?.km ?? 0) + 0.3;
    this.request({
      id: "rebase",
      covers: off > REBASE_NIGHT_OK_KM ? ["cloud", "night"] : ["cloud"],
      minCoverS: 1.0,
      force: () => safe() && this.host.offsetKm() > REBASE_FORCE_KM,
      run: () => this.host.rebase(),
    });
    // 距离跨过深夜阈值后要更新请求的遮挡种类：直接替换
    const r = this.pending.find((p) => p.id === "rebase");
    if (r && off > REBASE_NIGHT_OK_KM && !r.covers.includes("night")) r.covers = ["cloud", "night"];
  }

  // ---------- 航段 ----------

  /** 换了预设（main.ts 的 setPreset 之后调用）：航线预设映射成航段；其他预设清掉航段（开着连续航程时就地接入航线网） */
  onPresetChanged() {
    const s = this.host.state;
    this.prevGeo = null;
    this.haze = -1;
    const p = s.preset;
    if (p.dest) {
      // 航线预设的 id 就是「起点-终点」的 IATA 代码（hnd-cts）；认不出时按最近的机场（起点在爬升结束处，离机场几十公里）
      const [c0, c1] = p.id.toUpperCase().split("-");
      const from = AIRPORTS[c0] ?? nearestAirport(p.lat, p.lon).airport;
      const to = AIRPORTS[c1] ?? nearestAirport(p.dest[0], p.dest[1]).airport;
      this.leg = { ...makeLeg(from, to), cruiseKm: s.targetAltKm };
      this.phase = "cruise";
      this.markVisit(from);
    } else {
      this.leg = null;
      if (this.active) this.joinNetwork();
    }
    // 换预设是用户的跳变：天气直接对齐到天气场（本地坐标原点也换了，已摆放的雷暴 / 台风作废）
    if (this.active) this.weather.onJump();
  }

  /** 开启 / 关闭连续航程 */
  setActive(on: boolean) {
    this.active = on;
    this.cabinNight = null;
    if (!on) {
      this.backdrop = false;
      this.host.state.altRateKms = undefined;
      this.weather.stop();
      return;
    }
    if (!this.leg) this.joinNetwork();
    this.phase = this.host.state.altitudeKm < (this.leg?.cruiseKm ?? 10) - 0.2 ? "climb" : "cruise";
  }

  /** 从当前位置（非航线预设）接入航线网：朝机头前方的机场飞 */
  private joinNetwork() {
    const s = this.host.state;
    const [lat, lon] = this.host.geo();
    const to = airportAhead(lat, lon, s.heading);
    const here: Airport = { ...nearestAirport(lat, lon).airport };
    const leg = makeLeg(here, to);
    // 起点是「当前位置」而不是机场：距离、方位按当前位置算，巡航高度保持现在的
    leg.distKm = haversineKm(lat, lon, to.lat, to.lon);
    leg.cruiseKm = Math.max(s.targetAltKm, 7.6);
    this.beginLeg(leg, { lat, lon, name: `当前位置 → ${to.name}` });
  }

  /** 到达终点上空（flight.ts 的 onReachDest）：接下一段。不管连续航程开没开都接力，不再瞬移回起点 */
  relay() {
    const cur = this.leg?.to ?? nearestAirport(...this.host.geo()).airport;
    this.markVisit(cur);
    const next = pickNextLeg(cur, this.leg?.from ?? null, this.visits);
    this.beginLeg(next);
  }

  private markVisit(a: Airport) {
    this.visits.set(a.code, (this.visits.get(a.code) ?? 0) + 1);
    this.visits.set(a.region, (this.visits.get(a.region) ?? 0) + 1);
  }

  private beginLeg(leg: Leg, origin?: { lat: number; lon: number; name: string }) {
    const s = this.host.state;
    this.leg = leg;
    this.fitCruise(leg, s.altitudeKm);
    this.phase = s.altitudeKm < leg.cruiseKm - 0.2 ? "climb" : "cruise";
    // 航段预设：只换导航目标与显示信息，不换本地坐标原点（不调 setPreset，地面 / 云场都不重建）
    const prev = s.preset;
    const preset: Preset = {
      id: `leg-${leg.from.code}-${leg.to.code}`,
      name: origin?.name ?? `航段：${leg.from.name} → ${leg.to.name}`,
      lat: origin?.lat ?? leg.from.lat,
      lon: origin?.lon ?? leg.from.lon,
      heading: leg.bearing,
      tz: prev.tz,
      islands: prev.islands, // 关掉真实地理时的示例岛屿：沿用，免得换段时凭空消失
      dest: [leg.to.lat, leg.to.lon],
      land: true,
      haze: prev.haze ?? 1,
    };
    s.preset = preset;
    this.telemetry.legs.push({ from: leg.from.code, to: leg.to.code, distKm: Math.round(leg.distKm), cruiseKm: leg.cruiseKm, atSimTime: s.simTime });
  }

  /** 短程航段飞不到标准巡航高度：爬升段 + 下降段的水平距离要装得进航程 */
  private fitCruise(leg: Leg, startAlt: number) {
    const horiz = (a0: number, a1: number, rate: number) => (Math.abs(a1 - a0) / rate) * ((speedAt(a0) + speedAt(a1)) / 2);
    while (leg.cruiseKm > 4.5 && horiz(startAlt, leg.cruiseKm, CLIMB_RATE_KMS) + horiz(leg.cruiseKm, ARRIVAL_ALT_KM, DESCENT_RATE_KMS) > leg.distKm - ARRIVE_KM) {
      leg.cruiseKm -= 0.3;
    }
    leg.cruiseKm = Math.max(leg.cruiseKm, startAlt > 4.5 ? Math.min(startAlt, leg.cruiseKm + 0.3) : 4.5);
  }

  /** 剖面：离终点够近（按下降率和地速算出的下降距离 + 余量）就开始下降，到达上空后接下一段、再爬升 */
  private updateProfile(lat: number, lon: number) {
    const s = this.host.state;
    const leg = this.leg;
    if (!leg) return;
    const dist = haversineKm(lat, lon, leg.to.lat, leg.to.lon);
    const descentKm = ((leg.cruiseKm - ARRIVAL_ALT_KM) / DESCENT_RATE_KMS) * ((speedAt(leg.cruiseKm) + speedAt(ARRIVAL_ALT_KM)) / 2) + ARRIVE_KM + 15;
    if (this.phase !== "descent" && dist < descentKm) this.phase = "descent";
    if (this.phase === "climb" && s.altitudeKm >= leg.cruiseKm - 0.01) this.phase = "cruise";
    s.targetAltKm = this.phase === "descent" ? ARRIVAL_ALT_KM : leg.cruiseKm;
    s.altRateKms = this.phase === "descent" ? DESCENT_RATE_KMS : CLIMB_RATE_KMS;
    // 当地时刻的时区：飞过航程一半后换成目的地的
    const done = 1 - dist / Math.max(leg.distKm, 1);
    s.preset.tz = done > 0.5 ? leg.to.tz : leg.from.tz;
  }

  private updateCabin() {
    if (!this.autoCabin) return;
    const sun = this.host.sunAltDeg();
    const night = this.cabinNight === null ? sun < -3 : this.cabinNight ? sun < -2 : sun < -4;
    if (night !== this.cabinNight) {
      this.cabinNight = night;
      this.host.setCabinLight(night ? "false" : "true");
    }
  }

  /** 地区霾：沿航段在起讫两地之间按进度插值，再时间平滑（原来 preset.haze 是换预设时的一个常数，接力时会突变） */
  private updateHaze(lat: number, lon: number, simDt: number) {
    const leg = this.leg;
    if (!leg || !this.host.state.preset.id.startsWith("leg-")) return;
    const dFrom = haversineKm(lat, lon, leg.from.lat, leg.from.lon);
    const dTo = haversineKm(lat, lon, leg.to.lat, leg.to.lon);
    const target = THREE.MathUtils.lerp(leg.from.haze, leg.to.haze, THREE.MathUtils.smoothstep(dFrom / (dFrom + dTo + 1e-6), 0.3, 0.7));
    if (this.haze < 0) this.haze = this.host.state.preset.haze ?? target;
    this.haze += (target - this.haze) * (1 - Math.exp(-simDt / 600));
    this.host.state.preset.haze = this.haze;
  }

  // ---------- 每帧 ----------

  /** 每帧调用（advanceFlight 之后）：dtReal 真实秒，simDt 模拟秒，speedKms 地速 */
  update(dtReal: number, simDt: number, speedKms: number) {
    this.realTime += dtReal;
    const [lat, lon] = this.host.geo();
    this.recordContinuity(lat, lon, simDt, speedKms);
    this.updateCovers();
    if (!this.active) return;
    this.updateProfile(lat, lon);
    this.updateCabin();
    this.updateHaze(lat, lon, simDt);
    this.maybeRequestRebase();
    this.weather.update(dtReal, simDt, lat, lon);
  }

  private recordContinuity(lat: number, lon: number, simDt: number, speedKms: number) {
    const s = this.host.state;
    const t = this.telemetry;
    if (this.prevGeo && simDt > 0) {
      const jump = haversineKm(this.prevGeo[0], this.prevGeo[1], lat, lon);
      const expect = Math.max(speedKms * simDt, 0.05);
      t.maxJumpRatio = Math.max(t.maxJumpRatio, jump / expect);
      t.maxJumpKm = Math.max(t.maxJumpKm, jump);
      t.maxAltRate = Math.max(t.maxAltRate, Math.abs(s.altitudeKm - this.prevAlt) / simDt);
      const dh = Math.abs(((s.heading - this.prevHeading + 540) % 360) - 180);
      t.maxTurnRate = Math.max(t.maxTurnRate, dh / simDt);
    }
    t.frames++;
    this.prevGeo = [lat, lon];
    this.prevAlt = s.altitudeKm;
    this.prevHeading = s.heading;
  }

  /** 面板信息栏的一行 */
  describe(): string {
    if (!this.leg) return "";
    const l = this.leg;
    const phase = { climb: "爬升", cruise: "巡航", descent: "下降" }[this.phase];
    return `航段 ${l.from.code} → ${l.to.code}（${l.from.name} → ${l.to.name}，${Math.round(l.distKm)} km）` + (this.active ? `，${phase}，${this.rate}×；${this.weather.describe()}` : "");
  }
}

/** 调试 / 测试用：按代码取机场 */
export const airport = (code: string) => AIRPORTS[code];
