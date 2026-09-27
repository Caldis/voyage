#!/usr/bin/env node
// PERF-5：自动画质档验收。真实 rAF 循环（不用 benchFrame，那是合成测量，quality.ts 特意不在里面跑自动逻辑）。
// 用法：node apps/voyage/handoff/PERF-5-check.mjs --port 5245 [--angle d3d11]
import { chromium } from "playwright-core";
import { DEFAULTS, applyScene } from "../scripts/scenarios.mjs";
import { launchBrowser, closeBrowserSafely } from "../scripts/lib/chrome.mjs";

const args = {};
for (let i = 2; i < process.argv.length; i++) {
  const a = process.argv[i];
  if (a.startsWith("--")) {
    const n = process.argv[i + 1];
    if (n !== undefined && !n.startsWith("--")) { args[a.slice(2)] = n; i++; } else args[a.slice(2)] = true;
  }
}
const port = args.port || 5245;
const angle = args.angle || "d3d11";

async function openPage(browser, viewport, deviceScaleFactor) {
  const context = await browser.newContext({ viewport, deviceScaleFactor });
  const page = await context.newPage();
  await page.goto(`http://127.0.0.1:${port}/?dev=${Date.now()}`, { waitUntil: "commit", timeout: 180000 });
  await page.bringToFront();
  await page.waitForFunction(() => window.__voyageStartup, null, { timeout: 300000, polling: 500 });
  return page;
}

async function sample(page, times, sampleMs) {
  const out = [];
  for (let i = 0; i < times; i++) {
    await page.waitForTimeout(sampleMs);
    const s = await page.evaluate(() => {
      const q = window.__voyage.quality;
      return { level: q.level, cloudScale: window.__voyage.clouds.resolutionScale, text: q.describe() };
    });
    out.push(s);
  }
  return out;
}

function printSamples(samples, stepMs) {
  samples.forEach((s, i) => console.log(`  t=${(((i + 1) * stepMs) / 1000).toFixed(1)}s  ${s.level}  cloudScale=${s.cloudScale}  ${s.text}`));
}

const browser = await launchBrowser(chromium, { angle });
try {
  console.log("== A) 正常视口 1600x1200 DPR1（本机原生分辨率）==");
  const normal = await openPage(browser, { width: 1600, height: 1200 }, 1);
  console.log("-- noon-cumulus --");
  await normal.evaluate(applyScene, { sc: { name: "noon-cumulus", p: { preset: "wpac", time: 720, "wing-pos": "8" }, wait: 300 }, defaults: DEFAULTS });
  printSamples(await sample(normal, 6, 500), 500);
  console.log("-- typhoon-bands（PERF-2 之后原生分辨率应已经在预算内，不该被迫降档）--");
  await normal.evaluate(applyScene, { sc: { name: "typhoon-bands", p: { preset: "wpac", time: 900, coverage: 0.2, weather: "typhoon-bands", "wing-pos": "-4" }, wait: 300 }, defaults: DEFAULTS });
  printSamples(await sample(normal, 8, 500), 500);
  console.log("-- 来回切换 3 次，看有没有抖动 --");
  for (let i = 0; i < 3; i++) {
    await normal.evaluate(applyScene, { sc: { name: "noon-cumulus", p: { preset: "wpac", time: 720, "wing-pos": "8" }, wait: 150 }, defaults: DEFAULTS });
    await normal.waitForTimeout(300);
    await normal.evaluate(applyScene, { sc: { name: "typhoon-bands", p: { preset: "wpac", time: 900, coverage: 0.2, weather: "typhoon-bands", "wing-pos": "-4" }, wait: 150 }, defaults: DEFAULTS });
    await normal.waitForTimeout(300);
  }
  const afterFlap = await normal.evaluate(() => window.__voyage.quality.level);
  console.log("来回切换 3 轮之后的档位：" + afterFlap);
  await normal.context().close();

  console.log("\n== B) 高分屏模拟：1600x1200 窗口 × DPR 1.5（实际绘制 2400x1800）==");
  const heavy = await openPage(browser, { width: 1600, height: 1200 }, 1.5);
  await heavy.evaluate(applyScene, { sc: { name: "typhoon-bands", p: { preset: "wpac", time: 900, coverage: 0.2, weather: "typhoon-bands", "wing-pos": "-4" }, wait: 300 }, defaults: DEFAULTS });
  console.log("-- typhoon-bands，观察降档 --");
  printSamples(await sample(heavy, 10, 500), 500);
  console.log("-- 收窄视口到 800x600（同 DPR1.5，画布约 1200x900，比正常视口还小），观察是否回升 --");
  await heavy.setViewportSize({ width: 800, height: 600 });
  await heavy.evaluate(() => window.dispatchEvent(new Event("resize")));
  printSamples(await sample(heavy, 10, 500), 500);
  console.log("-- 放大回 1600x1200（画布回到 2400x1800），观察是否重新降档 --");
  await heavy.setViewportSize({ width: 1600, height: 1200 });
  await heavy.evaluate(() => window.dispatchEvent(new Event("resize")));
  printSamples(await sample(heavy, 10, 500), 500);
  await heavy.context().close();

  console.log("\n== 完成 ==");
} finally {
  await closeBrowserSafely(browser);
}
