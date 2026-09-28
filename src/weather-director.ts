import { haversineKm } from "./flight";
import type { CloudParams } from "./clouds/clouds";
import type { CoverKind, Director, DirectorHost, SwitchRequest } from "./director";
import { FUJI_SUMMIT, REGIME_FAMILY, REGIME_NAMES, WeatherField, WeatherSystem, lenticularFrom, mountainWavelengthKm, windSpeed, type CloudRegime, type StormSystemSample, type TyphoonSample, type WeatherSample, type WindProfile } from "./weather";

/**
 * 天气驱动（T19b）：连续航程开着时，按天气场（weather.ts 的 WeatherField）让天气随位置与时间演变。导演（director.ts）持有它。
 *
 * 三类变化，三种做法：
 *   1. 连续项（同一族云型里的云量、云顶、密度）：每 5 模拟分钟取样一次天气场，按限速插值推过去（云量满幅约 40 模拟分钟），
 *      推给 clouds.setParams(…, gradual) ——不清时间累积、云影图按分片节奏跟上，看不出台阶；
 *   2. 跳变项（换云族：积云 ↔ 层积云 ↔ 高积云 ↔ 卷云，云层高度要变）：目标云族持续 20 模拟分钟才动手，
 *      向导演排「cloud-regime」请求，借穿云 / 深夜硬切；等遮挡的同时把当前云量淡出，淡到 0 时（晴空间隙，窗外没有云可跳）也可以切，
 *      然后新云型从 0 淡入——所以不会无限期等遮挡，也不会当着面硬切；
 *   3. 雷暴 / 台风：天气场里是有出生、寿命、漂移的「系统」，按世界坐标（经纬度 → 本地公里坐标）摆放，飞机从旁边经过。
 *      生成 / 移除都是「会跳一下」的切换：等它在窗外视野以外（机头前方或机尾后方、或远到看不见），或借穿云 / 深夜；
 *      摆放时如果正好压在航线上，整组横移到航线一侧（等价于机长绕飞），保证是「远远路过」。
 *
 * 奇观之门（W01 用）：openGate() 在航线前方放一道安静的云墙（不打闪电的积雨云单体），飞机穿进去窗外全白时执行回调并移除云墙。
 * gateDemo = true 时每 2 模拟小时自动开一道（演示开关）。
 */

// ---------- 可调参数 ----------
/** 天气场取样间隔（模拟秒） */
const SAMPLE_SIM_S = 300;
/** 目标云族要持续多久（模拟秒）才开始换族：免得在两族交界处来回切 */
const REGIME_PERSIST_SIM_S = 20 * 60;
/** 云量的最大变化率（每模拟秒）：满幅约 40 模拟分钟 */
const COVERAGE_RATE = 1 / (40 * 60);
/** 云顶 / 云底的最大变化率（km / 模拟秒）：约 3 km / 小时，积云长成浓积云的速度 */
const HEIGHT_RATE = 3 / 3600;
/** 云型系数、密度的最大变化率（每模拟秒） */
const SHAPE_RATE = 1 / (30 * 60);
/** 推给云着色器的最小间隔（真实秒）：每次推进是一小步，云影图按分片重建 */
const PUSH_MIN_REAL_S = 0.25;
/**
 * 雷暴系统进入这个范围（km）就准备摆放，离开 STORM_DROP_KM 或消散后移除。
 * 不放得更远：占据网格只覆盖 ±128 km，网格外的雷暴照样按点求值，4 个单体在 300 km 外仍要 +1–1.5 ms / 帧（T19b-storm-cost.mjs），
 * 而那么远只剩地平线上的一小块砧顶
 */
const STORM_RANGE_KM = 280;
const STORM_DROP_KM = 340;
/** 台风：中心进入这个范围（km）就准备摆放（卷云盖半径约 16 × 眼半径 ≈ 300 km）；远处的台风也要 +2–3 ms / 帧 */
const TY_RANGE_KM = 600;
const TY_DROP_KM = 720;
/** 窗外视野：窗户左右各约 25°，再留余量。物体的角范围完全落在「离窗外方向 55° 以外」才算看不见 */
const OUT_OF_VIEW_DEG = 55;
/** 远到这个程度（km，扣掉物体半径）就算看不见 */
const OUT_OF_VIEW_FAR_KM = 450;
/** 雷暴离航线至少多远（km）：单体半径 × 5 + 8（颠簸的影响范围约 6 倍半径，擦边而过只有轻微颠簸） */
const stormPassKm = (radius: number) => radius * 5 + 8;
/** 台风中心离航线至少多远（km）：外围雨带、卷云盖外缘（「台风外围」预设是 220 km） */
const TY_PASS_KM = 220;
/** 构图：机头前方离航线这么近（km）的雷暴系统挪到窗外一侧（composeForWindow） */
const COMPOSE_CROSS_KM = 200;
/** 构图：机头前方这么远（km）以外的才挪（再近的已经快到窗前了，挪会被看见） */
const COMPOSE_AHEAD_KM = 60;
/** 整组都在机尾方向这么远（km）以外，就算「已经飞过去」：不再摆放，已摆放的看不见了就撤掉让出名额（TW01） */
const PASSED_KM = 40;

/** 名额挑选的候选：一个雷暴系统，组中心相对飞机的本地坐标（km，x 东 z 南） */
export interface StormCandidate {
  id: string;
  cells: number;
  x: number;
  z: number;
}

