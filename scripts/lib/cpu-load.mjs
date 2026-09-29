// DX-10：负载感知。多个代理并行开发时，离线 FXC（CPU）、真冷启动 / 按 pass 的 GPU 计时（GPU，但编译期也吃 CPU）
// 都对机器负载敏感，噪声可到 ±30~40%（README 坑点「离线 fxc 计时对系统负载很敏感」「测帧时间…多个代理同时占
// GPU 时任何计时都不可信」；research/DX_REPORT_wave6.md 审计当天 CPU 82% 时干脆放弃了离线 FXC）。
// 这里只做「测一下当前 CPU 占用、超过阈值就警告并记录」，不试图消除噪声——消除靠多轮交替 + 判定按最小值
// （负载只会让计时变慢，噪声是单向的，这条来自 research/PERF_REPORT_wave6.md 的验证结论）+ 收尾安静窗口复测。
//
// DX-32：以前只查 CPU，漏了「GPU 被一个没关的浏览器页面占着」这种污染源——2026-09-29 协调者线上验收开的
// Playwright MCP 页面没关，持续渲染占 GPU 约 51%，PUB-3 / PERF-16 的帧时间全部被抬高（见 DEV_SOP.md「测量前查
// GPU」一条、handoff/PERF-16.md、handoff/PERF-16b.md）。这里补上 `sampleGpuLoad`（`nvidia-smi
// --query-gpu=utilization.gpu`）与 `sampleAndWarnGpu`，`waitForQuiet` 等完 CPU 后接着等 GPU。非 NVIDIA 显卡
// （包括 macOS）没有 `nvidia-smi`，静默跳过、整个进程生命周期只打印一次提示（调用方可能每轮都采样一次，
// 不想刷屏）。

import { execFileSync } from "node:child_process";

let warnedNoNvidiaSmi = false;

/** 当前 GPU 利用率（0–100，来自 `nvidia-smi --query-gpu=utilization.gpu`）。没有 `nvidia-smi`
 * （非 NVIDIA 显卡，或不在 PATH 里，包括 macOS）时返回 null，整个进程生命周期只打印一次提示（不阻塞主流程，
 * 调用方按 null 当「未知 / 跳过」处理，和 sampleCpuLoad 的约定一致）。 */
export function sampleGpuLoad() {
  try {
    const out = execFileSync("nvidia-smi", ["--query-gpu=utilization.gpu", "--format=csv,noheader,nounits"], {
      encoding: "utf8",
      timeout: 5000,
    }).trim();
    const v = Number(out.split(/\r?\n/)[0]);
    return Number.isFinite(v) ? v : null;
  } catch {
    if (!warnedNoNvidiaSmi) {
      warnedNoNvidiaSmi = true;
      console.log("[负载] 没有找到 nvidia-smi（非 NVIDIA 显卡，或不在 PATH 里），跳过 GPU 利用率检查（本进程只提示这一次）");
    }
    return null;
  }
}

/** 采样 GPU + 超阈值打印警告，返回采样值（null 表示没有 nvidia-smi，不算超标）。默认阈值 10%——
 * DEV_SOP「测量前查 GPU」一条给的经验值（空闲应 < 10%，一个没关的浏览器页面持续渲染能占约 51%）。 */
export function sampleAndWarnGpu(context, threshold = 10) {
  const load = sampleGpuLoad();
  if (load != null && load > threshold) {
    console.warn(
      `[负载] ${context}：GPU 利用率 ${load.toFixed(0)}%（> ${threshold}%），本次计时可能不可信` +
        `（可能有别的进程 / 没关的浏览器页面在占 GPU，见 DEV_SOP.md「测量前查 GPU」）`,
    );
  }
  return load;
}

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

/** --wait-quiet：轮询等到 CPU 占用 <= threshold 再往下；各自有超时上限（不无限等），超时打印警告后继续。
 * DX-32：CPU 等到之后接着等 GPU（`gpuThreshold`，默认 10%，见 DEV_SOP「测量前查 GPU」）——连续两次采样都
 * <= gpuThreshold 才算真的空闲（GPU 利用率单次采样噪声大，一帧的活可能恰好落在两次采样之间；两次都低才不容易
 * 把「刚好没采到那一下」误判成空闲）。没有 `nvidia-smi`（非 NVIDIA / macOS）时 `sampleGpuLoad` 返回 null，
 * 这一段直接跳过（`sampleGpuLoad` 自己打印过一次提示，这里不重复）。
 * 返回 `{ cpu, gpu }`：分别是等到（或超时放弃时）最后一次采样值，null 表示未知 / 跳过。 */
export async function waitForQuiet({
  threshold = 50,
  gpuThreshold = 10,
  timeoutMs = 5 * 60 * 1000,
  gpuTimeoutMs = 5 * 60 * 1000,
  pollMs = 5000,
  log = console.log,
} = {}) {
  const start = Date.now();
  let cpu;
  for (;;) {
    cpu = sampleCpuLoad();
    if (cpu == null || cpu <= threshold) break;
    if (Date.now() - start > timeoutMs) {
      log(`[--wait-quiet] 等了 ${(timeoutMs / 60000).toFixed(1)} 分钟，CPU 仍 ${cpu.toFixed(0)}%，超时放弃等待，继续测量`);
      break;
    }
    log(`[--wait-quiet] CPU ${cpu.toFixed(0)}% > ${threshold}%，${(pollMs / 1000).toFixed(0)}s 后重查...`);
    await new Promise((r) => setTimeout(r, pollMs));
  }

  const gpuStart = Date.now();
  let gpu = null;
  let consecutiveQuiet = 0;
  for (;;) {
    gpu = sampleGpuLoad();
    if (gpu == null) break; // 没有 nvidia-smi：静默跳过（sampleGpuLoad 已打印过一次环境提示）
    if (gpu <= gpuThreshold) {
      consecutiveQuiet++;
      if (consecutiveQuiet >= 2) break;
    } else {
      consecutiveQuiet = 0;
    }
    if (Date.now() - gpuStart > gpuTimeoutMs) {
      log(`[--wait-quiet] 等了 ${(gpuTimeoutMs / 60000).toFixed(1)} 分钟，GPU 仍 ${gpu.toFixed(0)}%，超时放弃等待，继续测量` + `（DEV_SOP「测量前查 GPU」：可能有没关的浏览器页面在占 GPU）`);
      break;
    }
    log(
      gpu <= gpuThreshold
        ? `[--wait-quiet] GPU ${gpu.toFixed(0)}% <= ${gpuThreshold}%，但还差一次连续采样才算空闲，${(pollMs / 1000).toFixed(0)}s 后重查...`
        : `[--wait-quiet] GPU ${gpu.toFixed(0)}% > ${gpuThreshold}%（需连续两次 <= ${gpuThreshold}% 才算空闲），${(pollMs / 1000).toFixed(0)}s 后重查...`,
    );
    await new Promise((r) => setTimeout(r, pollMs));
  }
  return { cpu, gpu };
}
