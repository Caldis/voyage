#!/usr/bin/env node
// T08：道路灯带的闪烁检查（私有 headless）。飞机按真实速度前进，连拍 N 帧，再用 T08-flicker.py 统计
// 「每个小块里的总亮度随时间的变异系数」：抗锯齿做对了，线在屏幕上滑动时每块的能量应当几乎不变；
// 漏采 / 锯齿会让线时有时无，块能量上下跳。
// 用法：node handoff/T08-flicker.mjs --port 5208 [--angle vulkan] [--scene route-hnd-cts-night] [--frames 20] [--debug 24] [--out tmp/screenshot/T08/flicker]
//   --debug 24：窗外只画道路灯带（ground.glsl / terrain-shading 的调试 24），排除城市灯点和云
import { chromium } from "playwright-core";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { DEFAULTS, applyScene, pickScenes } from "../scripts/scenarios.mjs";
import { launchBrowser, closeBrowserSafely } from "../scripts/lib/chrome.mjs";

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const args = {};
for (let i = 2; i < process.argv.length; i++) {
  const a = process.argv[i];
  if (a.startsWith("--")) {
    const n = process.argv[i + 1];
    if (n !== undefined && !n.startsWith("--")) { args[a.slice(2)] = n; i++; } else args[a.slice(2)] = true;
  }
}
const port = args.port || 5208;
const angle = args.angle || "d3d11";
const sceneName = args.scene || "route-hnd-cts-night";
const frames = Number(args.frames || 20);
const debug = Number(args.debug || 0);
const outDir = path.join(ROOT, args.out || `tmp/screenshot/T08/flicker-${sceneName}-${debug}`);
fs.mkdirSync(outDir, { recursive: true });
const base = pickScenes([sceneName])[0];
if (!base) throw new Error(`未知场景 ${sceneName}`);
// 云量归零：云随 uCloudOffset 平移，会混进统计
const sc = { ...base, p: { ...base.p, coverage: 0 } };

const browser = await launchBrowser(chromium, { angle });
try {
  const context = await browser.newContext({ viewport: { width: 1600, height: 1200 }, deviceScaleFactor: 1 });
  const page = await context.newPage();
  page.on("console", (m) => { if (m.type() === "error") console.log(`[控制台 error] ${m.text()}`); });
  page.on("pageerror", (e) => console.log(`[页面异常] ${e.message}`));
  await page.goto(`http://127.0.0.1:${port}/?flicker=${Date.now()}`, { waitUntil: "commit", timeout: 180000 });
  await page.waitForFunction(() => window.__voyageStartup, null, { timeout: 300000, polling: 500 });
  await page.waitForTimeout(2000);
  await page.evaluate(applyScene, { sc, defaults: DEFAULTS });
  await page.evaluate((d) => {
    const v = window.__voyage;
    v.wingDebug.strobe = 0;
    v.sceneMat.uniforms.uDebug.value = d;
  }, debug);
  await page.waitForTimeout(1500);
  // 冻住曝光适应，只看画面本身的变化
  await page.evaluate(() => {
    const u = window.__voyage.exposure.adaptMat.uniforms.uDt;
    Object.defineProperty(u, "value", { configurable: true, get: () => 0, set: () => {} });
  });
  await page.waitForTimeout(300);
  // 停掉主循环，改成手动推进：每拍一张走 step 帧（benchFrame 每帧按 16 ms 推进，巡航 250 m/s ≈ 4 m / 帧），
  // 屏幕上的位移是亚像素级，线的抗锯齿做对了块能量就几乎不变
  const step = Number(args.step || 2);
  await page.evaluate(() => { window.requestAnimationFrame = () => 0; });
  await page.waitForTimeout(300);
  const t0 = Date.now();
  const offs = [];
  for (let i = 0; i < frames; i++) {
    offs.push(await page.evaluate((k) => { const v = window.__voyage; v.benchFrame(k); return v.cloudUniforms.uCloudOffset.value.toArray(); }, step));
    await page.screenshot({ path: path.join(outDir, `f${String(i).padStart(2, "0")}.png`), timeout: 60000 });
  }
  const moved = Math.hypot(offs.at(-1)[0] - offs[0][0], offs.at(-1)[1] - offs[0][1]) * 1000;
  console.log(`[T08-flicker] ${sceneName} debug=${debug}：${frames} 帧，飞了 ${moved.toFixed(0)} m，用时 ${Date.now() - t0} ms，输出 ${path.relative(ROOT, outDir)}`);
} finally {
  await closeBrowserSafely(browser);
}