/**
 * 名额内挑哪些雷暴系统（TW01）。着色器只有 WeatherSystem.MAX_STORMS 个单体名额，而盛夏华南 / 南海 280 km 内常有 5–6 个单体，
 * 改前按离飞机的距离挑，机尾后方刚飞过的、在另一侧窗外看不见的也照样占名额。现在的代价：
 *   · 已经飞过去（组中心在机尾方向 PASSED_KM 以外）：不挑；
 *   · 机头前方、离航线 COMPOSE_CROSS_KM 以内的会被 composeForWindow 挪到窗外 40–90 km：按挪过去以后的位置算；
 *   · 在窗户这一侧（或挪过去以后在这一侧）：代价 = 距离；在另一侧：不挑（整段航程都看不见，还占名额、占 GPU；转弯后到了窗户这一侧，下一次规划再摆）；
 *   · 正侧方到机尾之间（along < 0）的再加 100 km：马上要离开视野，不如前方的。
 * 按代价从小到大、放得下（cells ≤ 剩余名额）就挑。fwd：机头方向单位向量（本地 x、z）；side：窗户在机头右侧为 1、左侧为 −1
 */
export function pickStormSystems(cands: StormCandidate[], free: number, fwd: [number, number], side: 1 | -1): string[] {
  const [fx, fz] = fwd;
  const rx = -fz, rz = fx; // 机头右侧
  const scored: { id: string; cells: number; cost: number }[] = [];
  for (const c of cands) {
    const along = c.x * fx + c.z * fz;
    let cross = c.x * rx + c.z * rz;
    if (along < -PASSED_KM) continue;
    if (along >= COMPOSE_AHEAD_KM && Math.abs(cross) <= COMPOSE_CROSS_KM) cross = side * (40 + (50 * Math.abs(cross)) / COMPOSE_CROSS_KM);
    const d = Math.hypot(along, cross);
    if (cross * side <= 0) continue;
    scored.push({ id: c.id, cells: c.cells, cost: d + (along < 0 ? 100 : 0) });
  }
  scored.sort((a, b) => a.cost - b.cost || (a.id < b.id ? -1 : 1));
  const out: string[] = [];
  for (const s of scored) {
    if (s.cells > free) continue;
    free -= s.cells;
    out.push(s.id);
  }
  return out;
}

/** 奇观之门演示：间隔（模拟秒） */
const GATE_DEMO_EVERY_SIM_S = 2 * 3600;
/**
 * 海面风速的最大变化率（m/s / 模拟秒，WX11g）：约 4 m/s / 模拟小时。海况跟着风走要时间——短波与白浪几分钟到半小时、
 * 风浪的波高要几个小时（风时 / 风区关系，[教科书] 量级），这里取折中；天气场自己 1 小时的变化 p99 约 5%，
 * 沿航线 900 km/h 穿过风带时，这个速率让海况大约一刻钟变 1 m/s，看不出台阶。海面按档位混合（ocean/waves.ts），风速连续写入即可
 */
const SEA_WIND_RATE = 4 / 3600;

/**
 * 富士山笠云 / 吊し雲（SPEC-FUJI）：飞机离山顶这么远（km）以内才摆。巡航 10 km 高时 300 km 外的笠云已在地平线附近的霾里，
 * 摆它还要多编一个云步进变体（CLOUD_LENTICULAR），不值
 */
const LENS_RANGE_KM = 300;
/**
 * 生消时间（模拟秒）：盘从山顶上空长出来 / 缩回去。荚状云随湿层与风的变化在几分钟到几十分钟里形成、消散 [估算]；
 * 用生消代替「借遮挡硬切」：它本来就是在人眼前慢慢长出来的，也不需要等变体（编好之前盘还很小）
 */
const LENS_GROW_SIM_S = 15 * 60;
const LENS_DECAY_SIM_S = 20 * 60;

/**
 * 海面 10 m 风速（m/s）：直接用 weather.ts 按周围海陆比例算好的地面风（z₀ 在海面 Charnock 与陆地 0.2 m 之间按陆地比例插值）。
 * 审查 D1：第一版在陆地 / 近岸格点上改用开阔海面的 Charnock 推导，骏河湾 1 月中位 13.8 m/s，偏高——
 * 近岸的海被陆地包着（风区短、背风），海陆比例插值后的值更接近窗外那片海的实际风
 */
function seaSurfaceWind(p: WindProfile) {
  return windSpeed(p.sfc);
}

interface LocalCell {
  id: string;
  x: number;
  z: number;
  radius: number;
  top: number;
}

export interface WeatherLogEntry {
  simTime: number;
  lat: number;
  lon: number;
  event: string;
  how?: string;
}

export interface WeatherTelemetry {
  /** 渐变推进时单步的最大变化（没有遮挡时的「台阶」）：云量、云顶（km） */
  maxCoverageStep: number;
  maxTopStep: number;
  /** 硬切次数（按遮挡种类） */
  hardSwitches: Record<string, number>;
  pushes: number;
}

const clamp = (v: number, a: number, b: number) => Math.min(Math.max(v, a), b);
/** 限速逼近：离目标越近越慢（最后 15% 的幅度里减到 30%），免得到点时「刹车」 */
function approach(cur: number, goal: number, rate: number, dt: number, span: number) {
  const d = goal - cur;
  if (d === 0) return cur;
  const r = rate * dt * (0.3 + 0.7 * clamp(Math.abs(d) / (span * 0.15), 0, 1));
  return Math.abs(d) <= r ? goal : cur + Math.sign(d) * r;
}

