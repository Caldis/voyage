#!/usr/bin/env node
// T48b 同帧多变体对照：应用场景（--settle 等瓦片）→ 钉回机位 → 冻结、翼尖频闪钉灭 → 依次跑每个变体的 js 各拍一张。
// 冻结后只有曝光合成的 uniform / 着色器变了，各张逐像素可比（不受飞行位置 / 瓦片加载时机影响）。
// 变体 "master"：把 exposure.finalMat 的着色器换成 --base <端口> 页面上的原文（对照改前），拍完换回。
// 用法：node handoff/T48b-ab.mjs --port 5215 [--base 5275] --scenes-file <场景.json> --variants <变体.json>
//        [--only a,b] [--out tmp/screenshot/T48b/ab] [--angle vulkan]
//   变体文件：[{ "name": "new", "js": "u.uNightChroma.value.x = 0.45;" }, { "name": "master" }, ...]
//   js 里可用 v = window.__voyage、u = v.exposure.finalMat.uniforms；每个变体跑之前先把 uniform 复原成页面初始值。
// 每张图旁写 <场景>.<变体>.json：地面瓦片 pending（截图那一刻重新取）、截图前后的 console error 数（含 CORS / eox 条数）、画质档。
import { chromium } from "playwright-core";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { DEFAULTS, applyScene, pinGeometry } from "../scripts/scenarios.mjs";
import { launchBrowser, closeBrowserSafely, resolveRepoPath } from "../scripts/lib/chrome.mjs";
import { readLock, waitForRelease } from "../scripts/lib/measure-lock.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.join(HERE, "..", "..", "..");
const args = {};
for (let i = 2; i < process.argv.length; i++) {
  const a = process.argv[i];
  if (a.startsWith("--")) args[a.slice(2)] = process.argv[i + 1] && !process.argv[i + 1].startsWith("--") ? process.argv[++i] : true;
}
const port = args.port;
const outDir = resolveRepoPath(REPO_ROOT, args.out || "tmp/screenshot/T48b/ab");
fs.mkdirSync(outDir, { recursive: true });
let scenes = JSON.parse(fs.readFileSync(resolveRepoPath(REPO_ROOT, args["scenes-file"]), "utf8"));
if (args.only) { const only = String(args.only).split(","); scenes = scenes.filter((s) => only.includes(s.name)); }
const variants = JSON.parse(fs.readFileSync(resolveRepoPath(REPO_ROOT, args.variants), "utf8"));
const angle = String(args.angle || "vulkan");

if (readLock(REPO_ROOT)) await waitForRelease(REPO_ROOT, { log: (s) => console.log(`[T48b-ab] ${s}`) });

