#!/usr/bin/env node
// T31：穿云 / 出云时舱内光照乘子（uKeyCloud）的时间序列 + 出云过程的连续截图。
// 在 in-cloud 场景里把飞机从云里（1.35 km）一步抬到云顶以上（3 km），每 100 ms 记一次 uKeyCloud 和探针原始值；
// 另外打印几个回归场景（晴空）里的 uKeyCloud，应为 (1, 0, 1)。
// 用法：node handoff/T31-exit.mjs --port 5231 [--angle vulkan] [--out tmp/screenshot/t31/exit]
import { chromium } from "playwright-core";
import fs from "node:fs";
import path from "node:path";
import { DEFAULTS, SCENES, applyScene } from "../scripts/scenarios.mjs";
import { launchBrowser, closeBrowserSafely } from "../scripts/lib/chrome.mjs";

const args = {};
const av = process.argv.slice(2);
for (let i = 0; i < av.length; i++) if (av[i].startsWith("--")) { args[av[i].slice(2)] = av[i + 1]; i++; }
const out = args.out || "../../tmp/screenshot/t31/exit";
fs.mkdirSync(out, { recursive: true });
const browser = await launchBrowser(chromium, { angle: String(args.angle || "d3d11") });
try {
  const page = await (await browser.newContext({ viewport: { width: 1600, height: 1200 }, deviceScaleFactor: 1 })).newPage();
  const errors = [];
  page.on("console", (m) => m.type() === "error" && errors.push(m.text().slice(0, 200)));
  await page.goto(`http://127.0.0.1:${args.port}/?t31=${Date.now()}`, { waitUntil: "commit", timeout: 180000 });
  await page.bringToFront();
  await page.waitForFunction(() => window.__voyageStartup, null, { timeout: 300000, polling: 500 });
  const read = () => page.evaluate(() => {
    const v = window.__voyage;
    const k = v.sceneMat.uniforms.uKeyCloud.value;
    return { k: k.toArray().map((x) => +x.toFixed(3)), tRaw: +v.clouds.keyTransmittanceRaw.toFixed(3), tau: +v.clouds.keyOpticalDepthRaw.toFixed(2), dens: +v.clouds.cameraDensity.toFixed(3) };
  });
  for (const name of ["noon-cumulus", "sunset-wing", "clouds-variety", "storm-day", "typhoon-outer", "typhoon-eye", "in-cloud"]) {
    const sc = SCENES.find((s) => s.name === name);
    await page.evaluate(applyScene, { sc, defaults: DEFAULTS });
    await page.waitForTimeout(sc.wait || 2500);
    console.log(name.padEnd(16), JSON.stringify(await read()));
  }
  await page.evaluate(() => { for (const el of document.querySelectorAll("#panel,.panel,#hud,#info")) el.classList.add("hidden"); });
  // 出云：直接把高度设到云顶以上（滑块 input 事件）
  const series = [];
  await page.evaluate(() => {
    const el = document.getElementById("altitude");
    el.value = "3";
    el.dispatchEvent(new Event("input", { bubbles: true }));
  });
  const t0 = Date.now();
  for (let i = 0; i < 30; i++) {
    const r = await read();
    series.push({ ms: Date.now() - t0, ...r });
    if (i % 5 === 0) await page.screenshot({ path: path.join(out, `exit-${String(i).padStart(2, "0")}.png`) });
    await page.waitForTimeout(100);
  }
  for (const s of series) console.log(JSON.stringify(s));
  console.log("errors:", errors.length ? errors : "无");
} finally {
  await closeBrowserSafely(browser);
}