/** 从当前云层参数猜它属于哪个云型（开启连续航程时从面板的状态起步，不跳） */
function guessRegime(p: CloudParams): CloudRegime {
  if (p.coverage < 0.005) return "clear";
  if (p.bottom >= 10) return "cirrus";
  if (p.bottom >= 4) return "altocumulus";
  if (p.type >= 0.7) return p.top > 5 ? "towering" : "cumulus";
  return "stratocumulus";
}

export class WeatherDirector {
  readonly field = new WeatherField();
  /** 连续航程时是否由天气场驱动（关掉则连续航程只管航线与时间，天气保持面板所选） */
  enabled = true;
  /** 奇观之门演示开关：每 2 模拟小时在航线前方放一道云墙 */
  gateDemo = false;
  /** 最近一次取样 */
  target: WeatherSample | null = null;
  /** 当前显示的云型（族由 REGIME_FAMILY 定） */
  regime: CloudRegime = "clear";
  readonly log: WeatherLogEntry[] = [];
  readonly telemetry: WeatherTelemetry = { maxCoverageStep: 0, maxTopStep: 0, hardSwitches: {}, pushes: 0 };
  /** 海面风速（WX11g）：天气场给的目标（m/s，最近一次取样）；null = 还没取样 / 连续航程关着，面板滑条说了算 */
  seaWindGoal: number | null = null;
  /** 当前写进 state.wind 的海面风速（限速逼近 seaWindGoal） */
  private seaWind: number | null = null;

  private cur: CloudParams | null = null;
  private pushed: CloudParams | null = null;
  private lastSampleT = -Infinity;
  private candidate: { regime: CloudRegime; since: number } | null = null;
  /** 正在等遮挡 / 淡出的换族目标 */
  private switching: CloudRegime | null = null;
  private realTime = 0;
  private lastPushReal = -Infinity;
  private snapNext = false;
  private lastGateT = -Infinity;
  private gateCb: ((how: CoverKind | "forced") => void) | null = null;
  private lat = 0;
  private lon = 0;

  /** 笠云 / 吊し雲的目标强度（最近一次取样；0 / 1），每帧按生消时间逼近（stepLens） */
  private lensGoal = { cap: 0, chain: 0 };
  /**
   * 演示（URL ?fujiCap=1）：不看天气条件，只要在富士山附近就有笠云 + 吊し雲；页面打开后自动切到「骏河湾上空」预设
   * 与面板天气「富士山笠云（演示）」
   */
  readonly fujiDemo = typeof location !== "undefined" && /^(1|on|true)$/.test(new URLSearchParams(location.search).get("fujiCap") ?? "");

  constructor(
    private readonly d: Director,
    private readonly host: DirectorHost,
  ) {
    // 面板预设「富士山笠云（演示）」要把山顶换成本地坐标（WeatherSystem 自己没有坐标系）
    host.weather.toLocal = (lat, lon) => host.toLocal(lat, lon);
    if (this.fujiDemo && typeof document !== "undefined") {
      // 面板在导演之后才建（main.ts 的 setupUi）：等下拉框就位再切
      const go = (tries: number) => {
        const pre = document.getElementById("preset") as HTMLSelectElement | null;
        const wx = document.getElementById("weather") as HTMLSelectElement | null;
        if (!pre || !wx || !Array.from(wx.options).some((o) => o.value === "fuji-cap")) {
          if (tries < 100) setTimeout(() => go(tries + 1), 100);
          return;
        }
        pre.value = "fuji";
        pre.dispatchEvent(new Event("change"));
        wx.value = "fuji-cap";
        wx.dispatchEvent(new Event("change"));
      };
      setTimeout(() => go(0), 0);
    }
  }

  // ---------- 生命周期 ----------

  /** 用户跳变（换预设）：下一次取样直接对齐天气场；天气场摆放的雷暴 / 台风作废（本地坐标原点已换） */
  onJump() {
    this.cancelAll();
    const w = this.host.weather;
    w.removeStorms((s) => !!s.id && s.id !== "gate");
    if (w.hurricane?.id) w.setHurricane(null);
    // 笠云 / 吊し雲按新的时间 / 位置重新判（演示时保留面板摆好的那一组）
    if (w.lenticular && !this.fujiDemo) w.setLenticular(null);
    this.cur = null;
    this.lastSampleT = -Infinity;
    this.snapNext = true;
  }

  /** 关闭连续航程：撤掉排队的天气切换（已摆放的保持原样，面板手选天气照常有效） */
  stop() {
    this.cancelAll();
    this.cur = null;
    this.lastSampleT = -Infinity;
    this.seaWindGoal = this.seaWind = null;
  }

  private cancelAll() {
    for (const id of this.d.pendingIds) if (id === "cloud-regime" || id.startsWith("storm") || id.startsWith("typhoon")) this.d.cancel(id);
    this.switching = null;
    this.candidate = null;
  }

  // ---------- 每帧 ----------

