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
//   node scripts/dev-browser.mjs check --port 5230 [--angle d3d11|vulkan] [--viewport WxH] [--dpr N]
//   node scripts/dev-browser.mjs shots --port 5230 [--only noon-cumulus,sunset-wing] [--scene '<JSON>' ...]
//                                       [--out tmp/screenshot/dev-5230] [--allow-flash] [--freeze] [--settle]
//                                       [--angle d3d11|vulkan] [--viewport WxH] [--dpr N]
//   node scripts/dev-browser.mjs cold  --port 5230 [--repeat 2] [--angle d3d11|vulkan] [--viewport WxH] [--dpr N]
//   node scripts/dev-browser.mjs bench --port 5230 [--baseline 5181] [--only noon-cumulus] [--frames 30] [--rounds 5] [--angle d3d11|vulkan] [--viewport WxH] [--dpr N]
//   node scripts/dev-browser.mjs flicker --port 5230 --only <场景> [--step 0.06] [--frames 20] [--crop x,y,w,h] [--debug N]
// 也可以用 apps/voyage/package.json 里的 shots / cold / bench 三个 pnpm 脚本（见 README）。
//
// --freeze（DX-08，仅 shots）：截图前调用 __voyage.freeze(true)（main.ts 的调试句柄）钉住位置 / 航向 / 头部 /
//   模拟时间 / 曝光适应 / 闪电 / 翼尖航行灯频闪相位，冻结后连续渲染逐像素一致，可以拿两次 shots 的截图相减
//   （配合 compare.mjs 的 --diff）定位「这一版改动到底动了哪些像素」，不必依赖「同一份代码跑两次」的噪声估计。
// --settle（DX-08，仅 shots）：等 __voyage.ground.pending === 0 再截（默认的 sc.ground 等待用的是更宽松的
//   pending < 5，够看大致画面但地面瓦片可能还在陆续贴上来），逐像素对比前建议加上，否则瓦片加载差异会被
//   误判成回归。
// flicker（DX-08，泛化自 handoff/T08-flicker.mjs + T08-flicker.py + T43-crawl.py）：__voyage.freeze(true) 之后
//   按 --step 毫米（默认 0.06，亚像素）步进微移相机（head.x），连拍 --frames 帧，输出块能量变异系数（T08 法，
//   抗锯齿做对了每块总亮度守恒）与爬行指标（T43 法，二阶差分，抓块能量法量不出的「台阶沿线爬」）。
//
// --out（shots 的截图输出目录）相对**仓库根**解析，不是当前工作目录（T08 开发体验反馈踩过这个坑：
//   写了 `../../tmp/...` 结果传到了仓库外面）。不传就是 `tmp/screenshot/dev-<port>`。
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
//
// check：只开一个页面、等 __voyageStartup 出现（启动完成）、收集期间的 console error / pageerror。
//   有错误就打印全部并以非 0 退出码报告；没有就打印一行确认，退出码 0。用来在提交前快速确认「页面本身没炸」，
//   比跑 shots 截一堆图快（不用等每个场景 2.5 s 的稳定等待）。
//
// shots 的 --scene：每个代理反复手写「T0x-shots.mjs」来拍一次性场景（例如 handoff/T35-shots.mjs 的
// 「看前方 / 看后方」对照），DX-05 把这个模式收成通用参数，不用每个任务都新建一个脚本文件。
//   --scene '<JSON>'：字段和 scenarios.mjs 里 SCENES 数组的条目一致（name 必填，其余同 applyScene 会读的字段）：
//     name    场景名，同时是截图 / JSON 输出的文件名（必填）
//     p       面板控件 id -> 值，如 { "preset": "wpac", "time": 1040, "wing-pos": "8", "cabin-class": "business" }
//     head    头部位置：单个数字只设 z，或 [x, y, z] 三元组（见 scenarios.mjs 文件头注释，T06/T35 常用
//             [-0.42, 0.1, -0.5] 看前方、[0.42, 0.1, -0.5] 看后方、[0, 0.02, -0.42] 默认坐姿）
//     offset  云的世界偏移 [x, y]（uCloudOffset），不填就是 [0, 0]
//     wait    截图前等待的毫秒数，不填是 2500
//     ground  是否要等真实地面瓦片加载
//   可以重复传多次 --scene 拍多个临时场景；和 --only（挑 scenarios.mjs 里的固定场景）可以同时用，
//   两边选中的场景会拼在一起跑。都不传就是原来的行为（全量回归表，或 --only 过滤后的子集）。
//   例：node scripts/dev-browser.mjs shots --port 5247 --scene "{\"name\":\"biz-behind\",\"p\":{\"preset\":\"wpac\",\"time\":720,\"wing-pos\":\"8\",\"cabin-class\":\"business\"},\"head\":[0.42,0.1,-0.5]}"
//
// shots 默认关闪电频闪（DX-07）：`window.__voyage.weather.hold = true` + `heldIntensity = 0`
//   （src/weather.ts 本来就留了这个调试 / 截图开关，这里只是调用，没改 src/）。截图偶尔会撞上一大团
//   闪电白光，糊里糊涂当成回归差异（T08 开发体验反馈）。`--allow-flash` 保留旧行为（正常按泊松过程闪，
//   雷暴 / 台风场景想专门看闪电时用）。
// shots 现在也会打印截图期间的 console error / pageerror 数（和 check 共用同一份收集逻辑），
//   不用再另外跑一次 check 才知道有没有炸。

