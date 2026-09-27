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
//                                       [--out tmp/screenshot/dev-5230] [--allow-flash] [--freeze] [--cloud-live] [--settle]
//                                       [--pair '<js1>' --pair '<js2>' | --pair '<预设置js>' --base-shader <端口|目录|提交>
//                                         [--material sceneMat] [--define KEY[=VALUE] ...]]
//                                       [--angle d3d11|vulkan] [--viewport WxH] [--dpr N]
//   node scripts/dev-browser.mjs cold  --port 5230 [--repeat 2] [--baseline 5181] [--angle d3d11|vulkan] [--viewport WxH] [--dpr N]
//   node scripts/dev-browser.mjs bench --port 5230 [--baseline 5181] [--only noon-cumulus] [--frames 30] [--rounds 5] [--angle d3d11|vulkan] [--viewport WxH] [--dpr N]
//   node scripts/dev-browser.mjs flicker --port 5230 --only <场景> [--step 0.06] [--frames 20] [--cloud-live] [--crop x,y,w,h] [--debug N]
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
//   预设置 js（DX-22：但必须显式给，哪怕是空字符串——不给 --pair 时 --base-shader 会直接报错，不再静默
//   忽略只拍一张普通截图）。冻结前会先 pinGeometry（钉回场景该有的头部 / 云偏移，见 scenarios.mjs），并把
//   翼尖频闪钉死为灭（PERF-13 反馈，避免夜景冻结截图撞上全白窗）。详见 README「调试与验证」。
// --material（DX-22，配 --base-shader）：除了字面点号路径（sceneMat/outsideMat/wingMat/seatMat/clouds.*），
//   还认几个「这一帧实际在画什么」的运行时路径：cabinClass.current / cabinClass.seat（座椅单独 pass，
//   PERF-14）/ wingMat.current / wingMat.wet（机翼湿窗变体）/ clouds.marchMat（这里特指当前实际画的云步进
//   变体，不是字面默认变体）。--define KEY[=VALUE]（可重复）给换上的着色器原文补 #define 再重编。
// --cloud-live（DX-22，仅 shots，配 --freeze 或 --pair 用）：__voyage.freeze(true, {cloudLive:true})，
//   冻结除云以外的一切，云照常渲染 / 做时间累积。
//
// --freeze（DX-08，仅 shots）：截图前调用 __voyage.freeze(true)（main.ts 的调试句柄）钉住位置 / 航向 / 头部 /
//   模拟时间 / 曝光适应 / 闪电 / 翼尖航行灯频闪相位，冻结后连续渲染逐像素一致，可以拿两次 shots 的截图相减
//   （配合 compare.mjs 的 --diff）定位「这一版改动到底动了哪些像素」，不必依赖「同一份代码跑两次」的噪声估计。
//   DX-22：benchFrame 现在也遵守冻结（以前会绕开冻结推进飞机位置 / 模拟时间 / 曝光，见下面 benchFrame 注释）。
// --settle（DX-08，仅 shots）：等 __voyage.ground.pending === 0 再截（默认的 sc.ground 等待用的是更宽松的
//   pending < 5，够看大致画面但地面瓦片可能还在陆续贴上来），逐像素对比前建议加上，否则瓦片加载差异会被
//   误判成回归。
// flicker（DX-08，泛化自 handoff/T08-flicker.mjs + T08-flicker.py + T43-crawl.py）：__voyage.freeze(true) 之后
//   按 --step 毫米（默认 0.06，亚像素）步进微移相机（head.x），连拍 --frames 帧，输出块能量变异系数（T08 法，
//   抗锯齿做对了每块总亮度守恒）与爬行指标（T43 法，二阶差分，抓块能量法量不出的「台阶沿线爬」）。
//   --cloud-live（DX-22，把 handoff/C03-rt.mjs 审查用的实时路径收成正式选项）：冻结除云以外的一切，
//   --step 默认改 0、--frames 默认改 32，额外输出 relStd（时间标准差/均值）与 relLow16（16 帧盒平均后的
//   低频标准差/均值——层状云横纹这类肉眼看得出的起伏是低频的，纯 relStd 会被逐帧噪声盖住）。
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
import { cmdAb, cmdFlight } from "./lib/ab.mjs";

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
// DX-22：--base-shader 不给 --pair/--ab 时以前会静默忽略——parsePairJs 直接返回 null，cmdShots 整段
// pairJs 分支都不会进入，--base-shader 本身悄悄被吃掉，只拍到一张普通冻结截图，用户还以为拍到了对照
// （TASKS.md DX-22 描述）。现在改成直接报错：--base-shader 必须搭配 --pair（哪怕只传一个空字符串占位，
// 表示「不需要预设置 js，直接对照」），报错信息里给出这个写法。
function parsePairJs(args) {
  const raw = args.pair !== undefined ? args.pair : args.ab;
  if (raw === undefined) {
    if (args["base-shader"]) {
      throw new Error(
        `--base-shader 需要同时给 --pair/--ab（哪怕只传一个空字符串占位，如 --pair ''），否则会被静默忽略、` +
          `只拍到一张普通冻结截图（DX-22 发现的坑）。收到 --base-shader "${args["base-shader"]}" 但没有 --pair/--ab。`,
      );
    }
    return null;
  }
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
      if (type === "webgl2" && ctx) (window.__glProbes ??= []).push(ctx);
      if (type === "webgl2" && ctx && !window.__glProbe) window.__glProbe = ctx;
      return ctx;
    };
  });
}

/** GPU timer query（EXT_disjoint_timer_query_webgl2），返回 { ms, reason }：ms 为每帧 ms，拿不到时 ms=null 并在
 * reason 里写原因（调用方打印警告，不阻塞主流程）。
 * DX-24：以前取「页面上第一个 webgl2 上下文」——那常常是 quality.ts 探测 GPU 用的一次性画布，早已丢失
 * （isContextLost），查询永远不可用，bench 的 gpu 列静默全是 "-"。现在优先用渲染器自己的上下文
 * （__voyage.clouds.pass.renderer.getContext()），退回时跳过已丢失的上下文。 */