  update(dtReal: number, simDt: number, lat: number, lon: number) {
    this.realTime += dtReal;
    this.lat = lat;
    this.lon = lon;
    if (!this.enabled) return;
    const t = this.host.state.simTime;
    // 起步 / 用户在面板上改了云：从当前参数接着走
    const now = this.host.cloudParams();
    if (!this.cur || (this.pushed && !sameParams(now, this.pushed))) {
      this.cur = { ...now };
      this.pushed = { ...now };
      this.regime = guessRegime(now);
    }
    if (t - this.lastSampleT >= SAMPLE_SIM_S * 1000 || t < this.lastSampleT) {
      this.lastSampleT = t;
      this.sampleField(lat, lon, t);
    }
    this.stepParams(simDt);
    this.stepSeaWind(simDt);
    this.stepLens(simDt);
    if (this.gateDemo && t - this.lastGateT > GATE_DEMO_EVERY_SIM_S * 1000 && !this.d.hasPending("wonder-gate")) {
      this.lastGateT = t;
      this.openGate({ onCover: (how) => this.note(`奇观之门（演示）：穿过云墙`, how) });
    }
  }

  private sampleField(lat: number, lon: number, t: number) {
    const land = this.host.landBelow();
    const s = this.field.sample(lat, lon, t, land ?? undefined);
    this.target = s;
    // 用户跳变（换预设）本身就是一次硬切：云型、雷暴、台风都直接对齐天气场，不再等遮挡（WX10：否则白天的台风几乎摆不出来，
    // 它的卷云盖半径约 300 km，整组落在视野外的条件在巡航中很难满足）
    const jump = this.snapNext;
    this.seaWindGoal = seaSurfaceWind(s.wind);
    if (jump) {
      this.snapNext = false;
      this.regime = s.regime;
      this.cur = pick(s);
      this.push(true);
      // 跳变本身就是硬切：海面风直接对齐（海面在 Worker 算好新档位之前停在旧海况上，最多几十毫秒）
      this.seaWind = this.host.state.wind = this.seaWindGoal;
      this.note(`对齐天气场：${REGIME_NAMES[s.regime]}，海面风 ${this.seaWindGoal.toFixed(1)} m/s`, "jump");
    } else this.planRegime(s, t);
    this.planStorms(lat, lon, t, jump);
    this.planTyphoon(lat, lon, t, jump);
    this.planLenticular(lat, lon, t, jump);
  }

  // ---------- 富士山笠云 / 吊し雲（SPEC-FUJI）----------

  /**
   * 按天气场的条件（WeatherField.orographic：山顶风速 / 风向 / 湿 / 稳定，出处见那里）定目标：有 → 盘长出来，没有 → 缩回去。
   * 一次过程（从长出到消失）里风向、形态固定（云「静止于山」）；消失后下一次过程重新取风向与随机形态。
   * jump（用户换预设 / 跳时间）时直接按目标强度摆好，不从 0 长
   */
  private planLenticular(lat: number, lon: number, t: number, jump: boolean) {
    const w = this.host.weather;
    const far = haversineKm(lat, lon, FUJI_SUMMIT.lat, FUJI_SUMMIT.lon) > LENS_RANGE_KM;
    if (far && !this.fujiDemo) {
      this.lensGoal = { cap: 0, chain: 0 };
      if (w.lenticular && jump) w.setLenticular(null);
      return;
    }
    const o = this.field.orographic(t);
    this.lensGoal = this.fujiDemo ? { cap: 1, chain: 1 } : { cap: o.cap > 0.5 ? 1 : 0, chain: o.chain > 0.5 ? 1 : 0 };
    if (w.lenticular || (!this.lensGoal.cap && !this.lensGoal.chain)) return;
    // 新的一次过程：风向取此刻山顶的风（演示时风太弱就按典型的西南西 20 m/s），形态随机数由时间哈希
    const cond = this.fujiDemo && o.speed < 15 ? { speed: 20, fromDeg: 247.5, wavelengthKm: mountainWavelengthKm(20) } : o;
    const seed = (Math.sin(t * 1e-5 + 0.123) * 43758.5453) % 1;
    const start = jump ? this.lensGoal : { cap: 0, chain: 0 };
    w.setLenticular(lenticularFrom(cond, this.host.toLocal(FUJI_SUMMIT.lat, FUJI_SUMMIT.lon), Math.abs(seed), start));
    const dir = Math.round(cond.fromDeg);
    this.note(`富士山${this.lensGoal.cap ? "笠云" : ""}${this.lensGoal.cap && this.lensGoal.chain ? " + " : ""}${this.lensGoal.chain ? "吊し雲" : ""}开始形成（山顶风 ${dir}° ${cond.speed.toFixed(0)} m/s）`, jump ? "jump" : undefined);
  }

  /** 笠云 / 吊し雲的生消：按模拟时间向目标逼近，两者都缩回 0 且目标为 0 时撤掉（下一次过程重新取风向） */
  private stepLens(simDt: number) {
    const w = this.host.weather;
    const l = w.lenticular;
    if (!l || simDt <= 0) return;
    const step = (cur: number, goal: number) => (goal > cur ? Math.min(goal, cur + simDt / LENS_GROW_SIM_S) : Math.max(goal, cur - simDt / LENS_DECAY_SIM_S));
    l.cap = step(l.cap, this.lensGoal.cap);
    l.chain = step(l.chain, this.lensGoal.chain);
    if (l.cap <= 0 && l.chain <= 0 && !this.lensGoal.cap && !this.lensGoal.chain) {
      w.setLenticular(null);
      this.note("富士山笠云 / 吊し雲消散");
    } else w.syncLens();
  }

  // ---------- 云型 ----------