import { chromium } from "playwright-core";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { DEFAULTS, applyScene, pickScenes } from "./scenarios.mjs";
import { launchBrowser as launchBrowserAngle, closeBrowserSafely, resolveRepoPath } from "./lib/chrome.mjs";
import { sampleAndWarn, waitForQuiet } from "./lib/cpu-load.mjs";
import { tryAcquire, readLock, noticeIfLocked, waitForRelease } from "./lib/measure-lock.mjs";

const VOYAGE_ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const REPO_ROOT = path.join(VOYAGE_ROOT, "..", "..");
const DEFAULT_VIEWPORT = { width: 1600, height: 1200 };
const DEFAULT_DPR = 1;

// ---------- CLI 参数 ----------
// 同名参数重复出现时合并成数组（目前只有 --scene 会用到，见文件头注释；JSON 字符串不会以 "--" 开头，
// 不影响「下一个 token 是不是新 flag」的判断）。
function parseArgs(argv) {
  const out = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith("--")) {
      const key = a.slice(2);
      const next = argv[i + 1];
      let val;
      if (next !== undefined && !next.startsWith("--")) {
        val = next;
        i++;
      } else val = true;
      if (key in out) out[key] = Array.isArray(out[key]) ? [...out[key], val] : [out[key], val];
      else out[key] = val;
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

/** --scene '<JSON>'（可重复）解析成场景对象数组；字段约定见文件头注释，与 scenarios.mjs 的 SCENES 条目一致 */
function parseAdhocScenes(args) {
  if (!args.scene) return [];
  const list = Array.isArray(args.scene) ? args.scene : [args.scene];
  return list.map((raw, i) => {
    let sc;
    try {
      sc = JSON.parse(raw);
    } catch (err) {
      throw new Error(`--scene 第 ${i + 1} 个不是合法 JSON：${err.message}\n收到：${raw}`);
    }
    if (!sc || typeof sc !== "object" || !sc.name) throw new Error(`--scene 第 ${i + 1} 个缺少必填的 "name" 字段：${raw}`);
    if (sc.p === undefined) sc.p = {};
    return sc;
  });
}

/** 合并 --only（挑 scenarios.mjs 里的固定场景）与 --scene（临时场景）：两边都给就拼在一起，
 * 都不给就是原来的行为（pickScenes(null) 返回全量表）。 */
function resolveScenes(args) {
  const only = args.only ? String(args.only).split(",") : null;
  const adhoc = parseAdhocScenes(args);
  if (adhoc.length === 0) return pickScenes(only);
  return [...(only ? pickScenes(only) : []), ...adhoc];
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

// DX-10：check / shots 不持测量锁（它们本来就轻量，不是离线 FXC / 真冷启动 / 按 pass GPU 计时那种重负载），
// 但发现锁存在时打印一句提示（别人可能正在测量，这里的浏览器会给它添负载）；--respect-lock 时改成先等锁释放。
async function noticeOrRespectLock(args, context) {
  if (args["respect-lock"]) {
    const lock = readLock(REPO_ROOT);
    if (lock) await waitForRelease(REPO_ROOT, { log: (s) => console.log(`[dev-browser] ${s}`) });
  } else {
    noticeIfLocked(REPO_ROOT, context);
  }
}

// ---------- check：只开页面、等启动完成、收集 console error / pageerror ----------
async function cmdCheck(args) {
  const port = args.port;
  if (!port) throw new Error("check 需要 --port <端口>");
  const angle = String(args.angle || "d3d11");
  const viewport = parseViewport(args);
  const dpr = parseDpr(args);
  await noticeOrRespectLock(args, "check");

  const browser = await launchBrowser(angle);
  try {
    const { renderer, errors } = await openPage(browser, port, angle, viewport, dpr, { collectErrors: true });
    // 启动完成（__voyageStartup 出现）后再等一小段时间，抓头几帧才触发的异常（例如某个 pass 首次
    // draw 才暴露的问题），不然掐着 waitForFunction 一 resolve 就关页面，可能漏掉这类错误。
    await new Promise((r) => setTimeout(r, 1500));
    console.log(`[dev-browser] check --angle=${angle}  viewport=${viewport.width}x${viewport.height}  dpr=${dpr}  GL_RENDERER = ${renderer}`);
    if (errors.length === 0) {
      console.log(`[dev-browser] 没有 console error / pageerror。`);
    } else {
      console.error(`[dev-browser] 发现 ${errors.length} 条错误：`);
      for (const e of errors) console.error(`  [${e.type}] ${e.text}`);
    }
    return { ok: errors.length === 0, errors };
  } finally {
    await closeBrowserSafely(browser);
  }
}

/** viewport/dpr 不传就是默认 1600×1200 / DPR1（原行为不变），传了就用来模拟高分屏 / 弱 GPU（见文件头注释）。
 * opts.collectErrors 为 true 时，在 goto 之前挂上 console/pageerror 监听，返回值里带一个 errors 数组
 * （check 子命令用；shots/cold/bench 不传这个选项，行为完全不变）。 */
async function openPage(browser, port, angle, viewport = DEFAULT_VIEWPORT, dpr = DEFAULT_DPR, opts = {}) {
  const context = await browser.newContext({ viewport, deviceScaleFactor: dpr });
  const page = await context.newPage();
  const errors = [];
  if (opts.collectErrors) {
    page.on("console", (m) => {
      if (m.type() === "error") errors.push({ type: "console", text: m.text() });
    });
    page.on("pageerror", (e) => errors.push({ type: "pageerror", text: e.message }));
  }
  await installGlProbe(page);
  const renderer = await assertRealGpu(page);
  await page.goto(`${originFor(port)}/?dev=${Date.now()}`, { waitUntil: "commit", timeout: 180000 });
  await page.bringToFront();
  await page.waitForFunction(() => window.__voyageStartup, null, { timeout: 180000, polling: 500 });
  return { context, page, renderer, angle, viewport, dpr, errors };
}

/** DX-07：默认关闭闪电频闪（weather.hold + heldIntensity = 0，见 src/weather.ts 的 update()：
 * hold 为 true 时不再触发新闪电、亮度锁在 heldIntensity），不然截图偶尔会撞上一大团白光，
 * 差点被当成回归（T08 开发体验反馈）。这个开关本来就是给调试 / 截图用的（weather.ts 注释原话），
 * 只是调用它，不改 src/。--allow-flash 保留旧行为（正常按泊松过程闪）。 */
async function setFlashDisabled(page, disabled) {
  return page.evaluate((disabled) => {
    const w = window.__voyage && window.__voyage.weather;
    if (!w) return false;
    if (disabled) {
      w.hold = true;
      w.heldIntensity = 0;
    } else {
      w.hold = false;
    }
    return true;
  }, disabled);
}

// ---------- shots：跑回归场景表，截图 + 每场景一份同名 JSON ----------
async function cmdShots(args) {
  const port = args.port;
  if (!port) throw new Error("shots 需要 --port <端口>");
  const angle = String(args.angle || "d3d11");
  const outDir = resolveRepoPath(REPO_ROOT, args.out || `tmp/screenshot/dev-${port}`);
  fs.mkdirSync(outDir, { recursive: true });
  const viewport = parseViewport(args);
  const dpr = parseDpr(args);
  const allowFlash = Boolean(args["allow-flash"]);
  const freeze = Boolean(args.freeze);
  const settle = Boolean(args.settle);
  await noticeOrRespectLock(args, "shots");

  const browser = await launchBrowser(angle);
  try {
    // collectErrors：截图期间的 console error / pageerror 数一并打印出来（DX-07），不用另外跑一次 check
    const { page, renderer, errors } = await openPage(browser, port, angle, viewport, dpr, { collectErrors: true });
    console.log(`[dev-browser] --angle=${angle}  viewport=${viewport.width}x${viewport.height}  dpr=${dpr}  GL_RENDERER = ${renderer}`);
    if (!allowFlash) {
      const applied = await setFlashDisabled(page, true);
      console.log(`[dev-browser] 默认关闭雷电频闪${applied ? "" : "（没找到 window.__voyage.weather，跳过）"}（--allow-flash 保留旧行为）`);
    }
    const scenes = resolveScenes(args);
    const results = [];
    for (const sc of scenes) {
      const info = await page.evaluate(applyScene, { sc, defaults: DEFAULTS, settle });
      // --freeze（DX-08）：截图前钉住位置 / 航向 / 头部 / 模拟时间 / 曝光适应 / 闪电 / 翼尖频闪相位
      // （__voyage.freeze，见 main.ts），冻结后连续渲染逐像素一致，可用来做两图相减定位。
      // 多等两帧让第一帧的残留 dt 归零（freeze 那一刻可能刚好在两次 rAF 中间）；截图后立刻解冻，
      // 不影响紧接着的 benchFrame 计时（那条路本来就不经过 frame()，freeze 状态对它没有实际影响，
      // 这里解冻只是让后续场景恢复正常节奏）。
      if (freeze) {
        await page.evaluate(() => window.__voyage.freeze(true));
        await page.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))));
      }
      const pngPath = path.join(outDir, `${sc.name}.png`);
      await page.screenshot({ path: pngPath, timeout: 60000 });
      if (freeze) await page.evaluate(() => window.__voyage.freeze(false));
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
    console.log(`[dev-browser] 完成，共 ${results.length} 个场景，输出目录 ${path.relative(REPO_ROOT, outDir).replace(/\\/g, "/")}（--out 相对仓库根解析）`);
    if (errors.length === 0) {
      console.log(`[dev-browser] 截图期间没有 console error / pageerror。`);
    } else {
      console.error(`[dev-browser] 截图期间共 ${errors.length} 条 console error / pageerror：`);
      for (const e of errors) console.error(`  [${e.type}] ${e.text}`);
    }
    return results;
  } finally {
    await closeBrowserSafely(browser);
  }
}

