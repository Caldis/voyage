import * as THREE from "three";
import type { Clouds } from "./clouds/clouds";

/**
 * PERF-5：画质档位与「自动」档。
 *
 * 背景（见 `research/PERF_REPORT_wave3.md` §2.3）：面板「画质」原来只缩放云步进的分辨率（1 / 0.75 / 0.5），
 * 默认「高」= 云全分辨率；1.5 倍屏（实际绘制 2400×1800）上台风场景曾到 17 ms，掉出 60 fps；用户的 Mac
 * 显卡也弱得多。这里加「自动」档并设为默认：按最近若干帧的 GPU 时间（有 `EXT_disjoint_timer_query_webgl2`
 * 就用它）或帧间隔（没有该扩展时的兜底）自适应升降云分辨率、必要时再降 `setPixelRatio` 的上限，目标帧预算
 * 按侦测到的显示器刷新周期动态换算，带滞回避免来回跳。
 *
 * 手动三档（高 / 中 / 低）行为与改动前完全一致：只缩放云步进分辨率，DPR 上限固定 1.5。自动档额外多一档
 * 「最低」（云步进再降到 0.5 分辨率 + DPR 上限降到 1.0），手动选不到，只有自动档在前三档都不够用时才会伸到这里。
 */

export type QualityTier = "auto" | "high" | "medium" | "low";
export type QualityLevel = "high" | "medium" | "low" | "min";

interface LevelProfile {
  level: QualityLevel;
  label: string;
  /** 云步进相对全屏的分辨率比例，见 clouds.ts 的 resolutionScale */
  cloudScale: number;
  /** setPixelRatio 的上限 */
  dprCap: number;
}

/** 由「贵」到「省」排列；手动档只能选前三个，自动档可以一直降到最后一个 */
const LEVELS: LevelProfile[] = [
  { level: "high", label: "高", cloudScale: 1, dprCap: 1.5 },
  { level: "medium", label: "中", cloudScale: 0.75, dprCap: 1.5 },
  { level: "low", label: "低", cloudScale: 0.5, dprCap: 1.5 },
  { level: "min", label: "最低", cloudScale: 0.5, dprCap: 1.0 },
];

/** 手动三档在 LEVELS 里的下标 */
const MANUAL_INDEX: Record<Exclude<QualityTier, "auto">, number> = { high: 0, medium: 1, low: 2 };

/** main.ts 里初始 `renderer.setPixelRatio` 用它做种子（等于 LEVELS[0].dprCap，单一出处） */
export const DEFAULT_DPR_CAP = LEVELS[0].dprCap;

/** 天气预设里公认的重负载场景（雷暴 / 飑线 / 台风三个视角），对应 weather.ts 的 WEATHER_PRESETS id，
 * 数字见 PERF_REPORT_wave3 §2.3 的云步进耗时表（storm-day、typhoon-bands 等） */
const HEAVY_WEATHER_IDS = new Set(["storm", "squall", "typhoon-bands", "typhoon-eye", "typhoon-outer"]);
export const isHeavyWeather = (weatherId: string) => HEAVY_WEATHER_IDS.has(weatherId);

// ---------- G07：地面纹理精度（启动时定一次，运行时不随自动档切换） ----------