  private planRegime(s: WeatherSample, t: number) {
    const curFam = REGIME_FAMILY[this.regime];
    const tgtFam = REGIME_FAMILY[s.regime];
    if (tgtFam === curFam || s.regime === "clear") {
      // 同族（或目标是晴空：淡出即可），不需要换族
      this.candidate = null;
      if (this.switching) {
        this.switching = null;
        this.d.cancel("cloud-regime");
        this.note(`取消换云型（目标回到 ${REGIME_NAMES[s.regime]}）`);
      }
      if (s.regime !== "clear") this.regime = s.regime; // 积云 ↔ 浓积云：同族，名称跟着目标走
      return;
    }
    // 当前没有云可见（晴空或已经淡没了）：直接换，新云型从 0 淡入
    if (curFam === "none" || this.cur!.coverage <= 0.001) {
      this.switchRegime(s, "clear-gap");
      return;
    }
    if (!this.candidate || REGIME_FAMILY[this.candidate.regime] !== tgtFam) this.candidate = { regime: s.regime, since: t };
    if (this.switching || t - this.candidate.since < REGIME_PERSIST_SIM_S * 1000) return;
    this.switching = s.regime;
    this.note(`准备换云型：${REGIME_NAMES[this.regime]} → ${REGIME_NAMES[s.regime]}（等穿云 / 深夜，同时淡出）`);
    this.d.request({
      id: "cloud-regime",
      covers: ["cloud", "night"],
      minCoverS: 0.8,
      // 当前云量淡到 0：窗外没有云可跳，直接换
      force: () => !!this.cur && this.cur.coverage <= 0.001,
      run: (how) => {
        const tgt = this.target && REGIME_FAMILY[this.target.regime] !== "none" ? this.target : s;
        this.switchRegime(tgt, how === "forced" ? "clear-gap" : how);
      },
    });
  }

  /** 换云族。how = 遮挡种类（直接切到目标云量）或 clear-gap（在云量 0 时切，再从 0 淡入） */
  private switchRegime(s: WeatherSample, how: CoverKind | "clear-gap") {
    const from = this.regime;
    this.switching = null;
    this.candidate = null;
    this.regime = s.regime;
    this.cur = { ...pick(s), coverage: how === "clear-gap" ? 0 : s.coverage };
    this.push(true);
    this.telemetry.hardSwitches[how] = (this.telemetry.hardSwitches[how] ?? 0) + 1;
    this.note(`换云型 ${REGIME_NAMES[from]} → ${REGIME_NAMES[s.regime]}`, how);
  }

  /** 连续项按限速逼近目标 */
  private stepParams(simDt: number) {
    const cur = this.cur!;
    const s = this.target;
    if (!s || simDt <= 0) return;
    // 换族：等遮挡期间淡出；目标族还没持续够久时原地保持（交界处来回摆动时不闪烁）；目标晴空：淡出
    const otherFamily = REGIME_FAMILY[s.regime] !== REGIME_FAMILY[this.regime];
    const goal: CloudParams = this.switching || s.regime === "clear" ? { ...cur, coverage: 0 } : otherFamily ? { ...cur } : pick(s);
    cur.coverage = approach(cur.coverage, goal.coverage, COVERAGE_RATE, simDt, 1);
    cur.top = approach(cur.top, goal.top, HEIGHT_RATE, simDt, 3);
    cur.bottom = approach(cur.bottom, goal.bottom, HEIGHT_RATE, simDt, 1);
    cur.type = approach(cur.type, goal.type, SHAPE_RATE, simDt, 1);
    cur.density = approach(cur.density, goal.density, SHAPE_RATE, simDt, 1);
    const p = this.pushed!;
    const moved = Math.abs(cur.coverage - p.coverage) > 0.002 || Math.abs(cur.top - p.top) > 0.01 || Math.abs(cur.bottom - p.bottom) > 0.01 || Math.abs(cur.type - p.type) > 0.004 || Math.abs(cur.density - p.density) > 0.004;
    const settled = !sameParams(cur, p) && sameParams(cur, goal);
    if ((moved || settled) && this.realTime - this.lastPushReal >= PUSH_MIN_REAL_S) this.push(false);
  }

  /**
   * 海面风（WX11g）：限速逼近天气场的地面风，写进 state.wind（main.ts 每帧交给海面与着色器的 uWind）。
   * 海面按风速档位混合两份预算好的频谱（ocean/waves.ts），风速连续变化不重算频谱，所以这里不量化、不借遮挡；
   * 用户拖了面板滑条（state.wind 被别人改了）就从新值接着走，下一次取样再慢慢拉回天气场
   */
  private stepSeaWind(simDt: number) {
    const st = this.host.state;
    if (this.seaWindGoal === null) return;
    if (this.seaWind === null || st.wind !== this.seaWind) this.seaWind = st.wind;
    if (simDt > 0) this.seaWind = approach(this.seaWind, this.seaWindGoal, SEA_WIND_RATE, simDt, 2);
    st.wind = this.seaWind;
  }

  private push(hard: boolean) {
    const cur = this.cur!;
    if (!hard && this.pushed) {
      this.telemetry.maxCoverageStep = Math.max(this.telemetry.maxCoverageStep, Math.abs(cur.coverage - this.pushed.coverage));
      this.telemetry.maxTopStep = Math.max(this.telemetry.maxTopStep, Math.abs(cur.top - this.pushed.top));
    }
    this.host.setCloudParams(cur, !hard);
    this.pushed = { ...cur };
    this.lastPushReal = this.realTime;
    this.telemetry.pushes++;
  }

  // ---------- 雷暴 ----------

