#!/usr/bin/env node
// SC-2：离线着色器编译预算工具（把开发体验官 research/DX_SHADER_COMPILE.md 里的实验方法做成正式脚本）。
//
// 目的：不用等浏览器真冷编译（Windows 上场景程序约 1–2 分钟）就能知道「这个程序编译要多久、
// sampler 用了几个、改哪块能省多少」。不占 GPU 做计时——GLSL → HLSL 的翻译在浏览器里做（ANGLE
// 的编译器前端，CPU 工作，约 1 秒），真正的编译时间用 Windows SDK 的 fxc.exe 离线计时（同样是 CPU）。
//
// 原理（三步，来自开发体验官的实验，已用真实浏览器交叉验证一次，见文末「验证记录」）：
//   1. 用 vite ssrLoadModule 在 Node 里直接构造各材质（复用 lint-shaders.mjs 的 collectPrograms，
//      不开浏览器），拿到每个程序的 GLSL 源码文本。
//   2. 私有 d3d11 headless 在 about:blank 页里对每个程序的片元着色器调用一次
//      gl.compileShader()：这一步只是 ANGLE 把 GLSL 翻译成 HLSL（编译器前端，很快），
//      真正耗时的原生编译（fxc 那部分）在 ANGLE 里是延后到链接时才做的——我们不链接，
//      所以这一步不会卡住。**坑**：翻译结果要在 compileShader() 之后立刻用
//      WEBGL_debug_shaders.getTranslatedShaderSource() 取（three.js 链接后会删 shader 对象，这里
//      我们自己控制 shader 生命周期，不受影响，但如果以后改成 hook 真实页面要记得这条）。
//   3. ANGLE 翻译出的 HLSL 带 `@@ PIXEL OUTPUT @@` / `@@ PIXEL MAIN PARAMETERS @@` /
//      `@@ MAIN PROLOGUE @@` 占位符（链接时才用输出信号生成，见坑点），本地补全后交给
//      fxc.exe（`/T ps_5_0`）编译计时，各程序之间用一个小线程池并行（互不影响正确性，
//      只是同一批里都会变慢，只比较同一批内的数字，和浏览器里的做法一致）。
//   sampler 数直接数 HLSL 头里 `Texture2D<...> textures2D[n]` 这类声明的数组长度求和
//   （ANGLE 在 d3d11 上按类型打包成数组，上限 16，见 research/DX_SHADER_COMPILE.md 第二节）。
//
// 用法：
//   pnpm --filter voyage shader-budget                                   # 全部程序，/O1，几分钟（场景程序最慢）
//   node scripts/shader-budget.mjs --only scene-default                  # 只测一个程序
//   node scripts/shader-budget.mjs --quick                               # /Od 跳过优化，几秒到十几秒出「能不能编过」
//   node scripts/shader-budget.mjs --bisect list                         # 列出已知的可换桩模块
//   node scripts/shader-budget.mjs --bisect ground                       # scene-default 换桩 ground，和不换桩的基线对照
//   node scripts/shader-budget.mjs --bisect "ocean-main;ocean-in-ground;ground"   # 分号 = 各自一个变体，一次性对照
//   node scripts/shader-budget.mjs --bisect "ocean-main,ocean-in-ground"          # 逗号 = 这几个一起换桩（同一个变体）
//   node scripts/shader-budget.mjs --jobs 4 --out tmp/screenshot/shader-budget.json
//   node scripts/shader-budget.mjs --keep-hlsl --only scene-default        # 编完不删临时目录，打印 HLSL 路径
//   node scripts/shader-budget.mjs --rounds 5 --only cloud-march           # 默认流程也支持多轮，输出 min/med/MAD（DX-10）
//   node scripts/shader-budget.mjs --baseline .claude/worktrees/agent-xxx/apps/voyage --rounds 5 --only scene-default
//     # 与另一个 worktree 对照：GLSL→HLSL 翻译两侧各做一次（确定性，不重复），fxc 编译交替测 5 轮，
//     # 判定按最小值（DX-10）；基线树缺材质 / 程序时跳过并列出，不再整体崩溃
//   node scripts/shader-budget.mjs --chain "1de0481,69b1aca,f8a06ba" --program cloud-march --rounds 3   # DX-10
//     # 沿一串提交轮转测同一个程序，归因「哪次合并让它变慢了多少」（在 tmp/shader-budget-chain 建一次性对照 worktree）
//   node scripts/shader-budget.mjs --variants tmp/dx10-variants.mjs --only scene-default --rounds 3      # DX-10
//     # 补丁文件（查找/替换对）：按单项撤回做变体对照，交替测各变体，判定按最小值
//   node scripts/shader-budget.mjs --wait-quiet --rounds 5                # 先等 CPU 降到 50% 以下再测（DX-10）
//   node scripts/shader-budget.mjs --ledger                               # 测完追加一行到 research/compile-ledger.json（DX-10）
//
// --keep-hlsl（DX-08，T41 反馈）：默认编完就删临时目录；传了就保留并打印路径，方便直接改 HLSL 本身再用
//   fxc 计时（比在 GLSL 层一轮轮 --bisect 更快定位「具体是哪几行贵」）。
// --rounds N（DX-10，默认流程也支持，不只 --baseline）：重复测 N 轮，程序表输出「min/med/MAD」与
//   `--out` JSON 里每轮原始值；**判定按最小值**——负载（其它代理占用 CPU）只会让计时变慢，噪声是单向的，
//   见 research/PERF_REPORT_wave6.md 的验证结论（两侧交替测 MAD 只有基线的个位数百分比）。
// --baseline <目录> --rounds N（DX-08，DX-10 加了 min/MAD 与跨版本容错）：只接受目录（另一个 voyage 应用根，
//   或含 apps/voyage 的仓库根）——shader-budget 不连接开发服务器，Windows 也没有 /proc/<pid>/cwd 那样的机制
//   能从端口反查目录，传端口号会报错并提示改传目录。两侧的 GLSL→HLSL 翻译各做一次（确定性），fxc 编译
//   按「当前一轮、基线一轮」交替测 --rounds 轮，判定按最小值，同时打印中位数 / MAD。**基线树缺材质或程序**
//   （对照更老的提交，奇观 / 卷云 / 经济舱这类后来加的功能还不存在）**时跳过并在结果里列出，不再让整棵树
//   的枚举崩溃**（性能工程师第 6 波复测反馈踩过这个坑，见 research/PERF_REPORT_wave6.md 末尾）。
// --chain <提交1,提交2,…> --program <id>[,<id>...] [--rounds N] [--jobs N] [--workdir 目录]（DX-10）：
//   沿一串提交（通常是某个功能的合并链）轮转只测指定的一个或几个程序，每个状态相对上一状态的增量就是那次
//   合并「贡献」了多少编译时间——收编性能工程师第 6 波手工做的归因（tmp/perf-w6/march-chain.sh，未进仓库）。
//   在 tmp/shader-budget-chain（或 --workdir 指定的路径）建一次性对照 worktree（`git worktree add --detach`，
//   首次用会跑一次 `pnpm install --filter voyage`），跑完保留下来给下次 --chain 复用；不需要了手工
//   `git worktree remove` 清理。--program 指定的程序在某个提交里还不存在时跳过该提交（打印提示），不报错。
// --variants <文件.mjs> --only <id>[,<id>...] [--rounds N]（DX-10）：补丁文件（查找 / 替换对），按单项撤回
//   做变体对照——收编 T47（handoff/T47-fxc-bisect.py）、W01b（handoff/W01b-fxc.sh）、T41（手工改 HLSL）
//   三份各写一次的需求。文件导出 `VARIANTS = [[name, [{file, find, replace}, ...]], ...]`（file 相对
//   apps/voyage；空数组 = 不改、当基线），直接在磁盘上的源文件做替换、翻译、计时，然后立刻改回原样
//   （无论成功失败都会恢复，不会把中间状态留在工作区）。和已有的 --bisect 不同：--bisect 只能撤 MODULE_STUBS
//   里预先登记的几个大模块调用点，--variants 可以撤任意一行改动，更贴近实际排查时「撤掉这一行看掉多少」的用法。
// --wait-quiet（DX-10）：测量前先等 CPU 占用降到 50% 以下再开始（超时也会继续，不无限等），见 scripts/lib/cpu-load.mjs。
//   每轮开始前也会采样一次 CPU 占用，超过 50% 打印警告（不阻塞，只是提醒这一轮的数字可能不可信）。
// --ledger（DX-10，仅默认流程）：测完把这次的程序 min/median/MAD 追加一行到 research/compile-ledger.json
//   （编译预算账本，见 scripts/compile-ledger.mjs），带上当前 git 提交和日期。
//
// --bisect 的模块表（MODULE_STUBS）是人工按 scene.ts / terrain-shading.glsl.ts 当前的调用点文本维护的
// 精确字符串替换（做法照抄开发体验官的 variants.py）。**代码演进后锚点会漂移**：找不到就跳过并在
// 输出里注明「锚点对不上」，不会让整个工具报错退出——过一段时间锚点大批失效是正常的，
// 照着当前 scene.ts 的调用点更新 MODULE_STUBS 就行（不是这个工具本身坏了）。只对 scene-*
// 程序生效，其它程序会被自动跳过（有提示）。
//
// 已知「离线计时对这个程序不可信」的程序（DX-10，见 OFFLINE_UNRELIABLE）：exposure-meter 离线 fxc /O1
// 约 25 秒，浏览器里整个「曝光与眩光」阶段只要 0.25 秒，偏差百倍（research/PERF_REPORT_wave6.md §3.1）；
// 程序表里会标注【离线不可信】，数字仍然打印（不隐藏），只是不建议拿它做「贴线 / 超预算」判定。
//
// 验证记录（2026-09-27，本次交付时用真实浏览器交叉验证一次，见 handoff/SC-12.md）：
// scene-default 真实冷编译（dev-browser.mjs cold，D3D11，当时 GPU 被其他代理占用）「场景着色器编译
// （后台）」= 115049 ms；本工具离线 /O1 对同一份程序（含真实页面 hook 出的完整文本、以及本工具实际用的
// 合成文本两条路径）分别是 124917 ms（+8.6%）和 111545 ms（−3.0%），HLSL 翻译结果字节长度完全一致
// （128449），确认合成文本这条路（不需要跑起来的 dev server）足够还原真实编译，都在 ≤15% 的验收范围内。