// ---------- cold：真冷启动（nonce 破缓存 + 每次独立浏览器上下文） ----------
// DX-10：真冷启动对机器负载敏感（编译在 CPU 上做），持测量锁 + 每轮前采样 CPU 占用；--wait-quiet 先等安静再测。
async function cmdCold(args) {
  const port = args.port;
  if (!port) throw new Error("cold 需要 --port <端口>");
  const angle = String(args.angle || "d3d11");
  const repeat = Number(args.repeat || 1);
  const viewport = parseViewport(args);
  const dpr = parseDpr(args);
  const origin = originFor(port);

  if (args["wait-quiet"]) await waitForQuiet({ log: (s) => console.log(`[dev-browser] ${s}`) });
  const releaseLock = tryAcquire(REPO_ROOT, `dev-browser.mjs cold（端口 ${port}, pid ${process.pid}, ${new Date().toLocaleTimeString("zh-CN", { hour12: false })}）`);
  if (!releaseLock) {
    const lock = readLock(REPO_ROOT);
    console.warn(`[dev-browser] 测量锁被占用（持有者：${lock ? lock.owner.split("\n")[0] : "未知"}），继续测量但结果可能被对方的负载污染（反之亦然）`);
  }

  const browser = await launchBrowser(angle);
  const results = [];
  try {
    for (let i = 0; i < repeat; i++) {
      const cpuLoad = sampleAndWarn(`cold 第 ${i + 1}/${repeat} 轮之前`);
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
        const entry = { origin, angle, viewport, dpr, nonce, totalMs, startup, renderer, cpuLoadPercent: cpuLoad };
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
    if (releaseLock) releaseLock();
  }
  if (args.out) fs.writeFileSync(resolveRepoPath(REPO_ROOT, args.out), JSON.stringify(results, null, 2));
  return results;
}

// ---------- flicker：冻结后亚像素步进微移相机连拍 N 帧，块能量 CV（T08 法）+ 爬行指标（T43 法）----------
// 泛化自 handoff/T08-flicker.mjs（+ T08-flicker.py 的块能量变异系数）与 handoff/T43-crawl.py（二阶差分爬行指标）。
// 原理：__voyage.freeze(true) 钉住一切按 dt 累积的状态（见 main.ts），只手动步进 head.x（相机横向亚像素位移，
// 绕过头部平滑——冻结时 dt=0，head.tx 目标不会再被追上）。线在屏幕上滑动时，抗锯齿做对了：
//   - 块能量守恒：把画面切成小块，每块总亮度随帧几乎不变（T08 法，输出变异系数 CV = std/mean）；
//   - 亮度平滑变化：每个像素的亮度随时间线性变化，二阶差分 ≈ 0（T43 法）——盒式足迹的台阶会让二阶差分很大，
//     块能量法量不出台阶移动（块能量本身仍守恒），所以两个指标都要看。
function parseXYWH(s, label) {
  const nums = String(s).split(",").map(Number);
  if (nums.length !== 4 || nums.some((n) => !Number.isFinite(n))) throw new Error(`${label} 格式应为 x,y,w,h，收到 "${s}"`);
  const [x, y, w, h] = nums;
  return { x, y, w, h };
}

/** 在（已经打开的）页面里解码 N 张截图、算块能量 CV 与爬行指标；不需要真实 GPU，只用 Canvas2D。 */
async function analyzeFlicker(page, files, crop, blockSize) {
  const dataUrls = files.map((f) => `data:image/png;base64,${fs.readFileSync(f).toString("base64")}`);
  return page.evaluate(
    async ({ dataUrls, crop, blockSize }) => {
      const loadImg = (src) =>
        new Promise((resolve, reject) => {
          const img = new Image();
          img.onload = () => resolve(img);
          img.onerror = () => reject(new Error("图片解码失败"));
          img.src = src;
        });
      const imgs = await Promise.all(dataUrls.map(loadImg));
      const x0 = crop ? crop.x : 0;
      const y0 = crop ? crop.y : 0;
      const w = crop ? crop.w : imgs[0].naturalWidth;
      const h = crop ? crop.h : imgs[0].naturalHeight;
      const T = imgs.length;
      const lumas = imgs.map((img) => {
        const c = document.createElement("canvas");
        c.width = w;
        c.height = h;
        const ctx = c.getContext("2d");
        ctx.drawImage(img, x0, y0, w, h, 0, 0, w, h);
        const data = ctx.getImageData(0, 0, w, h).data;
        const lum = new Float64Array(w * h);
        for (let p = 0, j = 0; p < data.length; p += 4, j++) lum[j] = 0.2126 * data[p] + 0.7152 * data[p + 1] + 0.0722 * data[p + 2];
        return lum;
      });
      const percentile = (arr, p) => {
        if (arr.length === 0) return NaN;
        const idx = (p / 100) * (arr.length - 1);
        const lo = Math.floor(idx);
        const hi = Math.ceil(idx);
        return lo === hi ? arr[lo] : arr[lo] + (arr[hi] - arr[lo]) * (idx - lo);
      };
      // ---- T08 法：块能量变异系数（块内总亮度对时间的 std/mean），排除太暗的块 ----
      const cvs = [];
      for (let by = 0; by + blockSize <= h; by += blockSize) {
        for (let bx = 0; bx + blockSize <= w; bx += blockSize) {
          const sums = new Array(T).fill(0);
          for (let t = 0; t < T; t++) {
            let s = 0;
            for (let y = by; y < by + blockSize; y++) for (let x = bx; x < bx + blockSize; x++) s += lumas[t][y * w + x];
            sums[t] = s;
          }
          const mean = sums.reduce((a, b) => a + b, 0) / T;
          if (mean / (blockSize * blockSize) < 3) continue; // 太暗（全黑块）会把中位数拉低，排除
          const variance = sums.reduce((a, b) => a + (b - mean) ** 2, 0) / T;
          cvs.push(Math.sqrt(variance) / mean);
        }
      }
      cvs.sort((a, b) => a - b);
      // ---- T43 法：亮像素上 |I(t+1) - 2I(t) + I(t-1)| 的均值 ÷ 亮度均值（爬行指标）；一阶差分做参考 ----
      const N = w * h;
      const mean = new Float64Array(N);
      for (let j = 0; j < N; j++) {
        let s = 0;
        for (let t = 0; t < T; t++) s += lumas[t][j];
        mean[j] = s / T;
      }
      let sumD2 = 0, sumD1 = 0, sumBrightMean = 0, brightCount = 0;
      const jitVals = []; // T08 法自己的逐像素抖动（亮像素阈值不同，见下）
      for (let j = 0; j < N; j++) {
        if (mean[j] <= 12) continue;
        let d2 = 0;
        for (let t = 1; t < T - 1; t++) d2 += Math.abs(lumas[t + 1][j] - 2 * lumas[t][j] + lumas[t - 1][j]);
        let d1 = 0;
        for (let t = 1; t < T; t++) d1 += Math.abs(lumas[t][j] - lumas[t - 1][j]);
        d2 /= Math.max(1, T - 2);
        d1 /= Math.max(1, T - 1);
        sumD2 += d2;
        sumD1 += d1;
        sumBrightMean += mean[j];
        brightCount++;
        if (mean[j] > 20) jitVals.push(d1 / mean[j]);
      }
      jitVals.sort((a, b) => a - b);
      return {
        frames: T,
        crop: { x: x0, y: y0, w, h },
        blocks: cvs.length,
        cvMedian: percentile(cvs, 50),
        cvP90: percentile(cvs, 90),
        cvP98: percentile(cvs, 98),
        crawlD2: brightCount ? sumD2 / sumBrightMean : NaN,
        crawlD1: brightCount ? sumD1 / sumBrightMean : NaN,
        pixelJitterMedian: percentile(jitVals, 50),
        brightPixels: brightCount,
      };
    },
    { dataUrls, crop, blockSize },
  );
}

async function cmdFlicker(args) {
  const port = args.port;
  if (!port) throw new Error("flicker 需要 --port <端口>");
  const angle = String(args.angle || "d3d11");
  const viewport = parseViewport(args);
  const dpr = parseDpr(args);
  const outDir = resolveRepoPath(REPO_ROOT, args.out || `tmp/screenshot/dev-${port}-flicker`);
  fs.mkdirSync(outDir, { recursive: true });
  const frames = Number(args.frames || 20);
  // 每帧头部横向位移（毫米），W01b-flicker.mjs 用过 0.06 mm 这个量级（亚像素、不引入可见的构图变化）
  const stepMm = Number(args.step ?? 0.06);
  const blockSize = Number(args.block || 48);
  const crop = args.crop ? parseXYWH(args.crop, "--crop") : null;
  const debugMode = args.debug !== undefined ? Number(args.debug) : null;
  const settle = Boolean(args.settle);

  const scenes = resolveScenes(args);
  if (scenes.length !== 1) throw new Error(`flicker 一次只测一个场景（用 --only 单选一个，或传一个 --scene），收到 ${scenes.length} 个`);
  const sc = scenes[0];

  const browser = await launchBrowser(angle);
  try {
    const { page, renderer } = await openPage(browser, port, angle, viewport, dpr);
    console.log(`[dev-browser] flicker --angle=${angle}  viewport=${viewport.width}x${viewport.height}  dpr=${dpr}  GL_RENDERER = ${renderer}`);
    await page.evaluate(applyScene, { sc, defaults: DEFAULTS, settle });
    if (debugMode !== null) await page.evaluate((d) => { window.__voyage.sceneMat.uniforms.uDebug.value = d; }, debugMode);
    // 冻结（DX-08）：位置 / 航向 / 模拟时间 / 曝光适应 / 闪电 / 频闪相位全部钉住，只由下面手动步进 head.x
    await page.evaluate(() => window.__voyage.freeze(true));
    await page.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))));
    const stepM = stepMm / 1000;
    const files = [];
    for (let i = 0; i < frames; i++) {
      if (i > 0) await page.evaluate((dx) => { window.__voyage.head.x += dx; }, stepM);
      // 等两帧真正画出新的 head.x（frame() 里 renderFrame 每次都读最新的 head.x，不缓存）
      await page.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))));
      const file = path.join(outDir, `f${String(i).padStart(2, "0")}.png`);
      await page.screenshot({ path: file, timeout: 60000 });
      files.push(file);
    }
    await page.evaluate(() => window.__voyage.freeze(false));
    console.log(`[dev-browser] ${sc.name}：${frames} 帧，每帧头部 +${stepMm} mm，输出 ${path.relative(REPO_ROOT, outDir).replace(/\\/g, "/")}`);
    const stats = await analyzeFlicker(page, files, crop, blockSize);
    console.log(`  块能量 CV（T08 法）中位 ${stats.cvMedian.toFixed(4)} / p90 ${stats.cvP90.toFixed(4)} / p98 ${stats.cvP98.toFixed(4)}（${stats.blocks} 个块，边长 ${blockSize}）`);
    console.log(`  爬行指标（T43 法，二阶差分/亮度）${stats.crawlD2.toFixed(4)}（一阶差分/亮度 ${stats.crawlD1.toFixed(4)} 做参考，亮像素 ${stats.brightPixels}）`);
    if (args.out) fs.writeFileSync(path.join(outDir, "stats.json"), JSON.stringify({ scene: sc.name, stepMm, debug: debugMode, ...stats }, null, 2));
    return stats;
  } finally {
    await closeBrowserSafely(browser);
  }
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
    if (args.out) fs.writeFileSync(resolveRepoPath(REPO_ROOT, args.out), JSON.stringify({ angle, viewport, dpr, renderers, table }, null, 2));
    return table;
  } finally {
    await closeBrowserSafely(browser);
  }
}