  private planStorms(lat: number, lon: number, t: number, now = false) {
    const w = this.host.weather;
    const near = this.field.stormsNear(lat, lon, t, STORM_DROP_KM);
    const keep = new Set(near.map((s) => s.id));
    // 已摆放的：不在天气场里了（消散 / 走远）就排移除；面板预设留下的（没有 id）一并交给天气场接管
    const placedSystems = new Set<string>();
    for (const st of w.storms) {
      if (st.id === "gate") continue;
      const sys = st.id ? st.id.split("#")[0] : "manual";
      placedSystems.add(sys);
      if (!keep.has(sys)) this.requestStormRemoval(sys);
    }
    // TW01：已经飞过去（整组在机尾方向 PASSED_KM 以外）的系统不再占名额，看不见了就撤掉，把槽位让给前方 / 窗外的
    const [px, pz] = this.host.localPos();
    const [fx, fz] = this.fwd();
    for (const sys of placedSystems) {
      if (sys === "manual" || !keep.has(sys)) continue;
      const mine = w.storms.filter((s) => s.id?.split("#")[0] === sys);
      if (mine.length && mine.every((s) => (s.x - px) * fx + (s.z - pz) * fz < -PASSED_KM)) this.requestStormRemoval(sys);
    }
    // 新进入范围的：整组（系统）摆放，槽位不够就等。名额只有 WeatherSystem.MAX_STORMS 个单体，按「离视线近、看得见」排优先级（pickStormSystems）
    let free = WeatherSystem.MAX_STORMS - w.storms.length - this.pendingStormCells();
    // 预告（PERF-10）：雷暴变体还没编好就先不摆（同时触发后台编译），下一次规划再来
    if (free <= 0 || (this.host.weatherReady && !this.host.weatherReady("storm"))) return;
    const cands: StormCandidate[] = [];
    const byId = new Map<string, StormSystemSample>();
    for (const sys of near) {
      if (placedSystems.has(sys.id) || this.d.hasPending(`storm+${sys.id}`)) continue;
      if (haversineKm(lat, lon, sys.lat, sys.lon) > STORM_RANGE_KM) continue;
      const [x, z] = this.host.toLocal(sys.lat, sys.lon);
      cands.push({ id: sys.id, cells: sys.cells.length, x: x - px, z: z - pz });
      byId.set(sys.id, sys);
    }
    for (const id of pickStormSystems(cands, free, [fx, fz], this.host.state.seat === "right" ? 1 : -1)) this.requestStormPlacement(byId.get(id)!, now);
  }

  private pendingStormCells() {
    return this.d.pendingIds.filter((id) => id.startsWith("storm+")).reduce((n, id) => n + (this.pendingCells.get(id) ?? 0), 0);
  }
  private readonly pendingCells = new Map<string, number>();

  private requestStormPlacement(sys: StormSystemSample, now = false) {
    const id = `storm+${sys.id}`;
    this.pendingCells.set(id, sys.cells.length);
    // 强度随生命周期：成熟期的单体更大更高
    const cellsGeo = sys.cells.map((c) => ({ ...c, radius: c.radius * (0.75 + 0.25 * sys.strength), top: c.top - 1.2 * (1 - sys.strength) }));
    const placement = () => this.nudgeOffTrack(this.composeForWindow(cellsGeo.map((c) => this.toLocalCell(c))), (c) => stormPassKm(c.radius));
    this.submit(now, {
      id,
      covers: ["cloud", "night"],
      minCoverS: 0.5,
      force: () => this.outOfView(placement().map((c) => ({ x: c.x, z: c.z, r: c.radius * 2.5 }))),
      run: (how) => {
        this.pendingCells.delete(id);
        const w = this.host.weather;
        const cells = placement();
        if (w.storms.length + cells.length > WeatherSystem.MAX_STORMS) return;
        for (const c of cells) w.addStorm(c);
        const dist = Math.round(haversineKm(this.lat, this.lon, sys.lat, sys.lon));
        const kind = { isolated: "孤立雷暴", cluster: "雷暴群", squall: "飑线" }[sys.kind];
        this.note(`生成${kind}（${cells.length} 个单体，距 ${dist} km）`, how === "forced" ? (this.jumpRun ? "jump" : "out-of-view") : how);
      },
    });
  }

  private requestStormRemoval(sys: string) {
    const id = `storm-${sys}`;
    if (this.d.hasPending(id)) return;
    const mine = () => this.host.weather.storms.filter((s) => (sys === "manual" ? !s.id : s.id?.split("#")[0] === sys));
    this.d.request({
      id,
      covers: ["cloud", "night"],
      minCoverS: 0.5,
      force: () => this.outOfView(mine().map((c) => ({ x: c.x, z: c.z, r: c.radius * 2.5 }))),
      run: (how) => {
        const n = mine().length;
        this.host.weather.removeStorms((s) => (sys === "manual" ? !s.id : s.id?.split("#")[0] === sys));
        if (n) this.note(`移除雷暴 ${sys}（${n} 个单体）`, how === "forced" ? "out-of-view" : how);
      },
    });
  }

  // ---------- 台风 ----------