import { createServer } from "vite";
import { chromium } from "playwright-core";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { fileURLToPath, pathToFileURL } from "node:url";
import { launchBrowser as launchBrowserAngle, closeBrowserSafely, resolveRepoPath } from "./lib/chrome.mjs";
import { collectPrograms, resolveIncludes, FRAG_PREFIX } from "./lint-shaders.mjs";
import { sampleAndWarn, waitForQuiet } from "./lib/cpu-load.mjs";
import { tryAcquire, readLock } from "./lib/measure-lock.mjs";
import { appendLedgerEntry } from "./compile-ledger.mjs";

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const VOYAGE_ROOT = path.join(SCRIPT_DIR, "..");
const REPO_ROOT = path.join(VOYAGE_ROOT, "..", "..");

// DX-10：已知「离线计时对这个程序不可信」的程序（README 坑点 + research/PERF_REPORT_wave6.md §3.1：
// exposure-meter 离线 fxc /O1 约 25 秒，浏览器里整个「曝光与眩光」阶段只要 0.25 秒，偏差百倍——推测是
// 32×32 常量循环在 fxc /O1 下被整段展开，ANGLE 实际用的编译配置不同，未查证）。程序表里遇到这些 id 就标注，
// 不参与「贴线 / 超预算」这类判定的默认解读（数字仍然打印出来，只是加一句提醒，不隐藏）。
const OFFLINE_UNRELIABLE = new Set(["exposure-meter"]);
function unreliableNote(id) {
  return OFFLINE_UNRELIABLE.has(id) ? "【离线不可信，浏览器实测远快，见 README 坑点】" : "";
}

// ---------- 统计：最小值 / 中位数 / MAD（判定按最小值——负载只会让计时变慢，噪声是单向的，
// 见 research/PERF_REPORT_wave6.md 的验证结论） ----------
function median(arr) {
  if (arr.length === 0) return NaN;
  const s = [...arr].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}
function mad(arr) {
  if (arr.length === 0) return NaN;
  const m = median(arr);
  return median(arr.map((x) => Math.abs(x - m)));
}
function minOf(arr) {
  return arr.length === 0 ? NaN : Math.min(...arr);
}
function statsOf(arr) {
  return { min: minOf(arr), median: median(arr), mad: mad(arr), n: arr.length, raw: [...arr] };
}
function fmtStats(st) {
  if (!st || st.n === 0) return "—";
  return `min ${st.min.toFixed(0)} / med ${st.median.toFixed(0)} / MAD ${st.mad.toFixed(0)}（n=${st.n}，原始:[${st.raw.map((x) => x.toFixed(0)).join(",")}]）`;
}

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

// ---------- --bisect 的模块表：按 scene.ts / terrain-shading.glsl.ts 当前调用点维护的精确字符串替换 ----------
// （见文件头注释「坑」：代码演进后锚点会漂移，找不到就跳过，不报错）
const MODULE_STUBS = {
  ground: {
    desc: "地面 clipmap 分支（outsideRadiance 里 uGroundOn 提前返回的整段）",
    rules: [["if (uGroundOn > 0.5) {", "if (false) {"]],
  },
  "ocean-main": {
    desc: "开阔海面主调用（outsideRadiance 里那次 oceanRadiance）",
    rules: [
      [
        "vec3 sea = tView * (oceanRadiance(P, rd, tGround, vec3(-1.0), 1.0, fView, nView) + vec3(0.02, 0.04, 0.05) / M_PI * flashIlluminance(P));",
        "fView = 0.0; nView = vec3(0.0, 1.0, 0.0);\n    vec3 sea = tView * (vec3(0.0) + vec3(0.02, 0.04, 0.05) / M_PI * flashIlluminance(P));",
      ],
    ],
  },
  "ocean-in-ground": {
    desc: "地面路径里的水体调用（groundRadiance 里那次 oceanRadiance——研究报告发现的重复内联，和 ocean-main 是同一份逻辑）",
    rules: [
      [
        "if (wat.g > 0.5) water = oceanRadiance(P, rd, tT, alb.rgb * 0.7, 1.0, fView, nView);",
        "if (wat.g > 0.5) { fView = 0.0; nView = vec3(0.0, 1.0, 0.0); water = alb.rgb * 0.02; }",
      ],
    ],
  },
  seats: {
    desc: "座椅（traceSeats + shadeSeat + 接触阴影）",
    rules: [
      ["SeatHit seat = traceSeats(ro, rd, tWall, pixAng);", "SeatHit seat; seat.cov = 0.0;"],
      ["vec3 seatCol = seat.cov > 0.0 ? shadeSeat(ro, rd, seat, pixAng, cl, uShadeBottom) : vec3(0.0);", "vec3 seatCol = vec3(0.0);"],
      ["float wallSeatAO = pW.y < 0.08 ? mix(0.55, 1.0, smoothstep(0.0, 0.12, sdSeats(pW))) : 1.0;", "float wallSeatAO = 1.0;"],
    ],
  },
  wall: {
    desc: "舱壁明暗（shadeWall）",
    rules: [["vec3 wall = shadeWall(pW, rd, tWall, pixAng, wq, dBezel, seed, wallSeatAO, cl);", "vec3 wall = PLASTIC_ALBEDO / M_PI * eCabin * wallSeatAO;"]],
  },
  funnel: {
    desc: "窗洞内衬（marchFunnel 光线步进）",
    rules: [["if (dBezel < 0.01 && marchFunnel(roL, rd, hit)) {", "if (false) {"]],
  },
  shade: {
    desc: "遮光板（shadeShade）",
    rules: [["vec3 shade = shadeShade(pShade - vec3(wOff, 0.0), rd, pixShade, cl, shadeBottom, seed);", "vec3 shade = PLASTIC_ALBEDO / M_PI * eCabin;"]],
  },
  outside: {
    desc: "窗外主调用（outsideRadiance，含地面 / 海面 / 天空一整套，是 ground / ocean-main 的超集）",
    rules: [["view = outsideRadiance(rdW, cloud);", "view = skyRadiance(rdW, rdW.y < 0.0) * cloud.a + cloud.rgb;"]],
  },
  traffic: {
    desc: "过路飞机（trafficRadiance，含 2 次循环）",
    rules: [["vec4 tr = trafficRadiance(rdW);", "vec4 tr = vec4(0.0, 0.0, 0.0, 1.0);"]],
  },
  bolt: {
    desc: "闪电（boltRadiance）",
    rules: [["boltRadiance(rdW)", "vec3(0.0)"]],
  },
  pane: {
    desc: "窗板细节（划痕 / 油污 / 擦痕 / 水珠）",
    rules: [
      ["vec2 sc = scratches(q, rd, sunC, pixPane);", "vec2 sc = vec2(0.0);"],
      ["float sm = smudges(q);", "float sm = 0.0;"],
      ["float wm = wipeMarks(q, pixPane);", "float wm = 0.0;"],
      ["vec2 wetCov = waterOnPane(q, pixPane, -uSeatSign, uTime, uWetness);", "vec2 wetCov = vec2(0.0);"],
    ],
  },
};