/**
 * 地面 clipmap 影像 / 水体纹理的边长（G06 的 2048² 或此前的 1024²，两档都带 mip + 16× 各向异性）。
 *
 * 为什么只能启动时定：它同时是纹理的不可变尺寸（texStorage3D，两张 7 层）、着色器常量（ground.glsl.ts 的 GROUND_RES，
 * 参与选级 / 纹素换算 / 道路 / 火车远景）和瓦片缩放级的依据；换一次要重新分配 2 × 150 MB、重编窗外程序、重下全部瓦片，
 * 几十秒的模糊。PERF-5 的自动档会在大雨 / 台风时降档、雨停后升档，跟着它切就是整套反复重建，所以这里只在模块加载时判一次，
 * 结果冻结成常量：着色器文本在同一台机器上恒定（2048 档与 G06 逐字一致，离线 FXC 不变），运行时任何调档都不会触发重编。
 *
 * G07b：地面精度与画质档**解耦**。G07 曾让面板手动画质档跨载入记忆、并由它决定地面精度（「高」→ 2048、「中 / 低」→ 1024），
 * 结果是为了看云选过一次「中」，之后每次载入地面都掉到 1024²；Safari（渲染器恒为「Apple GPU」、自动判 1024）想要 2048 只能选「高」，
 * 代价是云固定全分辨率、失去 PERF-5 的自动降档（G07 审查 M2）。现在：画质档恢复 PERF-5 的「每次载入从自动起步」、不记忆；
 * 地面精度是面板上单独一项「地面精度：自动 / 2048² / 1024²」，只有这一项的手动选择跨载入记忆（localStorage `voyage.groundRes`），
 * 改了之后状态行提示「下次载入生效」（这次不变）。
 *
 * 判定顺序（第一条命中即定）：
 * 1. 不在浏览器里（node 离线工具：shader-budget / check:glsl / shader-parity）→ 2048（与 G06 的着色器文本一致）；
 * 2. URL `?groundres=1024|2048`（调试 / 对照，压过面板选项）；
 * 3. 面板「地面精度」手动选过 2048 / 1024（localStorage `voyage.groundRes`）；选「自动」或没选过 → 4；
 * 4. 按 GPU 自动：开一个临时 WebGL2 上下文（`powerPreference: "high-performance"`，与主渲染器一致，双显卡 Mac 不会拿到核显）
 *    读渲染器字符串（WEBGL_debug_renderer_info）与 MAX_TEXTURE_SIZE，读完立即释放（finally 里，读参数抛异常也释放）。
 *    - 软件渲染（SwiftShader / llvmpipe / Microsoft Basic Render）、MAX_TEXTURE_SIZE < 8192、上下文开不出来 → 1024；
 *    - 显存 WebGL 读不到，用 `navigator.deviceMemory`（Chrome 有，上限报 8）粗估：< 8 GB 多半是集显 / 低端机 → 1024；
 *    - 渲染器是高性能独显 → 2048（规则见 isHighEndGpu）；
 *    - 其他（Intel UHD / Iris / Xe 集显、AMD 「Radeon Graphics」/ Vega APU、Apple M 基础款、Safari 隐藏型号的「Apple GPU」、
 *      移动端 Mali / Adreno、认不出的字符串）→ 1024。宁可保守：1024 档 = G06 之前的清晰度 + mip + 各向异性，不会比 G06 之前差。
 * PERF-5 的自动档没有「启动时初判」（一律从「高」起步、再按 GPU 计时升降），所以这里不能借它的结果，只能自己按 GPU 判。
 */
export interface GroundResDecision {
  res: 1024 | 2048;
  /** 依据（面板 / 调试显示） */
  reason: string;
  /** 探测到的渲染器字符串（没探测时为空） */
  renderer: string;
  /** 探测临时上下文花的时间（毫秒） */
  probeMs: number;
}

/** 面板「地面精度」的选项：自动（按 GPU）或手动固定一档 */
export type GroundResPref = "auto" | "2048" | "1024";

/** G07b：只记「地面精度」这一项（画质档不记，见上）。G07 时用过的 `voyage.quality` 载入时顺手清掉，免得留着误导排查 */
const GROUND_RES_STORAGE_KEY = "voyage.groundRes";
const LEGACY_QUALITY_STORAGE_KEY = "voyage.quality";

function storedGroundPref(): GroundResPref {
  try {
    const v = globalThis.localStorage?.getItem(GROUND_RES_STORAGE_KEY);
    return v === "2048" || v === "1024" ? v : "auto";
  } catch {
    return "auto";
  }
}

function storeGroundPref(pref: GroundResPref) {
  try {
    if (pref === "auto") globalThis.localStorage?.removeItem(GROUND_RES_STORAGE_KEY);
    else globalThis.localStorage?.setItem(GROUND_RES_STORAGE_KEY, pref);
  } catch {
    // 隐私模式等拿不到 localStorage：不记，下次载入按 GPU 判
  }
}

