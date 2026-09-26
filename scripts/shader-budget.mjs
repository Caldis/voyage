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
//
// --bisect 的模块表（MODULE_STUBS）是人工按 scene.ts / terrain-shading.glsl.ts 当前的调用点文本维护的
// 精确字符串替换（做法照抄开发体验官的 variants.py）。**代码演进后锚点会漂移**：找不到就跳过并在
// 输出里注明「锚点对不上」，不会让整个工具报错退出——过一段时间锚点大批失效是正常的，
// 照着当前 scene.ts 的调用点更新 MODULE_STUBS 就行（不是这个工具本身坏了）。只对 scene-*
// 程序生效，其它程序会被自动跳过（有提示）。
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
import { fileURLToPath } from "node:url";
import { launchBrowser as launchBrowserAngle, closeBrowserSafely } from "./lib/chrome.mjs";
import { collectPrograms, resolveIncludes, FRAG_PREFIX } from "./lint-shaders.mjs";

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const VOYAGE_ROOT = path.join(SCRIPT_DIR, "..");
const REPO_ROOT = path.join(VOYAGE_ROOT, "..", "..");

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
async function loadPrograms(only) {
  const server = await createServer({ root: VOYAGE_ROOT, server: { middlewareMode: true }, appType: "custom", logLevel: "error" });
  let programs;
  try {
    programs = await collectPrograms(server);
  } finally {
    await server.close();
  }
  if (only) {
    const wanted = new Set(only);
    const known = new Set(programs.map((p) => p.id));
    const missing = [...wanted].filter((id) => !known.has(id));
    if (missing.length > 0) {
      throw new Error(`--only 里有未知程序：${missing.join(", ")}\n已知程序：${[...known].join(", ")}`);
    }
    programs = programs.filter((p) => wanted.has(p.id));
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
    const isScene = prog.id.startsWith("scene");
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

  console.log("== SC-2 离线着色器编译预算 ==");
  console.log(`fxc: ${fxc}`);
  console.log(`模式: ${quick ? "/Od（快速，跳过优化）" : "/O1（完整优化，和浏览器实际使用的等级一致）"}  并行: ${jobsN}\n`);

  console.log("[1/3] 枚举程序 + 收集 GLSL（vite ssrLoadModule，不开浏览器）...");
  const programs = await loadPrograms(only);
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

  const tmpDir = mkdtempSync(path.join(tmpdir(), "voyage-shader-budget-"));
  let timed;
  try {
    console.log(`\n[3/3] fxc.exe 离线计时（${quick ? "/Od" : "/O1"}，并行 ${jobsN} 路）...`);
    const t2 = Date.now();
    timed = await runFxc(translated, { fxc, quick, jobsN, tmpDir });
    console.log(`  完成，墙钟用时 ${Date.now() - t2} ms\n`);
  } finally {
    rmSync(tmpDir, { recursive: true, force: true });
  }

  // ---- 结果表 ----
  const baselineMs = new Map();
  for (const r of timed) if (r.label === "baseline") baselineMs.set(r.baseId, r.fxcMs);

  console.log("== 结果 ==");
  const header = `${"程序".padEnd(38)} ${"sampler".padEnd(10)} ${"fxc ms".padEnd(10)} 备注`;
  console.log(header);
  console.log("-".repeat(header.length + 20));
  for (const r of timed) {
    const samplerStr = `${r.samplers.total}/16${r.samplers.total > 16 ? "!" : ""}`;
    const msStr = r.fxcOk ? String(r.fxcMs) : "FAIL";
    let note = "";
    if (r.stubbed && r.stubbed.length > 0) note += `换桩:${r.stubbed.join("+")}`;
    if (r.missing && r.missing.length > 0) note += `${note ? " " : ""}(未换桩:${r.missing.map((m) => m.split("（")[0]).join("+")})`;
    if (r.label && r.label !== "baseline" && baselineMs.has(r.baseId) && r.fxcOk) {
      // 贡献 = 基线 − 换桩后：正数表示这个模块让编译多花了这么多 ms（换桩后变快），
      // 负数是异常（换桩后反而更慢，可能是噪声，同一批内比较仍然有效）
      const base = baselineMs.get(r.baseId);
      const contribution = base - r.fxcMs;
      note += `${note ? " " : ""}贡献≈${contribution >= 0 ? "+" : ""}${contribution}ms（基线 ${base}ms）`;
    }
    if (!r.fxcOk) note += `${note ? " " : ""}错误:${r.fxcError}`;
    console.log(`${r.id.padEnd(38)} ${samplerStr.padEnd(10)} ${msStr.padEnd(10)} ${note}`);
  }
  const skippedTranslate = translated.filter((v) => !v.translateOk);
  if (skippedTranslate.length > 0) console.log(`\n（${skippedTranslate.length} 个程序翻译失败，没有 fxc 结果，见上面的 [翻译失败]）`);

  if (args.out) {
    const outPath = path.join(REPO_ROOT, args.out);
    fs.mkdirSync(path.dirname(outPath), { recursive: true });
    fs.writeFileSync(
      outPath,
      JSON.stringify(
        {
          when: new Date().toISOString(),
          quick,
          jobsN,
          results: timed.map(({ hlsl, translateLog, fragmentShader, ...rest }) => rest), // 原文太大，JSON 里不留
        },
        null,
        2,
      ),
    );
    console.log(`\n结果已写入 ${args.out}`);
  }
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error(`[shader-budget] 失败：${err.message}`);
    process.exit(1);
  });
