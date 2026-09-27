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
//   node scripts/dev-browser.mjs check --port 5230 [--angle d3d11|vulkan] [--viewport WxH] [--dpr N] [--query '<url参数>']
//   node scripts/dev-browser.mjs shots --port 5230 [--only noon-cumulus,sunset-wing] [--scene '<JSON>' ...]
//                                       [--scenes-file 路径.json] [--query '<url参数>']
//                                       [--out tmp/screenshot/dev-5230] [--allow-flash] [--freeze] [--settle]
//                                       [--pair '<js1>' --pair '<js2>' | --base-shader <端口|目录|提交> [--material sceneMat]]
//                                       [--angle d3d11|vulkan] [--viewport WxH] [--dpr N]
//   node scripts/dev-browser.mjs cold  --port 5230 [--repeat 2] [--baseline 5181] [--angle d3d11|vulkan] [--viewport WxH] [--dpr N]
//   node scripts/dev-browser.mjs bench --port 5230 [--baseline 5181] [--only noon-cumulus] [--frames 30] [--rounds 5] [--angle d3d11|vulkan] [--viewport WxH] [--dpr N]
//   node scripts/dev-browser.mjs flicker --port 5230 --only <场景> [--step 0.06] [--frames 20] [--crop x,y,w,h] [--debug N]
// 也可以用 apps/voyage/package.json 里的 shots / cold / bench 三个 pnpm 脚本（见 README）。
//
// --scenes-file（DX-12）：一个场景数组的 JSON 文件（字段和 --scene 一致），免去命令行 JSON 转义——一个带
//   js 字段的场景拼成命令行参数经常因为 PowerShell / Git Bash 各自的引号规则不同而转义出错。可以和
//   --only / --scene 一起用，都不传就是原来的行为。
// --query '<url参数>'（DX-12）：附加到导航 URL 的额外查询参数（如 "eox=2024"、"?optics=all"），验证只受
//   URL 控制、面板上没有对应控件的行为（例如地面影像年份切换）。
// --pair/--ab + --base-shader（DX-12，PERF-12/TR07 反馈）：仅 shots，同一页面同一机位冻结后先后拍两张，
//   解决「批量截图时飞机一直在飞，只拨一个开关的同机位对照拍不成」。--pair '<js1>' --pair '<js2>' 时两张
//   各自跑一段任意 js；--base-shader <端口|目录|提交> 时第二张换成「换上另一棵树的着色器原文」（PERF-12-ab.mjs
//   的三段式对照：a → 换基线着色器拍 b → 换回原文拍 a2 当噪声底），--pair 此时至多给一段「拍 a 之前」的
//   预设置 js。冻结前会先 pinGeometry（钉回场景该有的头部 / 云偏移，见 scenarios.mjs），并把翼尖频闪钉死
//   为灭（PERF-13 反馈，避免夜景冻结截图撞上全白窗）。详见 README「调试与验证」。
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
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createServer } from "vite";
import { DEFAULTS, applyScene, pickScenes, pinGeometry } from "./scenarios.mjs";
import { launchBrowser as launchBrowserAngle, closeBrowserSafely, resolveRepoPath } from "./lib/chrome.mjs";
import { sampleAndWarn, waitForQuiet } from "./lib/cpu-load.mjs";
import { tryAcquire, readLock, noticeIfLocked, waitForRelease } from "./lib/measure-lock.mjs";
import { resolveExistingDirRoot, resolveCommitRoot } from "./lib/baseline-root.mjs";
import { collectPrograms } from "./lint-shaders.mjs";

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

/** --scenes-file <路径.json>（DX-12）：文件里放一个场景数组（字段和 --scene 的 JSON、SCENES 条目
 * 一致），免去命令行 JSON 转义——Windows 上 PowerShell / Git Bash 各自的引号规则不一样，一个稍微复杂点
 * 的场景（带 js 字段）拼成命令行参数经常因为转义错误直接报「不是合法 JSON」。路径相对仓库根解析
 * （和 --out 一致），也接受绝对路径。 */