function clearLegacyQualityStorage() {
  try {
    globalThis.localStorage?.removeItem(LEGACY_QUALITY_STORAGE_KEY);
  } catch {
    // 拿不到 localStorage 就算了
  }
}

/**
 * 渲染器字符串 → 是不是高性能独显（→ 2048）。自检：`handoff/G07-gpu-rules.mts`。
 * - NVIDIA：RTX（含 Quadro RTX / RTX A）、GTX 16 系、GTX 1060–1080、GTX 970 / 980 / 980 Ti（Maxwell 高端，性能约等于 1060–1070）、
 *   Quadro T 系（T1000 起，约等于 GTX 1650）、Quadro P3200 起（P4000 / P5000 / P6000）；
 *   除外：GeForce GT / MX、GTX 6 / 7 系、GTX 950 / 960、GTX 1010–1050、Quadro K / M、Quadro P400–P2200、不带 Quadro 的「NVIDIA T600」这类入门卡。
 * - AMD：Radeon RX / Radeon Pro；除外：Vega APU（「Radeon RX Vega 8 Graphics」名字里也带 RX）、Polaris 入门的 RX 460 / 550 / 560、
 *   Radeon Pro 450 / 455 / 460 / 555(X) / 560(X)（2016–2018 款 MacBook Pro 的移动版；iMac 的 Pro 570 / 575 / 580 约等于 RX 570 / 580，放行）。
 * - Intel：Arc A5 / A7 / B 系独显；除外 A3 系（A310 / A350M / A370M / A380，入门）与不带型号的「Arc Graphics」（Meteor Lake 核显）。
 * - Apple：M Pro / Max / Ultra（统一内存大、GPU 核多）；M 基础款与 Safari 的「Apple GPU」→ 1024。
 */
export function isHighEndGpu(renderer: string): boolean {
  const r = renderer.toLowerCase();
  if (/swiftshader|llvmpipe|softpipe|basic render/.test(r)) return false;
  if (/nvidia|geforce|quadro|rtx/.test(r)) {
    if (/geforce\s*(gt|mx)\s*\d|gtx\s*(6|7)\d\d\b|gtx\s*9[56]0\b|gtx\s*10[1-5]0\b|quadro\s*[km]\d|quadro\s*p([1-9]\d{2}|1\d{3}|2\d{3})\b/.test(r))
      return false;
    return /rtx|gtx\s*16\d\d|gtx\s*10[6-8]0|gtx\s*9[78]0|quadro/.test(r);
  }
  // 「Radeon RX Vega 3 / 8 / 11 Graphics」是 APU 集显，名字里也带 RX
  if (/vega\s*\d+\s*graphics/.test(r)) return false;
  if (/radeon\s*(\(tm\)\s*)?(rx\s*(4[56]0|5[56]0)|pro\s*(4[56][05]|5[56][05]))x?\b/.test(r)) return false;
  if (/radeon\s*(\(tm\)\s*)?(rx|pro)\b/.test(r)) return true;
  if (/arc\s*(\(tm\)\s*)?a3\d{2}/.test(r)) return false;
  if (/arc\s*(\(tm\)\s*)?[ab]\d{3}/.test(r)) return true;
  if (/apple\s*m\d+\s*(pro|max|ultra)/.test(r)) return true;
  return false;
}

/** URL `?groundres=`（调试 / 对照，压过面板选项）；没带或值不对时为 null */
function urlGroundRes(): 1024 | 2048 | null {
  const q = new URLSearchParams(globalThis.location?.search ?? "").get("groundres");
  return q === "1024" || q === "2048" ? (Number(q) as 1024 | 2048) : null;
}

function decideGroundRes(): GroundResDecision {
  if (typeof document === "undefined") return { res: 2048, reason: "离线工具（默认 2048）", renderer: "", probeMs: 0 };
  clearLegacyQualityStorage();
  const q = urlGroundRes();
  if (q) return { res: q, reason: `URL ?groundres=${q}`, renderer: "", probeMs: 0 };
  const pref = storedGroundPref();
  if (pref !== "auto") return { res: Number(pref) as 1024 | 2048, reason: "面板手动选", renderer: "", probeMs: 0 };
  return autoGroundRes();
}