async function gpuTimedFrame(page, frames) {
  return page.evaluate(async (n) => {
    const v = window.__voyage;
    let gl = v && v.clouds && v.clouds.pass && v.clouds.pass.renderer ? v.clouds.pass.renderer.getContext() : null;
    if (!gl || gl.isContextLost()) gl = (window.__glProbes || []).filter((c) => !c.isContextLost()).pop() || null;
    if (!gl) return { ms: null, reason: "没有可用的 webgl2 上下文（全部已丢失）" };
    const ext = gl.getExtension("EXT_disjoint_timer_query_webgl2");
    if (!ext) return { ms: null, reason: "没有 EXT_disjoint_timer_query_webgl2 扩展（软渲染？）" };
    const q = gl.createQuery();
    gl.beginQuery(ext.TIME_ELAPSED_EXT, q);
    window.__voyage.benchFrame(n);
    gl.endQuery(ext.TIME_ELAPSED_EXT);
    const t0 = performance.now();
    while (!gl.getQueryParameter(q, gl.QUERY_RESULT_AVAILABLE)) {
      if (performance.now() - t0 > 2000) return { ms: null, reason: "查询 2 s 未返回结果" };
      await new Promise((r) => requestAnimationFrame(r));
    }
    if (gl.getParameter(ext.GPU_DISJOINT_EXT)) return { ms: null, reason: "期间发生 GPU disjoint，结果不可信" };
    const ns = gl.getQueryParameter(q, gl.QUERY_RESULT);
    return { ms: ns / 1e6 / n, reason: null };
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
    const { renderer, errors, tileErrors } = await openPage(browser, port, angle, viewport, dpr, { collectErrors: true, extraQuery: parseExtraQuery(args) });
    // 启动完成（__voyageStartup 出现）后再等一小段时间，抓头几帧才触发的异常（例如某个 pass 首次
    // draw 才暴露的问题），不然掐着 waitForFunction 一 resolve 就关页面，可能漏掉这类错误。
    await new Promise((r) => setTimeout(r, 1500));
    console.log(`[dev-browser] check --angle=${angle}  viewport=${viewport.width}x${viewport.height}  dpr=${dpr}  GL_RENDERER = ${renderer}`);
    printTileErrors(tileErrors);
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
  // DX-23：EOX 地面影像瓦片跨域 / 加载失败的报错每批能刷 600+ 条（T48b / C09 审查反馈），淹没真正的错误。
  // 这类报错不进 errors，只计数（tileErrors.n，首条原文留在 tileErrors.first），结尾聚合成一行打印；
  // ab 会按每张图记 corsErrors，期间有就把那张标作废（地面可能缺瓦片）。
  const tileErrors = { n: 0, first: null };
  const isTileError = (t) => /eox\.at|tiles\.maps|CORS policy|net::ERR_FAILED/i.test(t);
  if (opts.collectErrors) {
    page.on("console", (m) => {
      if (m.type() !== "error") return;
      const t = m.text();
      if (isTileError(t)) {
        tileErrors.n++;
        tileErrors.first ??= t.slice(0, 200);
      } else errors.push({ type: "console", text: t });
    });
    page.on("pageerror", (e) => errors.push({ type: "pageerror", text: e.message }));
  }
  await installGlProbe(page);
  const renderer = await assertRealGpu(page);
  // --query（DX-12）：附加到导航 URL 的额外查询参数（例如 "&eox=2024"），不传就是原来的行为
  await page.goto(`${originFor(port)}/?dev=${Date.now()}${opts.extraQuery || ""}`, { waitUntil: "commit", timeout: 180000 });
  await page.bringToFront();
  await page.waitForFunction(() => window.__voyageStartup, null, { timeout: 180000, polling: 500 });
  return { context, page, renderer, angle, viewport, dpr, errors, tileErrors };
}

/** 聚合打印 EOX 瓦片报错（DX-23），没有就不打印 */
function printTileErrors(tileErrors) {
  if (tileErrors && tileErrors.n > 0) console.log(`[dev-browser] EOX 地面瓦片跨域 / 加载失败 ${tileErrors.n} 条（已聚合，不计入 console error；首条：${tileErrors.first}）`);
}

/** DX-23：画质档。自动档会在截图 / 测量期间按帧时间悄悄降档（云半分辨率），同一批截图前后不可比（T48b / C09 反馈），
 * shots / ab / flight 默认固定成「高」；--quality auto 保留旧行为，--quality medium|low 显式指定。场景 p 里写了
 * quality 的，applyScene 会再覆盖。 */
async function setQualityTier(page, q) {
  const tier = q === undefined || q === true ? "high" : String(q);
  if (!["auto", "high", "medium", "low"].includes(tier)) throw new Error(`--quality 只接受 auto|high|medium|low，收到 "${q}"`);
  await page.evaluate((tier) => {
    const el = document.getElementById("quality");
    if (el) {
      el.value = tier;
      el.dispatchEvent(new Event("change", { bubbles: true }));
    }
    const qq = window.__voyage && window.__voyage.quality;
    if (qq && typeof qq.setTier === "function" && qq.tier !== tier) qq.setTier(tier);
  }, tier);
  return tier;
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
 * 那个端口页面上材质此刻的 fragmentShader，见 resolveBaseShaderSource）。
 * DX-22：`cabinClass.current` / `cabinClass.seat` / `wingMat.current` / `wingMat.wet`（这一帧或强制
 * 指定实际画的变体）与「`clouds.marchMat` 当前实际画的变体」这几个 --material 值是「运行中的页面状态」，
 * 离线枚举一棵目录 / 提交时没有「当前 / 这一帧」的概念，所以故意不放进这张表——传目录 / 提交时会走下面
 * resolveBaseShaderSource 的通用报错，提示改传端口号（见 resolveLiveMaterial）。`clouds.marchMat` / `wingMat`
 * / `seatMat` 字面值仍然映射到各自默认变体的程序 id，离线对照默认变体不受影响。
 * PERF-14 合并后新增 `seatMat`（座椅单独拆出的 pass，见 seat-pass.ts）与 wing 的 WING_WET 派生变体
 * （wing-pass.ts 的 WingWetVariant，窗上有水时的湿窗版本）。 */
const MATERIAL_TO_PROGRAM_ID = {
  sceneMat: "scene-default",
  outsideMat: "outside-default",
  wingMat: "wing",
  seatMat: "seat-default",
  "clouds.marchMat": "cloud-march",
  "clouds.resolveMat": "cloud-resolve",
};

// DX-22：在页面里解析 --material 点号路径到真正的材质对象，特判几个「路径本身不够、还要看运行时状态」的
// 值（其余按字面点号路径逐级取属性，和以前的 resolvePath 行为一致）：
//   "cabinClass.current"  这一帧实际画的舱内合成材质（v.cabinClass.mats[v.cabinClass.shown].cabin），不是
//                          构造时传入的默认商务舱材质字面量（= 字面量 "sceneMat"）——想换经济舱正在用的
//                          着色器时，"cabinClass.mats.business.cabin" 这种写法拿到的永远是商务舱（无论
//                          面板选的是什么）。PERF-14 起 `mats[班次]` 是 `{cabin, seat}` 对子，不再是单个
//                          材质，取错一层会拿到整个对子对象（不是 ShaderMaterial，下面会报错提醒）。
//   "cabinClass.seat"     这一帧实际画的座椅 pass 材质（PERF-14 拆出来的单独 pass，v.cabinClass.seat()），
//                          和舱内合成材质是同一个舱等但两个不同的程序（分别编译、分别计时）。
//   "wingMat.current"     这一帧实际画的机翼材质：窗上有水（湿度超阈值）且 WING_WET 变体已编好时是湿窗版
//                          （v.wingVariant.wet），否则是默认干窗版（字面量 "wingMat" 本身）。
//   "wingMat.wet"          不管这一帧实际画的是不是它，强制取 WING_WET 变体本身（v.wingVariant.wet，变体
//                          还没编好时是 null，调用方会看到解析失败的报错，不会拿到默认材质悄悄顶替）。
//   "clouds.marchMat"     当前实际画的云步进变体（v.clouds.marchVariants.get(v.clouds.marchShown).mat），
//                          不是字面属性 clouds.marchMat（只是默认变体，天气 / 奇观 / 卷云场景下不是实际在画的那个，
//                          C03 审查发现的「冻结工具对云是瞎的」同一类问题——materialPath 对不上实际渲染路径）。
// 只在这些值上特判：老版本页面缺对应字段时自动退回能找到的最接近的东西（跨版本对照容错，和 applyScene 的
// 容错原则一致），其余任意点号路径（sceneMat、outsideMat、wingMat、seatMat，以及以后新增的材质）不需要
// 在这里特判，通用的点号路径解析已经能覆盖。
//
// 这段逻辑要在**两处** page.evaluate 里各写一遍（resolveBaseShaderSource 的端口分支、swapMaterialShader，
// 各自内联一份 resolveLiveMaterial）：page.evaluate 只序列化传入函数自身的源码，不能引用 Node 侧的闭包函数，
// 和 scenarios.mjs 的 pinGeometry / applyScene 必须各自独立、不能互相调用是同一个限制（该文件头注释已写明）；
// 原来两处各写一遍的 `resolvePath` 就是同一个模式，这里只是把它换成更懂 --material 语义的版本。

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
        function resolveLiveMaterial(v, materialPath) {
          if (materialPath === "cabinClass.current" && v.cabinClass && v.cabinClass.mats) {
            const pair = v.cabinClass.mats[v.cabinClass.shown];
            return pair ? pair.cabin || pair : null; // pair.cabin：PERF-14 起 mats[班次] 是 {cabin, seat} 对子；老页面兜底 pair 本身
          }
          if (materialPath === "cabinClass.seat" && v.cabinClass) {
            if (typeof v.cabinClass.seat === "function") return v.cabinClass.seat();
            const pair = v.cabinClass.mats && v.cabinClass.mats[v.cabinClass.shown];
            return pair ? pair.seat || null : null; // 老页面（PERF-14 之前）没有座椅单独 pass，解析不到
          }
          if (materialPath === "wingMat.current" && v.wingVariant) {
            return v.wingVariant.shownWet ? v.wingVariant.wet : v.wingMat;
          }
          if (materialPath === "wingMat.wet" && v.wingVariant) {
            return v.wingVariant.wet || null; // 还没编好（state 不是 ready）时是 null，不悄悄退回干窗版
          }
          if (materialPath === "clouds.marchMat" && v.clouds && v.clouds.marchVariants && v.clouds.marchShown !== undefined) {
            const variant = v.clouds.marchVariants.get(v.clouds.marchShown || "");
            if (variant && variant.mat) return variant.mat;
          }
          return materialPath.split(".").reduce((o, k) => (o == null ? o : o[k]), v);
        }
        const m = resolveLiveMaterial(window.__voyage, materialPath);
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
 * 同一个材质多次换只缓存第一次（从未改动过的原文），和 probe.mjs 的 origShaders 是同一个设计。
 * DX-22：defines（--define，见 parseDefines）在 src 给了值时叠加到材质原本的 defines 上再重编——换上
 * 另一棵树的着色器原文，如果那份原文靠某个 #define 才走到想看的分支（例如经济舱变体的
 * CABIN_CLASS_ECONOMY），光换文本编不出想要的东西。src 为 null（换回原文）时 defines 也一并复原，
 * 不管这次调用有没有传 defines，否则「拍 a2」时着色器换回去了、define 却留着上一轮加的。 */
async function swapMaterialShader(page, materialPath, src, defines) {
  return page.evaluate(
    async ({ materialPath, src, defines }) => {
      const v = window.__voyage;
      // 同 resolveBaseShaderSource 端口分支的 resolveLiveMaterial，见上面「--material 点号路径」注释
      function resolveLiveMaterial(v, materialPath) {
        if (materialPath === "cabinClass.current" && v.cabinClass && v.cabinClass.mats) {
          const pair = v.cabinClass.mats[v.cabinClass.shown];
          return pair ? pair.cabin || pair : null;
        }
        if (materialPath === "cabinClass.seat" && v.cabinClass) {
          if (typeof v.cabinClass.seat === "function") return v.cabinClass.seat();
          const pair = v.cabinClass.mats && v.cabinClass.mats[v.cabinClass.shown];
          return pair ? pair.seat || null : null;
        }
        if (materialPath === "wingMat.current" && v.wingVariant) {
          return v.wingVariant.shownWet ? v.wingVariant.wet : v.wingMat;
        }
        if (materialPath === "wingMat.wet" && v.wingVariant) {
          return v.wingVariant.wet || null;
        }
        if (materialPath === "clouds.marchMat" && v.clouds && v.clouds.marchVariants && v.clouds.marchShown !== undefined) {
          const variant = v.clouds.marchVariants.get(v.clouds.marchShown || "");
          if (variant && variant.mat) return variant.mat;
        }
        return materialPath.split(".").reduce((o, k) => (o == null ? o : o[k]), v);
      }
      const m = resolveLiveMaterial(v, materialPath);
      if (!m || typeof m.fragmentShader !== "string") throw new Error(`--material 解析不到 "${materialPath}"（或它不是 ShaderMaterial——变体可能还没编好，比如 wingMat.wet 在窗还没湿过、WING_WET 从未后台编译时就是 null）`);
      window.__pairOrigShaders ??= new Map();
      window.__pairOrigDefines ??= new Map();
      if (!window.__pairOrigShaders.has(m)) window.__pairOrigShaders.set(m, m.fragmentShader);
      if (!window.__pairOrigDefines.has(m)) window.__pairOrigDefines.set(m, { ...(m.defines || {}) });
      m.fragmentShader = src ?? window.__pairOrigShaders.get(m);
      if (src == null) m.defines = { ...window.__pairOrigDefines.get(m) };
      else if (defines) m.defines = { ...window.__pairOrigDefines.get(m), ...defines };
      m.needsUpdate = true;
      const passObj = v.clouds.pass;
      const renderer = passObj.renderer;
      const prevMat = passObj.mesh.material;
      const prevTarget = renderer.getRenderTarget();
      // DX-22：按 materialPath 直接查表选真正画进去的目标，不再靠「在 cabinClass.mats 里做对象身份查找」
      // 猜（PERF-14 把 mats[班次] 从单个材质改成了 {cabin, seat} 对子后，原来的 Object.values(mats).includes(m)
      // 永远查不到、会一律退化成 hdrOutside，协调者验收前发现的坑）。ANGLE/D3D11 按链接时绑定的帧缓冲生成
      // 输出布局，绑错会在下一次真实渲染时同步重编（README「着色器编译」坑点，PERF-1）；hdrWing / hdrSeat
      // 是本任务和 PERF-14 分别加的调试句柄，老版本页面没有就退回 hdrOutside（画面仍然对，只是多一次同步重编）。
      const tgt =
        materialPath === "sceneMat" || materialPath === "cabinClass.current"
          ? v.cabinClass?.target || v.hdrOutside
          : materialPath === "seatMat" || materialPath === "cabinClass.seat"
            ? v.hdrSeat || v.cabinClass?.seatTarget || v.hdrOutside
            : materialPath === "wingMat" || materialPath === "wingMat.current" || materialPath === "wingMat.wet"
              ? v.hdrWing || v.hdrOutside
              : materialPath === "clouds.resolveMat"
                ? v.clouds.history[0]
                : materialPath.startsWith("clouds.")
                  ? v.clouds.raw
                  : v.hdrOutside;
      passObj.mesh.material = m;
      renderer.setRenderTarget(tgt);
      await renderer.compileAsync(passObj.scene, passObj.camera);
      passObj.render(m, tgt); // 强制真正 acquire 程序（compileAsync 只保证编译完成，不保证已经切换）
      passObj.mesh.material = prevMat;
      renderer.setRenderTarget(prevTarget);
      return true;
    },
    { materialPath, src, defines: defines || null },
  );
}

/** --define KEY[=VALUE]（可重复，DX-22）：--base-shader 换上另一棵树的着色器原文后，如果那份原文靠一个
 * 当前材质默认没开的 #define 才走到想看的分支（例如经济舱变体的 CABIN_CLASS_ECONOMY），只换 fragmentShader
 * 文本编不出想要的变体——重编前把这些 define 一并加上去（叠加在材质原本的 defines 上，不覆盖其余的）。
 * VALUE 不给就是 1（GLSL `#define X 1` 最常见的写法）。不传 --define 时返回 null（swapMaterialShader
 * 按「不改 defines」处理，和以前完全一样）。 */
function parseDefines(args) {
  if (!args.define) return null;
  const list = Array.isArray(args.define) ? args.define : [args.define];
  const out = {};
  for (const raw of list) {
    const s = String(raw);
    const eq = s.indexOf("=");
    if (eq === -1) out[s] = 1;
    else out[s.slice(0, eq)] = s.slice(eq + 1);
  }
  return out;
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
  // --cloud-live（DX-22）：冻结除云以外的一切，云照常渲染 / 做时间累积（main.ts 的 freeze(on, {cloudLive})）。
  // 单独传 --cloud-live（不另加 --freeze）也生效——「冻结但云活着」这个状态本身就依赖冻结，两个开关分开写
  // 没有意义，见下面 `freeze` 变量。
  const cloudLive = Boolean(args["cloud-live"]);
  const freeze = Boolean(args.freeze) || cloudLive;
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
    const { page, renderer, errors, tileErrors } = await openPage(browser, port, angle, viewport, dpr, { collectErrors: true, extraQuery: parseExtraQuery(args) });
    const tier = await setQualityTier(page, args.quality); // DX-23：默认固定高画质档，--quality auto 保留旧的自动档
    console.log(`[dev-browser] --angle=${angle}  viewport=${viewport.width}x${viewport.height}  dpr=${dpr}  画质档=${tier}  GL_RENDERER = ${renderer}`);
    const warnQuality = (name, extra) => {
      if (extra.quality && extra.quality.level !== "high" && tier === "auto") console.warn(`  [警告] ${name}：自动档此刻是「${extra.quality.level}」（降档了），和别的截图不可比；要固定就别传 --quality auto`);
    };
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
        await page.evaluate((cl) => window.__voyage.freeze(true, { cloudLive: cl }), cloudLive);
        await setWingStrobe(page, 0); // PERF-13 反馈：冻结截图钉死翼尖频闪为灭，不撞上全白窗
        await page.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))));

        const shootOne = async (label, extraFields) => {
          const pngPath = path.join(outDir, `${sc.name}.${label}.png`);
          await page.screenshot({ path: pngPath, timeout: 60000 });
          const frameMs = await page.evaluate((n) => window.__voyage.benchFrame(n), 30);
          const head = await page.evaluate(() => window.__voyage.head);
          const extra = await collectShotMeta(page);
          warnQuality(`${sc.name}.${label}`, extra);
          const meta = { scene: sc.name, pair: label, info, head, viewport, dpr, angle, renderer, cloudLive, frameMs: +frameMs.toFixed(3), origin: originFor(port), ...extraFields, ...extra };
          fs.writeFileSync(path.join(outDir, `${sc.name}.${label}.json`), JSON.stringify(meta, null, 2));
          results.push(meta);
          console.log(`  ${sc.name}.${label}: frameMs=${meta.frameMs}`);
        };

        if (args["base-shader"]) {
          // DX-12（PERF-12/TR07 反馈）：第二张不是任意 js，是同一机位换上另一棵树的着色器原文——
          // 拍 a（可选先跑 pairJs[0] 做预设置）→ 换上 --base-shader 拍 b → 换回原文拍 a2（噪声底）
          const materialPath = args.material || "sceneMat";
          const defines = parseDefines(args); // DX-22：--define KEY[=VALUE]，只作用于 b 那次换文（见 swapMaterialShader）
          const preJs = pairJs[0];
          let preOut;
          if (preJs) {
            preOut = await page.evaluate((code) => new (async () => {}).constructor("v", code)(window.__voyage), preJs);
            await page.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))));
          }
          await shootOne("a", { pairJs: preJs ?? null, jsOut: preOut === undefined ? null : preOut, baseShader: args["base-shader"], material: materialPath });

          const baseSrc = await resolveBaseShaderSource(args["base-shader"], materialPath, { browser, angle });
          const errBefore = errors.length;
          await swapMaterialShader(page, materialPath, baseSrc, defines);
          const shaderError = errors.length > errBefore;
          if (shaderError) console.error(`[dev-browser] --base-shader 换上的着色器编译 / 链接时报了错（见上面的 console.error），"${sc.name}.b.png" 很可能是垃圾画面，不要当真`);
          await shootOne("b", { baseShader: args["base-shader"], material: materialPath, defines, shaderError });

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
      // 再调用 benchFrame 计时——DX-22 起 benchFrame 冻结时也会读同一个 frozenNow（不再绕开冻结推进状态，
      // 见 main.ts），但这里先解冻更干净：这一条 benchFrame 数字本来就是想测「正常节奏下」这个场景的帧时间，
      // 不是想再拍一份冻结帧，解冻后恢复正常节奏，不影响后续场景。
      // PERF-13 反馈：freeze 只钉住频闪的「相位」，冻结那一刻可能恰好落在亮的窗口，夜景冻结截图偶尔会
      // 撞上一整块过曝白光；这里额外把 wingDebug.strobe 钉死为灭（0），解冻后恢复正常节奏。
      // --cloud-live（DX-22）：freeze 变量已经把 cloudLive 纳入（见上），这里统一传给 __voyage.freeze。
      if (freeze) {
        await page.evaluate((cl) => window.__voyage.freeze(true, { cloudLive: cl }), cloudLive);
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
      warnQuality(sc.name, extra);
      const meta = {
        scene: sc.name,
        info,
        head,
        viewport,
        dpr,
        angle,
        renderer,
        cloudLive,
        frameMs: +frameMs.toFixed(3),
        origin: originFor(port),
        ...extra,
      };
      fs.writeFileSync(path.join(outDir, `${sc.name}.json`), JSON.stringify(meta, null, 2));
      results.push(meta);
      console.log(`  ${sc.name}: frameMs=${meta.frameMs}`);
    }
    console.log(`[dev-browser] 完成，共 ${results.length} 个场景，输出目录 ${outDir}（--out 相对仓库根解析；worktree 里就是 worktree 根，不是主仓库）`);
    printTileErrors(tileErrors);
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

