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
//   node scripts/dev-browser.mjs shots --port 5230 [--only noon-cumulus,sunset-wing] [--out tmp/screenshot/dev-5230] [--angle d3d11|vulkan] [--viewport WxH] [--dpr N]
//   node scripts/dev-browser.mjs cold  --port 5230 [--repeat 2] [--angle d3d11|vulkan] [--viewport WxH] [--dpr N]
//   node scripts/dev-browser.mjs bench --port 5230 [--baseline 5181] [--only noon-cumulus] [--frames 30] [--rounds 5] [--angle d3d11|vulkan] [--viewport WxH] [--dpr N]
// 也可以用 apps/voyage/package.json 里的 shots / cold / bench 三个 pnpm 脚本（见 README）。
//
// --angle：ANGLE 图形后端，默认 d3d11（Windows 上与生产环境一致，**这是交付验收的口径，不要改**）。
//   vulkan 只用于开发内循环：真冷启动快约 18 倍（无 FXC 优化器），但会藏住 D3D11 专属问题
//   （sampler 上限 16 vs 32、FXC 编译暴涨、X3595 屏幕导数报错），验收前一定要在默认 d3d11 上再跑一次
//   （见 research/DX_SHADER_COMPILE.md 第二节的差异表）。
//
// --viewport WxH：浏览器视口尺寸（如 2400x1800），默认 1600×1200（和 regression.playwright.js 的截图基线一致，
//   DX-03 也把 MCP 版对齐到了这个尺寸；不传就完全保持原行为）。
// --dpr N：deviceScaleFactor，默认 1。二者组合用来模拟高分屏 / 弱 GPU（画布像素 = 视口 × DPR，
//   例如 --viewport 1600x1200 --dpr 1.5 实际绘制 2400×1800），PERF-5 验收时就是这样手工模拟出「高分屏 + typhoon-bands」
//   的过载场景（见 handoff/PERF-5.md）——本任务（DX-04）把这个手法从一次性验收脚本收成通用参数。

import { chromium } from "playwright-core";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { DEFAULTS, applyScene, pickScenes } from "./scenarios.mjs";
import { launchBrowser as launchBrowserAngle, closeBrowserSafely } from "./lib/chrome.mjs";

const VOYAGE_ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const REPO_ROOT = path.join(VOYAGE_ROOT, "..", "..");
const DEFAULT_VIEWPORT = { width: 1600, height: 1200 };
const DEFAULT_DPR = 1;

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

/** --viewport WxH，不传就是默认 1600×1200（原行为不变） */
function parseViewport(args) {
  if (!args.viewport) return { ...DEFAULT_VIEWPORT };
  const m = String(args.viewport).match(/^(\d+)x(\d+)$/i);
  if (!m) throw new Error(`--viewport 格式应为 WxH（如 2400x1800），收到 "${args.viewport}"`);
  return { width: Number(m[1]), height: Number(m[2]) };
}

/** --dpr N（deviceScaleFactor），不传就是默认 1（原行为不变） */
function parseDpr(args) {
  if (args.dpr === undefined) return DEFAULT_DPR;
  const n = Number(args.dpr);
  if (!Number.isFinite(n) || n <= 0) throw new Error(`--dpr 应为正数，收到 "${args.dpr}"`);
  return n;
}