let autoCache: GroundResDecision | null = null;
/** 按 GPU 自动判（规则 4）；结果缓存，面板提示「下次载入」时复用，不重复开临时上下文 */
function autoGroundRes(): GroundResDecision {
  if (autoCache) return autoCache;
  const t0 = performance.now();
  let renderer = "";
  let maxTex = 0;
  let gl: WebGL2RenderingContext | null = null;
  try {
    // 与主渲染器（main.ts）同一个 powerPreference：双显卡 Mac 上默认值会拿到 Intel 核显、误判 1024
    gl = document.createElement("canvas").getContext("webgl2", { powerPreference: "high-performance" });
    if (gl) {
      const generic = gl.getParameter(gl.RENDERER) as string;
      const ext = /webkit webgl/i.test(generic) ? gl.getExtension("WEBGL_debug_renderer_info") : null;
      renderer = ext ? (gl.getParameter(ext.UNMASKED_RENDERER_WEBGL) as string) : generic;
      maxTex = gl.getParameter(gl.MAX_TEXTURE_SIZE) as number;
    }
  } catch {
    // 探测失败按保守处理
  } finally {
    // 读参数中途抛异常也要释放（WebGL 上下文数按页面有上限）
    try {
      gl?.getExtension("WEBGL_lose_context")?.loseContext();
    } catch {
      // 释放失败只能交给 GC
    }
  }
  const probeMs = performance.now() - t0;
  const mem = (navigator as Navigator & { deviceMemory?: number }).deviceMemory;
  const done = (res: 1024 | 2048, reason: string): GroundResDecision => ({ res, reason: `自动：${reason}`, renderer, probeMs });
  autoCache = !renderer
    ? done(1024, "GPU 探测失败")
    : maxTex < 8192
      ? done(1024, `MAX_TEXTURE_SIZE ${maxTex}`)
      : mem !== undefined && mem < 8
        ? done(1024, `内存约 ${mem} GB`)
        : isHighEndGpu(renderer)
          ? done(2048, "高性能独显")
          : done(1024, "集显 / 入门 GPU / 未识别");
  return autoCache;
}

/** 本次载入的地面纹理精度（模块加载时定，之后不变；clipmap.ts 的 GROUND_RES 取自这里） */
export const GROUND_RES_DECISION: GroundResDecision = decideGroundRes();

/** 面板「地面精度」的当前选项（载入时从 localStorage 读，改了之后跟着变） */
let groundPrefValue: GroundResPref = typeof document === "undefined" ? "auto" : storedGroundPref();

/** 面板「地面精度」当前选项 */
export function groundResPref(): GroundResPref {
  return groundPrefValue;
}

/** 面板改「地面精度」：记下来，下次载入生效（这次的 GROUND_RES_DECISION 不变） */
export function setGroundResPref(pref: GroundResPref) {
  groundPrefValue = pref;
  storeGroundPref(pref);
}

/** 按当前面板选项，下次载入会用多大的地面纹理（URL ?groundres= 仍然压过面板） */
function nextGroundRes(): 1024 | 2048 {
  if (typeof document === "undefined") return 2048;
  const q = urlGroundRes();
  if (q) return q;
  return groundPrefValue === "auto" ? autoGroundRes().res : (Number(groundPrefValue) as 1024 | 2048);
}

/** 面板「地面精度」下方的状态行：本次精度与依据；改了选项、下次载入会换精度时提示 */
export function describeGroundRes(): string {
  const d = GROUND_RES_DECISION;
  const cur = `本次 ${d.res}²（${d.reason}）`;
  const next = nextGroundRes();
  if (next !== d.res) return `${cur}，下次载入改为 ${next}²`;
  if (urlGroundRes()) return `${cur}；URL 参数优先，面板选项下次载入也不生效`;
  return cur;
}

// ---------- GPU 计时：EXT_disjoint_timer_query_webgl2，非阻塞轮询 ----------

/** 扩展没有内置类型声明（非标准 WebGL 扩展），这里只声明用到的两个常量 */
interface TimerQueryExt {
  TIME_ELAPSED_EXT: number;
  GPU_DISJOINT_EXT: number;
}

