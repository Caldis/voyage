#!/usr/bin/env node
// 快速反复切场景 + resize，检查控制台有没有报错（GPU query 池、resize 路径）
import { chromium } from "playwright-core";
import { DEFAULTS, applyScene } from "../scripts/scenarios.mjs";
import { launchBrowser, closeBrowserSafely } from "../scripts/lib/chrome.mjs";

const port = process.argv.includes("--port") ? process.argv[process.argv.indexOf("--port") + 1] : 5245;
const browser = await launchBrowser(chromium, { angle: "d3d11" });
try {
  const context = await browser.newContext({ viewport: { width: 1600, height: 1200 }, deviceScaleFactor: 1.5 });
  const page = await context.newPage();
  const errors = [];
  page.on("console", (m) => { if (m.type() === "error") errors.push("console: " + m.text()); });
  page.on("pageerror", (e) => errors.push("pageerror: " + e.message));
  await page.goto(`http://127.0.0.1:${port}/?dev=${Date.now()}`, { waitUntil: "commit", timeout: 180000 });
  await page.bringToFront();
  await page.waitForFunction(() => window.__voyageStartup, null, { timeout: 300000, polling: 500 });
  await page.evaluate(applyScene, { sc: { name: "typhoon-bands", p: { preset: "wpac", time: 900, coverage: 0.2, weather: "typhoon-bands", "wing-pos": "-4" }, wait: 300 }, defaults: DEFAULTS });
  for (let i = 0; i < 6; i++) {
    await page.evaluate(applyScene, {
      sc: i % 2
        ? { name: "noon-cumulus", p: { preset: "wpac", time: 720, "wing-pos": "8" }, wait: 100 }
        : { name: "typhoon-bands", p: { preset: "wpac", time: 900, coverage: 0.2, weather: "typhoon-bands", "wing-pos": "-4" }, wait: 100 },
      defaults: DEFAULTS,
    });
    await page.setViewportSize({ width: i % 2 ? 800 : 1600, height: i % 2 ? 600 : 1200 });
    await page.evaluate(() => window.dispatchEvent(new Event("resize")));
    await page.waitForTimeout(400);
  }
  await page.waitForTimeout(2000);
  console.log("控制台错误数：" + errors.length);
  errors.slice(0, 20).forEach((e) => console.log("  " + e));
  const finalState = await page.evaluate(() => ({ level: window.__voyage.quality.level, text: window.__voyage.quality.describe() }));
  console.log(JSON.stringify(finalState));
} finally {
  await closeBrowserSafely(browser);
}
