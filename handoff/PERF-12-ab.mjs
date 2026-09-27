#!/usr/bin/env node
// PERF-12：同一页面、冻结状态下对照两份舱内合成着色器（或两种调试开关），逐像素求差不受飞行位置 / 云 / 时间的影响。
// 做法：从基线端口的页面取舱内合成的 fragmentShader 原文 → 在本端口的页面里设场景、freeze(true) → 截图 A（本分支）→
// 把当前舱等的舱内材质换成基线原文，等它编完（needsUpdate + 渲染几帧）→ 截图 B（基线）→ 换回来再截 A2（冻结噪声底，应与 A 逐像素一致）。
// 用法：
//   node handoff/PERF-12-ab.mjs --port 5212 --base 5272 --out tmp/screenshot/PERF-12/ab --only night-city-on,noon-cumulus
//   node handoff/PERF-12-ab.mjs --port 5212 --js-b "v.sceneMat.uniforms.uDebug.value=32" --js-a "v.sceneMat.uniforms.uDebug.value=0" --only noon-cumulus
//     （不给 --base 时用 --js-a / --js-b 两段脚本切换状态，v = window.__voyage）
//   --scene '<JSON>' 可重复，字段同 dev-browser.mjs shots
// 输出 <out>/<场景>-A.png、-B.png、-A2.png；之后用 scripts/compare.mjs --diff 求差。
import { chromium } from "playwright-core";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { DEFAULTS, applyScene, pickScenes } from "../scripts/scenarios.mjs";
import { launchBrowser, closeBrowserSafely, resolveRepoPath } from "../scripts/lib/chrome.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.join(HERE, "..", "..", "..");

const args = { scene: [] };
const argv = process.argv.slice(2);
for (let i = 0; i < argv.length; i++) {
  const k = argv[i].replace(/^--/, "");
  const v = argv[i + 1] && !argv[i + 1].startsWith("--") ? argv[++i] : true;
  if (k === "scene") args.scene.push(JSON.parse(v));
  else args[k] = v;
}
const port = args.port;
const outDir = resolveRepoPath(REPO_ROOT, args.out || "tmp/screenshot/PERF-12/ab");
fs.mkdirSync(outDir, { recursive: true });
const fromFile = args["scenes-file"] ? JSON.parse(fs.readFileSync(path.resolve(String(args["scenes-file"])), "utf8")) : [];
const scenes = [...(args.only ? pickScenes(String(args.only).split(",")) : []), ...args.scene, ...fromFile];

async function open(browser, p) {
  const ctx = await browser.newContext({ viewport: { width: 1600, height: 1200 }, deviceScaleFactor: 1 });
  const page = await ctx.newPage();
  page.on("pageerror", (e) => console.log(`[ab:${p}][pageerror]`, e.message));
  page.on("console", (m) => { if (m.type() === "error") console.log(`[ab:${p}][console.error]`, m.text().slice(0, 300)); });
  await page.goto(`http://127.0.0.1:${p}/?ab=${Date.now()}`, { waitUntil: "commit", timeout: 180000 });
  await page.waitForFunction(() => window.__voyageStartup, null, { timeout: 300000, polling: 500 });
  await page.evaluate(() => { const w = window.__voyage.weather; if (w) { w.hold = true; w.heldIntensity = 0; } });
  return page;
}
const frames = (page, n) => page.evaluate((n) => new Promise((r) => { let k = 0; const f = () => (++k >= n ? r() : requestAnimationFrame(f)); requestAnimationFrame(f); }), n);

// 换材质原文并等它真正编完：compileAsync 用的是全屏 pass 自己的场景（和 passes.mjs --variants 同一套）
async function swapShader(page, src) {
  return page.evaluate(async (src) => {
    const v = window.__voyage;
    const m = v.cabinClass.mats[v.cabinClass.shown];
    window.__abOrig ??= m.fragmentShader;
    m.fragmentShader = src ?? window.__abOrig;
    m.needsUpdate = true;
    const passObj = v.clouds.pass;
    const renderer = passObj.renderer;
    const prevMat = passObj.mesh.material;
    const prevT = renderer.getRenderTarget();
    passObj.mesh.material = m;
    renderer.setRenderTarget(v.cabinClass.target);
    await renderer.compileAsync(passObj.scene, passObj.camera);
    passObj.mesh.material = prevMat;
    renderer.setRenderTarget(prevT);
    return v.cabinClass.shown;
  }, src);
}

const browser = await launchBrowser(chromium, { angle: String(args.angle || "d3d11") });
try {
  let baseSrc = null;
  if (args.base) {
    const pb = await open(browser, args.base);
    baseSrc = await pb.evaluate(() => window.__voyage.sceneMat.fragmentShader);
    await pb.context().close();
    console.log(`[ab] 基线 ${args.base} 的舱内合成原文 ${baseSrc.length} 字符`);
  }
  const page = await open(browser, port);
  for (const sc of scenes) {
    const info = await page.evaluate(applyScene, { sc, defaults: DEFAULTS, settle: true });
    if (sc.name.includes("economy") || sc.p?.["cabin-class"] === "economy") {
      for (let i = 0; i < 240 && (await page.evaluate(() => window.__voyage.cabinClass.shown)) !== "economy"; i++) await frames(page, 10);
    }
    if (args["js-a"]) await page.evaluate((s) => new Function("v", s)(window.__voyage), args["js-a"]);
    await page.evaluate(() => window.__voyage.freeze(true));
    await frames(page, 4);
    const shot = (tag) => page.screenshot({ path: path.join(outDir, `${sc.name}-${tag}.png`), timeout: 60000 });
    await shot("A");
    if (baseSrc) await swapShader(page, baseSrc);
    else await page.evaluate((s) => new Function("v", s)(window.__voyage), args["js-b"]);
    await frames(page, 4);
    await shot("B");
    if (baseSrc) await swapShader(page, null);
    else if (args["js-a"]) await page.evaluate((s) => new Function("v", s)(window.__voyage), args["js-a"]);
    await frames(page, 4);
    await shot("A2");
    await page.evaluate(() => window.__voyage.freeze(false));
    await page.evaluate(() => { delete window.__abOrig; });
    console.log(`[ab] ${sc.name}：${String(info).slice(0, 120)}`);
  }
} finally {
  await closeBrowserSafely(browser);
}
