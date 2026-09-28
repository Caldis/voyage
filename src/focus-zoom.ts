/**
 * 聚焦观察（FOCUS-ZOOM）：按住画面不动（或按住 Z）视场平滑收窄到「默认 / 倍率」，松开平滑还原——像 FPS 游戏里的放大查看。
 *
 * - 只改垂直半视场的正切 uTanHalfFov（所有 pass 共用同一个 uniform 对象）；倍率 1 时写回的值与原来的常数逐位相同。
 * - 过渡：进度 p 按真实时间线性走（过渡时长 durationMs），经 smootherstep 缓入缓出，再在对数域插值倍率
 *   （factor = mag^ease(p)）——放大速度在感知上均匀，不会前半段猛冲、后半段拖泥带水。冻结（dt = 0）时不动。
 * - 谁在「按住」：pointer（画布长按）、key（Z）、script（调试句柄 / 测量脚本）各自独立，任何一个按着就聚焦。
 * - 设置（开发者区）：倍率、过渡时长、暗角强度。优先级 URL（?zoom= / ?zoomms=）> 用户上次亲手调的值（localStorage
 *   voyage.focus，只记 isTrusted 的操作）> 默认；URL 生效的那一项本次不写记忆。
 */

/** 默认垂直半视场 25°（render/scene.ts 的 uTanHalfFov 初值，写法保持一致，倍率 1 时逐位相同） */
export const TAN_HALF_FOV_DEFAULT = Math.tan((25 * Math.PI) / 180);

export const FOCUS_MAG = { min: 1.5, max: 8, step: 0.1, def: 2.5 };
export const FOCUS_MS = { min: 0, max: 600, step: 10, def: 200 };
export const FOCUS_VIGNETTE = { min: 0, max: 1, step: 0.05, def: 0.4 };

const STORE_KEY = "voyage.focus";
type Stored = { v: 1; mag?: number; ms?: number; vignette?: number };

const clamp = (v: number, a: number, b: number) => Math.min(Math.max(v, a), b);
const snap = (v: number, step: number) => Math.round(v / step) * step;

function readStore(): Stored | null {
  try {
    const s = JSON.parse(localStorage.getItem(STORE_KEY) ?? "null") as Stored | null;
    return s && s.v === 1 ? s : null;
  } catch {
    return null;
  }
}

function urlNumber(name: string): number | null {
  const all = new URLSearchParams(location.search).getAll(name);
  if (all.length === 0) return null;
  const n = Number(all[all.length - 1]); // 同名参数多个时以最后一个为准（同 ?voyage=）
  return Number.isFinite(n) ? n : null;
}

export type FocusSource = "pointer" | "key" | "script";

export class FocusZoom {
  /** 聚焦倍率（视场收窄到默认的 1 / mag） */
  mag = FOCUS_MAG.def;
  /** 放大 / 还原的过渡时长（毫秒） */
  durationMs = FOCUS_MS.def;
  /** 聚焦时画面四角压暗的强度（0 = 关；CSS 叠层，不进渲染管线） */
  vignette = FOCUS_VIGNETTE.def;
  /** 这几项由 URL 参数定（本次载入不写记忆，面板上注明） */
  readonly fromUrl = { mag: false, ms: false };
  /** 当前的放大倍数（1 = 不聚焦）与过渡进度（0..1） */
  factor = 1;
  progress = 0;
  private readonly holds = new Set<FocusSource>();
  private vignetteEl: HTMLElement | null = null;

  constructor() {
    const s = readStore();
    if (s?.mag !== undefined) this.mag = clamp(s.mag, FOCUS_MAG.min, FOCUS_MAG.max);
    if (s?.ms !== undefined) this.durationMs = clamp(s.ms, FOCUS_MS.min, FOCUS_MS.max);
    if (s?.vignette !== undefined) this.vignette = clamp(s.vignette, FOCUS_VIGNETTE.min, FOCUS_VIGNETTE.max);
    const um = urlNumber("zoom");
    if (um !== null) {
      this.mag = clamp(snap(um, FOCUS_MAG.step), 1, FOCUS_MAG.max); // URL 允许 1（等于关掉聚焦，测量对照用）
      this.fromUrl.mag = true;
    }
    const ut = urlNumber("zoomms");
    if (ut !== null) {
      this.durationMs = clamp(ut, FOCUS_MS.min, FOCUS_MS.max);
      this.fromUrl.ms = true;
    }
  }

  /** 按住 / 松开（各来源独立） */
  hold(src: FocusSource, on: boolean) {
    if (on) this.holds.add(src);
    else this.holds.delete(src);
  }

  get engaged() {
    return this.holds.size > 0;
  }

  /** 是否在聚焦或过渡中（完全还原后为 false） */
  get active() {
    return this.engaged || this.progress > 0;
  }

  /** 每帧调用（dt：真实秒，冻结时为 0）；返回当前放大倍数 */
  update(dt: number): number {
    const target = this.engaged ? 1 : 0;
    if (this.progress !== target) {
      const step = this.durationMs <= 0 ? 1 : (dt * 1000) / this.durationMs;
      this.progress = target > this.progress ? Math.min(1, this.progress + step) : Math.max(0, this.progress - step);
    }
    const p = this.progress;
    const e = p * p * p * (p * (p * 6 - 15) + 10); // smootherstep：两端速度、加速度都为 0
    this.factor = e === 0 ? 1 : Math.pow(this.mag, e);
    this.updateVignette(e);
    return this.factor;
  }

  /** 设置（面板用）。trusted：用户亲手操作才写记忆 */
  set(key: "mag" | "ms" | "vignette", value: number, trusted: boolean) {
    if (key === "mag") this.mag = clamp(value, FOCUS_MAG.min, FOCUS_MAG.max);
    else if (key === "ms") this.durationMs = clamp(value, FOCUS_MS.min, FOCUS_MS.max);
    else this.vignette = clamp(value, FOCUS_VIGNETTE.min, FOCUS_VIGNETTE.max);
    if (key === "mag") this.fromUrl.mag = false;
    if (key === "ms") this.fromUrl.ms = false;
    if (!trusted) return;
    try {
      const s: Stored = readStore() ?? { v: 1 };
      if (key === "mag") s.mag = this.mag;
      else if (key === "ms") s.ms = this.durationMs;
      else s.vignette = this.vignette;
      localStorage.setItem(STORE_KEY, JSON.stringify(s));
    } catch {
      // 隐私模式等拿不到 localStorage：只是不记忆
    }
  }

  /** 暗角：一层 CSS 径向渐变叠在画布上（pointer-events: none），不透明度跟过渡走；完全还原时 display: none */
  private updateVignette(e: number) {
    const el = (this.vignetteEl ??= document.getElementById("focus-vignette"));
    if (!el) return;
    const o = this.vignette * e;
    const show = o > 0.001;
    if (el.hidden === show) el.hidden = !show;
    if (show) el.style.opacity = o.toFixed(3);
  }
}
