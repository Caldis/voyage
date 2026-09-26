import { DEFAULT_TIMINGS, loadTimings, saveTimings, type BootTimings } from "./timings";

/**
 * 加载遮罩的分阶段清单与总进度条。
 *
 * 清单打勾是真实进度（每个阶段真正跑完才调用 finish()）；总进度条在单个阶段内部没有真实驱动进度可用
 * （`compileAsync` 只能整体等它 resolve），所以按上一次实际测到的耗时做指数缓动，趋近但不到该阶段的满格，
 * 真正跑完的那一刻才跳满，界面上标「约」。
 *
 * 命中着色器磁盘缓存时全程可能不到 1 秒：这种情况不展示这一整块 UI（只留原有的标题 / 文案），
 * 避免「进度条只跳了一点点就消失」的抖动感——见 REVEAL_DELAY_MS。
 */

export const BOOT_STAGE_IDS = ["atmosphere", "cloudNoise", "shaders", "cloudMarch", "oceanFft", "post", "firstFrame"] as const;
export type BootStageId = (typeof BOOT_STAGE_IDS)[number];

const REVEAL_DELAY_MS = 1000;

function num(v: number | undefined, fallback: number) {
  return typeof v === "number" && Number.isFinite(v) && v > 0 ? v : fallback;
}

export class BootProgress {
  private readonly startedAt = performance.now();
  private readonly estimate: BootTimings = loadTimings();
  private readonly actual: Partial<Record<BootStageId, number>> = {};
  private readonly cumEstimate: number[];
  private readonly totalEstimate: number;

  private stageStart = this.startedAt;
  private cursor = 0;
  private confirmedMs = 0;
  private revealed = false;
  private finished = false;
  private revealTimer = 0;
  private rafId = 0;

  private readonly container = document.getElementById("loading-progress");
  private readonly barFill = document.getElementById("loading-bar-fill");
  private readonly elapsedEl = document.getElementById("loading-elapsed");
  private readonly etaEl = document.getElementById("loading-eta");
  private readonly stepEls: Partial<Record<BootStageId, HTMLElement>> = {};

  constructor() {
    for (const id of BOOT_STAGE_IDS) {
      const el = document.querySelector<HTMLElement>(`[data-stage="${id}"]`);
      if (el) this.stepEls[id] = el;
    }
    let acc = 0;
    this.cumEstimate = BOOT_STAGE_IDS.map((id) => (acc += num(this.estimate[id], num(DEFAULT_TIMINGS[id], 1000))));
    this.totalEstimate = acc;
    this.stepEls[BOOT_STAGE_IDS[0]]?.classList.add("active");
    this.revealTimer = window.setTimeout(() => this.reveal(), REVEAL_DELAY_MS);
    this.rafId = requestAnimationFrame(this.tick);
  }

  private reveal() {
    this.revealed = true;
    this.container?.classList.add("visible");
  }

  /** 标记某个阶段真正完成；顺序必须和 BOOT_STAGE_IDS 一致（main.ts 的启动编排本身就是顺序执行的） */
  finish(id: BootStageId) {
    if (this.finished) return;
    const now = performance.now();
    const dur = Math.max(0, Math.round(now - this.stageStart));
    this.actual[id] = dur;
    this.confirmedMs += dur;
    this.stageStart = now;
    this.stepEls[id]?.classList.remove("active");
    this.stepEls[id]?.classList.add("done");
    this.cursor++;
    const next = BOOT_STAGE_IDS[this.cursor];
    if (next) this.stepEls[next]?.classList.add("active");
  }

  private readonly tick = () => {
    if (this.finished) return;
    const now = performance.now();
    if (this.revealed && this.container) {
      const idx = this.cursor;
      let simulated = this.confirmedMs;
      if (idx < BOOT_STAGE_IDS.length) {
        const id = BOOT_STAGE_IDS[idx];
        const est = num(this.estimate[id], num(DEFAULT_TIMINGS[id], 1000));
        const inStage = now - this.stageStart;
        // 指数缓动到这一阶段估算耗时的 92%：真实完成前不到头（免得看起来卡住），完成那一刻由 finish() 直接跳满
        simulated += est * 0.92 * (1 - Math.exp(-inStage / (est * 0.6)));
      }
      const frac = Math.min(simulated / this.totalEstimate, 0.995);
      if (this.barFill) this.barFill.style.width = `${(frac * 100).toFixed(1)}%`;
      if (this.elapsedEl) this.elapsedEl.textContent = `已用 ${((now - this.startedAt) / 1000).toFixed(1)} 秒`;
      if (this.etaEl) {
        const remain = Math.max(this.totalEstimate - simulated, 0) / 1000;
        this.etaEl.textContent = idx < BOOT_STAGE_IDS.length ? `约剩 ${Math.max(remain, 0.2).toFixed(0)} 秒` : "";
      }
    }
    this.rafId = requestAnimationFrame(this.tick);
  };

  /** 全部阶段结束：停止动画，把这次的实测耗时写回，供下次估算 */
  complete() {
    if (this.finished) return;
    this.finished = true;
    window.clearTimeout(this.revealTimer);
    cancelAnimationFrame(this.rafId);
    if (this.barFill) this.barFill.style.width = "100%";
    saveTimings({ ...this.estimate, ...this.actual });
  }

  /** 调试用：各阶段估算 / 实测耗时，挂在 window.__voyage 上 */
  get debugInfo() {
    return { estimate: this.estimate, actual: this.actual, cumEstimate: this.cumEstimate, totalEstimate: this.totalEstimate };
  }
}
