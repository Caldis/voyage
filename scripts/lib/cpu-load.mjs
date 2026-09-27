// DX-10：负载感知。多个代理并行开发时，离线 FXC（CPU）、真冷启动 / 按 pass 的 GPU 计时（GPU，但编译期也吃 CPU）
// 都对机器负载敏感，噪声可到 ±30~40%（README 坑点「离线 fxc 计时对系统负载很敏感」「测帧时间…多个代理同时占
// GPU 时任何计时都不可信」；research/DX_REPORT_wave6.md 审计当天 CPU 82% 时干脆放弃了离线 FXC）。
// 这里只做「测一下当前 CPU 占用、超过阈值就警告并记录」，不试图消除噪声——消除靠多轮交替 + 判定按最小值
// （负载只会让计时变慢，噪声是单向的，这条来自 research/PERF_REPORT_wave6.md 的验证结论）+ 收尾安静窗口复测。

import { execFileSync } from "node:child_process";

/** 当前总 CPU 占用（0–100）。非 Windows 或采样失败返回 null（不阻塞主流程，调用方按 null 当「未知」处理）。
 * 用 PowerShell Get-Counter 读一次 `\Processor(_Total)\% Processor Time`（single sample，不设 -SampleInterval
 * 时立即返回当前值，约一两百毫秒，比 typeperf 起一个新进程轮询快）。 */
export function sampleCpuLoad() {
  if (process.platform !== "win32") return null;
  try {
    const out = execFileSync(
      "powershell.exe",
      [
        "-NoProfile",
        "-NonInteractive",
        "-Command",
        "(Get-Counter '\\Processor(_Total)\\% Processor Time').CounterSamples.CookedValue",
      ],
      { encoding: "utf8", timeout: 8000 },
    ).trim();
    const v = Number(out);
    return Number.isFinite(v) ? v : null;
  } catch {
    return null;
  }
}

/** 采样 + 超阈值打印警告，返回采样值（null 表示采样失败 / 非 Windows，不算超标，调用方不必特殊处理）。 */
export function sampleAndWarn(context, threshold = 50) {
  const load = sampleCpuLoad();
  if (load != null && load > threshold) {
    console.warn(
      `[负载] ${context}：CPU 占用 ${load.toFixed(0)}%（> ${threshold}%），本次计时可能不可信` +
        `（并行开发时噪声可到 ±30~40%，判定请看多轮的最小值，权威结论留给安静窗口复测）`,
    );
  }
  return load;
}

/** --wait-quiet：轮询等到 CPU 占用 <= threshold 再返回采样值；超时也返回（不无限等），返回值可能仍 > threshold。 */
export async function waitForQuiet({ threshold = 50, timeoutMs = 5 * 60 * 1000, pollMs = 5000, log = console.log } = {}) {
  const start = Date.now();
  for (;;) {
    const load = sampleCpuLoad();
    if (load == null || load <= threshold) return load;
    if (Date.now() - start > timeoutMs) {
      log(`[--wait-quiet] 等了 ${(timeoutMs / 60000).toFixed(1)} 分钟，CPU 仍 ${load.toFixed(0)}%，超时放弃等待，继续测量`);
      return load;
    }
    log(`[--wait-quiet] CPU ${load.toFixed(0)}% > ${threshold}%，${(pollMs / 1000).toFixed(0)}s 后重查...`);
    await new Promise((r) => setTimeout(r, pollMs));
  }
}
