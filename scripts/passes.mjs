#!/usr/bin/env node
// DX-08：收编「按 pass 计 GPU 耗时」的工具。历次任务（T33、T37、T44、W00、CLOUD-PERF）都在各自的
// worktree 里手工复制一份 `tmp/perf(-cloud)/passes.mjs`，从没进过仓库，每次都要重新对齐一遍——这里把它
// 收成正式脚本。
//
// 原理：main.ts 里所有全屏 pass 都经同一个共享的 FullscreenPass 实例（`__voyage.clouds.pass`）调用
// `pass.render(material, target)`；这里从页面外（Playwright）给这一个方法打补丁，用
// `EXT_disjoint_timer_query_webgl2` 给每次调用包一个查询，按材质对象认出这是哪个 pass（窗外 / 云步进 /
// 舱内合成 / 机翼 / … 认不出的归到「其他」）。批渲 N 帧用已有的调试句柄 `__voyage.benchFrame`（main.ts
// 无需为此改动），它内部的 `readRenderTargetPixels` 会强制一次 GPU 同步，批渲这一批查询在返回时基本都
// 已经可读（不需要靠真实 rAF 帧数去等）。
//
// 用法：
//   node scripts/passes.mjs --port 5230 [--only noon-cumulus,typhoon-bands] [--frames 30] [--rounds 3]
//     [--baseline 5290] [--param w00probe] [--param key=value] [--angle d3d11|vulkan] [--out 路径]
//   node scripts/passes.mjs --port 5230 --only typhoon-bands --variants handoff/T37-variants-cost.mjs
//     [--material clouds.marchMat] [--target clouds.raw]
//
// --variants 文件：导出 `VARIANTS = [[name, pairs], ...]`，和 handoff/T37-variants-cost.mjs、
//   handoff/W00-variants-cost.mjs 的写法一致——pairs 是若干 `[查找文本, 替换文本]` 组成的数组，同一变体
//   里的几对一起换（例如 `["comp+cast", [COMP, CAST]]`）。每个变体换上以后：
//     1. 等 `renderer.compileAsync` 真正编完（不是盲等几秒）；
//     2. 检查这个材质的程序缓存数（`renderer.properties.get(mat).programs.size`）确实增加了——没增加就
//        打印警告，说明量到的可能还是旧程序（W00 在 README 坑点里踩过这个坑：「换着色器做 A/B 要等后台
//        编译真的完成再计时」）；
//   变体之间共用同一份「原始文本」基准（每次都从没改动过的原文出发替换，不会越换越乱）。默认作用在
//   `clouds.marchMat`（--material 可以指向 `window.__voyage` 下任意点号路径的材质），--target 指定
//   compileAsync 时绑定的渲染目标（不传就用 hdrOutside）。
//
// --param（可重复）：追加到页面 URL 的查询参数，写 "key" 或 "key=value"（例如 W00 的 `?w00probe`）。
//
// typhoon-bands 的「云步进」两档：README 坑点记录着它在两个端口上都会随页面加载出现约 3.2 / 5.2 ms 两档、
//   与代码无关（W00 的发现）；量到这个场景的「云步进」时会顺带打印「更接近哪一档」的提示，避免把这个
//   已知的、和代码无关的抖动误判成回归。
import { chromium } from "playwright-core";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { DEFAULTS, applyScene, pickScenes } from "./scenarios.mjs";
import { launchBrowser as launchBrowserAngle, closeBrowserSafely, resolveRepoPath } from "./lib/chrome.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const VOYAGE_ROOT = path.join(HERE, "..");
const REPO_ROOT = path.join(VOYAGE_ROOT, "..", "..");

// README 坑点「typhoon-bands 的云步进在两个端口上都会随页面加载出现约 3.2 / 5.2 ms 两档（与代码无关）」
const TYPHOON_BANDS_TIERS = { 低档: 3.2, 高档: 5.2 };

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

function usage() {
  console.error(
    "用法：node scripts/passes.mjs --port <端口> [--only a,b] [--frames 30] [--rounds 3] [--baseline 端口]\n" +
      "                              [--param k[=v]] [--angle d3d11|vulkan] [--out 路径]\n" +
      "                              [--variants 文件.mjs [--material 点号路径] [--target 点号路径]]",
  );
}

function launchBrowser(angle) {
  return launchBrowserAngle(chromium, { angle });
}