function parseScenesFile(args) {
  if (!args["scenes-file"]) return [];
  const raw = resolveRepoPath(REPO_ROOT, String(args["scenes-file"]));
  if (!fs.existsSync(raw)) throw new Error(`--scenes-file 找不到文件：${args["scenes-file"]}`);
  let list;
  try {
    list = JSON.parse(fs.readFileSync(raw, "utf8"));
  } catch (err) {
    throw new Error(`--scenes-file "${args["scenes-file"]}" 不是合法 JSON：${err.message}`);
  }
  if (!Array.isArray(list)) throw new Error(`--scenes-file "${args["scenes-file"]}" 应该是一个场景数组`);
  list.forEach((sc, i) => {
    if (!sc || typeof sc !== "object" || !sc.name) throw new Error(`--scenes-file 第 ${i + 1} 个场景缺少必填的 "name" 字段`);
    if (sc.p === undefined) sc.p = {};
  });
  return list;
}

/** 合并 --only（挑 scenarios.mjs 里的固定场景）、--scene（临时场景）与 --scenes-file（场景数组文件，
 * DX-12）：三者都给就拼在一起，都不给就是原来的行为（pickScenes(null) 返回全量表）。 */
function resolveScenes(args) {
  const only = args.only ? String(args.only).split(",") : null;
  const adhoc = [...parseAdhocScenes(args), ...parseScenesFile(args)];
  if (adhoc.length === 0) return pickScenes(only);
  return [...(only ? pickScenes(only) : []), ...adhoc];
}

/** --query '<url 参数>'（DX-12）：附加到导航 URL 的额外查询参数，例如 "?eox=2024" 或 "optics=all"
 * （带不带开头的 "?" 都可以）。用来验证「地面影像年份切换」「强制罕见光学现象」这类只受 URL 参数控制、
 * 面板上没有对应控件的行为，不用每次都手改 openPage 里写死的 "dev=<时间戳>"。 */
function parseExtraQuery(args) {
  if (!args.query) return "";
  const q = String(args.query).replace(/^\?/, "");
  return q ? `&${q}` : "";
}

/** --pair '<js1>' --pair '<js2>'（或 --ab，同样重复传两次；DX-12）：同一页面、同一机位，冻结后先后跑两段
 * js、各拍一张——解决「批量截图飞机一直在飞，只拨一个开关的同机位对照拍不成」（任务背景，见 cmdShots）。
 * 两段 js 必须都给（正好两次），和 --scene 一样靠重复同名 flag 传参，不必再教 parseArgs 认「一个 flag 后面
 * 跟两个位置参数」这种新语法。 */
// DX-12（PERF-12/TR07 反馈）：给了 --base-shader 时，第二张不再是任意 js，而是「同一机位换上另一棵树的
// 着色器原文」，此时 --pair/--ab 至多给一段「拍 a 之前」的预设置 js（0 或 1 个都行）；没给 --base-shader
// 还是原来的规矩——必须正好两段 js。
function parsePairJs(args) {
  const raw = args.pair !== undefined ? args.pair : args.ab;
  if (raw === undefined) return null;
  if (args.pair !== undefined && args.ab !== undefined) throw new Error("--pair 和 --ab 是同一个功能的两个名字，只传其中一个");
  const arr = Array.isArray(raw) ? raw : [raw];
  if (args["base-shader"]) {
    if (arr.length > 1) throw new Error(`--base-shader 模式下 --pair/--ab 至多给一段 js（拍 a 之前的预设置），收到 ${arr.length} 个`);
    return arr;
  }
  if (arr.length !== 2) {
    throw new Error(
      `--pair/--ab 需要正好两段 js（把这个参数重复传两次，如 --pair 'a' --pair 'b'），收到 ${arr.length} 个；` +
        "换上另一棵树的着色器做对照时改传 --base-shader <端口|目录|提交>，那种模式下 --pair 至多给一段预设置 js",
    );
  }
  return arr;
}