/** DX-22：把多轮 cold 的 startup（各阶段耗时，`window.__voyageStartup`）汇总成 min/median/max——以前
 * `cmdCold` 只是每一轮各打印一份，`--repeat` 传大了以后自己拿眼睛比哪个阶段稳定、哪个阶段来回跳很费劲。
 * 数值型的键直接聚合；值本身是对象、或是「对象序列化后的 JSON 字符串」的键（PERF-14 加的
 * `startup["批次各程序编好（ms）"]` 就是后者：`JSON.stringify({窗外: ms, 舱内: ms, 座椅: ms, 机翼: ms, "云#0": ms, ...})`，
 * main.ts 的 `startup` 类型是 `Record<string, number | string>`，塞对象会被 `JSON.stringify` 整个页面状态
 * 序列化失败，所以那边写成了字符串）按子键分别聚合，找出这一批并行后台编译里稳定的关键路径瓶颈是哪个程序。
 * 非数值、非对象、不是能解析成对象的 JSON 字符串的键（如老页面缺这个字段时的 undefined）跳过。 */
function summarizeStartup(entries) {
  const keys = new Set();
  for (const e of entries) for (const k of Object.keys(e.startup || {})) keys.add(k);
  const summarizeNums = (vals) => {
    const nums = vals.filter((v) => typeof v === "number" && Number.isFinite(v));
    if (nums.length === 0) return null;
    const sorted = [...nums].sort((a, b) => a - b);
    return { min: sorted[0], median: sorted[Math.floor(sorted.length / 2)], max: sorted[sorted.length - 1], n: nums.length };
  };
  /** "批次各程序编好（ms）" 这类字段是 JSON.stringify 过的对象（见上）：能解析且解析出来是纯对象就返回解析结果，
   * 否则（不是 JSON、或解析出来是数组 / 原语）原样返回，交给外层按普通字符串处理（跳过，不硬凑聚合）。 */
  const tryParseObject = (v) => {
    if (typeof v !== "string") return v;
    try {
      const parsed = JSON.parse(v);
      return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : v;
    } catch {
      return v;
    }
  };
  const summary = {};
  for (const k of keys) {
    const vals = entries.map((e) => e.startup && e.startup[k]).filter((v) => v !== undefined).map(tryParseObject);
    if (vals.length === 0) continue;
    if (typeof vals[0] === "number") {
      summary[k] = summarizeNums(vals);
    } else if (typeof vals[0] === "object" && vals[0] !== null) {
      const subKeys = new Set();
      for (const v of vals) if (v && typeof v === "object") for (const sk of Object.keys(v)) subKeys.add(sk);
      const sub = {};
      for (const sk of subKeys) {
        const s = summarizeNums(vals.map((v) => (v && typeof v === "object" ? v[sk] : undefined)));
        if (s) sub[sk] = s;
      }
      summary[k] = sub;
    }
  }
  return summary;
}

