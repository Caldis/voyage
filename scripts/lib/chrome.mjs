// dev-browser.mjs、shader-budget.mjs 和 compare.mjs 共用：定位并启动本机缓存的完整版 chrome.exe
// （headless=new，真实 GPU）。
//
// **不能**用 chrome-headless-shell.exe——会静默退化成 SwiftShader 软渲染，且没有
// EXT_disjoint_timer_query_webgl2 扩展，冷编译时间 / sampler 上限 / GPU 计时全部失真且不报错
// （开发体验官实测结论，见 apps/voyage/research/DX_REPORT_wave2.md §1.1）。compare.mjs 只用它做
// Canvas2D 图片合成，不需要真实 GPU，但复用同一份「怎么找到本机 chrome.exe」逻辑更省事，
// 也不用再额外装一次 chrome-headless-shell。

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

function candidateRoots() {
  const home = os.homedir();
  const roots = [];
  if (process.env.PLAYWRIGHT_BROWSERS_PATH) roots.push(process.env.PLAYWRIGHT_BROWSERS_PATH);
  if (process.platform === "win32") roots.push(path.join(process.env.LOCALAPPDATA || path.join(home, "AppData", "Local"), "ms-playwright"));
  else if (process.platform === "darwin") roots.push(path.join(home, "Library", "Caches", "ms-playwright"));
  else roots.push(path.join(home, ".cache", "ms-playwright"));
  return roots.filter((r) => fs.existsSync(r));
}

/** 只要 chromium-<数字>，排除 chromium_headless_shell-*（见文件头注释） */
export function findChromeExecutable() {
  for (const root of candidateRoots()) {
    let dirs;
    try {
      dirs = fs
        .readdirSync(root)
        .filter((d) => /^chromium-\d+$/.test(d))
        .sort((a, b) => Number(b.split("-")[1]) - Number(a.split("-")[1]));
    } catch {
      continue;
    }
    for (const d of dirs) {
      const candidates = [
        path.join(root, d, "chrome-win64", "chrome.exe"),
        path.join(root, d, "chrome-win", "chrome.exe"),
        path.join(root, d, "chrome-linux", "chrome"),
        path.join(root, d, "chrome-mac", "Chromium.app", "Contents", "MacOS", "Chromium"),
      ];
      const found = candidates.find((c) => fs.existsSync(c));
      if (found) return found;
    }
  }
  return null;
}

/** angle: "d3d11"（默认，Windows 上的验收口径，与生产环境一致）| "vulkan"（开发内循环，编译快约 18 倍，
 * 但会藏住 D3D11 专属问题，见 research/DX_SHADER_COMPILE.md）。extraArgs 附加在 --use-angle 之后。 */
export async function launchBrowser(chromium, { angle = "d3d11", extraArgs = [] } = {}) {
  const executablePath = findChromeExecutable();
  if (!executablePath) {
    throw new Error(
      "找不到本机缓存的完整版 chrome.exe（<ms-playwright 缓存>/chromium-<版本>/…），已排除 chromium_headless_shell-*。\n" +
        "本机没缓存时可以先 `npx --yes playwright install chromium` 下载一次（约 150MB，只需要一次）。",
    );
  }
  return chromium.launch({ executablePath, headless: true, args: [`--use-angle=${angle}`, ...extraArgs] });
}

/** browser.close() 在渲染进程已经崩溃（Target crashed）之后可能永远等不到 CDP 握手回来，
 * 用超时 race，超时就直接杀掉底层进程，避免脚本挂死（多个代理同时抢 GPU 时会撞上，见 README 坑点） */
export async function closeBrowserSafely(browser, timeoutMs = 5000) {
  try {
    await Promise.race([browser.close(), new Promise((_, reject) => setTimeout(() => reject(new Error("close timeout")), timeoutMs))]);
  } catch {
    try {
      browser.process()?.kill("SIGKILL");
    } catch {
      /* 尽力而为 */
    }
  }
}