function buildUrl(port, params) {
  const u = new URL(`http://127.0.0.1:${port}/`);
  u.searchParams.set("perf", String(Date.now())); // 破缓存，避免拿到别的调用留下的旧状态
  for (const p of params) {
    const eq = p.indexOf("=");
    if (eq === -1) u.searchParams.set(p, "");
    else u.searchParams.set(p.slice(0, eq), p.slice(eq + 1));
  }
  return u.toString();
}

async function openPage(browser, port, params) {
  const context = await browser.newContext({ viewport: { width: 1600, height: 1200 }, deviceScaleFactor: 1 });
  const page = await context.newPage();
  page.on("pageerror", (e) => console.log(`[passes:${port}][pageerror]`, e.message));
  await page.goto(buildUrl(port, params), { waitUntil: "commit", timeout: 180000 });
  await page.waitForFunction(() => window.__voyageStartup, null, { timeout: 300000, polling: 500 });
  return page;
}

// ---------- 页面内：按 pass 的 GPU 计时器（猴子补丁 clouds.pass.render） ----------
function installTimer() {
  const v = window.__voyage;
  const passObj = v.clouds.pass;
  const renderer = passObj.renderer;
  const gl = renderer.getContext();
  const ext = gl.getExtension("EXT_disjoint_timer_query_webgl2");
  const nameOf = (mat) => {
    if (mat === v.outsideMat) return "窗外";
    if (mat === v.sceneMat) return "舱内合成";
    if (mat === v.wingMat) return "机翼";
    if (v.clouds.marchMat && mat === v.clouds.marchMat) return "云步进";
    if (v.clouds.marchWonderMat && mat === v.clouds.marchWonderMat) return "云步进(奇观变体)";
    // PERF-10：雷暴 / 台风 / 卷云等步进变体（材质名 cloud-march-<键>）照旧算「云步进」，和改动前的单一程序可比；
    // 带奇观层的（键含 W）归「云步进(奇观变体)」
    if (typeof mat.name === "string" && mat.name.startsWith("cloud-march-")) return mat.name.includes("W", 12) ? "云步进(奇观变体)" : "云步进";
    if (v.clouds.resolveMat && mat === v.clouds.resolveMat) return "云resolve";
    if (v.clouds.shadowMat && mat === v.clouds.shadowMat) return "云影图";
    if (v.clouds.shadowWeatherMat && mat === v.clouds.shadowWeatherMat) return "云影图";
    if (v.clouds.wonderSurfMat && mat === v.clouds.wonderSurfMat) return "奇观表面";
    if (v.exposure.meterMat && mat === v.exposure.meterMat) return "测光";
    if (v.exposure.adaptMat && mat === v.exposure.adaptMat) return "曝光适应";
    if (v.exposure.finalMat && mat === v.exposure.finalMat) return "曝光合成";
    if (v.cabinClass && v.cabinClass.variants) {
      for (const k in v.cabinClass.variants) if (v.cabinClass.variants[k] === mat) return "舱内合成";
    }
    if (v.groundDetail && v.groundDetail.variants) {
      for (const k in v.groundDetail.variants) if (v.groundDetail.variants[k] === mat) return "窗外(地面细节)";
    }
    return "其他";
  };
  const origRender = passObj.render.bind(passObj);
  let recording = false;
  let pending = [];
  let samples = new Map();
  passObj.render = function (material, target, layer) {
    if (!recording || !ext) return origRender(material, target, layer);
    const q = gl.createQuery();
    gl.beginQuery(ext.TIME_ELAPSED_EXT, q);
    origRender(material, target, layer);
    gl.endQuery(ext.TIME_ELAPSED_EXT);
    pending.push({ name: nameOf(material), q });
  };
  window.__passes = {
    available: !!ext,
    start() {
      samples = new Map();
      pending = [];
      recording = true;
    },
    stop() {
      recording = false;
    },
    poll() {
      if (!ext) return;
      const disjoint = gl.getParameter(ext.GPU_DISJOINT_EXT);
      const still = [];
      for (const { name, q } of pending) {
        if (gl.getQueryParameter(q, gl.QUERY_RESULT_AVAILABLE)) {
          if (!disjoint) {
            const ns = Number(gl.getQueryParameter(q, gl.QUERY_RESULT));
            if (!samples.has(name)) samples.set(name, []);
            samples.get(name).push(ns / 1e6);
          }
          gl.deleteQuery(q);
        } else still.push({ name, q });
      }
      pending = still;
    },
    pendingCount() {
      return pending.length;
    },
    result() {
      const out = {};
      for (const [name, arr] of samples) {
        const sorted = [...arr].sort((a, b) => a - b);
        out[name] = { n: arr.length, meanMs: arr.reduce((a, b) => a + b, 0) / arr.length, medianMs: sorted[Math.floor(sorted.length / 2)] };
      }
      return out;
    },
  };
}

