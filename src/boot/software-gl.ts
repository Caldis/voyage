/**
 * PERF-CPU：浏览器在用 CPU 软件渲染时给出提示。
 *
 * 2026-09-28 用户报告「帧率非常低、CPU 打满、GPU 利用不到 40%」。查下来不是代码问题：前一晚 23:59 NVIDIA 驱动重装，
 * Chrome 的 GPU 进程 4 秒后重启时退到了 WARP（Microsoft Basic Render Driver，D3D11 的 CPU 软件光栅），之后一直不会自己切回。
 * 本页的云 / 大气 / 地面着色器在 WARP 上约 2.4 fps，WARP 的光栅线程吃满 26 个核（`scripts/cpu-prof.mjs --angle d3d11-warp` 复现）。
 * 页面自己改不了浏览器的 GPU 状态，能做的是一眼告诉用户原因与办法，免得当成性能回归去查。
 *
 * 判定：主渲染器上下文的 WEBGL_debug_renderer_info 渲染器字符串命中软件光栅（WARP 报「Microsoft Basic Render Driver」，
 * Chrome 的另一种兜底报「SwiftShader」，Linux 上是 llvmpipe / softpipe）。读不到字符串（Safari、Firefox 隐藏型号）时不提示。
 * 调试：URL `?swgl=1` 强制显示提示（看样式），`__voyage.softwareRenderer` 看判定结果。
 */

const SOFTWARE_RE = /swiftshader|basic render|llvmpipe|softpipe|\bwarp\b/i;

export interface SoftwareGlInfo {
  /** 渲染器字符串（读不到时为空） */
  renderer: string;
  /** 是否判为软件渲染 */
  software: boolean;
}

export function detectSoftwareGl(gl: WebGL2RenderingContext): SoftwareGlInfo {
  let renderer = "";
  try {
    const ext = gl.getExtension("WEBGL_debug_renderer_info");
    renderer = String(gl.getParameter(ext ? ext.UNMASKED_RENDERER_WEBGL : gl.RENDERER) ?? "");
  } catch {
    // 读不到就不判
  }
  const forced = typeof location !== "undefined" && new URLSearchParams(location.search).get("swgl") === "1";
  return { renderer, software: forced || SOFTWARE_RE.test(renderer) };
}

/** 页面顶部一条可关闭的提示（在加载遮罩之上，启动编译期间也看得到） */
export function showSoftwareGlBanner(info: SoftwareGlInfo) {
  if (!info.software || typeof document === "undefined") return;
  const el = document.createElement("div");
  el.id = "software-gl";
  el.setAttribute("role", "alert");
  const name = /basic render/i.test(info.renderer) ? "WARP（Microsoft Basic Render Driver）" : /swiftshader/i.test(info.renderer) ? "SwiftShader" : info.renderer || "软件光栅";
  el.innerHTML =
    `<b>浏览器正在用 CPU 软件渲染（${name}），显卡加速没有生效</b>——所以帧率很低、CPU 占满、显卡却很闲。` +
    `常见原因：刚更新过显卡驱动或驱动重置过，Chrome 的 GPU 进程退回了软件渲染，而且不会自己恢复。` +
    `办法：地址栏打开 <code>chrome://restart</code> 重启浏览器（标签页会恢复），再到 <code>chrome://gpu</code> 确认「WebGL: Hardware accelerated」。` +
    `<button type="button" aria-label="关闭提示">×</button>`;
  el.querySelector("button")?.addEventListener("click", () => el.remove());
  document.body.appendChild(el);
}