function printModuleList() {
  console.log("已知的 --bisect 模块（只对 scene-default / scene-ground-detail 生效）：\n");
  for (const [name, { desc }] of Object.entries(MODULE_STUBS)) console.log(`  ${name.padEnd(18)} ${desc}`);
  console.log("\n用法：--bisect ground（单个）、--bisect \"a,b\"（几个一起换桩）、--bisect \"a;b;c\"（分号=各自一个变体，一次对照）。");
}

/** 把 moduleNames 列出的模块在 src 里换成桩。锚点对不上（不是恰好出现一次）就跳过，写进 missing，不抛错。 */
function applyStubs(src, moduleNames) {
  let text = src;
  const applied = [];
  const missing = [];
  for (const name of moduleNames) {
    const mod = MODULE_STUBS[name];
    if (!mod) {
      missing.push(`${name}（未知模块名，见 --bisect list）`);
      continue;
    }
    let ok = true;
    let next = text;
    for (const [from, to] of mod.rules) {
      const count = next.split(from).length - 1;
      if (count !== 1) {
        ok = false;
        break;
      }
      next = next.split(from).join(to);
    }
    if (ok) {
      text = next;
      applied.push(name);
    } else {
      missing.push(`${name}（锚点对不上，代码可能已经变了，去 shader-budget.mjs 的 MODULE_STUBS 按 scene.ts 当前文本更新）`);
    }
  }
  return { text, applied, missing };
}

function parseBisectSpec(spec) {
  return spec
    .split(";")
    .map((g) => g.split(",").map((s) => s.trim()).filter(Boolean))
    .filter((g) => g.length > 0);
}

// ---------- 定位 fxc.exe（Windows SDK） ----------
function findFxc() {
  if (process.platform !== "win32") return null;
  const roots = ["C:\\Program Files (x86)\\Windows Kits\\10\\bin", "C:\\Program Files\\Windows Kits\\10\\bin"];
  for (const root of roots) {
    if (!fs.existsSync(root)) continue;
    let versions;
    try {
      versions = fs
        .readdirSync(root)
        .filter((d) => /^10\.\d+\.\d+\.\d+$/.test(d))
        .sort()
        .reverse();
    } catch {
      continue;
    }
    for (const v of versions) {
      const p = path.join(root, v, "x64", "fxc.exe");
      if (fs.existsSync(p)) return p;
    }
  }
  return null;
}

// ---------- 补占位符（ANGLE 的 HLSL 输出留给链接期生成的部分，我们自己补，见文件头「坑」） ----------
function fillPlaceholders(hlsl) {
  let s = hlsl;
  s = s.replace(
    "@@ PIXEL OUTPUT @@",
    "struct PS_OUTPUT { float4 gl_Color0 : SV_Target0; };\nPS_OUTPUT generateOutput() { PS_OUTPUT o; o.gl_Color0 = out_pc_fragColor; return o; }\n",
  );
  s = s.replace("@@ PIXEL MAIN PARAMETERS @@", "float4 dx_Position : SV_Position");
  s = s.replace("@@ MAIN PROLOGUE @@", s.includes("static float4 gl_FragCoord") ? "gl_FragCoord = dx_Position;" : "");
  return s;
}

// ---------- sampler 计数：直接数 HLSL 头里 Texture2D<...> textures2D[n] 这类声明的数组长度 ----------
function countSamplers(hlsl) {
  const re = /uniform\s+(Texture\w+)<[^>]*>\s+\w+\[(\d+)\]/g;
  let total = 0;
  const byType = [];
  let m;
  while ((m = re.exec(hlsl))) {
    total += Number(m[2]);
    byType.push(`${m[1]}[${m[2]}]`);
  }
  return { total, byType };
}

// ---------- 1. 枚举程序 + 收集 GLSL（vite ssrLoadModule，不开浏览器，复用 lint-shaders.mjs） ----------
// root：voyage 应用根目录（含 scripts/lint-shaders.mjs），--baseline / --chain 对照模式下指向另一棵（通常更老的）
// 树，其余情况都是当前的 VOYAGE_ROOT。
// opts.lenient（DX-10）：对照的树可能缺材质 / 程序（奇观、卷云、经济舱……在更老的提交里还不存在），lenient=true
// 时跳过缺失的部分并通过 opts.onSkip 上报，而不是让 collectPrograms 直接抛错炸掉整棵树的枚举（性能工程师第 6 波
// 复测反馈：「shader-budget --baseline 对不同时期的树直接失败」，见 research/PERF_REPORT_wave6.md 末尾）。
// --only 在 lenient 模式下同理：指定的程序在这棵树里不存在就跳过并警告，不抛错。
async function loadPrograms(root, only, { lenient = false } = {}) {
  const server = await createServer({ root, server: { middlewareMode: true }, appType: "custom", logLevel: "error" });
  const skipped = [];
  let programs;
  try {
    if (lenient) {
      programs = await collectPrograms(server, { lenient: true, onSkip: (id, err) => skipped.push(`${id}: ${err.message}`) });
    } else {
      programs = await collectPrograms(server);
    }
  } finally {
    await server.close();
  }
  if (only) {
    const wanted = new Set(only);
    const known = new Set(programs.map((p) => p.id));
    const missing = [...wanted].filter((id) => !known.has(id));
    if (missing.length > 0) {
      if (lenient) {
        skipped.push(`--only 里这些程序在这棵树没找到，已跳过：${missing.join(", ")}`);
      } else {
        throw new Error(`--only 里有未知程序：${missing.join(", ")}\n已知程序：${[...known].join(", ")}`);
      }
    }
    programs = programs.filter((p) => wanted.has(p.id));
  }
  if (lenient && skipped.length > 0) {
    const label = path.relative(REPO_ROOT, root) || root;
    console.warn(`[shader-budget] ${label}：以下程序缺失或跳过：\n${skipped.map((s) => `  - ${s}`).join("\n")}`);
  }
  return programs;
}