// ---------- 页面内：--variants 用的着色器补丁 + compileAsync 等待 + 程序切换检查 ----------
function installVariantPatcher() {
  const v = window.__voyage;
  const resolvePath = (root, p) => p.split(".").reduce((o, k) => (o == null ? o : Array.isArray(o) ? o[Number(k)] : o[k]), root);
  const origShaders = new Map();
  window.__variant = {
    apply(matPath, pairs) {
      const m = resolvePath(v, matPath);
      if (!m) throw new Error(`--material 解析不到 "${matPath}"`);
      if (!origShaders.has(m)) origShaders.set(m, m.fragmentShader);
      let s = origShaders.get(m);
      for (const [from, to] of pairs) {
        if (!s.includes(from)) throw new Error(`变体：材质 "${matPath}" 里找不到查找文本：${from.slice(0, 100)}`);
        s = s.split(from).join(to);
      }
      m.fragmentShader = s;
      m.needsUpdate = true;
    },
    async waitCompile(matPath, targetPath) {
      const m = resolvePath(v, matPath);
      const tgt = targetPath ? resolvePath(v, targetPath) : v.hdrOutside;
      const passObj = v.clouds.pass;
      const renderer = passObj.renderer;
      const before = renderer.properties.get(m)?.programs?.size ?? 0;
      const prevMat = passObj.mesh.material;
      const prevTarget = renderer.getRenderTarget();
      passObj.mesh.material = m;
      renderer.setRenderTarget(tgt);
      await renderer.compileAsync(passObj.scene, passObj.camera);
      // compileAsync 只保证编译完成，「链接进这个材质的实际使用」还要一次真正的 render 调用去触发
      // acquireProgram；这里顺手做一次（不计时，recording 默认是关的）
      passObj.render(m, tgt);
      passObj.mesh.material = prevMat;
      renderer.setRenderTarget(prevTarget);
      const after = renderer.properties.get(m)?.programs?.size ?? 0;
      return { before, after, switched: after > before };
    },
  };
}

async function measurePasses(page, sc, frames, rounds) {
  await page.evaluate(applyScene, { sc, defaults: DEFAULTS });
  await page.evaluate(() => window.__passes.start());
  for (let r = 0; r < rounds; r++) {
    await page.evaluate((n) => window.__voyage.benchFrame(n), frames);
    await page.evaluate(() => window.__passes.poll());
  }
  // benchFrame 的强制同步通常已经让查询可读，这里多等一小段、再 poll 一次做保险
  await new Promise((r) => setTimeout(r, 50));
  await page.evaluate(() => window.__passes.poll());
  const pendingLeft = await page.evaluate(() => window.__passes.pendingCount());
  const res = await page.evaluate(() => window.__passes.result());
  await page.evaluate(() => window.__passes.stop());
  if (pendingLeft > 0) console.warn(`[passes] ${sc.name}：还有 ${pendingLeft} 个查询没读到结果（GPU 被占满时常见，样本数会略少）`);
  return res;
}

function hintTyphoonBands(sceneName, res) {
  if (sceneName !== "typhoon-bands") return;
  const march = res["云步进"];
  if (!march) return;
  const dists = Object.entries(TYPHOON_BANDS_TIERS).map(([label, ms]) => [label, Math.abs(march.meanMs - ms)]);
  dists.sort((a, b) => a[1] - b[1]);
  const [label, dist] = dists[0];
  if (dist < 0.6) {
    console.log(`  [提示] typhoon-bands 云步进 ${march.meanMs.toFixed(2)} ms 接近已知的${label}（${TYPHOON_BANDS_TIERS[label]} ms，与页面加载有关、与代码无关，见 README 坑点）`);
  } else {
    console.log(`  [提示] typhoon-bands 云步进 ${march.meanMs.toFixed(2)} ms 不落在已知两档（3.2 / 5.2 ms）附近，可能是真实变化`);
  }
}