const browser = await launchBrowser(chromium, { angle });
const raf2 = (page) => page.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))));
async function openPage(p) {
  const context = await browser.newContext({ viewport: { width: 1600, height: 1200 }, deviceScaleFactor: 1 });
  const page = await context.newPage();
  const errors = [];
  page.on("console", (m) => m.type() === "error" && errors.push(m.text()));
  page.on("pageerror", (e) => errors.push(e.message));
  await page.goto(`http://127.0.0.1:${p}/?dev=${Date.now()}`, { waitUntil: "commit", timeout: 180000 });
  await page.bringToFront();
  await page.waitForFunction(() => window.__voyageStartup, null, { timeout: 180000, polling: 500 });
  return { context, page, errors };
}
try {
  let baseSrc = null;
  if (variants.some((v) => v.name === "master")) {
    if (!args.base) throw new Error("变体里有 master，需要 --base <端口>");
    const b = await openPage(args.base);
    baseSrc = await b.page.evaluate(() => window.__voyage.exposure.finalMat.fragmentShader);
    await b.context.close();
  }
  const { page, errors } = await openPage(port);
  console.log("GL_RENDERER:", await page.evaluate(() => { const gl = document.createElement("canvas").getContext("webgl2"); const e = gl.getExtension("WEBGL_debug_renderer_info"); return e ? gl.getParameter(e.UNMASKED_RENDERER_WEBGL) : "?"; }));
  await page.evaluate(() => { const w = window.__voyage.weather; w.hold = true; w.heldIntensity = 0; });
  // 页面初始 uniform 快照（每个变体先复原）
  await page.evaluate(() => {
    const u = window.__voyage.exposure.finalMat.uniforms;
    window.__t48bInit = {};
    for (const [k, o] of Object.entries(u)) if (o.value && typeof o.value.clone === "function" && o.value.isVector2 | o.value.isVector3 | o.value.isVector4) window.__t48bInit[k] = o.value.toArray();
      else if (typeof o.value === "number" || typeof o.value === "boolean") window.__t48bInit[k] = o.value;
    window.__t48bSrc = window.__voyage.exposure.finalMat.fragmentShader;
  });
  for (const sc of scenes) {
    const errBefore = errors.length;
    const info = await page.evaluate(applyScene, { sc, defaults: DEFAULTS, settle: true });
    await page.evaluate(pinGeometry, sc);
    await page.evaluate(() => window.__voyage.freeze(true));
    await page.evaluate(() => { const w = window.__voyage.wingDebug; if (w) w.strobe = 0; });
    await raf2(page);
    // applyScene 的 settle 有超时，钉回机位后还可能触发新瓦片：冻结状态下等 pending 归零（最多 120 s），再多等 2 s 让上传落地
    const t0 = Date.now();
    await page.waitForFunction(() => !window.__voyage.ground || window.__voyage.ground.pending === 0, null, { timeout: 120000, polling: 500 }).catch(() => console.log(`  ${sc.name}: 等瓦片超时`));
    await page.waitForTimeout(2000);
    console.log(`  ${sc.name}: 冻结后等瓦片 ${((Date.now() - t0) / 1000).toFixed(1)} s`);
    // T48c（T48b 审查 P2-2）：先拍一张丢弃的预热图。冻结、pending 0、再等 2 s 之后，有城的黄昏第一张仍与后面各张差 141–211 级
    //   （2–5 万像素，城区灯点），排在第一个的变体总是不可比。拍到连续两张 PNG 逐字节相同为止（最多 6 张）
    {
      let prev = await page.screenshot({ timeout: 60000 });
      let n = 1;
      for (; n < 6; n++) {
        await raf2(page);
        const cur = await page.screenshot({ timeout: 60000 });
        if (cur.equals(prev)) break;
        prev = cur;
      }
      console.log(`  ${sc.name}: 预热 ${Math.min(n + 1, 6)} 张${n >= 6 ? "（仍未稳定）" : ""}`);
    }
    for (const va of variants) {
      const out = await page.evaluate(async ({ js, src }) => {
        const v = window.__voyage, m = v.exposure.finalMat, u = m.uniforms;
        for (const [k, a] of Object.entries(window.__t48bInit)) { if (Array.isArray(a)) u[k].value.fromArray(a); else u[k].value = a; }
        // T48c 审查 P3-4：每个变体开头复原频闪（钉灭）与局部适应的 dt 覆盖，结果不再依赖变体的排列顺序
        if (v.wingDebug) v.wingDebug.strobe = 0;
        if ("localDt" in v.exposure) v.exposure.localDt = null;
        const want = src || window.__t48bSrc;
        if (m.fragmentShader !== want) { m.fragmentShader = want; m.needsUpdate = true; }
        let r = null;
        if (js) r = await new (async () => {}).constructor("v", "u", js)(v, u);
        for (let i = 0; i < 4; i++) await new Promise((res) => requestAnimationFrame(res));
        return r;
      }, { js: va.js || null, src: va.name === "master" ? baseSrc : null });
      const png = path.join(outDir, `${sc.name}.${va.name}.png`);
      await page.screenshot({ path: png, timeout: 60000 });
      const meta = await page.evaluate(() => ({
        groundPendingAtShot: window.__voyage.ground ? window.__voyage.ground.pending : null,
        quality: document.getElementById("quality")?.value,
        qualityStatus: document.getElementById("quality-status")?.textContent,
        date: document.getElementById("date")?.value,
        moonAltDeg: window.__voyage.moonAltDeg ? window.__voyage.moonAltDeg() : null,
        adapted: null,
      }));
      const errs = errors.slice(errBefore);
      meta.errors = errs.length;
      meta.corsErrors = errs.filter((t) => /CORS|eox/i.test(t)).length;
      meta.variant = va; meta.jsOut = out; meta.info = typeof info === "string" ? info.slice(0, 300) : info;
      fs.writeFileSync(png.replace(/\.png$/, ".json"), JSON.stringify(meta, null, 2));
      console.log(`${sc.name}.${va.name}: pending=${meta.groundPendingAtShot} errors=${meta.errors} cors=${meta.corsErrors} q=${meta.quality} moon=${meta.moonAltDeg?.toFixed?.(1)}`);
    }
    // 复原着色器与 uniform
    await page.evaluate(() => {
      const m = window.__voyage.exposure.finalMat, u = m.uniforms;
      for (const [k, a] of Object.entries(window.__t48bInit)) { if (Array.isArray(a)) u[k].value.fromArray(a); else u[k].value = a; }
      if (m.fragmentShader !== window.__t48bSrc) { m.fragmentShader = window.__t48bSrc; m.needsUpdate = true; }
      window.__voyage.freeze(false);
      const w = window.__voyage.wingDebug; if (w) w.strobe = null;
      if ("localDt" in window.__voyage.exposure) window.__voyage.exposure.localDt = null; // T48c 调试句柄，变体里可能改过
    });
  }
  console.log(errors.length ? `console error ${errors.length} 条，前 3 条：${errors.slice(0, 3).join(" | ")}` : "没有 console error");
} finally {
  await closeBrowserSafely(browser);
}