/**
 * 一帧一个 query，池子里轮流用：结果通常要等 1~3 帧才就绪，同一帧读不到刚提交的查询。
 * 没有该扩展时 `available` 为 false，所有方法都是空操作——调用方不用关心有没有扩展。
 */
class GpuTimer {
  private readonly gl: WebGL2RenderingContext;
  private readonly ext: TimerQueryExt | null;
  private readonly free: WebGLQuery[] = [];
  private pending: WebGLQuery[] = [];
  private active: WebGLQuery | null = null;

  constructor(renderer: THREE.WebGLRenderer, poolSize = 8) {
    this.gl = renderer.getContext() as WebGL2RenderingContext;
    this.ext = (this.gl.getExtension("EXT_disjoint_timer_query_webgl2") as TimerQueryExt | null) ?? null;
    if (this.ext) {
      for (let i = 0; i < poolSize; i++) {
        const q = this.gl.createQuery();
        if (q) this.free.push(q);
      }
    }
  }

  get available() {
    return this.ext !== null;
  }

  begin() {
    if (!this.ext) return;
    const q = this.free.pop();
    if (!q) return; // 池子暂时用完（还有帧没轮到结果）：这一帧不测，下一帧再试，不阻塞、不报错
    this.gl.beginQuery(this.ext.TIME_ELAPSED_EXT, q);
    this.active = q;
  }

  end() {
    if (!this.ext || !this.active) return;
    this.gl.endQuery(this.ext.TIME_ELAPSED_EXT);
    this.pending.push(this.active);
    this.active = null;
  }

  /** 非阻塞地收集这一帧已经就绪的历史查询结果（毫秒），可能一帧收到 0～多个。
   * GPU_DISJOINT_EXT 一旦为真，说明期间发生过与本次测量无关的 GPU 中断（例如切换电源模式），这批结果整体作废。 */
  poll(): number[] {
    if (!this.ext) return [];
    const disjoint = this.gl.getParameter(this.ext.GPU_DISJOINT_EXT) as boolean;
    const out: number[] = [];
    const stillPending: WebGLQuery[] = [];
    for (const q of this.pending) {
      if (this.gl.getQueryParameter(q, this.gl.QUERY_RESULT_AVAILABLE)) {
        if (!disjoint) out.push(Number(this.gl.getQueryParameter(q, this.gl.QUERY_RESULT)) / 1e6);
        this.free.push(q);
      } else {
        stillPending.push(q);
      }
    }
    this.pending = stillPending;
    return out;
  }
}

// ---------- 判档的时间常数 ----------

const TARGET_FRACTION = 0.7; // 60 fps 的 70%
/** 有 GPU 计时：预算固定按 60 fps × 70% 算（≈11.7 ms），**不**按侦测到的刷新率换算——
 * 踩过的坑：曾经用「挂钟帧间隔的滑动最小值」估刷新周期当分母，无头浏览器（乃至任何没有真正 vsync 节流、
 * rAF 跑多快算多快的环境）里这个估计会一路收敛到「GPU 空闲时能跑多快」本身（观测到 6 ms 量级，
 * 换算出来的预算不到 GPU 实际开销的一半），导致画质在完全不重的场景下也被误判过载、一路砸到「最低」再也
 * 升不回来。GPU 计时本身已经是与显示器无关的绝对硬件耗时，不需要再靠一个不可靠的挂钟信号去换算预算；
 * 高刷新率屏幕上这个固定预算偏保守（allow 稍多），但不会像「按检测刷新率算」那样在异常环境里直接失灵。 */
const GPU_BUDGET_MS = (1000 / 60) * TARGET_FRACTION;
const DOWNGRADE_RATIO = 1.0; // 实测耗时 / 预算 超过这个比例才算过载
const UPGRADE_RATIO = 0.55; // 低于这个比例、且持续够久，才考虑升档（比降档门槛更松，形成滞回，防抖）
const FALLBACK_OVERRUN = 1.15; // 没有 GPU 计时：帧间隔超过一次刷新周期的 15% 才判定过载（只能反应式抓「已经掉帧」）
const DOWNGRADE_HOLD_MS = 700; // 过载要持续这么久才真正降档，滤掉单帧尖峰
const UPGRADE_HOLD_MS = 3000; // 升档比降档保守得多
const CHANGE_COOLDOWN_MS = 1500; // 任意两次调档之间的最短间隔（探测式回退例外，见 decideByFrameInterval）
const PROBE_WINDOW_MS = 3000; // 无 GPU 计时时，探测式升档后的观察期
const PROBE_BACKOFF_MIN_MS = 4000;
const PROBE_BACKOFF_MAX_MS = 60000;
const COST_EMA_ALPHA = 0.15;