function printStartupSummary(label, summary) {
  console.log(`[dev-browser] cold 汇总 ${label}（${Object.keys(summary).length} 项，min/median/max，ms）：`);
  for (const [k, v] of Object.entries(summary)) {
    if (v && typeof v.min === "number") {
      console.log(`    ${k}: min=${v.min} median=${v.median} max=${v.max}（n=${v.n}）`);
    } else if (v && typeof v === "object") {
      console.log(`    ${k}:`);
      for (const [sk, sv] of Object.entries(v)) console.log(`      ${sk}: min=${sv.min} median=${sv.median} max=${sv.max}（n=${sv.n}）`);
    }
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
  // DX-22：--repeat > 1 时才有聚合的意义（1 轮聚合就是那一轮本身，跳过避免刷屏）
  let summary;
  if (repeat > 1) {
    const currentEntries = results.filter((e) => !baseline || e.side === "current");
    summary = { current: summarizeStartup(currentEntries) };
    printStartupSummary(baseline ? `当前 ${port}` : `${port}`, summary.current);
    if (baseline) {
      const baseEntries = results.filter((e) => e.side === "baseline");
      summary.baseline = summarizeStartup(baseEntries);
      printStartupSummary(`基线 ${baseline}`, summary.baseline);
    }
  }
  if (args.out) fs.writeFileSync(resolveRepoPath(REPO_ROOT, args.out), JSON.stringify({ results, summary }, null, 2));
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

/** 在（已经打开的）页面里解码 N 张截图、算块能量 CV 与爬行指标；不需要真实 GPU，只用 Canvas2D。
 * cloudLive=true 时额外算 relStd / relLow16（DX-22，把 handoff/C03-rt.mjs 审查用的 realtime() 收成正式
 * 指标）：每个够亮的像素在 T 帧上的 luma 时间序列，relStd = 时间标准差 / 均值，relLow16 = 先按 16 帧盒平均
 * 去掉逐帧噪声、再算这条「低频」序列的标准差 / 均值——前者混进了 TAA / 抖动这类逐帧就会自己抵消的高频噪声，
 * 后者才是「云本身在变化」的量级（C03 审查发现层状云横纹有肉眼看得出的低频明暗起伏，逐帧噪声掩盖不了它）。
 * 两个指标都只在 cloudLive 时计算（不改变非 cloud-live 调用的返回形状，向后兼容）。 */
async function analyzeFlicker(page, files, crop, blockSize, cloudLive) {
  const dataUrls = files.map((f) => `data:image/png;base64,${fs.readFileSync(f).toString("base64")}`);
  return page.evaluate(
    async ({ dataUrls, crop, blockSize, cloudLive }) => {
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
      // ---- DX-22（cloud-live）：逐像素 relStd（全频段时间标准差/均值）与 relLow16（16 帧盒平均后的
      // 低频标准差/均值），只在 cloudLive 时算（其余状态冻结，波动来源只可能是云自己） ----
      let relStd = null, relLow16 = null;
      if (cloudLive) {
        let sumRelStd = 0, sumRelLow = 0, cntRS = 0;
        const BOX = 16;
        for (let j = 0; j < N; j++) {
          const m = mean[j];
          if (m <= 12) continue;
          let s2 = 0;
          for (let t = 0; t < T; t++) s2 += (lumas[t][j] - m) ** 2;
          let l2 = 0, nb = 0;
          for (let t0 = 0; t0 + BOX <= T; t0 += BOX) {
            let a = 0;
            for (let t = t0; t < t0 + BOX; t++) a += lumas[t][j];
            a /= BOX;
            l2 += (a - m) ** 2;
            nb++;
          }
          if (nb === 0) continue; // T < 16：一个完整的盒子都凑不齐，这个像素不参与 relLow16（也不参与 relStd，两个指标要在同一批像素上才可比）
          sumRelStd += Math.sqrt(s2 / T) / m;
          sumRelLow += Math.sqrt(l2 / nb) / m;
          cntRS++;
        }
        if (cntRS > 0) {
          relStd = sumRelStd / cntRS;
          relLow16 = sumRelLow / cntRS;
        }
      }
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
        relStd,
        relLow16,
      };
    },
    { dataUrls, crop, blockSize, cloudLive: !!cloudLive },
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
  // --cloud-live（DX-22）：冻结除云以外的一切，只看云本身的时间波动——这时不应该再叠加 --step 的相机
  // 平移（那是测空间抗锯齿用的，混进来会分不清波动到底来自云还是来自相机微移）。默认步长改成 0，默认帧数
  // 拉到 32（凑够 2 个 16 帧盒子，relLow16 才有统计意义；本想学 handoff/C03-rt.mjs 的 nSeries=128，但
  // analyzeFlicker 是拿一批完整截图 + base64 dataUrl 整批塞进 page.evaluate 解码，不是 C03-rt 那种直接读
  // GPU 缓冲——DX-22 交付前在本机实测：48 帧稳定复现 `page.evaluate: Target page, context or browser has
  // been closed`（40 帧过、48 帧必炸，猜测是这一批 dataUrl 太大让渲染进程崩溃；**不带 `--cloud-live` 的原版
  // flicker 同样在 48 帧崩，不是本任务引入的新问题**，只是原来没人试过这么多帧）。32 是留了余量的稳妥默认值，
  // 机器空闲、确实需要更细的低频分辨率时可以 `--frames` 显式调大，但见 README「调试与验证」flicker 一节的
  // 提醒——这是一个已知的 DX 缺口，没有列进本任务范围，建议排一个 DX 任务把 analyzeFlicker 改成分批读回
  // （不必一次性把所有帧的 dataUrl 都塞进同一次 page.evaluate）。
  // --step / --frames 都可以显式覆盖（例如就是想同时测「云 + 相机微移」的耦合效应）。
  const cloudLive = Boolean(args["cloud-live"]);
  const frames = Number(args.frames || (cloudLive ? 32 : 20));
  // 每帧头部横向位移（毫米），W01b-flicker.mjs 用过 0.06 mm 这个量级（亚像素、不引入可见的构图变化）
  const stepMm = Number(args.step ?? (cloudLive ? 0 : 0.06));
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
    console.log(`[dev-browser] flicker --angle=${angle}  viewport=${viewport.width}x${viewport.height}  dpr=${dpr}  GL_RENDERER = ${renderer}${cloudLive ? "  --cloud-live" : ""}`);
    await page.evaluate(applyScene, { sc, defaults: DEFAULTS, settle });
    if (debugMode !== null) await page.evaluate((d) => { window.__voyage.sceneMat.uniforms.uDebug.value = d; }, debugMode);
    // 冻结（DX-08）：位置 / 航向 / 模拟时间 / 曝光适应 / 闪电 / 频闪相位全部钉住，只由下面手动步进 head.x；
    // cloudLive 时云不在冻结之列，照常按真实 rAF 节奏渲染 / 做时间累积（main.ts 的 freeze(on, {cloudLive})）。
    await page.evaluate((cl) => window.__voyage.freeze(true, { cloudLive: cl }), cloudLive);
    await page.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))));
    const stepM = stepMm / 1000;
    const files = [];
    for (let i = 0; i < frames; i++) {
      if (i > 0 && stepM !== 0) await page.evaluate((dx) => { window.__voyage.head.x += dx; }, stepM);
      // 等两帧真正画出新状态（frame() 里 renderFrame 每次都读最新的 head.x，不缓存；cloudLive 时这两帧
      // rAF 本身就是云继续渲染的驱动力，即使 stepM=0 也不能省）
      await page.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))));
      const file = path.join(outDir, `f${String(i).padStart(2, "0")}.png`);
      await page.screenshot({ path: file, timeout: 60000 });
      files.push(file);
    }
    await page.evaluate(() => window.__voyage.freeze(false));
    console.log(`[dev-browser] ${sc.name}：${frames} 帧，每帧头部 +${stepMm} mm，输出 ${path.relative(REPO_ROOT, outDir).replace(/\\/g, "/")}`);
    const stats = await analyzeFlicker(page, files, crop, blockSize, cloudLive);
    console.log(`  块能量 CV（T08 法）中位 ${stats.cvMedian.toFixed(4)} / p90 ${stats.cvP90.toFixed(4)} / p98 ${stats.cvP98.toFixed(4)}（${stats.blocks} 个块，边长 ${blockSize}）`);
    console.log(`  爬行指标（T43 法，二阶差分/亮度）${stats.crawlD2.toFixed(4)}（一阶差分/亮度 ${stats.crawlD1.toFixed(4)} 做参考，亮像素 ${stats.brightPixels}）`);
    if (cloudLive) {
      console.log(`  云时间波动（DX-22）relStd=${stats.relStd?.toFixed(4) ?? "n/a"}  relLow16=${stats.relLow16?.toFixed(4) ?? "n/a"}（16 帧盒平均后的低频/均值；n/a 说明 --frames 太少凑不出一个盒子，或裁剪区太暗）`);
      console.log(`  对角高频（棋盘 / 菱形纹）不在这里算：拿输出目录里任意一帧（如 f00.png）跑 compare.mjs --measure 看 adjDiffDiag（见 README「调试与验证」）`);
    }
    if (args.out) fs.writeFileSync(path.join(outDir, "stats.json"), JSON.stringify({ scene: sc.name, stepMm, cloudLive, debug: debugMode, ...stats }, null, 2));
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
          const g = await gpuTimedFrame(pages[p], frames);
          row.gpuMsPerFrame[p] = g.ms;
          if (g.ms == null) console.warn(`  [警告] ${sc.name} 端口 ${p}：拿不到 GPU 计时（${g.reason}），gpu 列为空`);
        } catch (err) {
          row.gpuMsPerFrame[p] = null;
          console.warn(`  [警告] ${sc.name} 端口 ${p}：GPU 计时出错（${err.message.split("\n")[0]}）`);
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
  else if (sub === "ab" || sub === "flight") {
    const helpers = {
      REPO_ROOT,
      openPage,
      launchBrowser,
      closeBrowserSafely,
      setFlashDisabled,
      setWingStrobe,
      resolveBaseShaderSource,
      parseViewport,
      parseDpr,
      parseExtraQuery,
      setQualityTier,
      log: (s) => console.log(`[dev-browser ${sub}] ${s}`),
    };
    result = sub === "ab" ? await cmdAb(args, helpers) : await cmdFlight(args, helpers);
  } else {
    console.error(
      "用法：node scripts/dev-browser.mjs <check|shots|cold|bench|flicker|ab|flight> --port <端口> [--angle d3d11|vulkan] [--viewport WxH] [--dpr N] [--only a,b] [--scene '<JSON>' ...] [--scenes-file 路径.json] [--query '<url参数>'] [--out 路径] [--allow-flash] [--freeze] [--settle] [--pair '<js1>' --pair '<js2>' | --base-shader <端口|目录|提交>] [--baseline 端口] [--frames N] [--rounds N] [--repeat N] [--wait-quiet] [--respect-lock]",
    );
    console.error("  check           只开页面、等启动完成、收集 console error / pageerror，有错误就非 0 退出");
    console.error("  --wait-quiet    仅 cold（DX-10）：测量前先等 CPU 占用降到 50% 以下再开始");
    console.error("  --respect-lock  仅 check / shots（DX-10）：发现测量锁（tmp/measure.lock）时先等它释放，而不只是打印提示");
    console.error("  --viewport WxH  浏览器视口尺寸，默认 1600x1200（如 --viewport 2400x1800）");
    console.error("  --dpr N         deviceScaleFactor，默认 1（和 --viewport 组合模拟高分屏 / 弱 GPU）");
    console.error("  --scene '<JSON>'  仅 shots / flicker：临时场景，字段同 scenarios.mjs 的 SCENES 条目，可重复（shots 可与 --only 并用）");
    console.error("  --scenes-file 路径.json  仅 shots（DX-12）：场景数组文件，免去命令行 JSON 转义，可与 --only/--scene 并用");
    console.error("  --query '<url参数>'      附加到导航 URL 的额外查询参数（DX-12），如 --query 'eox=2024' 或 '?optics=all'");
    console.error("  --out 路径      shots / cold / bench / flicker / ab / flight 的输出路径：绝对路径原样使用，相对路径按**仓库根**解析");
    console.error("                  （不是当前目录；worktree 里就是 worktree 根，不是主仓库。scripts/ 下所有脚本的 --out / --scenes-file /");
    console.error("                  --jobs / --variants / file: 都是这个基准。shots 不传是 tmp/screenshot/dev-<端口>）");
    console.error("  --quality auto|high|medium|low  shots / ab / flight（DX-23）：画质档，默认固定 high；auto 保留自动档（可能中途降档，会打印警告）");
    console.error("  ab --jobs 路径.json [--variants 路径.json] [--base 对照端口] [--rounds 2] [--cloud-live] [--warm-max 8]（DX-23）");
    console.error("                  同页多变体 A/B：每个 job 摆好场景、冻结、等 ground.pending===0，按 old,new,old#2,new#2 交替套用变体");
    console.error("                  （着色器来源 current|base|base:<材质>|file:<路径>、文本补丁、#define、uniform 覆盖、js，可一次换多个材质），");
    console.error("                  每张预热到连续两张逐字节相同、记 pending / 瓦片跨域数（有则标作废），最后打印指标表与噪声底；");
    console.error("                  job 可带 crop（测量区）、zoom、hdr（读回渲染目标逐位对照，如 hdrWing）+ hdrMask、bench（benchWing 等）、pre（js）");
    console.error("  flight --jobs 路径.json [--variants 路径.json] [--modes static,reset,cruise,turn,exit,live]（DX-23）");
    console.error("                  确定性航迹重放（云的时间行为）：全冻结后手动推进云，航迹逐位可复现；对静止真值（raw 等权平均 --truth 帧）");
    console.error("                  算误差 / 等效模糊 σ（云边宽度）/ 云边梯度能量比，reset 后第 k 帧收敛，live 为解冻后页内逐帧 readPixels 的抖动");
    console.error("  --allow-flash   仅 shots：不关闭雷电频闪（默认关，见 weather.ts 的 hold / heldIntensity 开关）");
    console.error("  --freeze        仅 shots（DX-08）：截图前 __voyage.freeze(true)——位置 / 航向 / 头部 / 模拟时间 /");
    console.error("                  曝光适应 / 闪电 / 翼尖频闪相位全部钉住（PERF-13：另把翼尖频闪钉死为灭），连续渲染逐像素一致，适合两图相减找回归");
    console.error("                  DX-22：benchFrame 现在也遵守冻结，不会再把状态推进掉（以前 --pair 两张之间调用 benchFrame 会绕开冻结）");
    console.error("  --cloud-live    仅 shots（DX-22）：__voyage.freeze(true, {cloudLive:true})，冻结除云以外的一切，云照常渲染 / 做时间累积");
    console.error("  --settle        仅 shots（DX-08）：等 ground.pending === 0 再截（而不是默认的 pending<5），逐像素对比用");
    console.error("  --pair '<js1>' --pair '<js2>'（或 --ab，DX-12）  仅 shots：同一机位冻结后先后跑两段 js 各拍一张（<场景>.a.png / .b.png）");
    console.error("                  --base-shader <端口|目录|提交> [--material sceneMat] [--define KEY[=VALUE] ...]：第二张换成换上另一棵树着色器原文的对照（另拍 a2 噪声底）");
    console.error("                  DX-22：--base-shader 必须搭配 --pair（哪怕传空字符串），不给会直接报错，不再静默忽略");
    console.error("                  DX-22：--material 除字面路径外还认 cabinClass.current / cabinClass.seat / wingMat.current / wingMat.wet（这一帧实际画的变体）");
    console.error("  flicker         冻结后按亚像素步进（--step 毫米，默认 0.06）微移相机（head.x）连拍 --frames 帧（默认 20），");
    console.error("                  输出块能量变异系数（T08 法）与爬行指标（T43 法）；--crop x,y,w,h 限定统计区域，");
    console.error("                  --block N 块边长（默认 48），--debug N 设 uDebug，一次只测一个场景（--only 单选或单个 --scene）");
    console.error("                  --cloud-live（DX-22）：冻结除云以外的一切（--step 默认改 0、--frames 默认改 32），额外输出 relStd / relLow16（云的时间波动）");
    console.error("  cold --baseline 端口（DX-12）：--repeat 轮交替测 port / baseline 两侧真冷启动，不用手写交替脚本");
    console.error("                  --repeat > 1 时额外打印各阶段 min/median/max 汇总（DX-22），含 PERF-14 的「批次各程序编好（ms）」——按程序名分别聚合，看关键路径稳不稳定");
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