// ---------- 2. 按 --bisect 展开成待翻译的变体列表 ----------
function buildVariants(programs, bisectGroups) {
  const variants = [];
  for (const prog of programs) {
    if (bisectGroups.length === 0) {
      variants.push({ id: prog.id, baseId: prog.id, label: null, fragmentShader: prog.fragmentShader, stubbed: [], missing: [] });
      continue;
    }
    // SC-5：原场景程序拆成了 scene-*（舱内合成）与 outside-*（窗外），模块表两边都试（锚点对不上的会跳过）
    const isScene = prog.id.startsWith("scene") || prog.id.startsWith("outside");
    if (!isScene) {
      console.warn(`[shader-budget] --bisect 跳过 ${prog.id}：模块表是按场景程序（scene-*）的调用点建的，这个程序用不上。`);
      variants.push({ id: prog.id, baseId: prog.id, label: null, fragmentShader: prog.fragmentShader, stubbed: [], missing: [] });
      continue;
    }
    variants.push({ id: `${prog.id} [baseline]`, baseId: prog.id, label: "baseline", fragmentShader: prog.fragmentShader, stubbed: [], missing: [] });
    for (const group of bisectGroups) {
      const { text, applied, missing } = applyStubs(prog.fragmentShader, group);
      const label = group.join("+");
      variants.push({ id: `${prog.id} [stub:${label}]`, baseId: prog.id, label, fragmentShader: text, stubbed: applied, missing });
    }
  }
  return variants;
}

// ---------- 3. 私有 d3d11 headless，about:blank 页里逐个翻译（只翻译不链接，不占 GPU） ----------
async function translateAll(variants) {
  const browser = await launchBrowserAngle(chromium, { angle: "d3d11" });
  const out = [];
  try {
    const page = await (await browser.newContext()).newPage();
    await page.goto("about:blank");
    for (const v of variants) {
      const unknown = new Set();
      const glsl = FRAG_PREFIX + resolveIncludes(v.fragmentShader, unknown);
      if (unknown.size > 0) {
        console.warn(`[shader-budget] ${v.id}：未登记的 THREE #include <${[...unknown].join(", ")}>，去 lint-shaders.mjs 的 INCLUDE_STUBS 补一条（已按空文本处理，翻译结果可能不准）`);
      }
      const r = await page.evaluate((src) => {
        const gl = document.createElement("canvas").getContext("webgl2");
        const ext = gl.getExtension("WEBGL_debug_shaders");
        const sh = gl.createShader(gl.FRAGMENT_SHADER);
        gl.shaderSource(sh, src);
        gl.compileShader(sh);
        const ok = gl.getShaderParameter(sh, gl.COMPILE_STATUS);
        return { ok, log: gl.getShaderInfoLog(sh), hlsl: ext ? ext.getTranslatedShaderSource(sh) : null };
      }, glsl);
      out.push({ ...v, translateOk: r.ok, translateLog: r.log, hlsl: r.hlsl });
    }
  } finally {
    await closeBrowserSafely(browser);
  }
  return out;
}