export interface QualityControllerDeps {
  renderer: THREE.WebGLRenderer;
  clouds: Clouds;
  /** main.ts 的 resize()：按当前 renderer / pixelRatio 尺寸重建所有渲染目标（含 clouds.setSize，
   *  它已经会在分辨率变化时把云的时间累积标记为 reset，不需要这里再额外处理重投影） */
  resize: () => void;
}

export class QualityController {
  private tierValue: QualityTier = "auto";
  private levelIndex = 0;
  private vsyncEstimate = 1000 / 60;
  private vsyncSeen = 0;
  private costEma: number | null = null;
  private overSince: number | null = null;
  private underSince: number | null = null;
  private lastChangeAt = 0;
  private readonly timer: GpuTimer;
  // ---- 无 GPU 计时时的探测式升档：定期乐观地试着升一档，撑不住就退回并拉长下次尝试的间隔 ----
  private probing = false;
  private probeUntil = 0;
  private probeBackoff = PROBE_BACKOFF_MIN_MS;
  private nextProbeAt = 0;
  private lastGpuMs: number | null = null;
  private lastIntervalMs = 1000 / 60;

  constructor(private readonly deps: QualityControllerDeps) {
    this.timer = new GpuTimer(deps.renderer);
    // PERF-5：每次载入都从「自动」起步（G07 曾在这里恢复上次的手动档，G07b 撤掉，见文件头「解耦」一段）
  }

  get tier() {
    return this.tierValue;
  }

  get level(): QualityLevel {
    return LEVELS[this.levelIndex].level;
  }

  get gpuTimingAvailable() {
    return this.timer.available;
  }

  /** G07：本次载入的地面纹理精度与依据（调试：`__voyage.quality.groundRes`）；与画质档无关（G07b） */
  get groundRes() {
    return GROUND_RES_DECISION;
  }

  /** G07b：面板「地面精度」当前选项（调试：`__voyage.quality.groundPref`） */
  get groundPref() {
    return groundResPref();
  }

  /** 每个真实动画帧开始时调用。**不要**在 benchFrame 这类合成测量循环里调用——那是给其他任务做性能
   * 回归用的干净基准，被自动档中途改分辨率会污染结果（main.ts 只在 requestAnimationFrame 驱动的 frame() 里调用）。 */
  beginFrame() {
    this.timer.begin();
  }

  /** 每个真实动画帧结束时调用。intervalMs：这一帧到上一帧的挂钟间隔（rAF 时间戳之差），
   * 用来估计显示器刷新周期，没有 GPU 计时扩展时也拿它兜底当作耗时信号。 */
  endFrame(nowMs: number, intervalMs: number) {
    this.timer.end();
    this.updateVsync(intervalMs);
    this.lastIntervalMs = intervalMs;
    const samples = this.timer.poll();
    if (this.timer.available) {
      for (const ms of samples) this.pushCost(ms);
      if (samples.length) this.lastGpuMs = samples[samples.length - 1];
    } else {
      this.pushCost(intervalMs);
    }
    if (this.tierValue === "auto") this.decide(nowMs);
  }

  /** 面板切换画质档位 */
  setTier(tier: QualityTier, nowMs = performance.now()) {
    if (tier === this.tierValue) return;
    this.tierValue = tier;
    this.overSince = this.underSince = null;
    this.probing = false;
    this.nextProbeAt = nowMs;
    this.probeBackoff = PROBE_BACKOFF_MIN_MS;
    this.levelIndex = tier === "auto" ? 0 : MANUAL_INDEX[tier];
    this.lastChangeAt = nowMs;
    this.applyLevel();
  }

