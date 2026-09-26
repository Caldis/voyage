#!/usr/bin/env node
// DX-01：私有 headless Chromium 联调脚本。
//
// 每个代理各自起私有浏览器，不再需要共享浏览器锁（锁只留给确实要用 Playwright MCP 的场合，
// 见 DEV_SOP.md「浏览器锁」）。用完整版 chrome.exe 的新版 headless（Playwright 默认的 `--headless=new`），
// **不能**用 chrome-headless-shell.exe——会静默退化成 SwiftShader 软渲染，且没有
// EXT_disjoint_timer_query_webgl2 扩展，冷编译时间 / sampler 上限 / GPU 计时全部失真且不报错
// （开发体验官实测结论，见 apps/voyage/research/DX_REPORT_wave2.md §1.1）。
//
// 用法：
//   node scripts/dev-browser.mjs shots --port 5230 [--only noon-cumulus,sunset-wing] [--out tmp/screenshot/dev-5230]
//   node scripts/dev-browser.mjs cold  --port 5230 [--repeat 2]
//   node scripts/dev-browser.mjs bench --port 5230 [--baseline 5181] [--only noon-cumulus] [--frames 30] [--rounds 5]
// 也可以用 apps/voyage/package.json 里的 shots / cold / bench 三个 pnpm 脚本（见 README）。
//
// 固定视口 1600×1200、deviceScaleFactor 1（和 regression.playwright.js 的截图基线一致，DX-03 也把 MCP 版对齐到了这个尺寸）。

import { chromium } from "playwright-core";
import os from "node:os";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { DEFAULTS, applyScene, pickScenes } from "./scenarios.mjs";

const VOYAGE_ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const REPO_ROOT = path.join(VOYAGE_ROOT, "..", "..");
const VIEWPORT = { width: 1600, height: 1200 };

// ---------- CLI 参数 ----------
function parseArgs(argv) {
  const out = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith("--")) {
      const key = a.slice(2);
      const next = argv[i + 1];
      if (next !== undefined && !next.startsWith("--")) {
        out[key] = next;
        i++;
      } else out[key] = true;
    } else out._.push(a);
  }
  return out;
}

