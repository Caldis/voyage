/**
 * 启动各阶段耗时的本地记录。
 *
 * GPU 编译期间驱动不会给出真实进度（`compileAsync` 只能等它 resolve，没有百分比），
 * 所以总进度条只能按「上一次实际测到的各阶段耗时」估算着走，标「约」。
 * 存取都包一层 try/catch：无痕模式、存储配额满、用户清了站点数据都不该影响启动。
 */

const STORAGE_KEY = "voyage.bootTimings.v1";

export type BootTimings = Record<string, number>;

/**
 * 首次没有历史记录时的默认估算（毫秒），量级参考 README「坑点」的实测数据：
 * 场景 + 机翼着色器冷编译占大头，常见 45–55 秒，复杂时可到 80–90 秒；其余阶段是次要开销。
 */
export const DEFAULT_TIMINGS: BootTimings = {
  atmosphere: 300,
  cloudNoise: 200,
  shaders: 50000,
  cloudMarch: 2000,
  oceanFft: 400,
  post: 300,
  firstFrame: 150,
};

export function loadTimings(): BootTimings {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return { ...DEFAULT_TIMINGS };
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object") return { ...DEFAULT_TIMINGS };
    const merged: BootTimings = { ...DEFAULT_TIMINGS };
    for (const [k, v] of Object.entries(parsed as Record<string, unknown>)) {
      if (typeof v === "number" && Number.isFinite(v) && v >= 0) merged[k] = v;
    }
    return merged;
  } catch {
    return { ...DEFAULT_TIMINGS };
  }
}

export function saveTimings(timings: BootTimings) {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(timings));
  } catch {
    // 无痕模式 / 配额满：忽略，不影响启动
  }
}