  private planTyphoon(lat: number, lon: number, t: number, now = false) {
    const w = this.host.weather;
    const ty = this.field.typhoonNear(lat, lon, t, TY_DROP_KM);
    const h = w.hurricane;
    if (h && (!h.id || !ty || ty.id !== h.id)) {
      if (!this.d.hasPending("typhoon-")) {
        const r = h.eye * 16;
        this.d.request({
          id: "typhoon-",
          covers: ["cloud", "night"],
          minCoverS: 0.8,
          force: () => !!this.host.weather.hurricane && this.outOfView([{ x: this.host.weather.hurricane.x, z: this.host.weather.hurricane.z, r }]),
          run: (how) => {
            this.host.weather.setHurricane(null);
            this.note(`移除台风 ${h.id ?? "（面板预设）"}`, how === "forced" ? "out-of-view" : how);
          },
        });
      }
      return;
    }
    if (h || !ty || haversineKm(lat, lon, ty.lat, ty.lon) > TY_RANGE_KM || this.d.hasPending("typhoon+")) return;
    // 预告（PERF-10）：台风变体还没编好就先不摆（同时触发后台编译）。WX10：jump 时也要过这道门，否则会摆出画不出来的台风
    if (this.host.weatherReady && !this.host.weatherReady("typhoon")) return;
    this.requestTyphoon(ty, now);
  }

  private requestTyphoon(ty: TyphoonSample, now = false) {
    const placement = () => this.nudgeOffTrack([this.toLocalCell({ id: ty.id, lat: ty.lat, lon: ty.lon, radius: ty.eye, top: 0 })], () => TY_PASS_KM)[0];
    this.submit(now, {
      id: "typhoon+",
      covers: ["cloud", "night"],
      minCoverS: 0.8,
      force: () => {
        const p = placement();
        return this.outOfView([{ x: p.x, z: p.z, r: ty.eye * 16 }]);
      },
      run: (how) => {
        if (this.host.weather.hurricane) return;
        const p = placement();
        this.host.weather.setHurricane({ id: ty.id, x: p.x, z: p.z, eye: ty.eye });
        const [px, pz] = this.host.localPos();
        this.note(`生成台风 ${ty.id}（中心距 ${Math.round(Math.hypot(p.x - px, p.z - pz))} km）`, how === "forced" ? (this.jumpRun ? "jump" : "out-of-view") : how);
      },
    });
  }

  /** 排一个切换请求；now = true（用户跳变之后）时立即执行，日志记作 jump */
  private jumpRun = false;
  private submit(now: boolean, req: SwitchRequest) {
    if (!now) return this.d.request(req);
    this.jumpRun = true;
    try {
      req.run("forced");
    } finally {
      this.jumpRun = false;
    }
  }

  // ---------- 奇观之门（W01 挂钩） ----------

  /**
   * 在航线前方 aheadKm 处放一道安静的云墙（不打闪电的积雨云单体，半径 9 km），飞机穿进去、窗外全白持续 0.4 s 时
   * 移除云墙并调用 onCover("cloud")——奇观系统在这一刻切换奇观开关。航线转弯错过了云墙时（飞过去 15 km 仍没穿云），
   * 以 "forced" 调用，由调用方决定要不要硬切。槽位满时挤掉一个看不见的天气场雷暴；挤不出来返回 false。
   */
  openGate(opts: { aheadKm?: number; onCover?: (how: CoverKind | "forced") => void } = {}) {
    const w = this.host.weather;
    if (this.d.hasPending("wonder-gate")) return false;
    if (w.storms.length >= WeatherSystem.MAX_STORMS) {
      const victim = w.storms.find((s) => s.id && s.id !== "gate" && this.outOfView([{ x: s.x, z: s.z, r: s.radius * 2.5 }]));
      if (!victim) return false;
      w.removeStorms((s) => s === victim);
    }
    const ahead = opts.aheadKm ?? 120;
    const [px, pz] = this.host.localPos();
    const [fx, fz] = this.fwd();
    const gx = px + fx * ahead, gz = pz + fz * ahead;
    w.addStorm({ id: "gate", x: gx, z: gz, radius: 9, top: 12.5, quiet: true });
    this.gateCb = opts.onCover ?? null;
    this.note(`奇观之门：前方 ${ahead} km 放云墙`);
    this.d.request({
      id: "wonder-gate",
      covers: ["cloud"],
      minCoverS: 0.4,
      force: () => {
        const g = this.host.weather.storms.find((s) => s.id === "gate");
        if (!g) return true;
        const [x, z] = this.host.localPos();
        const [ax, az] = this.fwd();
        return (g.x - x) * ax + (g.z - z) * az < -15; // 已经飞过去了
      },
      run: (how) => {
        this.host.weather.removeStorms((s) => s.id === "gate");
        this.note(`奇观之门：${how === "forced" ? "错过云墙（未穿云）" : "穿过云墙"}`, how);
        this.gateCb?.(how);
        this.gateCb = null;
      },
    });
    return true;
  }

  // ---------- 几何 ----------

  /** 机头方向（本地坐标，x 东 z 南） */
  private fwd(): [number, number] {
    const h = (this.host.state.heading * Math.PI) / 180;
    return [Math.sin(h), -Math.cos(h)];
  }
  /** 窗外方向（右座朝右、左座朝左） */
  private outward(): [number, number] {
    const h = (this.host.state.heading * Math.PI) / 180;
    const s = this.host.state.seat === "right" ? 1 : -1;
    return [Math.cos(h) * s, Math.sin(h) * s];
  }

  private toLocalCell(c: { id: string; lat: number; lon: number; radius: number; top: number }): LocalCell {
    const [x, z] = this.host.toLocal(c.lat, c.lon);
    return { id: c.id, x, z, radius: c.radius, top: c.top };
  }