  /** 天气切到雷暴 / 台风这类重负载场景时调用（ui.ts 的 applyWeather）：如果还在最高档，提前退到「中」，
   * 不用等自适应的 DOWNGRADE_HOLD_MS 才反应过来，减少切换瞬间的第一下掉帧。只在自动档、且当前确实在
   * 最高档时生效；不会覆盖自适应已经做出的更低选择，也不会在手动档下生效。 */
  hintHeavyScene(heavy: boolean, nowMs = performance.now()) {
    if (!heavy || this.tierValue !== "auto" || this.levelIndex !== 0) return;
    this.levelIndex = 1;
    this.lastChangeAt = nowMs;
    this.overSince = this.underSince = null;
    this.applyLevel();
  }

  /** 面板文字：手动档标「固定」；自动档带上依据的数字，方便用户判断是不是自己的机器偏弱 */
  describe(): string {
    const p = LEVELS[this.levelIndex];
    if (this.tierValue !== "auto") return `${p.label}（固定）`;
    const basis = this.timer.available
      ? `GPU ${this.lastGpuMs !== null ? this.lastGpuMs.toFixed(1) : "—"} / 预算 ${GPU_BUDGET_MS.toFixed(1)} ms`
      : `无 GPU 计时，帧间隔 ${this.lastIntervalMs.toFixed(1)} ms`;
    return `自动 → ${p.label}（${basis}）`;
  }

  /** 刷新周期估计：出现更快的帧立刻贴过去（说明之前的估计偏保守，或者显示器 / 窗口换了）；
   * 变慢则缓慢跟随——热身期（前 90 帧）跟得快一点尽快收敛，之后跟得很慢，避免真正的过载被「跟」没了。
   * 夹到 [1000/240, 1000/20] 之间，防止单帧异常值（例如切后台）把估计带偏。 */
  private updateVsync(intervalMs: number) {
    const clamped = Math.min(Math.max(intervalMs, 1000 / 240), 1000 / 20);
    this.vsyncSeen++;
    if (this.vsyncSeen === 1) this.vsyncEstimate = clamped;
    else if (clamped < this.vsyncEstimate) this.vsyncEstimate = clamped;
    else this.vsyncEstimate += (clamped - this.vsyncEstimate) * (this.vsyncSeen < 90 ? 0.15 : 0.01);
  }

  private pushCost(ms: number) {
    this.costEma = this.costEma === null ? ms : this.costEma + (ms - this.costEma) * COST_EMA_ALPHA;
  }

  private decide(nowMs: number) {
    if (this.costEma === null) return;
    if (this.timer.available) this.decideByGpuTime(nowMs);
    else this.decideByFrameInterval(nowMs);
  }

  /** 有 GPU 计时：预算固定（GPU_BUDGET_MS），降档 / 升档用同一套「持续时间 + 滞回」判断，但两头不对称：
   *
   * - 降档要快、要严格：pressure 一超过 DOWNGRADE_RATIO 就开始计时，只要连续 DOWNGRADE_HOLD_MS 都在超，
   *   立刻降档；中途哪怕有一帧回到预算内也整个重新计时（掉帧要尽快压下去，不能拖）。
   * - 升档要慢、要宽容：**踩过的坑**——一开始 underSince 也是「一超过 UPGRADE_RATIO 就整个清零重来」，
   *   实测在有真实地面瓦片加载、天气切换后重建阴影 / 占据网格这类正常噪声下，耗时会在 UPGRADE_RATIO 和
   *   DOWNGRADE_RATIO 之间偶尔弹一下，导致 underSince 永远攒不满 UPGRADE_HOLD_MS，明明早就有余量了也升不回去
   *   （实测：typhoon-bands 原生分辨率降到「中」后，实测耗时一直在预算的 45%–70% 之间，从没真正过载，
   *   但也从没能连续 3 秒都严格低于 55%，卡在「中」出不来）。改成：只有真正过载（pressure > DOWNGRADE_RATIO）
   *   才清零 underSince；「预算内但还没宽松到 UPGRADE_RATIO」这种中间地带不清零、只是不推进——
   *   underSince measure 的是「最近一次真正过载」到现在的时间，而不是「最近一次波动」到现在的时间。 */
  private decideByGpuTime(nowMs: number) {
    const pressure = this.costEma! / GPU_BUDGET_MS;
    if (pressure > DOWNGRADE_RATIO) {
      this.underSince = null;
      if (this.overSince === null) this.overSince = nowMs;
      if (nowMs - this.overSince >= DOWNGRADE_HOLD_MS) this.tryStep(1, nowMs);
      return;
    }
    this.overSince = null;
    if (pressure < UPGRADE_RATIO) {
      if (this.underSince === null) this.underSince = nowMs;
      if (nowMs - this.underSince >= UPGRADE_HOLD_MS) this.tryStep(-1, nowMs);
    }
    // 中间地带（UPGRADE_RATIO ≤ pressure ≤ DOWNGRADE_RATIO）：不算过载也不算「已经宽松」，
    // underSince 保持原样（可能是 null，也可能是之前已经在计时），既不重置也不新开一段。
  }

