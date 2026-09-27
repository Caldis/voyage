#!/usr/bin/env node
// T33 附带：台风外围 / 雨带里「纱窗点阵」幽灵塔与透明方盒（美术总监 wave5 第 2 处）的对照截图。
// 每个场景 × 每个变体截一张（变体 = 场景应用后执行的一段 JS），存到 --out。
// 用法：node handoff/T33-ghost.mjs --port 5231 [--angle vulkan] [--only typhoon-outer,typhoon-bands]
//        [--variants '[{"name":"noocc","js":"window.__voyage.clouds.occEnabled=false"}]'] [--out tmp/screenshot/t33-ghost]
import { chromium } from "playwright-core";
import fs from "node:fs";
import path from "node:path";
import { DEFAULTS, applyScene, pickScenes } from "../scripts/scenarios.mjs";
import { launchBrowser, closeBrowserSafely } from "../scripts/lib/chrome.mjs";

const args = {};
const av = process.argv.slice(2);
for (let i = 0; i < av.length; i++) if (av[i].startsWith("--")) { args[av[i].slice(2)] = av[i + 1]; i++; }
const out = args.out || "../../tmp/screenshot/t33-ghost";
fs.mkdirSync(out, { recursive: true });
const variants = [{ name: "base", js: "" }, ...(args.variants ? JSON.parse(args.variants) : [])];
const browser = await launchBrowser(chromium, { angle: String(args.angle || "d3d11") });
try {
  const page = await (await browser.newContext({ viewport: { width: 1600, height: 1200 }, deviceScaleFactor: 1 })).newPage();
  const errors = [];
  page.on("console", (m) => m.type() === "error" && errors.push(m.text().slice(0, 200)));
  await page.goto(`http://127.0.0.1:${args.port}/?ghost=${Date.now()}`, { waitUntil: "commit", timeout: 180000 });
  await page.bringToFront();
  await page.waitForFunction(() => window.__voyageStartup, null, { timeout: 300000, polling: 500 });
  for (const sc of pickScenes((args.only || "typhoon-outer,typhoon-bands").split(","))) {
    for (const vr of variants) {
      await page.evaluate(applyScene, { sc, defaults: DEFAULTS });
      await page.evaluate(() => { for (const el of document.querySelectorAll("#panel,.panel,#hud,#info")) el.classList.add("hidden"); });
      if (vr.js) await page.evaluate(vr.js);
      await page.waitForTimeout(sc.wait || 4000);
      await page.screenshot({ path: path.join(out, `${sc.name}-${vr.name}.png`) });
      if (vr.after) await page.evaluate(vr.after);
    }
  }
  console.log("errors:", errors.length ? errors : "无");
} finally {
  await closeBrowserSafely(browser);
}