// ---------- 定位本机缓存的完整版 chrome.exe ----------
function candidateRoots() {
  const home = os.homedir();
  const roots = [];
  if (process.env.PLAYWRIGHT_BROWSERS_PATH) roots.push(process.env.PLAYWRIGHT_BROWSERS_PATH);
  if (process.platform === "win32") roots.push(path.join(process.env.LOCALAPPDATA || path.join(home, "AppData", "Local"), "ms-playwright"));
  else if (process.platform === "darwin") roots.push(path.join(home, "Library", "Caches", "ms-playwright"));
  else roots.push(path.join(home, ".cache", "ms-playwright"));
  return roots.filter((r) => fs.existsSync(r));
}
function findChromeExecutable() {
  for (const root of candidateRoots()) {
    let dirs;
    try {
      // 只要 chromium-<数字>，排除 chromium_headless_shell-*（会退化成 SwiftShader，见文件头注释）
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

/** browser.close() 在渲染进程已经崩溃（Target crashed）之后可能永远等不到 CDP 握手回来，
 * 用超时 race，超时就直接杀掉底层进程，避免脚本挂死（多个代理同时抢 GPU 时会撞上，见 README 坑点） */
async function closeBrowserSafely(browser, timeoutMs = 5000) {
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

async function launchBrowser() {
  const executablePath = findChromeExecutable();
  if (!executablePath) {
    throw new Error(
      "找不到本机缓存的完整版 chrome.exe（<ms-playwright 缓存>/chromium-<版本>/…），已排除 chromium_headless_shell-*。\n" +
        "本机没缓存时可以先 `npx --yes playwright install chromium` 下载一次（约 150MB，只需要一次）。",
    );
  }
  return chromium.launch({
    executablePath,
    headless: true,
    // 防御性钉死：Playwright 默认新版 headless 已经走 D3D11（实测 MAX_TEXTURE_IMAGE_UNITS=16，和生产环境一致），
    // 这里显式指定防止未来 Chromium 改默认值
    args: ["--use-angle=d3d11"],
  });
}

/** 起一个临时 canvas 探测真实渲染器；不是 SwiftShader 就说明走的是真 GPU（见文件头注释） */
async function assertRealGpu(page) {
  const renderer = await page.evaluate(() => {
    const c = document.createElement("canvas");
    const gl = c.getContext("webgl2");
    if (!gl) return null;
    const ext = gl.getExtension("WEBGL_debug_renderer_info");
    return ext ? gl.getParameter(ext.UNMASKED_RENDERER_WEBGL) : gl.getParameter(gl.RENDERER);
  });
  if (!renderer || /swiftshader/i.test(renderer)) {
    throw new Error(
      `GL_RENDERER 疑似软渲染（${renderer}）。说明启动走到了 chrome-headless-shell 或 --use-angle=swiftshader，不是真实 GPU；` +
        "请确认用的是完整 chrome.exe（DX_REPORT_wave2.md §1.1）。",
    );
  }
  return renderer;
}

/** 在 page 上装一个 getContext 钩子，把第一个 webgl2 上下文存到 window.__glProbe（GPU timer query 要用） */
async function installGlProbe(page) {
  await page.addInitScript(() => {
    const orig = HTMLCanvasElement.prototype.getContext;
    HTMLCanvasElement.prototype.getContext = function (type, ...rest) {
      const ctx = orig.call(this, type, ...rest);
      if (type === "webgl2" && ctx && !window.__glProbe) window.__glProbe = ctx;
      return ctx;
    };
  });
}

/** GPU timer query（EXT_disjoint_timer_query_webgl2），有就返回每帧 ms，没有该扩展或超时返回 null（不阻塞主流程） */
async function gpuTimedFrame(page, frames) {
  return page.evaluate(async (n) => {
    const gl = window.__glProbe;
    const ext = gl && gl.getExtension("EXT_disjoint_timer_query_webgl2");
    if (!ext) return null;
    const q = gl.createQuery();
    gl.beginQuery(ext.TIME_ELAPSED_EXT, q);
    window.__voyage.benchFrame(n);
    gl.endQuery(ext.TIME_ELAPSED_EXT);
    const t0 = performance.now();
    while (!gl.getQueryParameter(q, gl.QUERY_RESULT_AVAILABLE)) {
      if (performance.now() - t0 > 2000) return null;
      await new Promise((r) => requestAnimationFrame(r));
    }
    if (gl.getParameter(ext.GPU_DISJOINT_EXT)) return null; // 期间发生过 GPU 中断，结果不可信
    const ns = gl.getQueryParameter(q, gl.QUERY_RESULT);
    return ns / 1e6 / n;
  }, frames);
}

function originFor(port) {
  return `http://127.0.0.1:${port}`;
}

async function openPage(browser, port) {
  const context = await browser.newContext({ viewport: VIEWPORT, deviceScaleFactor: 1 });
  const page = await context.newPage();
  await installGlProbe(page);
  const renderer = await assertRealGpu(page);
  await page.goto(`${originFor(port)}/?dev=${Date.now()}`, { waitUntil: "commit", timeout: 180000 });
  await page.bringToFront();
  await page.waitForFunction(() => window.__voyageStartup, null, { timeout: 180000, polling: 500 });
  return { context, page, renderer };
}

// ---------- shots：跑回归场景表，截图 + 每场景一份同名 JSON ----------
async function cmdShots(args) {
  const port = args.port;
  if (!port) throw new Error("shots 需要 --port <端口>");
  const only = args.only ? String(args.only).split(",") : null;
  const outDir = path.join(REPO_ROOT, args.out || `tmp/screenshot/dev-${port}`);
  fs.mkdirSync(outDir, { recursive: true });

  const browser = await launchBrowser();
  try {
    const { page, renderer } = await openPage(browser, port);
    console.log(`[dev-browser] GL_RENDERER = ${renderer}`);
    const scenes = pickScenes(only);
    const results = [];
    for (const sc of scenes) {
      const info = await page.evaluate(applyScene, { sc, defaults: DEFAULTS });
      const pngPath = path.join(outDir, `${sc.name}.png`);
      await page.screenshot({ path: pngPath, timeout: 60000 });
      const frameMs = await page.evaluate((n) => window.__voyage.benchFrame(n), 30);
      const head = await page.evaluate(() => window.__voyage.head);
      const meta = {
        scene: sc.name,
        info,
        head,
        viewport: VIEWPORT,
        renderer,
        frameMs: +frameMs.toFixed(3),
        origin: originFor(port),
      };
      fs.writeFileSync(path.join(outDir, `${sc.name}.json`), JSON.stringify(meta, null, 2));
      results.push(meta);
      console.log(`  ${sc.name}: frameMs=${meta.frameMs}`);
    }
    console.log(`[dev-browser] 完成，共 ${results.length} 个场景，输出目录 ${path.relative(REPO_ROOT, outDir).replace(/\\/g, "/")}`);
    return results;
  } finally {
    await closeBrowserSafely(browser);
  }
}

// ---------- cold：真冷启动（nonce 破缓存 + 每次独立浏览器上下文） ----------
async function cmdCold(args) {
  const port = args.port;
  if (!port) throw new Error("cold 需要 --port <端口>");
  const repeat = Number(args.repeat || 1);
  const origin = originFor(port);
  const browser = await launchBrowser();
  const results = [];
  try {
    for (let i = 0; i < repeat; i++) {
      // 每次独立浏览器上下文：非持久化 context 本身不共享磁盘 profile，加上 nonce 破缓存双重保险
      // （手法抄自 tmp/review-t02/cold.js，开发体验官已实测端到端跑通，见 DX_REPORT_wave2.md §1.2）
      const context = await browser.newContext({ viewport: VIEWPORT, deviceScaleFactor: 1 });
      try {
        const page = await context.newPage();
        const nonce = Date.now() % 100000;
        await page.addInitScript((n) => {
          const P = WebGL2RenderingContext.prototype;
          const orig = P.shaderSource;
          P.shaderSource = function (sh, src) {
            if (src.includes("void main")) {
              src = src.replace(/void\s+main\s*\(\s*\)\s*\{/, (m) => `float nonceF_${n}(){ return ${n}.0; }\n` + m + `\n if (nonceF_${n}() < -1.0) return;\n`);
            }
            return orig.call(this, sh, src);
          };
        }, nonce);
        const renderer = await assertRealGpu(page);
        const t0 = Date.now();
        await page.goto(`${origin}/?cold=${t0}`, { waitUntil: "commit", timeout: 180000 });
        await page.bringToFront();
        await page.waitForFunction(() => window.__voyageStartup, null, { timeout: 300000, polling: 250 });
        const startup = await page.evaluate(() => window.__voyageStartup);
        const totalMs = Date.now() - t0;
        const entry = { origin, nonce, totalMs, startup, renderer };
        results.push(entry);
        console.log(`[dev-browser] cold #${i + 1}/${repeat}: totalMs=${totalMs}  renderer=${renderer}`);
        console.log(
          Object.entries(startup)
            .map(([k, v]) => `    ${k}: ${v}`)
            .join("\n"),
        );
      } finally {
        // 只是关掉这一轮的 context，浏览器进程留给外层 finally 统一处理；这里超时同样不硬等
        await Promise.race([context.close(), new Promise((r) => setTimeout(r, 5000))]).catch(() => {});
      }
    }
  } finally {
    await closeBrowserSafely(browser);
  }
  if (args.out) fs.writeFileSync(path.join(REPO_ROOT, args.out), JSON.stringify(results, null, 2));
  return results;
}

// ---------- bench：批渲帧时间，多轮交替、剔除离群；--baseline 时两端口对照 ----------
async function cmdBench(args) {
  const port = String(args.port || "");
  if (!port) throw new Error("bench 需要 --port <端口>");
  const baseline = args.baseline ? String(args.baseline) : null;
  const only = args.only ? String(args.only).split(",") : null;
  const frames = Number(args.frames || 30);
  const rounds = Number(args.rounds || 5);
  const ports = baseline ? [port, baseline] : [port];

  const browser = await launchBrowser();
  try {
    const pages = {};
    const renderers = {};
    for (const p of ports) {
      const { page, renderer } = await openPage(browser, p);
      pages[p] = page;
      renderers[p] = renderer;
      console.log(`[dev-browser] ${p}: GL_RENDERER = ${renderer}`);
    }

    const scenes = pickScenes(only);
    const table = [];
    for (const sc of scenes) {
      for (const p of ports) await pages[p].evaluate(applyScene, { sc, defaults: DEFAULTS });
      // 预热一轮，消掉首次调用（着色器变体切换、GC）的抖动
      for (const p of ports) await pages[p].evaluate((n) => window.__voyage.benchFrame(n), Math.min(frames, 10));

      const samples = Object.fromEntries(ports.map((p) => [p, []]));
      // 交替测两端口：同一轮里先测 A 再测 B，避免「一端口连续测」把某一侧偶发的系统抖动全吃掉
      for (let r = 0; r < rounds; r++) {
        for (const p of ports) {
          const ms = await pages[p].evaluate((n) => window.__voyage.benchFrame(n), frames);
          samples[p].push(ms);
        }
      }
      const trimmedMean = (arr) => {
        const sorted = [...arr].sort((a, b) => a - b);
        const trimmed = sorted.length >= 5 ? sorted.slice(1, -1) : sorted; // 掐头去尾剔除离群
        return trimmed.reduce((a, b) => a + b, 0) / trimmed.length;
      };
      const row = { scene: sc.name, samples };
      for (const p of ports) row[p] = +trimmedMean(samples[p]).toFixed(3);
      if (baseline) {
        const base = row[baseline];
        row.deltaPct = base ? +(((row[port] - base) / base) * 100).toFixed(1) : null;
      }
      // GPU timer query：有 EXT_disjoint_timer_query_webgl2 就顺带报一次，没有就是 null（不影响主流程）
      row.gpuMsPerFrame = {};
      for (const p of ports) {
        try {
          row.gpuMsPerFrame[p] = await gpuTimedFrame(pages[p], frames);
        } catch {
          row.gpuMsPerFrame[p] = null;
        }
      }
      table.push(row);
      const gpuNote = ports.some((p) => row.gpuMsPerFrame[p] != null)
        ? "  gpu=" + ports.map((p) => `${p}:${row.gpuMsPerFrame[p]?.toFixed(3) ?? "-"}`).join(",")
        : "";
      console.log(`  ${sc.name}: ` + ports.map((p) => `${p}=${row[p]}ms`).join("  ") + (baseline ? `  Δ=${row.deltaPct}%` : "") + gpuNote);
    }
    console.log(`[dev-browser] renderer: ${JSON.stringify(renderers)}`);
    if (args.out) fs.writeFileSync(path.join(REPO_ROOT, args.out), JSON.stringify({ renderers, table }, null, 2));
    return table;
  } finally {
    await closeBrowserSafely(browser);
  }
}

// ---------- 主入口 ----------
async function main() {
  const [sub, ...rest] = process.argv.slice(2);
  const args = parseArgs(rest);
  if (sub === "shots") await cmdShots(args);
  else if (sub === "cold") await cmdCold(args);
  else if (sub === "bench") await cmdBench(args);
  else {
    console.error("用法：node scripts/dev-browser.mjs <shots|cold|bench> --port <端口> [--only a,b] [--out 路径] [--baseline 端口] [--frames N] [--rounds N] [--repeat N]");
    process.exit(1);
  }
  // playwright-core 有时会留一些内部句柄没清干净（尤其是 GPU 争用导致渲染进程中途崩溃过一次的情况），
  // 光靠事件循环自然清空可能永远不退出；成功也强制退出，不依赖 Node 自然收尾
  process.exit(0);
}

main().catch((err) => {
  console.error(`[dev-browser] 失败：${err.message}`);
  process.exit(1);
});