// --scenes-file / --scene 里的场景可能带 "view-preset"（DX-12，见 scenarios.mjs 头部注释），quality / date /
// time 没有对应的 DEFAULTS 键，一并加进要读的面板控件列表里
const PANEL_META_IDS = [...Object.keys(DEFAULTS), "view-preset", "quality", "date", "time"];

/** 截图 JSON 附面板值 / 日期 / 太阳 / 月亮高度 / 画质档（DX-12）：面板值按 PANEL_META_IDS 逐个读控件的
 * 当前值（老版本页面缺某个控件就跳过，不中断——和 applyScene 的 set() 同一套容错），太阳 / 月亮高度靠
 * main.ts 新加的 __voyage.sunAltDeg()/moonAltDeg()（老版本页面没有就是 null），画质档直接读已经暴露在
 * __voyage 上的 quality 对象。 */
async function collectShotMeta(page) {
  return page.evaluate((ids) => {
    const panel = {};
    for (const id of ids) {
      const el = document.getElementById(id);
      if (!el) continue;
      panel[id] = el.type === "checkbox" ? el.checked : el.value;
    }
    const v = window.__voyage;
    return {
      panel,
      date: document.getElementById("date")?.value ?? null,
      sunAltDeg: v && typeof v.sunAltDeg === "function" ? +v.sunAltDeg().toFixed(2) : null,
      moonAltDeg: v && typeof v.moonAltDeg === "function" ? +v.moonAltDeg().toFixed(2) : null,
      quality: v && v.quality ? { tier: v.quality.tier, level: v.quality.level, describe: v.quality.describe() } : null,
    };
  }, PANEL_META_IDS);
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
    const { renderer, errors } = await openPage(browser, port, angle, viewport, dpr, { collectErrors: true, extraQuery: parseExtraQuery(args) });
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
  // --query（DX-12）：附加到导航 URL 的额外查询参数（例如 "&eox=2024"），不传就是原来的行为
  await page.goto(`${originFor(port)}/?dev=${Date.now()}${opts.extraQuery || ""}`, { waitUntil: "commit", timeout: 180000 });
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

/** DX-12（PERF-13 反馈）：冻结截图时把翼尖航行灯频闪也钉死为「灭」，不只是冻结相位。__voyage.freeze(true)
 * 本身已经把频闪相位钉在冻结那一刻（main.ts 的 uStrobe 按相位算），但那一刻可能恰好落在「亮」的窗口
 * （main.ts：ph < 0.05 或 0.14–0.19 时 uStrobe=1，机翼贴着整片窗，夜景冻结截图偶尔会撞上一整块过曝
 * 白光，误判成回归）。main.ts 本来就留了 wingDebug.strobe 这个调试句柄（数字时频闪固定在这个亮度，
 * null 按正常节奏闪，见其注释「截『闪亮瞬间』用」），这里只是调用，不改 src/。 */
async function setWingStrobe(page, value) {
  return page.evaluate((value) => {
    const w = window.__voyage && window.__voyage.wingDebug;
    if (!w) return false;
    w.strobe = value;
    return true;
  }, value);
}

// ---------- --pair/--ab + --base-shader（DX-12，PERF-12/TR07 反馈追加）----------
// --pair/--ab 本身（parsePairJs / collectShotMeta，见上）已经解决「同一页面同一机位，冻结后先后跑两段
// js 各拍一张」；这里补的是 --base-shader <端口|目录|提交> [--material sceneMat]：把第二张换成「同一机位、
// 换上另一棵树的着色器原文」而不是任意 js——PERF-12-ab.mjs 的三段式对照手法（拍 a → 换上基线着色器拍 b →
// 换回原文拍 a2 当噪声底，a2 应该和 a 几乎逐像素一致，不一致说明「换材质」这个动作本身有副作用，不能只信
// a/b 的差异），收进 cmdShots 的 pairJs 分支（见下）。

/** --material 点号路径 -> collectPrograms（lint-shaders.mjs）枚举出的程序 id，只有这张表里的材质
 * 才能用「目录 / 提交」当 --base-shader（离线枚举，不用真起开发服务器）；传端口号不受此限制（直接读
 * 那个端口页面上材质此刻的 fragmentShader，见 resolveBaseShaderSource）。 */
const MATERIAL_TO_PROGRAM_ID = {
  sceneMat: "scene-default",
  outsideMat: "outside-default",
  wingMat: "wing",
  "clouds.marchMat": "cloud-march",
  "clouds.resolveMat": "cloud-resolve",
};

/** 解析 --base-shader 的值，返回目标材质的 fragmentShader 原文。
 *   看起来像端口号（纯数字）：起一个短命页面，直接读那个端口此刻页面上这个材质的 fragmentShader
 *     （最贴近「真的跑起来长什么样」，要求那个端口的开发服务器正在跑，和 handoff/PERF-12-ab.mjs 的
 *     --base <端口> 一致）。
 *   否则当「目录（另一个 voyage 应用根 / 含 apps/voyage 的仓库根）或 git 提交」处理：离线用
 *     vite ssrLoadModule 枚举程序（collectPrograms，和 shader-budget.mjs --baseline/--chain 同一套
 *     手法），不用真起开发服务器；--material 必须在 MATERIAL_TO_PROGRAM_ID 表里有映射。 */
async function resolveBaseShaderSource(spec, materialPath, { browser, angle }) {
  const trimmed = String(spec).trim();
  if (/^\d{2,5}$/.test(trimmed) && !fs.existsSync(path.isAbsolute(trimmed) ? trimmed : path.join(REPO_ROOT, trimmed))) {
    const { context, page } = await openPage(browser, trimmed, angle);
    try {
      const src = await page.evaluate((materialPath) => {
        const resolvePath = (root, p) => p.split(".").reduce((o, k) => (o == null ? o : o[k]), root);
        const m = resolvePath(window.__voyage, materialPath);
        if (!m || typeof m.fragmentShader !== "string") throw new Error(`端口 ${materialPath} 解析不到材质`);
        return m.fragmentShader;
      }, materialPath);
      console.log(`[dev-browser] --base-shader 端口 ${trimmed}：读到材质 "${materialPath}" 的 fragmentShader（${src.length} 字符）`);
      return src;
    } finally {
      await context.close();
    }
  }
  const programId = MATERIAL_TO_PROGRAM_ID[materialPath];
  if (!programId) {
    throw new Error(
      `--base-shader 传目录 / 提交时，--material "${materialPath}" 没有对应的离线程序 id（见 dev-browser.mjs 的 ` +
        `MATERIAL_TO_PROGRAM_ID）。可以改传一个端口号（另起一个跑着该版本代码的开发服务器），或者换一个已知映射的 --material。`,
    );
  }
  let root = resolveExistingDirRoot(REPO_ROOT, trimmed);
  if (!root) {
    const workdir = resolveRepoPath(REPO_ROOT, "tmp/dev-browser-base-shader");
    root = resolveCommitRoot(REPO_ROOT, trimmed, workdir, { log: (s) => console.log(`[dev-browser] ${s}`) });
  }
  const server = await createServer({ root, server: { middlewareMode: true }, appType: "custom", logLevel: "error" });
  try {
    const programs = await collectPrograms(server, {
      lenient: true,
      onSkip: (id, err) => console.warn(`[dev-browser] --base-shader：${id} 跳过（${err.message}）`),
    });
    const prog = programs.find((p) => p.id === programId);
    if (!prog) throw new Error(`--base-shader "${spec}" 这棵树上枚举不到程序 "${programId}"（对应 --material "${materialPath}"）`);
    console.log(`[dev-browser] --base-shader "${spec}"：离线枚举到程序 "${programId}" 的 fragmentShader（${prog.fragmentShader.length} 字符）`);
    return prog.fragmentShader;
  } finally {
    await server.close();
  }
}

/** 把 window.__voyage 下某个材质的 fragmentShader 换成 src（null 换回原文），等 renderer.compileAsync
 * 真正编完再返回，并做一次真正的 render() 强制切换（compileAsync 只保证编译完成，不保证已经切换，见
 * probe.mjs / passes.mjs --variants 同一套手法）。原文缓存在页面自己的 window.__pairOrigShaders，
 * 同一个材质多次换只缓存第一次（从未改动过的原文），和 probe.mjs 的 origShaders 是同一个设计。 */
async function swapMaterialShader(page, materialPath, src) {
  return page.evaluate(
    async ({ materialPath, src }) => {
      const v = window.__voyage;
      const resolvePath = (root, p) => p.split(".").reduce((o, k) => (o == null ? o : o[k]), root);
      const m = resolvePath(v, materialPath);
      if (!m || typeof m.fragmentShader !== "string") throw new Error(`--material 解析不到 "${materialPath}"（或它不是 ShaderMaterial）`);
      window.__pairOrigShaders ??= new Map();
      if (!window.__pairOrigShaders.has(m)) window.__pairOrigShaders.set(m, m.fragmentShader);
      m.fragmentShader = src ?? window.__pairOrigShaders.get(m);
      m.needsUpdate = true;
      const passObj = v.clouds.pass;
      const renderer = passObj.renderer;
      const prevMat = passObj.mesh.material;
      const prevTarget = renderer.getRenderTarget();
      const tgt = v.cabinClass && v.cabinClass.mats && Object.values(v.cabinClass.mats).includes(m) ? v.cabinClass.target : v.hdrOutside;
      passObj.mesh.material = m;
      renderer.setRenderTarget(tgt);
      await renderer.compileAsync(passObj.scene, passObj.camera);
      passObj.render(m, tgt); // 强制真正 acquire 程序（compileAsync 只保证编译完成，不保证已经切换）
      passObj.mesh.material = prevMat;
      renderer.setRenderTarget(prevTarget);
      return true;
    },
    { materialPath, src },
  );
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
  // --pair/--ab（DX-12）：批量截图时飞机一直在飞（applyScene 里等地面瓦片 / 舱等 / 云变体编译好那几秒到
  // 几十秒，位置一直按真实挂钟推进），只拨一个调试开关想拍「同一机位」的前后对照根本拍不成——两次分开跑
  // shots，第二次开始时飞机已经不在同一个地方了。这里同一页面里把场景摆好一次，pin 回场景该有的位置再冻结，
  // 先后跑两段 js、各拍一张，机位保证一致。见下面 parsePairJs 与 scenarios.mjs 的 pinGeometry。
  const pairJs = parsePairJs(args);
  await noticeOrRespectLock(args, "shots");

  const browser = await launchBrowser(angle);
  try {
    // collectErrors：截图期间的 console error / pageerror 数一并打印出来（DX-07），不用另外跑一次 check
    const { page, renderer, errors } = await openPage(browser, port, angle, viewport, dpr, { collectErrors: true, extraQuery: parseExtraQuery(args) });
    console.log(`[dev-browser] --angle=${angle}  viewport=${viewport.width}x${viewport.height}  dpr=${dpr}  GL_RENDERER = ${renderer}`);
    if (!allowFlash) {
      const applied = await setFlashDisabled(page, true);
      console.log(`[dev-browser] 默认关闭雷电频闪${applied ? "" : "（没找到 window.__voyage.weather，跳过）"}（--allow-flash 保留旧行为）`);
    }
    const scenes = resolveScenes(args);
    const results = [];
    for (const sc of scenes) {
      const info = await page.evaluate(applyScene, { sc, defaults: DEFAULTS, settle });

      if (pairJs) {
        // pin：把头部 / 云偏移钉回场景 JSON 写的值（pinGeometry，和 applyScene 里对应逻辑一致，见
        // scenarios.mjs 文件头注释）——不然 applyScene 设场景到这里之间的等待时间里飞机已经飘走了一截，
        // 冻结的就不是场景原本该有的那个机位。钉完再冻结，两段 js 才是真正「同一机位」的对照。
        await page.evaluate(pinGeometry, sc);
        await page.evaluate(() => window.__voyage.freeze(true));
        await setWingStrobe(page, 0); // PERF-13 反馈：冻结截图钉死翼尖频闪为灭，不撞上全白窗
        await page.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))));

        const shootOne = async (label, extraFields) => {
          const pngPath = path.join(outDir, `${sc.name}.${label}.png`);
          await page.screenshot({ path: pngPath, timeout: 60000 });
          const frameMs = await page.evaluate((n) => window.__voyage.benchFrame(n), 30);
          const head = await page.evaluate(() => window.__voyage.head);
          const extra = await collectShotMeta(page);
          const meta = { scene: sc.name, pair: label, info, head, viewport, dpr, angle, renderer, frameMs: +frameMs.toFixed(3), origin: originFor(port), ...extraFields, ...extra };
          fs.writeFileSync(path.join(outDir, `${sc.name}.${label}.json`), JSON.stringify(meta, null, 2));
          results.push(meta);
          console.log(`  ${sc.name}.${label}: frameMs=${meta.frameMs}`);
        };

        if (args["base-shader"]) {
          // DX-12（PERF-12/TR07 反馈）：第二张不是任意 js，是同一机位换上另一棵树的着色器原文——
          // 拍 a（可选先跑 pairJs[0] 做预设置）→ 换上 --base-shader 拍 b → 换回原文拍 a2（噪声底）
          const materialPath = args.material || "sceneMat";
          const preJs = pairJs[0];
          let preOut;
          if (preJs) {
            preOut = await page.evaluate((code) => new (async () => {}).constructor("v", code)(window.__voyage), preJs);
            await page.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))));
          }
          await shootOne("a", { pairJs: preJs ?? null, jsOut: preOut === undefined ? null : preOut, baseShader: args["base-shader"], material: materialPath });

          const baseSrc = await resolveBaseShaderSource(args["base-shader"], materialPath, { browser, angle });
          const errBefore = errors.length;
          await swapMaterialShader(page, materialPath, baseSrc);
          const shaderError = errors.length > errBefore;
          if (shaderError) console.error(`[dev-browser] --base-shader 换上的着色器编译 / 链接时报了错（见上面的 console.error），"${sc.name}.b.png" 很可能是垃圾画面，不要当真`);
          await shootOne("b", { baseShader: args["base-shader"], material: materialPath, shaderError });

          await swapMaterialShader(page, materialPath, null);
          await shootOne("a2", { baseShader: args["base-shader"], material: materialPath, note: "换回原文的噪声底：理论上应与 a 逐像素一致（compare.mjs --diff a2 对照 a）" });
        } else {
          for (let i = 0; i < 2; i++) {
            const label = i === 0 ? "a" : "b";
            const jsOut = await page.evaluate((code) => new (async () => {}).constructor("v", code)(window.__voyage), pairJs[i]);
            // 等两帧让 js 改动的状态真正画出来（同 flicker 的手法）
            await page.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))));
            await shootOne(label, { pairJs: pairJs[i], jsOut: jsOut === undefined ? null : jsOut });
          }
        }
        await page.evaluate(() => window.__voyage.freeze(false));
        await setWingStrobe(page, null);
        continue;
      }

      // --freeze（DX-08）：截图前钉住位置 / 航向 / 头部 / 模拟时间 / 曝光适应 / 闪电 / 翼尖频闪相位
      // （__voyage.freeze，见 main.ts），冻结后连续渲染逐像素一致，可用来做两图相减定位。
      // 多等两帧让第一帧的残留 dt 归零（freeze 那一刻可能刚好在两次 rAF 中间）；截图后立刻解冻，
      // 不影响紧接着的 benchFrame 计时（那条路本来就不经过 frame()，freeze 状态对它没有实际影响，
      // 这里解冻只是让后续场景恢复正常节奏）。
      // PERF-13 反馈：freeze 只钉住频闪的「相位」，冻结那一刻可能恰好落在亮的窗口，夜景冻结截图偶尔会
      // 撞上一整块过曝白光；这里额外把 wingDebug.strobe 钉死为灭（0），解冻后恢复正常节奏。
      if (freeze) {
        await page.evaluate(() => window.__voyage.freeze(true));
        await setWingStrobe(page, 0);
        await page.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))));
      }
      const pngPath = path.join(outDir, `${sc.name}.png`);
      await page.screenshot({ path: pngPath, timeout: 60000 });
      if (freeze) {
        await page.evaluate(() => window.__voyage.freeze(false));
        await setWingStrobe(page, null);
      }
      const frameMs = await page.evaluate((n) => window.__voyage.benchFrame(n), 30);
      const head = await page.evaluate(() => window.__voyage.head);
      // 面板值 / 日期 / 太阳月亮高度 / 画质档（DX-12），见 collectShotMeta
      const extra = await collectShotMeta(page);
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
        ...extra,
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
// DX-12（PERF-13 反馈）：--baseline <端口> 时 --repeat 轮交替测 port / baseline 两侧（同一轮先测当前端口
// 再测基线，和 bench 的交替顺序一致），不用每个代理各自手写一份 PowerShell 交替脚本；不传 --baseline
// 就是原来的行为（只测 port，重复 repeat 次）。
async function coldOnce(browser, origin, angle, viewport, dpr) {
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
    return { origin, angle, viewport, dpr, nonce, totalMs, startup, renderer };
  } finally {
    // 只是关掉这一轮的 context，浏览器进程留给外层 finally 统一处理；这里超时同样不硬等
    await Promise.race([context.close(), new Promise((r) => setTimeout(r, 5000))]).catch(() => {});
  }
}