// ---------- 定位并启动本机缓存的完整版 chrome.exe（两个脚本共用，见 lib/chrome.mjs） ----------
const VALID_ANGLES = ["d3d11", "vulkan"];
function launchBrowser(angle) {
  if (!VALID_ANGLES.includes(angle)) {
    throw new Error(`--angle 只接受 ${VALID_ANGLES.join(" | ")}，收到 "${angle}"（gl 后端场景程序链接失败，见 research/DX_SHADER_COMPILE.md）`);
  }
  return launchBrowserAngle(chromium, { angle });
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

/** viewport/dpr 不传就是默认 1600×1200 / DPR1（原行为不变），传了就用来模拟高分屏 / 弱 GPU（见文件头注释） */
async function openPage(browser, port, angle, viewport = DEFAULT_VIEWPORT, dpr = DEFAULT_DPR) {
  const context = await browser.newContext({ viewport, deviceScaleFactor: dpr });
  const page = await context.newPage();
  await installGlProbe(page);
  const renderer = await assertRealGpu(page);
  await page.goto(`${originFor(port)}/?dev=${Date.now()}`, { waitUntil: "commit", timeout: 180000 });
  await page.bringToFront();
  await page.waitForFunction(() => window.__voyageStartup, null, { timeout: 180000, polling: 500 });
  return { context, page, renderer, angle, viewport, dpr };
}

// ---------- shots：跑回归场景表，截图 + 每场景一份同名 JSON ----------
async function cmdShots(args) {
  const port = args.port;
  if (!port) throw new Error("shots 需要 --port <端口>");
  const angle = String(args.angle || "d3d11");
  const only = args.only ? String(args.only).split(",") : null;
  const outDir = path.join(REPO_ROOT, args.out || `tmp/screenshot/dev-${port}`);
  fs.mkdirSync(outDir, { recursive: true });
  const viewport = parseViewport(args);
  const dpr = parseDpr(args);

  const browser = await launchBrowser(angle);
  try {
    const { page, renderer } = await openPage(browser, port, angle, viewport, dpr);
    console.log(`[dev-browser] --angle=${angle}  viewport=${viewport.width}x${viewport.height}  dpr=${dpr}  GL_RENDERER = ${renderer}`);
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
        viewport,
        dpr,
        angle,
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
  const angle = String(args.angle || "d3d11");
  const repeat = Number(args.repeat || 1);
  const viewport = parseViewport(args);
  const dpr = parseDpr(args);
  const origin = originFor(port);
  const browser = await launchBrowser(angle);
  const results = [];
  try {
    for (let i = 0; i < repeat; i++) {
      // 每次独立浏览器上下文：非持久化 context 本身不共享磁盘 profile，加上 nonce 破缓存双重保险
      // （手法抄自 tmp/review-t02/cold.js，开发体验官已实测端到端跑通，见 DX_REPORT_wave2.md §1.2）
      const context = await browser.newContext({ viewport, deviceScaleFactor: dpr });
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
        const entry = { origin, angle, viewport, dpr, nonce, totalMs, startup, renderer };
        results.push(entry);
        console.log(
          `[dev-browser] cold #${i + 1}/${repeat}: --angle=${angle}  viewport=${viewport.width}x${viewport.height}  dpr=${dpr}  totalMs=${totalMs}  renderer=${renderer}`,
        );
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
  const angle = String(args.angle || "d3d11");
  const baseline = args.baseline ? String(args.baseline) : null;
  const only = args.only ? String(args.only).split(",") : null;
  const frames = Number(args.frames || 30);
  const rounds = Number(args.rounds || 5);
  const ports = baseline ? [port, baseline] : [port];
  const viewport = parseViewport(args);
  const dpr = parseDpr(args);

  const browser = await launchBrowser(angle);
  try {
    const pages = {};
    const renderers = {};
    for (const p of ports) {
      const { page, renderer } = await openPage(browser, p, angle, viewport, dpr);
      pages[p] = page;
      renderers[p] = renderer;
      console.log(`[dev-browser] ${p}: --angle=${angle}  viewport=${viewport.width}x${viewport.height}  dpr=${dpr}  GL_RENDERER = ${renderer}`);
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
    if (args.out) fs.writeFileSync(path.join(REPO_ROOT, args.out), JSON.stringify({ angle, viewport, dpr, renderers, table }, null, 2));
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
    console.error(
      "用法：node scripts/dev-browser.mjs <shots|cold|bench> --port <端口> [--angle d3d11|vulkan] [--viewport WxH] [--dpr N] [--only a,b] [--out 路径] [--baseline 端口] [--frames N] [--rounds N] [--repeat N]",
    );
    console.error("  --viewport WxH  浏览器视口尺寸，默认 1600x1200（如 --viewport 2400x1800）");
    console.error("  --dpr N         deviceScaleFactor，默认 1（和 --viewport 组合模拟高分屏 / 弱 GPU）");
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
