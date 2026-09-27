#!/usr/bin/env node
// T19b：远处雷暴的帧开销。天气场把雷暴摆在 100–500 km 外（占据网格只覆盖 ±128 km），量一下 4 个单体 / 台风放在不同距离时的 benchFrame。
// 用法：node handoff/T19b-storm-cost.mjs --port 5239 [--angle d3d11|vulkan]
import { chromium } from "playwright-core";
import { DEFAULTS, applyScene } from "../scripts/scenarios.mjs";
import { launchBrowser, closeBrowserSafely } from "../scripts/lib/chrome.mjs";

const args = Object.fromEntries(
  process.argv.slice(2).reduce((acc, a, i, arr) => (a.startsWith("--") ? [...acc, [a.slice(2), arr[i + 1] && !arr[i + 1].startsWith("--") ? arr[i + 1] : true]] : acc), []),
);
const browser = await launchBrowser(chromium, { angle: String(args.angle || "d3d11") });
try {
  const page = await (await browser.newContext({ viewport: { width: 1600, height: 1200 }, deviceScaleFactor: 1 })).newPage();
  const errors = [];
  page.on("console", (m) => m.type() === "error" && errors.push(m.text().slice(0, 200)));
  await page.goto(`http://127.0.0.1:${args.port}/?t19b=${Date.now()}`, { waitUntil: "commit", timeout: 180000 });
  await page.bringToFront();
  await page.waitForFunction(() => window.__voyageStartup, null, { timeout: 300000, polling: 500 });
  await page.evaluate(applyScene, { sc: { name: "storm-cost", p: { preset: "wpac", time: 900, coverage: 0.3, "wing-pos": "-4" } }, defaults: DEFAULTS });
  const out = await page.evaluate(async () => {
    const v = window.__voyage;
    const wait = (ms) => new Promise((r) => setTimeout(r, ms));
    const res = {};
    const place = (dist) => {
      v.weather.removeStorms(() => true);
      if (dist == null) return;
      const h = (v.state.heading * Math.PI) / 180;
      const o = v.cloudUniforms.uCloudOffset.value;
      // 窗外一侧（右座朝右），一排 4 个
      for (let i = 0; i < 4; i++) v.weather.addStorm({ id: `t#${i}`, x: o.x + Math.cos(h) * dist + Math.sin(h) * (i - 1.5) * 16, z: o.y + Math.sin(h) * dist - Math.cos(h) * (i - 1.5) * 16, radius: 5.5, top: 13 });
    };
    for (const [name, dist] of [["无雷暴", null], ["60 km", 60], ["134 km", 134], ["300 km", 300], ["无雷暴(复测)", null]]) {
      place(dist);
      await wait(4000); // 占据网格分帧建完
      const runs = [];
      for (let k = 0; k < 5; k++) runs.push(v.benchFrame(20));
      runs.sort((a, b) => a - b);
      res[name] = +runs[2].toFixed(2);
    }
    // 台风：中心放在窗外一侧 250 / 500 / 750 km
    for (const dist of [250, 500, 750]) {
      const h = (v.state.heading * Math.PI) / 180;
      const o = v.cloudUniforms.uCloudOffset.value;
      v.weather.setHurricane({ id: "t", x: o.x + Math.cos(h) * dist, z: o.y + Math.sin(h) * dist, eye: 20 });
      await wait(4000);
      const runs = [];
      for (let k = 0; k < 5; k++) runs.push(v.benchFrame(20));
      runs.sort((a, b) => a - b);
      res[`台风 ${dist} km`] = +runs[2].toFixed(2);
    }
    v.weather.setHurricane(null);
    return res;
  });
  console.log(JSON.stringify({ benchFrameMs: out, errors }, null, 2));
} finally {
  await closeBrowserSafely(browser);
}