// ---------- 主入口 ----------
async function main() {
  const [sub, ...rest] = process.argv.slice(2);
  const args = parseArgs(rest);
  let result;
  if (sub === "check") result = await cmdCheck(args);
  else if (sub === "shots") result = await cmdShots(args);
  else if (sub === "cold") result = await cmdCold(args);
  else if (sub === "bench") result = await cmdBench(args);
  else if (sub === "flicker") result = await cmdFlicker(args);
  else {
    console.error(
      "用法：node scripts/dev-browser.mjs <check|shots|cold|bench|flicker> --port <端口> [--angle d3d11|vulkan] [--viewport WxH] [--dpr N] [--only a,b] [--scene '<JSON>' ...] [--out 路径] [--allow-flash] [--freeze] [--settle] [--baseline 端口] [--frames N] [--rounds N] [--repeat N] [--wait-quiet] [--respect-lock]",
    );
    console.error("  check           只开页面、等启动完成、收集 console error / pageerror，有错误就非 0 退出");
    console.error("  --wait-quiet    仅 cold（DX-10）：测量前先等 CPU 占用降到 50% 以下再开始");
    console.error("  --respect-lock  仅 check / shots（DX-10）：发现测量锁（tmp/measure.lock）时先等它释放，而不只是打印提示");
    console.error("  --viewport WxH  浏览器视口尺寸，默认 1600x1200（如 --viewport 2400x1800）");
    console.error("  --dpr N         deviceScaleFactor，默认 1（和 --viewport 组合模拟高分屏 / 弱 GPU）");
    console.error("  --scene '<JSON>'  仅 shots / flicker：临时场景，字段同 scenarios.mjs 的 SCENES 条目，可重复（shots 可与 --only 并用）");
    console.error("  --out 路径      shots / cold / bench / flicker 的输出路径：绝对路径原样使用，相对路径按仓库根解析");
    console.error("                  （worktree 里就是 worktree 根；shots 不传是 tmp/screenshot/dev-<端口>）");
    console.error("  --allow-flash   仅 shots：不关闭雷电频闪（默认关，见 weather.ts 的 hold / heldIntensity 开关）");
    console.error("  --freeze        仅 shots（DX-08）：截图前 __voyage.freeze(true)——位置 / 航向 / 头部 / 模拟时间 /");
    console.error("                  曝光适应 / 闪电 / 翼尖频闪相位全部钉住，连续渲染逐像素一致，适合两图相减找回归");
    console.error("  --settle        仅 shots（DX-08）：等 ground.pending === 0 再截（而不是默认的 pending<5），逐像素对比用");
    console.error("  flicker         冻结后按亚像素步进（--step 毫米，默认 0.06）微移相机（head.x）连拍 --frames 帧（默认 20），");
    console.error("                  输出块能量变异系数（T08 法）与爬行指标（T43 法）；--crop x,y,w,h 限定统计区域，");
    console.error("                  --block N 块边长（默认 48），--debug N 设 uDebug，一次只测一个场景（--only 单选或单个 --scene）");
    process.exit(1);
  }
  // playwright-core 有时会留一些内部句柄没清干净（尤其是 GPU 争用导致渲染进程中途崩溃过一次的情况），
  // 光靠事件循环自然清空可能永远不退出；成功也强制退出，不依赖 Node 自然收尾
  process.exit(sub === "check" && result && result.ok === false ? 1 : 0);
}

main().catch((err) => {
  console.error(`[dev-browser] 失败：${err.message}`);
  process.exit(1);
});
