#!/usr/bin/env node
// T18：窗外 pass 的 GPU 时间（benchScene(n, "outside")），谷地雾开 / 关对照，衡量雾的逐像素代价。
// 用法：node handoff/T18-outside-bench.mjs --port 5218 [--angle d3d11]
import { chromium } from "playwright-core";
import { DEFAULTS, SCENES, applyScene } from "../scripts/scenarios.mjs";
import { launchBrowser, closeBrowserSafely } from "../scripts/lib/chrome.mjs";

const argv = process.argv.slice(2);
const arg = (k, d) => (argv.includes(`--${k}`) ? argv[argv.indexOf(`--${k}`) + 1] : d);
const port = arg("port");
const angle = arg("angle", "d3d11");
const scenes = [
  SCENES.find((s) => s.name === "fuji-day"),
  { name: "fuji-dawn-fog", p: { preset: "fuji", time: 390, altitude: 1.5, coverage: 0.05, "wing-pos": "-4" }, offset: [-15, -12], ground: true },
];
const browser = await launchBrowser(chromium, { angle });
try {
  const page = await (await browser.newContext({ viewport: { width: 1600, height: 1200 }, deviceScaleFactor: 1 })).newPage();
  await page.goto(`http://127.0.0.1:${port}/?b=${Date.now()}`, { waitUntil: "commit", timeout: 180000 });
  await page.bringToFront();
  await page.waitForFunction(() => window.__voyageStartup, null, { timeout: 300000, polling: 500 });
  for (const sc of scenes) {
    await page.evaluate(applyScene, { sc, defaults: DEFAULTS });
    for (const fog of [1, 0]) {
      const ms = await page.evaluate(async (fog) => {
        const v = window.__voyage;
        v.haze.override = { valleyFog: fog };
        await new Promise((r) => setTimeout(r, 500));
        const xs = [];
        for (let i = 0; i < 7; i++) xs.push(v.benchScene(30, "outside"));
        xs.sort((a, b) => a - b);
        return xs[3];
      }, fog);
      console.log(`${sc.name} 谷地雾=${fog}: 窗外 pass 中位数 ${ms.toFixed(3)} ms`);
    }
  }
} finally {
  await closeBrowserSafely(browser);
}