  /** 没有 GPU 计时：帧间隔本身分不清「GPU 空闲、被 vsync 卡住」和「GPU 打满、卡在 vsync 上限」，
   * 只能反应式地抓「已经掉帧」（间隔明显超过一次刷新周期）来降档；升档没有可靠的正向信号，
   * 改用探测式——定期乐观地试着升一档，PROBE_WINDOW_MS 内没有再掉帧就保留，掉了就退回并让下次
   * 尝试的间隔翻倍（上限 60 s），避免在临界点反复横跳。 */
  private decideByFrameInterval(nowMs: number) {
    const pressure = this.costEma! / this.vsyncEstimate;
    if (pressure > FALLBACK_OVERRUN) {
      if (this.overSince === null) this.overSince = nowMs;
      if (nowMs - this.overSince >= DOWNGRADE_HOLD_MS) {
        if (this.probing) {
          // 刚试探性升的这一档撑不住：退回去，且忽略常规冷却（frames 正在掉，越快退越好）
          this.probing = false;
          this.probeBackoff = Math.min(this.probeBackoff * 2, PROBE_BACKOFF_MAX_MS);
          this.nextProbeAt = nowMs + this.probeBackoff;
          this.tryStep(1, nowMs, true);
        } else {
          this.tryStep(1, nowMs);
        }
        this.overSince = null;
      }
    } else {
      this.overSince = null;
      if (this.probing && nowMs >= this.probeUntil) {
        // 探测期内没有再掉帧：保留这一档，之后还可以再往上试
        this.probing = false;
        this.nextProbeAt = nowMs + this.probeBackoff;
      }
    }
    if (!this.probing && this.levelIndex > 0 && nowMs >= this.nextProbeAt) {
      if (this.tryStep(-1, nowMs)) {
        this.probing = true;
        this.probeUntil = nowMs + PROBE_WINDOW_MS;
      } else {
        this.nextProbeAt = nowMs + CHANGE_COOLDOWN_MS; // 冷却没过，稍后再试
      }
    }
  }

  /** direction：+1 降档（更省），-1 升档（更贵）。force 时忽略冷却（只在「探测失败要立刻退回」时用）。
   * 返回是否真的调整了档位。 */
  private tryStep(direction: 1 | -1, nowMs: number, force = false): boolean {
    if (!force && nowMs - this.lastChangeAt < CHANGE_COOLDOWN_MS) return false;
    const next = Math.max(0, Math.min(LEVELS.length - 1, this.levelIndex + direction));
    if (next === this.levelIndex) return false;
    this.levelIndex = next;
    this.lastChangeAt = nowMs;
    this.overSince = this.underSince = null;
    this.applyLevel();
    return true;
  }

  private applyLevel() {
    const p = LEVELS[this.levelIndex];
    this.deps.clouds.resolutionScale = p.cloudScale;
    this.deps.renderer.setPixelRatio(Math.min(window.devicePixelRatio, p.dprCap));
    this.deps.resize();
  }
}

export function createQualityController(deps: QualityControllerDeps): QualityController {
  return new QualityController(deps);
}
