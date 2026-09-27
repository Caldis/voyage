#!/usr/bin/env node
// T48 同帧 A/B：应用场景 → 冻结 → 关掉 T48（uMesopicKeep 饱和度门限拉到 >1、uNightChroma 强度 0，等价于改前）截一张 →
// 恢复 T48 参数截一张。冻结后只有最终合成的 uniform 变了，两张逐像素可比（不受飞行位置 / 瓦片加载时机影响）。
// 用法：node handoff/T48-ab.mjs --port 5248 --only wonder-fogcity-night,night-city [--out tmp/screenshot/T48/ab]
//       [--keep 0.5,0.85,-2.5,-1.5] [--chroma 0.6,-1.5,0]（覆盖 T48 参数，调参用）
import { chromium } from "playwright-core";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { DEFAULTS, applyScene, pickScenes } from "../scripts/scenarios.mjs";
import { launchBrowser, closeBrowserSafely, resolveRepoPath } from "../scripts/lib/chrome.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.join(HERE, "..", "..", "..");
const args = {};
for (let i = 2; i < process.argv.length; i++) {
  const a = process.argv[i];
  if (a.startsWith("--")) args[a.slice(2)] = process.argv[i + 1] && !process.argv[i + 1].startsWith("--") ? process.argv[++i] : true;
}
const port = args.port;
const outDir = resolveRepoPath(REPO_ROOT, args.out || "tmp/screenshot/T48/ab");
fs.mkdirSync(outDir, { recursive: true });
const keep = args.keep ? String(args.keep).split(",").map(Number) : null;
const chroma = args.chroma ? String(args.chroma).split(",").map(Number) : null;

const browser = await launchBrowser(chromium, { angle: args.angle || "d3d11" });
try {
  const context = await browser.newContext({ viewport: { width: 1600, height: 1200 }, deviceScaleFactor: 1 });
  const page = await context.newPage();
  const errors = [];
  page.on("console", (m) => m.type() === "error" && errors.push(m.text()));
  page.on("pageerror", (e) => errors.push(e.message));
  await page.goto(`http://127.0.0.1:${port}/?dev=${Date.now()}`, { waitUntil: "commit", timeout: 180000 });
  await page.bringToFront();
  await page.waitForFunction(() => window.__voyageStartup, null, { timeout: 180000, polling: 500 });
  await page.evaluate(() => { const w = window.__voyage.weather; w.hold = true; w.heldIntensity = 0; });
  const raf2 = () => page.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))));
  const setT48 = (on) =>
    page.evaluate(({ on, keep, chroma }) => {
      const u = window.__voyage.exposure.finalMat.uniforms;
      if (!window.__t48) window.__t48 = { keep: u.uMesopicKeep.value.toArray(), chroma: u.uNightChroma.value.toArray() };
      const k = keep || window.__t48.keep, c = chroma || window.__t48.chroma;
      if (on) { u.uMesopicKeep.value.fromArray(k); u.uNightChroma.value.fromArray(c); }
      else { u.uMesopicKeep.value.set(2, 3, 9, 10); u.uNightChroma.value.set(0, c[1], c[2]); }
    }, { on, keep, chroma });
  for (const sc of pickScenes(args.only ? String(args.only).split(",") : null)) {
    await setT48(true);
    const info = await page.evaluate(applyScene, { sc, defaults: DEFAULTS, settle: true });
    await page.evaluate(() => window.__voyage.freeze(true));
    await raf2();
    await setT48(false); await raf2(); await raf2();
    await page.screenshot({ path: path.join(outDir, `${sc.name}-off.png`) });
    await setT48(true); await raf2(); await raf2();
    await page.screenshot({ path: path.join(outDir, `${sc.name}-on.png`) });
    await page.evaluate(() => window.__voyage.freeze(false));
    console.log(`${sc.name}: ${typeof info === "string" ? info.slice(0, 160) : ""}`);
  }
  console.log(errors.length ? `console error ${errors.length} 条：${errors.slice(0, 3).join(" | ")}` : "没有 console error");
} finally {
  await closeBrowserSafely(browser);
}