// ---------- 4. fxc.exe 离线计时，小线程池并行 ----------
async function runFxc(translated, { fxc, quick, jobsN, tmpDir }) {
  const queue = translated.filter((v) => v.translateOk && v.hlsl);
  const results = [];
  let idx = 0;
  async function worker() {
    while (idx < queue.length) {
      const v = queue[idx++];
      const filled = fillPlaceholders(v.hlsl);
      const safeName = v.id.replace(/[^\w.-]+/g, "_");
      const file = path.join(tmpDir, `${safeName}.hlsl`);
      fs.writeFileSync(file, filled);
      const samplers = countSamplers(v.hlsl);
      const t0 = Date.now();
      try {
        execFileSync(fxc, ["/nologo", "/T", "ps_5_0", "/E", "main", quick ? "/Od" : "/O1", "/Fo", "NUL", file], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
        results.push({ ...v, fxcOk: true, fxcMs: Date.now() - t0, samplers });
      } catch (err) {
        const tail = String(err.stderr || err.stdout || err.message)
          .trim()
          .split("\n")
          .slice(-2)
          .join(" / ");
        results.push({ ...v, fxcOk: false, fxcMs: Date.now() - t0, fxcError: tail, samplers });
      }
    }
  }
  await Promise.all(Array.from({ length: Math.max(1, Math.min(jobsN, queue.length)) }, worker));
  // 恢复原始顺序（线程池是抢占式的，结果顺序会打乱）
  const order = new Map(translated.map((v, i) => [v.id, i]));
  results.sort((a, b) => order.get(a.id) - order.get(b.id));
  return results;
}

// ---------- --baseline <目录或端口>：与另一个 worktree 对照，交替多轮取中位数（DX-08） ----------
// 只支持目录（另一个 voyage 应用根，或含 apps/voyage 的仓库根）：shader-budget 本身不连接开发服务器，
// 而 Windows 没有 Linux /proc/<pid>/cwd 那样的机制能从「端口」反查进程的工作目录，没法凭空把一个端口号
// 变成目录。传端口号时给出明确的报错和替代做法（传目录，或先 `git worktree list` 查一下）。
function resolveBaselineRoot(value) {
  const trimmed = String(value).trim();
  const looksLikePort = /^\d+$/.test(trimmed);
  const candidate = path.isAbsolute(trimmed) ? trimmed : path.join(REPO_ROOT, trimmed);
  if (fs.existsSync(candidate)) {
    const asRepoRoot = path.join(candidate, "apps", "voyage");
    if (fs.existsSync(asRepoRoot)) return asRepoRoot;
    if (fs.existsSync(path.join(candidate, "scripts", "lint-shaders.mjs"))) return candidate;
    throw new Error(`--baseline 目录 "${value}" 存在，但既不是含 apps/voyage 的仓库根，也不是 voyage 应用根（没有 scripts/lint-shaders.mjs）`);
  }
  if (looksLikePort) {
    throw new Error(
      `--baseline "${value}" 看起来是端口号：shader-budget 不连接开发服务器，Windows 也没法从端口反查进程的工作目录，` +
        `没法凭它找到对应的 worktree 目录。请改传目录路径（例如 ".claude/worktrees/agent-xxxx/apps/voyage"），` +
        `不确定的话先 "git worktree list" 查一下这个任务用的是哪个目录。`,
    );
  }
  throw new Error(`--baseline "${value}" 不是一个存在的目录`);
}

/** 枚举 + 翻译一侧（GLSL → HLSL 是确定性的翻译，噪声只来自后面 fxc 本身的编译计时，不需要重复做这一步） */
async function translateSide(root, only, bisectGroups, { lenient = false } = {}) {
  const programs = await loadPrograms(root, only, { lenient });
  const variants = buildVariants(programs, bisectGroups);
  return translateAll(variants);
}

async function runBaselineCompare(args, { fxc, quick, jobsN, only, bisectGroups }) {
  const baselineRoot = resolveBaselineRoot(args.baseline);
  const rounds = Number(args.rounds || 3);
  const keepHlsl = !!args["keep-hlsl"];

  console.log("== SC-2 离线着色器编译预算：--baseline 对照模式 ==");
  console.log(`当前：${VOYAGE_ROOT}`);
  console.log(`基线：${baselineRoot}`);
  console.log(`轮数：${rounds}（交替测两侧，判定按最小值）  模式：${quick ? "/Od" : "/O1"}\n`);

  if (args["wait-quiet"]) await waitForQuiet({ log: (s) => console.log(s) });

  // DX-10：lenient=true——基线可能是更老的提交，缺材质 / 程序（奇观、卷云、经济舱……）不再让整棵树枚举失败，
  // 缺的会被跳过并打印警告（见 loadPrograms / collectPrograms 的 lenient 模式）。
  console.log("[1/2] 枚举 + 翻译两侧（各一次，lenient：缺材质跳过不崩）...");
  const curTranslated = await translateSide(VOYAGE_ROOT, only, bisectGroups, { lenient: true });
  const baseTranslated = await translateSide(baselineRoot, only, bisectGroups, { lenient: true });
  console.log(`  当前 ${curTranslated.length} 个变体，基线 ${baseTranslated.length} 个变体`);

  console.log(`\n[2/2] fxc.exe 交替计时 ${rounds} 轮...`);
  const curSamples = new Map();
  const baseSamples = new Map();
  let keptCurDir = null;
  let keptBaseDir = null;
  for (let r = 0; r < rounds; r++) {
    const load = sampleAndWarn(`--baseline 第 ${r + 1}/${rounds} 轮之前`);
    const curDir = mkdtempSync(path.join(tmpdir(), "voyage-shader-budget-cur-"));
    const curTimed = await runFxc(curTranslated, { fxc, quick, jobsN, tmpDir: curDir });
    for (const t of curTimed) {
      if (!t.fxcOk) continue;
      if (!curSamples.has(t.id)) curSamples.set(t.id, []);
      curSamples.get(t.id).push(t.fxcMs);
    }
    if (keepHlsl && r === rounds - 1) keptCurDir = curDir;
    else rmSync(curDir, { recursive: true, force: true });

    const baseDir = mkdtempSync(path.join(tmpdir(), "voyage-shader-budget-base-"));
    const baseTimed = await runFxc(baseTranslated, { fxc, quick, jobsN, tmpDir: baseDir });
    for (const t of baseTimed) {
      if (!t.fxcOk) continue;
      if (!baseSamples.has(t.id)) baseSamples.set(t.id, []);
      baseSamples.get(t.id).push(t.fxcMs);
    }
    if (keepHlsl && r === rounds - 1) keptBaseDir = baseDir;
    else rmSync(baseDir, { recursive: true, force: true });

    console.log(`  第 ${r + 1}/${rounds} 轮完成${load != null ? `（CPU ${load.toFixed(0)}%）` : ""}`);
  }

  // DX-10：输出最小值 / 中位数 / MAD 与每轮原始值，判定按最小值（负载只会让计时变慢，噪声是单向的）。
  console.log("\n== 结果（ms，判定按最小值）==");
  const header = `${"程序".padEnd(38)} ${"当前 min/med/MAD".padEnd(24)} ${"基线 min/med/MAD".padEnd(24)} Δmin`;
  console.log(header);
  console.log("-".repeat(header.length + 20));
  const ids = [...new Set([...curSamples.keys(), ...baseSamples.keys()])];
  const rows = [];
  for (const id of ids) {
    const curArr = curSamples.get(id) || [];
    const baseArr = baseSamples.get(id) || [];
    const curSt = statsOf(curArr);
    const baseSt = statsOf(baseArr);
    const delta = Number.isFinite(curSt.min) && Number.isFinite(baseSt.min) && baseSt.min > 0 ? ((curSt.min - baseSt.min) / baseSt.min) * 100 : NaN;
    rows.push({ id, cur: curSt, base: baseSt, deltaMinPct: delta, note: unreliableNote(id) || undefined });
    const deltaStr = Number.isFinite(delta)
      ? `${delta >= 0 ? "+" : ""}${delta.toFixed(1)}%`
      : curArr.length === 0
        ? "—（仅基线，当前树没有）"
        : baseArr.length === 0
          ? "—（新增，基线树没有）"
          : "—";
    const curCell = curArr.length ? `${curSt.min.toFixed(0)}/${curSt.median.toFixed(0)}/${curSt.mad.toFixed(0)}` : "—";
    const baseCell = baseArr.length ? `${baseSt.min.toFixed(0)}/${baseSt.median.toFixed(0)}/${baseSt.mad.toFixed(0)}` : "—";
    console.log(`${id.padEnd(38)} ${curCell.padEnd(24)} ${baseCell.padEnd(24)} ${deltaStr}${unreliableNote(id) ? " " + unreliableNote(id) : ""}`);
  }
  if (keepHlsl) console.log(`\nHLSL 已保留：当前 ${keptCurDir}，基线 ${keptBaseDir}`);

  if (args.out) {
    const outPath = resolveRepoPath(REPO_ROOT, args.out);
    fs.mkdirSync(path.dirname(outPath), { recursive: true });
    fs.writeFileSync(
      outPath,
      JSON.stringify({ when: new Date().toISOString(), rounds, quick, current: VOYAGE_ROOT, baseline: baselineRoot, rows }, null, 2),
    );
    console.log(`\n结果已写入 ${path.relative(REPO_ROOT, outPath).replace(/\\/g, "/")}`);
  }
}

// ---------- --chain <提交1,提交2,…> --program <id>：沿合并链轮转测一个（或几个）程序（DX-10） ----------
// 收编性能工程师第 6 波手工做的归因（tmp/perf-w6/march-chain.sh + w6_analyze.py，未进仓库）：沿一串提交
// 逐个检出、只测指定程序，每个状态相对上一状态的增量就是那次合并「贡献」了多少编译时间
// （research/PERF_REPORT_wave6.md §2.3 的表就是这样手工跑出来的）。为了不在当前 worktree 里 checkout
// （会打断这里正在进行的工作，也会和别的代理抢), 单独建一个临时对照 worktree（默认
// tmp/shader-budget-chain，复用同一份约定：临时工作区放仓库 tmp/ 下，见 README 坑点「对照基线放进
// scratchpad 会让 check:glsl 静默全 FAIL」——这里不放 scratchpad 也是同一个理由）。
// 这个 worktree 会保留下来供下次 --chain 复用（省去重新 pnpm install 的时间），不需要了可以手工
// `git worktree remove <路径>` 清理。
function ensureChainWorktree(workdir, firstCommit) {
  fs.mkdirSync(path.dirname(workdir), { recursive: true });
  if (fs.existsSync(workdir)) {
    if (!fs.existsSync(path.join(workdir, ".git"))) {
      throw new Error(
        `--chain 的工作区 "${workdir}" 已存在，但看起来不是一个 git worktree（没有 .git）。` +
          "可能是异常中断留下的半成品目录，请先手工清理（PowerShell Remove-Item -Recurse -Force 这个目录，" +
          '再 "git worktree prune"），然后重跑。',
      );
    }
    console.log(`[chain] 复用已存在的临时 worktree：${workdir}`);
  } else {
    console.log(`[chain] 创建临时对照 worktree：${workdir}`);
    execFileSync("git", ["-C", REPO_ROOT, "worktree", "add", "--detach", workdir, firstCommit], { stdio: "inherit" });
  }
  const nodeModules = path.join(workdir, "apps", "voyage", "node_modules");
  if (!fs.existsSync(nodeModules)) {
    console.log('[chain] 首次使用，跑一次 "pnpm install --filter voyage"（后续复用这个 worktree 会跳过这一步）...');
    try {
      execFileSync("pnpm", ["install", "--filter", "voyage"], { cwd: workdir, stdio: "inherit", shell: process.platform === "win32" });
    } catch (err) {
      console.warn(`[chain] pnpm install 失败（${err.message}）——如果后面枚举程序失败，先手工在 ${workdir} 里跑一次 pnpm install`);
    }
  }
}

async function runChain(args, { fxc, quick }) {
  const commits = String(args.chain).split(",").map((s) => s.trim()).filter(Boolean);
  if (commits.length === 0) throw new Error("--chain 需要至少一个提交（逗号分隔）");
  if (!args.program) throw new Error("--chain 要配合 --program <程序id>[,程序id...] 一起用（例如 --program cloud-march）");
  const programIds = String(args.program).split(",").map((s) => s.trim()).filter(Boolean);
  const rounds = Number(args.rounds || 3);
  const jobsN = Number(args.jobs || 1); // 默认 --jobs 1：和性能工程师的 march-chain.sh 一致，避免同批内几个程序互相抢 CPU
  const workdir = resolveRepoPath(REPO_ROOT, args.workdir || "tmp/shader-budget-chain");

  console.log("== SC-2 离线着色器编译预算：--chain 合并链归因模式 ==");
  console.log(`提交链（${commits.length} 个）：${commits.join(" -> ")}`);
  console.log(`程序：${programIds.join(", ")}  轮数：${rounds}（判定按最小值）  模式：${quick ? "/Od" : "/O1"}  jobs：${jobsN}`);
  console.log(`临时工作区：${path.relative(REPO_ROOT, workdir) || workdir}\n`);

  ensureChainWorktree(workdir, commits[0]);
  const voyageAtCommit = fs.existsSync(path.join(workdir, "apps", "voyage")) ? path.join(workdir, "apps", "voyage") : workdir;

  if (args["wait-quiet"]) await waitForQuiet({ log: (s) => console.log(s) });

  const commitMeta = new Map();
  for (const c of commits) {
    try {
      commitMeta.set(c, {
        short: execFileSync("git", ["-C", REPO_ROOT, "rev-parse", "--short", c], { encoding: "utf8" }).trim(),
        subject: execFileSync("git", ["-C", REPO_ROOT, "log", "-1", "--format=%s", c], { encoding: "utf8" }).trim(),
      });
    } catch {
      commitMeta.set(c, { short: c, subject: "(取不到提交信息，可能是无效的提交)" });
    }
  }

  const samples = new Map(); // `${commit}::${programId}` -> ms[]
  for (let r = 0; r < rounds; r++) {
    const load = sampleAndWarn(`--chain 第 ${r + 1}/${rounds} 轮之前`);
    console.log(`\n[第 ${r + 1}/${rounds} 轮]${load != null ? `（CPU ${load.toFixed(0)}%）` : ""}`);
    for (const c of commits) {
      const meta = commitMeta.get(c);
      try {
        execFileSync("git", ["-C", workdir, "checkout", "-q", "--detach", c], { stdio: ["ignore", "pipe", "pipe"] });
      } catch (err) {
        console.warn(`  [跳过] ${meta.short}：检出失败——${String(err.stderr || err.message).trim().split("\n").slice(-2).join(" / ")}`);
        continue;
      }
      let translated;
      try {
        translated = await translateSide(voyageAtCommit, programIds, [], { lenient: true });
      } catch (err) {
        console.warn(`  [跳过] ${meta.short}：枚举程序失败——${err.message}`);
        continue;
      }
      if (translated.length === 0) {
        console.warn(`  [跳过] ${meta.short}：--program 指定的程序在这个提交里都不存在（还没加这个功能）`);
        continue;
      }
      const tmpDir = mkdtempSync(path.join(tmpdir(), "voyage-shader-budget-chain-"));
      let timed;
      try {
        timed = await runFxc(translated, { fxc, quick, jobsN, tmpDir });
      } finally {
        rmSync(tmpDir, { recursive: true, force: true });
      }
      for (const t of timed) {
        if (!t.fxcOk) continue;
        const key = `${c}::${t.id}`;
        if (!samples.has(key)) samples.set(key, []);
        samples.get(key).push(t.fxcMs);
      }
      console.log(`  ${meta.short} ${meta.subject.slice(0, 40)}：完成`);
    }
  }

  const outRows = [];
  for (const id of programIds) {
    console.log(`\n== ${id}（合并链归因，ms，判定按最小值，fxc ${quick ? "/Od" : "/O1"}） ==`);
    const header = `${"提交".padEnd(9)} ${"说明".padEnd(34)} ${"min/med/MAD".padEnd(20)} 相对上一状态`;
    console.log(header);
    console.log("-".repeat(header.length + 10));
    let prevMin = null;
    for (const c of commits) {
      const meta = commitMeta.get(c);
      const st = statsOf(samples.get(`${c}::${id}`) || []);
      if (st.n === 0) {
        console.log(`${meta.short.padEnd(9)} ${meta.subject.slice(0, 34).padEnd(34)} ${"—".padEnd(20)} —（缺失/失败，见上面 [跳过]）`);
        outRows.push({ commit: c, ...meta, programId: id, stats: null });
        continue;
      }
      const rel = prevMin == null ? "—（起点）" : `${st.min - prevMin >= 0 ? "+" : ""}${(((st.min - prevMin) / prevMin) * 100).toFixed(1)}%`;
      console.log(`${meta.short.padEnd(9)} ${meta.subject.slice(0, 34).padEnd(34)} ${`${st.min.toFixed(0)}/${st.median.toFixed(0)}/${st.mad.toFixed(0)}`.padEnd(20)} ${rel}`);
      outRows.push({ commit: c, ...meta, programId: id, stats: st, deltaFromPrevPct: prevMin == null ? null : ((st.min - prevMin) / prevMin) * 100 });
      prevMin = st.min;
    }
    if (unreliableNote(id)) console.log(`  ${unreliableNote(id)}`);
  }

  if (args.out) {
    const outPath = resolveRepoPath(REPO_ROOT, args.out);
    fs.mkdirSync(path.dirname(outPath), { recursive: true });
    fs.writeFileSync(outPath, JSON.stringify({ when: new Date().toISOString(), commits, programIds, rounds, quick, jobsN, rows: outRows }, null, 2));
    console.log(`\n结果已写入 ${path.relative(REPO_ROOT, outPath).replace(/\\/g, "/")}`);
  }

  console.log(
    `\n临时工作区保留在 ${path.relative(REPO_ROOT, workdir) || workdir}（下次 --chain 会复用，省去重新 pnpm install；` +
      '不再需要时可以手工 "git worktree remove" + 删目录清理）',
  );
}

// ---------- --variants <文件.mjs>：补丁文件（查找 / 替换对），按单项撤回做变体对照（DX-10） ----------
// 收编 T47（handoff/T47-fxc-bisect.py）、W01b（handoff/W01b-fxc.sh）、T41（手工替换 HLSL）三份各写一次的
// 「换掉单个改动、和 master／原版交替计时」需求。和已有的 --bisect 不同：--bisect 只能撤掉 MODULE_STUBS 里
// 预先登记好的几个大模块调用点；--variants 直接在**磁盘上的源文件**做任意查找 / 替换（更贴近 T47 们的实际
// 做法——撤掉某一行新加的代码，看编译时间掉多少），补丁应用 / 翻译 / 计时之后立刻把文件改回原样，不管成功
// 失败都会恢复（下面的 try/finally），不会把中间状态留在工作区里。
//
// --variants 文件格式（ESM，import(pathToFileURL(...))）：
//   export const VARIANTS = [
//     ["base", []],                                                    // 空数组 = 不改，当基线
//     ["noBend", [{ file: "src/render/seats.glsl.ts", find: "...", replace: "" }]],
//     ["no1c", [{ file: "src/render/cabin-shading.glsl.ts", find: "...", replace: "..." }]],
//   ];
// file 是相对 apps/voyage 的路径；find 必须在文件里恰好出现一次（和 --bisect 的锚点检查一样，多次 / 零次
// 都报错退出，不做「反正替换第一个」这种会读错文件的事）。必须配合 --only <程序>（先明确测哪个程序，变体
// 对照才有意义，不然要把 buildVariants 的 --bisect 展开逻辑也套上，意义不大）。
async function runVariants(args, { fxc, quick, jobsN, only }) {
  if (!only || only.length === 0) {
    throw new Error("--variants 要配合 --only <程序>[,程序...] 一起用（先明确测哪个 / 哪些程序）");
  }
  const variantsPath = path.resolve(String(args.variants));
  const mod = await import(pathToFileURL(variantsPath).href);
  const VARIANTS = mod.VARIANTS;
  if (!VARIANTS || VARIANTS.length === 0) throw new Error(`${args.variants} 没有导出非空的 VARIANTS 数组`);
  const rounds = Number(args.rounds || 3);

  console.log("== SC-2 离线着色器编译预算：--variants 补丁对照模式 ==");
  console.log(`补丁文件：${variantsPath}`);
  console.log(`变体：${VARIANTS.map(([name]) => name).join(", ")}`);
  console.log(`程序：${only.join(", ")}  轮数：${rounds}（判定按最小值）  模式：${quick ? "/Od" : "/O1"}\n`);

  if (args["wait-quiet"]) await waitForQuiet({ log: (s) => console.log(s) });

  // 备份涉及的全部文件的原始内容（所有变体的并集），保证无论中途在哪一步出错都能恢复
  const originalByFile = new Map();
  for (const [name, patches] of VARIANTS) {
    for (const p of patches) {
      const f = path.resolve(VOYAGE_ROOT, p.file);
      if (!f.startsWith(VOYAGE_ROOT)) throw new Error(`变体 "${name}"：file "${p.file}" 解析到了 apps/voyage 以外，拒绝`);
      if (!fs.existsSync(f)) throw new Error(`变体 "${name}"：文件不存在——${p.file}`);
      if (!originalByFile.has(f)) originalByFile.set(f, fs.readFileSync(f, "utf8"));
    }
  }

  const samples = new Map(); // `${variantName}::${programId}` -> ms[]
  try {
    for (let r = 0; r < rounds; r++) {
      const load = sampleAndWarn(`--variants 第 ${r + 1}/${rounds} 轮之前`);
      console.log(`\n[第 ${r + 1}/${rounds} 轮]${load != null ? `（CPU ${load.toFixed(0)}%）` : ""}`);
      for (const [name, patches] of VARIANTS) {
        const touched = [];
        try {
          for (const p of patches) {
            const f = path.resolve(VOYAGE_ROOT, p.file);
            const cur = fs.readFileSync(f, "utf8");
            const count = cur.split(p.find).length - 1;
            if (count !== 1) {
              throw new Error(
                `变体 "${name}"：${p.file} 里查找文本出现 ${count} 次（应恰好 1 次），锚点可能已经过时——` +
                  `${p.find.slice(0, 80)}${p.find.length > 80 ? "…" : ""}`,
              );
            }
            fs.writeFileSync(f, cur.split(p.find).join(p.replace), "utf8");
            touched.push(f);
          }
          const translated = await translateSide(VOYAGE_ROOT, only, [], { lenient: false });
          const tmpDir = mkdtempSync(path.join(tmpdir(), "voyage-shader-budget-variant-"));
          let timed;
          try {
            timed = await runFxc(translated, { fxc, quick, jobsN, tmpDir });
          } finally {
            rmSync(tmpDir, { recursive: true, force: true });
          }
          for (const t of timed) {
            if (!t.fxcOk) continue;
            const key = `${name}::${t.id}`;
            if (!samples.has(key)) samples.set(key, []);
            samples.get(key).push(t.fxcMs);
          }
          console.log(`  ${name}：完成`);
        } finally {
          // 不管成功失败都恢复这个变体动过的文件，下一个变体从干净的原文出发
          for (const f of touched) fs.writeFileSync(f, originalByFile.get(f), "utf8");
        }
      }
    }
  } finally {
    // 保险：万一某个文件的 touched 恢复没跑到（例如在 for 循环之外抛错），这里按并集再核对一次
    for (const [f, content] of originalByFile) {
      try {
        if (fs.readFileSync(f, "utf8") !== content) {
          fs.writeFileSync(f, content, "utf8");
          console.warn(`[variants] 补充恢复：${path.relative(VOYAGE_ROOT, f)}`);
        }
      } catch {
        /* 尽力而为 */
      }
    }
  }

  const outRows = [];
  for (const id of only) {
    console.log(`\n== ${id}（--variants 补丁对照，ms，判定按最小值） ==`);
    const header = `${"变体".padEnd(14)} ${"min/med/MAD".padEnd(24)} 相对第一个变体(min)`;
    console.log(header);
    console.log("-".repeat(header.length + 10));
    let baseMin = null;
    for (const [name] of VARIANTS) {
      const st = statsOf(samples.get(`${name}::${id}`) || []);
      if (st.n === 0) {
        console.log(`${name.padEnd(14)} ${"—".padEnd(24)} —`);
        outRows.push({ variant: name, programId: id, stats: null });
        continue;
      }
      if (baseMin === null) baseMin = st.min;
      const rel = baseMin === st.min ? "—（基线）" : `${st.min - baseMin >= 0 ? "+" : ""}${(((st.min - baseMin) / baseMin) * 100).toFixed(1)}%`;
      console.log(`${name.padEnd(14)} ${`${st.min.toFixed(0)}/${st.median.toFixed(0)}/${st.mad.toFixed(0)}`.padEnd(24)} ${rel}`);
      outRows.push({ variant: name, programId: id, stats: st, deltaFromFirstPct: baseMin === st.min ? 0 : ((st.min - baseMin) / baseMin) * 100 });
    }
    if (unreliableNote(id)) console.log(`  ${unreliableNote(id)}`);
  }

  if (args.out) {
    const outPath = resolveRepoPath(REPO_ROOT, args.out);
    fs.mkdirSync(path.dirname(outPath), { recursive: true });
    fs.writeFileSync(outPath, JSON.stringify({ when: new Date().toISOString(), variantsFile: variantsPath, programIds: only, rounds, quick, rows: outRows }, null, 2));
    console.log(`\n结果已写入 ${path.relative(REPO_ROOT, outPath).replace(/\\/g, "/")}`);
  }
}

// ---------- 主流程 ----------
async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.bisect === "list" || args.help || args.h) {
    printModuleList();
    return;
  }

  const fxc = findFxc();
  if (!fxc) {
    console.log("[shader-budget] 本机没找到 fxc.exe（Windows SDK），这个工具依赖 Windows 上的 D3D 编译器，非 Windows 平台跳过。");
    console.log('  期望路径形如 "C:\\Program Files (x86)\\Windows Kits\\10\\bin\\<版本>\\x64\\fxc.exe"，装了 Windows SDK 就有。');
    process.exit(0);
  }

  const only = args.only ? String(args.only).split(",").map((s) => s.trim()) : null;
  const bisectGroups = args.bisect ? parseBisectSpec(String(args.bisect)) : [];
  const quick = !!args.quick;
  const jobsN = Number(args.jobs || Math.max(2, Math.min(8, os.cpus().length - 2)));
  const keepHlsl = !!args["keep-hlsl"];

  // DX-10：测量锁——离线 FXC 计时（含下面的 --chain / --variants / --baseline 分支）整段算「测量」，
  // 持锁到结束才释放，见 scripts/lib/measure-lock.mjs 与 README「调试与验证」的约定。
  const lockOwner = `shader-budget.mjs（pid ${process.pid}, ${new Date().toLocaleTimeString("zh-CN", { hour12: false })}）`;
  const releaseLock = tryAcquire(REPO_ROOT, lockOwner);
  if (!releaseLock) {
    const lock = readLock(REPO_ROOT);
    console.warn(`[shader-budget] 测量锁被占用（持有者：${lock ? lock.owner.split("\n")[0] : "未知"}），继续测量但结果可能被对方的负载污染（反之亦然）`);
  }

  try {
    // --chain <提交1,提交2,…> --program <id>：沿合并链轮转测一个程序，走单独的流程（见 runChain）
    if (args.chain) {
      await runChain(args, { fxc, quick });
      return;
    }

    // --variants <文件.mjs>：补丁文件对照，走单独的流程（见 runVariants）
    if (args.variants) {
      await runVariants(args, { fxc, quick, jobsN, only });
      return;
    }

    // --baseline：和另一个 worktree 对照，交替多轮取最小值，走单独的流程（见 runBaselineCompare）
    if (args.baseline) {
      await runBaselineCompare(args, { fxc, quick, jobsN, only, bisectGroups });
      return;
    }

    if (args["wait-quiet"]) await waitForQuiet({ log: (s) => console.log(s) });
    const rounds = Number(args.rounds || 1);

    console.log("== SC-2 离线着色器编译预算 ==");
    console.log(`fxc: ${fxc}`);
    console.log(
      `模式: ${quick ? "/Od（快速，跳过优化）" : "/O1（完整优化，和浏览器实际使用的等级一致）"}  并行: ${jobsN}  轮数: ${rounds}${rounds > 1 ? "（判定按最小值）" : ""}\n`,
    );

    console.log("[1/3] 枚举程序 + 收集 GLSL（vite ssrLoadModule，不开浏览器）...");
    const programs = await loadPrograms(VOYAGE_ROOT, only);
    console.log(`  枚举到 ${programs.length} 个程序：${programs.map((p) => p.id).join(", ")}`);
    if (bisectGroups.length > 0) console.log(`  --bisect：${bisectGroups.map((g) => g.join("+")).join(" | ")}`);

    const variants = buildVariants(programs, bisectGroups);

    console.log(`\n[2/3] 私有 d3d11 headless 翻译 GLSL → HLSL（${variants.length} 个变体，只翻译不链接，不占 GPU）...`);
    const t1 = Date.now();
    const translated = await translateAll(variants);
    console.log(`  完成，用时 ${Date.now() - t1} ms`);
    for (const v of translated) {
      if (!v.translateOk) console.log(`  [翻译失败] ${v.id}：${(v.translateLog || "").slice(0, 300)}`);
      if (v.missing && v.missing.length > 0) console.log(`  [提示] ${v.id}：以下模块没能换桩——${v.missing.join("；")}`);
    }

    // DX-10：--rounds N（默认 1，向后兼容）重复计时，输出最小值 / 中位数 / MAD 与每轮原始值，判定按最小值
    // （负载只会让计时变慢，噪声是单向的，见 research/PERF_REPORT_wave6.md 的验证结论）。
    console.log(`\n[3/3] fxc.exe 离线计时（${quick ? "/Od" : "/O1"}，并行 ${jobsN} 路，共 ${rounds} 轮）...`);
    const roundResults = [];
    for (let r = 0; r < rounds; r++) {
      const load = sampleAndWarn(`第 ${r + 1}/${rounds} 轮之前`);
      const tmpDir = mkdtempSync(path.join(tmpdir(), "voyage-shader-budget-"));
      let timed;
      try {
        const t2 = Date.now();
        timed = await runFxc(translated, { fxc, quick, jobsN, tmpDir });
        console.log(`  第 ${r + 1}/${rounds} 轮完成，墙钟用时 ${Date.now() - t2} ms${load != null ? `（CPU ${load.toFixed(0)}%）` : ""}`);
      } finally {
        // --keep-hlsl（DX-08）：T41 反馈过——排查冷编译暴涨时想直接改翻译好的 HLSL、用 fxc 计时，
        // 但这里编译完就删了临时目录，拿不到 HLSL。默认行为不变（删），传了才保留最后一轮并打印路径。
        if (keepHlsl && r === rounds - 1) console.log(`HLSL 已保留：${tmpDir}`);
        else rmSync(tmpDir, { recursive: true, force: true });
      }
      roundResults.push(timed);
    }

    // ---- 汇总：每个变体 id 在各轮的 fxcMs，算 min/median/MAD；元数据（sampler、stub 信息）取最后一轮 ----
    const msById = new Map();
    for (const timed of roundResults) {
      for (const r of timed) {
        if (!r.fxcOk) continue;
        if (!msById.has(r.id)) msById.set(r.id, []);
        msById.get(r.id).push(r.fxcMs);
      }
    }
    const lastRound = roundResults[roundResults.length - 1];
    const baselineMinById = new Map(); // --bisect 的 [baseline] 变体，按 baseId 取最小值，用来算「贡献」
    for (const r of lastRound) {
      if (r.label === "baseline") baselineMinById.set(r.baseId, statsOf(msById.get(r.id) || []).min);
    }

    console.log(`\n== 结果（${rounds > 1 ? "min/med/MAD，判定按最小值" : "ms"}） ==`);
    const valueColWidth = rounds > 1 ? 24 : 10;
    const header = `${"程序".padEnd(38)} ${"sampler".padEnd(10)} ${(rounds > 1 ? "min/med/MAD" : "fxc ms").padEnd(valueColWidth)} 备注`;
    console.log(header);
    console.log("-".repeat(header.length + 20));
    const programRows = [];
    for (const r of lastRound) {
      const samplerStr = `${r.samplers.total}/16${r.samplers.total > 16 ? "!" : ""}`;
      const st = statsOf(msById.get(r.id) || []);
      const msStr = r.fxcOk ? (rounds > 1 ? `${st.min.toFixed(0)}/${st.median.toFixed(0)}/${st.mad.toFixed(0)}` : String(r.fxcMs)) : "FAIL";
      let note = "";
      if (r.stubbed && r.stubbed.length > 0) note += `换桩:${r.stubbed.join("+")}`;
      if (r.missing && r.missing.length > 0) note += `${note ? " " : ""}(未换桩:${r.missing.map((m) => m.split("（")[0]).join("+")})`;
      if (r.label && r.label !== "baseline" && baselineMinById.has(r.baseId) && r.fxcOk) {
        // 贡献 = 基线（最小值）− 换桩后（最小值）：正数表示这个模块让编译多花了这么多 ms（换桩后变快），
        // 负数是异常（换桩后反而更慢，可能是噪声，同一批内比较仍然有效）
        const base = baselineMinById.get(r.baseId);
        const cur = rounds > 1 ? st.min : r.fxcMs;
        const contribution = base - cur;
        note += `${note ? " " : ""}贡献≈${contribution >= 0 ? "+" : ""}${contribution.toFixed(0)}ms（基线 ${base.toFixed(0)}ms）`;
      }
      if (!r.fxcOk) note += `${note ? " " : ""}错误:${r.fxcError}`;
      if (unreliableNote(r.baseId)) note += `${note ? " " : ""}${unreliableNote(r.baseId)}`;
      console.log(`${r.id.padEnd(38)} ${samplerStr.padEnd(10)} ${msStr.padEnd(valueColWidth)} ${note}`);
      programRows.push({ id: r.id, baseId: r.baseId, label: r.label || null, samplers: r.samplers, fxcOk: r.fxcOk, stats: r.fxcOk ? st : null });
    }
    const skippedTranslate = translated.filter((v) => !v.translateOk);
    if (skippedTranslate.length > 0) console.log(`\n（${skippedTranslate.length} 个程序翻译失败，没有 fxc 结果，见上面的 [翻译失败]）`);

    if (args.out) {
      const outPath = resolveRepoPath(REPO_ROOT, args.out);
      fs.mkdirSync(path.dirname(outPath), { recursive: true });
      fs.writeFileSync(outPath, JSON.stringify({ when: new Date().toISOString(), quick, jobsN, rounds, programs: programRows }, null, 2));
      console.log(`\n结果已写入 ${path.relative(REPO_ROOT, outPath).replace(/\\/g, "/")}`);
    }

    // --ledger（DX-10）：追加一行到编译预算账本（research/compile-ledger.json）。--bisect 的换桩变体不进账本，
    // 只记基线口径（未换桩）的程序，和账本原有几行的口径保持一致。
    if (args.ledger) {
      let commit = "unknown";
      try {
        commit = execFileSync("git", ["-C", REPO_ROOT, "rev-parse", "--short", "HEAD"], { encoding: "utf8" }).trim();
      } catch {
        /* 取不到就记 unknown，不影响追加本身 */
      }
      const programsForLedger = {};
      for (const row of programRows) {
        if (row.label && row.label !== "baseline") continue;
        if (!row.fxcOk || !row.stats) continue;
        const key = row.baseId || row.id;
        programsForLedger[key] = { min: row.stats.min, median: row.stats.median, mad: row.stats.mad, ...(unreliableNote(key) ? { note: "离线不可信" } : {}) };
      }
      const entry = {
        date: new Date().toISOString().slice(0, 10),
        commit,
        label: `shader-budget --ledger${only ? `（--only ${only.join(",")}）` : ""}`,
        quick,
        jobs: jobsN,
        rounds,
        programs: programsForLedger,
      };
      appendLedgerEntry(entry);
      console.log(`\n[ledger] 已追加一行到 research/compile-ledger.json（提交 ${commit}，${Object.keys(programsForLedger).length} 个程序）`);
    }
  } finally {
    if (releaseLock) releaseLock();
  }
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error(`[shader-budget] 失败：${err.message}`);
    process.exit(1);
  });
