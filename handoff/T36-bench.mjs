#!/usr/bin/env node
// T36 性能对照：同一端口开两页，A = ?lut16（改前：半精度 LUT），B = 默认（32 位浮点 LUT），逐轮交替测 benchFrame，取中位数。
// 用法：node handoff/T36-bench.mjs --port 5236 [--angle d3d11] [--rounds 6] [--frames 30]
import { chromium } from "playwright-core";
import { DEFAULTS, SCENES, applyScene } from "../scripts/scenarios.mjs";
import { launchBrowser, closeBrowserSafely } from "../scripts/lib/chrome.mjs";

const arg = (k, d) => (process.argv.includes(`--${k}`) ? process.argv[process.argv.indexOf(`--${k}`) + 1] : d);
const port = arg("port");
const angle = arg("angle", "d3d11");
const rounds = Number(arg("rounds", 6));
const frames = Number(arg("frames", 30));
const twilight = { name: "twilight-15", p: { preset: "wpac", seat: "right", time: 1117, coverage: 0, "wing-pos": "-4", "cabin-light": "off" } };
const scenes = [...SCENES.filter((s) => ["noon-cumulus", "sunset-wing", "dusk-earthshadow", "night-city"].includes(s.name)), twilight];

const browser = await launchBrowser(chromium, { angle });
try {
  const open = async (q) => {
    const page = await (await browser.newContext({ viewport: { width: 1600, height: 1200 }, deviceScaleFactor: 1 })).newPage();
    await page.goto(`http://127.0.0.1:${port}/?bench=${Date.now()}${q}`, { waitUntil: "commit", timeout: 180000 });
    await page.waitForFunction(() => window.__voyageStartup, null, { timeout: 300000, polling: 500 });
    return page;
  };
  const pages = { half: await open("&lut16"), float: await open("") };
  const med = (a) => [...a].sort((x, y) => x - y)[Math.floor(a.length / 2)];
  for (const sc of scenes) {
    for (const p of Object.values(pages)) await p.evaluate(applyScene, { sc, defaults: DEFAULTS });
    for (const p of Object.values(pages)) await p.evaluate((n) => window.__voyage.benchFrame(n), 10);
    const ms = { half: [], float: [] };
    for (let r = 0; r < rounds; r++) {
      for (const [k, p] of Object.entries(pages)) {
        await p.bringToFront();
        ms[k].push(await p.evaluate((n) => window.__voyage.benchFrame(n), frames));
      }
    }
    const h = med(ms.half), f = med(ms.float);
    console.log(`${sc.name.padEnd(18)} 半精度 ${h.toFixed(2)} ms  32 位 ${f.toFixed(2)} ms  (${(((f - h) / h) * 100).toFixed(1)}%)`);
  }
} finally {
  await closeBrowserSafely(browser);
}
