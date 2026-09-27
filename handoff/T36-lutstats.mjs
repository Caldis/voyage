#!/usr/bin/env node
// T36 实验：读回天空视图 LUT（32 位浮点）在各太阳高度下的数值分布（绿通道，天空半边）。
// 需要 luts.ts 里的临时调试钩子（?svf32=1&t36dbg=1，实验结束后已删，复现时要加回）；
// 用法：node handoff/T36-lutstats.mjs --port 5236 --angle vulkan
import { chromium } from "playwright-core";
import { DEFAULTS, applyScene } from "../scripts/scenarios.mjs";
import { launchBrowser, closeBrowserSafely } from "../scripts/lib/chrome.mjs";

const port = process.argv[process.argv.indexOf("--port") + 1];
const angle = process.argv.includes("--angle") ? process.argv[process.argv.indexOf("--angle") + 1] : "d3d11";
const browser = await launchBrowser(chromium, { angle });
try {
  const page = await (await browser.newContext({ viewport: { width: 1600, height: 1200 } })).newPage();
  await page.goto(`http://127.0.0.1:${port}/?svf32=1&t36dbg=1`, { waitUntil: "commit", timeout: 180000 });
  await page.waitForFunction(() => window.__voyageStartup, null, { timeout: 300000, polling: 500 });
  for (const time of [1040, 1076, 1094, 1117, 1131]) {
    const info = await page.evaluate(applyScene, { sc: { name: "x", p: { preset: "wpac", time, coverage: 0 }, wait: 800 }, defaults: DEFAULTS });
    const st = await page.evaluate(() => window.__t36());
    console.log(info.match(/太阳高度角 (-?[\d.]+)°/)[0], JSON.stringify(st, (k, v) => (typeof v === "number" ? +v.toPrecision(3) : v)));
  }
} finally {
  await closeBrowserSafely(browser);
}