async function cmdCold(args) {
  const port = args.port;
  if (!port) throw new Error("cold 需要 --port <端口>");
  const angle = String(args.angle || "d3d11");
  const repeat = Number(args.repeat || 1);
  const viewport = parseViewport(args);
  const dpr = parseDpr(args);
  const origin = originFor(port);
  const baseline = args.baseline ? String(args.baseline) : null;
  const baseOrigin = baseline ? originFor(baseline) : null;

  if (args["wait-quiet"]) await waitForQuiet({ log: (s) => console.log(`[dev-browser] ${s}`) });
  const releaseLock = tryAcquire(REPO_ROOT, `dev-browser.mjs cold（端口 ${port}${baseline ? ` vs ${baseline}` : ""}, pid ${process.pid}, ${new Date().toLocaleTimeString("zh-CN", { hour12: false })}）`);
  if (!releaseLock) {
    const lock = readLock(REPO_ROOT);
    console.warn(`[dev-browser] 测量锁被占用（持有者：${lock ? lock.owner.split("\n")[0] : "未知"}），继续测量但结果可能被对方的负载污染（反之亦然）`);
  }

  const browser = await launchBrowser(angle);
  const results = [];
  try {
    for (let i = 0; i < repeat; i++) {
      const cpuLoad = sampleAndWarn(`cold 第 ${i + 1}/${repeat} 轮之前`);
      const entry = { ...(await coldOnce(browser, origin, angle, viewport, dpr)), side: baseline ? "current" : undefined, cpuLoadPercent: cpuLoad };
      results.push(entry);
      console.log(`[dev-browser] cold #${i + 1}/${repeat}${baseline ? ` [当前 ${port}]` : ""}: --angle=${angle}  viewport=${viewport.width}x${viewport.height}  dpr=${dpr}  totalMs=${entry.totalMs}  renderer=${entry.renderer}`);
      console.log(
        Object.entries(entry.startup)
          .map(([k, v]) => `    ${k}: ${v}`)
          .join("\n"),
      );
      if (baseOrigin) {
        const baseEntry = { ...(await coldOnce(browser, baseOrigin, angle, viewport, dpr)), side: "baseline", cpuLoadPercent: cpuLoad };
        results.push(baseEntry);
        const delta = baseEntry.totalMs ? (((entry.totalMs - baseEntry.totalMs) / baseEntry.totalMs) * 100).toFixed(1) : null;
        console.log(`[dev-browser] cold #${i + 1}/${repeat} [基线 ${baseline}]: totalMs=${baseEntry.totalMs}  renderer=${baseEntry.renderer}${delta !== null ? `  Δ=${delta}%` : ""}`);
        console.log(
          Object.entries(baseEntry.startup)
            .map(([k, v]) => `    ${k}: ${v}`)
            .join("\n"),
        );
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
      "用法：node scripts/dev-browser.mjs <check|shots|cold|bench|flicker> --port <端口> [--angle d3d11|vulkan] [--viewport WxH] [--dpr N] [--only a,b] [--scene '<JSON>' ...] [--scenes-file 路径.json] [--query '<url参数>'] [--out 路径] [--allow-flash] [--freeze] [--settle] [--pair '<js1>' --pair '<js2>' | --base-shader <端口|目录|提交>] [--baseline 端口] [--frames N] [--rounds N] [--repeat N] [--wait-quiet] [--respect-lock]",
    );
    console.error("  check           只开页面、等启动完成、收集 console error / pageerror，有错误就非 0 退出");
    console.error("  --wait-quiet    仅 cold（DX-10）：测量前先等 CPU 占用降到 50% 以下再开始");
    console.error("  --respect-lock  仅 check / shots（DX-10）：发现测量锁（tmp/measure.lock）时先等它释放，而不只是打印提示");
    console.error("  --viewport WxH  浏览器视口尺寸，默认 1600x1200（如 --viewport 2400x1800）");
    console.error("  --dpr N         deviceScaleFactor，默认 1（和 --viewport 组合模拟高分屏 / 弱 GPU）");
    console.error("  --scene '<JSON>'  仅 shots / flicker：临时场景，字段同 scenarios.mjs 的 SCENES 条目，可重复（shots 可与 --only 并用）");
    console.error("  --scenes-file 路径.json  仅 shots（DX-12）：场景数组文件，免去命令行 JSON 转义，可与 --only/--scene 并用");
    console.error("  --query '<url参数>'      附加到导航 URL 的额外查询参数（DX-12），如 --query 'eox=2024' 或 '?optics=all'");
    console.error("  --out 路径      shots / cold / bench / flicker 的输出路径：绝对路径原样使用，相对路径按仓库根解析");
    console.error("                  （worktree 里就是 worktree 根；shots 不传是 tmp/screenshot/dev-<端口>）");
    console.error("  --allow-flash   仅 shots：不关闭雷电频闪（默认关，见 weather.ts 的 hold / heldIntensity 开关）");
    console.error("  --freeze        仅 shots（DX-08）：截图前 __voyage.freeze(true)——位置 / 航向 / 头部 / 模拟时间 /");
    console.error("                  曝光适应 / 闪电 / 翼尖频闪相位全部钉住（PERF-13：另把翼尖频闪钉死为灭），连续渲染逐像素一致，适合两图相减找回归");
    console.error("  --settle        仅 shots（DX-08）：等 ground.pending === 0 再截（而不是默认的 pending<5），逐像素对比用");
    console.error("  --pair '<js1>' --pair '<js2>'（或 --ab，DX-12）  仅 shots：同一机位冻结后先后跑两段 js 各拍一张（<场景>.a.png / .b.png）");
    console.error("                  --base-shader <端口|目录|提交> [--material sceneMat]：第二张换成换上另一棵树着色器原文的对照（另拍 a2 噪声底）");
    console.error("  flicker         冻结后按亚像素步进（--step 毫米，默认 0.06）微移相机（head.x）连拍 --frames 帧（默认 20），");
    console.error("                  输出块能量变异系数（T08 法）与爬行指标（T43 法）；--crop x,y,w,h 限定统计区域，");
    console.error("                  --block N 块边长（默认 48），--debug N 设 uDebug，一次只测一个场景（--only 单选或单个 --scene）");
    console.error("  cold --baseline 端口（DX-12）：--repeat 轮交替测 port / baseline 两侧真冷启动，不用手写交替脚本");
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