function formatRow(res) {
  return Object.entries(res)
    .map(([k, v]) => `${k}=${v.meanMs.toFixed(3)}ms(中位${v.medianMs.toFixed(3)},n${v.n})`)
    .join("  ");
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (!args.port) {
    usage();
    process.exit(1);
  }
  const port = args.port;
  const angle = String(args.angle || "d3d11");
  const baseline = args.baseline ? String(args.baseline) : null;
  const only = args.only ? String(args.only).split(",") : null;
  const frames = Number(args.frames || 30);
  const rounds = Number(args.rounds || 3);
  const params = Array.isArray(args.param) ? args.param : args.param ? [args.param] : [];
  const material = args.material || "clouds.marchMat";
  const target = args.target || null;

  let VARIANTS = null;
  if (args.variants) {
    const mod = await import(pathToFileURL(path.resolve(args.variants)).href);
    VARIANTS = mod.VARIANTS;
    if (!VARIANTS || VARIANTS.length === 0) throw new Error(`${args.variants} 没有导出非空的 VARIANTS 数组`);
    if (baseline) console.warn("[passes] --variants 与 --baseline 是两个正交的对照维度，一次只用一个；这里忽略 --baseline");
  }

  const ports = VARIANTS ? [port] : baseline ? [port, baseline] : [port];
  const browser = await launchBrowser(angle);
  const table = [];
  try {
    const pages = {};
    for (const p of ports) {
      const page = await openPage(browser, p, params);
      await page.evaluate(installTimer);
      if (VARIANTS) await page.evaluate(installVariantPatcher);
      const avail = await page.evaluate(() => window.__passes.available);
      if (!avail) console.warn(`[passes] 端口 ${p}：没有 EXT_disjoint_timer_query_webgl2，量不出按 pass 的 GPU 耗时`);
      pages[p] = page;
    }

    const scenes = pickScenes(only);
    for (const sc of scenes) {
      if (VARIANTS) {
        const page = pages[port];
        for (const [name, pairs] of VARIANTS) {
          if (pairs.length > 0) {
            await page.evaluate(({ material, pairs }) => window.__variant.apply(material, pairs), { material, pairs });
            const check = await page.evaluate(({ material, target }) => window.__variant.waitCompile(material, target), { material, target });
            if (!check.switched) {
              console.warn(`[passes] ${sc.name}/${name}：材质 "${material}" 的程序缓存数没有增加（${check.before} -> ${check.after}），量到的可能还是旧程序`);
            }
          }
          const res = await measurePasses(page, sc, frames, rounds);
          hintTyphoonBands(sc.name, res);
          console.log(`  ${sc.name} [${name}]: ${formatRow(res)}`);
          table.push({ scene: sc.name, variant: name, res });
        }
      } else {
        for (const p of ports) {
          const res = await measurePasses(pages[p], sc, frames, rounds);
          hintTyphoonBands(sc.name, res);
          console.log(`  ${sc.name} [端口 ${p}]: ${formatRow(res)}`);
          table.push({ scene: sc.name, port: p, res });
        }
        if (baseline) {
          const a = table.at(-2).res;
          const b = table.at(-1).res;
          const names = new Set([...Object.keys(a), ...Object.keys(b)]);
          for (const name of names) {
            if (!a[name] || !b[name]) continue;
            const delta = ((b[name].meanMs - a[name].meanMs) / a[name].meanMs) * 100;
            console.log(`    Δ${name}: ${a[name].meanMs.toFixed(3)} -> ${b[name].meanMs.toFixed(3)} ms（${delta >= 0 ? "+" : ""}${delta.toFixed(1)}%）`);
          }
        }
      }
    }
    if (args.out) {
      const outPath = resolveRepoPath(REPO_ROOT, args.out);
      fs.mkdirSync(path.dirname(outPath), { recursive: true });
      fs.writeFileSync(outPath, JSON.stringify({ angle, frames, rounds, ports, variants: args.variants || null, table }, null, 2));
      console.log(`[passes] 结果写入 ${path.relative(REPO_ROOT, outPath).replace(/\\/g, "/")}`);
    }
  } finally {
    await closeBrowserSafely(browser);
  }
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error(`[passes] 失败：${err.message}`);
    process.exit(1);
  });