  /**
   * 构图（导演的取舍）：机头前方、离航线 ±COMPOSE_CROSS_KM 以内的雷暴系统，整组横移到窗外这一侧 40–90 km（原来越远、挪过去也越远），
   * 让「远远路过雷暴区」真的从窗前经过；不在这个范围的保持天气场给的位置。只在摆放那一刻算（摆放时它在视野外），摆好后不再动。
   * 天气场本来就是示意性的气候倾向，位置差一两百公里不影响「哪里有雷暴」的倾向
   */
  private composeForWindow(cells: LocalCell[]): LocalCell[] {
    const [px, pz] = this.host.localPos();
    const [fx, fz] = this.fwd();
    const rx = -fz, rz = fx;
    const cx = cells.reduce((a, c) => a + c.x, 0) / cells.length - px;
    const cz = cells.reduce((a, c) => a + c.z, 0) / cells.length - pz;
    const along = cx * fx + cz * fz;
    const cross = cx * rx + cz * rz;
    if (along < COMPOSE_AHEAD_KM || Math.abs(cross) > COMPOSE_CROSS_KM) return cells;
    const side = this.host.state.seat === "right" ? 1 : -1;
    const shift = side * (40 + (50 * Math.abs(cross)) / COMPOSE_CROSS_KM) - cross;
    return cells.map((c) => ({ ...c, x: c.x + rx * shift, z: c.z + rz * shift }));
  }

  /** 整组横移到航线一侧：机头前方（或刚到正侧方）的单体离航线（沿当前航向的直线）不够 pass(c) 就整组推开 */
  private nudgeOffTrack(cells: LocalCell[], pass: (c: LocalCell) => number): LocalCell[] {
    const [px, pz] = this.host.localPos();
    const [fx, fz] = this.fwd();
    const rx = -fz, rz = fx; // 机头右侧
    const rel = cells.map((c) => ({ along: (c.x - px) * fx + (c.z - pz) * fz, cross: (c.x - px) * rx + (c.z - pz) * rz, need: pass(c) }));
    const ahead = rel.filter((r) => r.along > -30);
    if (!ahead.length) return cells;
    const mean = ahead.reduce((a, r) => a + r.cross, 0) / ahead.length;
    // 往哪边推：组中心在哪边就推向哪边（正好压线时按 id 的哈希定边，同一组每次都一样）
    const side = Math.abs(mean) > 1e-3 ? Math.sign(mean) : cells[0].id.length % 2 ? 1 : -1;
    const shift = Math.max(0, ...ahead.map((r) => r.need - side * r.cross));
    if (shift <= 0) return cells;
    return cells.map((c) => ({ ...c, x: c.x + rx * side * shift, z: c.z + rz * side * shift }));
  }

  /** 这些圆盘（本地坐标 + 视半径 r）是不是都在窗外视野以外：在机头前方 / 机尾后方的扇区里，或远到看不见 */
  private outOfView(disks: { x: number; z: number; r: number }[]) {
    if (!disks.length) return true;
    const [px, pz] = this.host.localPos();
    const [ox, oz] = this.outward();
    for (const d of disks) {
      const dx = d.x - px, dz = d.z - pz;
      const dist = Math.hypot(dx, dz);
      if (dist - d.r > OUT_OF_VIEW_FAR_KM) continue;
      if (dist < d.r + 8) return false;
      const ang = (Math.acos(clamp((dx * ox + dz * oz) / dist, -1, 1)) * 180) / Math.PI;
      const margin = (Math.asin(Math.min(1, d.r / dist)) * 180) / Math.PI;
      if (ang - margin < OUT_OF_VIEW_DEG) return false;
    }
    return true;
  }

  // ---------- 记录 ----------

  private note(event: string, how?: string) {
    this.log.push({ simTime: this.host.state.simTime, lat: +this.lat.toFixed(3), lon: +this.lon.toFixed(3), event, how });
    if (this.log.length > 400) this.log.shift();
  }

  /** 面板信息栏的一行 */
  describe(): string {
    if (!this.enabled || !this.cur) return "天气：面板手选";
    const w = this.host.weather;
    const [px, pz] = this.host.localPos();
    const storms = w.storms.filter((s) => s.id !== "gate");
    const nearest = storms.length ? Math.round(Math.min(...storms.map((s) => Math.hypot(s.x - px, s.z - pz)))) : 0;
    let out = `天气：${REGIME_NAMES[this.regime]} ${Math.round(this.cur.coverage * 100)}%`;
    if (this.switching) out += ` → ${REGIME_NAMES[this.switching]}`;
    if (storms.length) out += `，雷暴 ${storms.length} 个（最近 ${nearest} km）`;
    if (w.hurricane) out += `，台风（中心 ${Math.round(Math.hypot(w.hurricane.x - px, w.hurricane.z - pz))} km）`;
    if (this.seaWind !== null) out += `，海面风 ${this.seaWind.toFixed(1)} m/s`;
    return out;
  }
}

function pick(s: CloudParams): CloudParams {
  return { bottom: s.bottom, top: s.top, coverage: s.coverage, type: s.type, density: s.density };
}
function sameParams(a: CloudParams, b: CloudParams) {
  return Math.abs(a.bottom - b.bottom) < 1e-6 && Math.abs(a.top - b.top) < 1e-6 && Math.abs(a.coverage - b.coverage) < 1e-6 && Math.abs(a.type - b.type) < 1e-6 && Math.abs(a.density - b.density) < 1e-6;
}
