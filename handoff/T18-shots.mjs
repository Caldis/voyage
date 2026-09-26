#!/usr/bin/env node
// T18 专用截图：回归表里的 fuji-day / route-hnd-cts / low-sea-glint，再加陆地低空、清晨谷地雾几个场景。
// 用法：node handoff/T18-shots.mjs --port 5218 [--angle vulkan] [--only a,b] [--out tmp/screenshot/t18-5218]
// 场景字段同 scripts/scenarios.mjs，外加 pre：截图前在页面里执行的一段 JS（字符串，拿得到 window.__voyage）。
import { chromium } from "playwright-core";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { DEFAULTS, SCENES, applyScene } from "../scripts/scenarios.mjs";
import { launchBrowser, closeBrowserSafely } from "../scripts/lib/chrome.mjs";

const VOYAGE_ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const REPO_ROOT = path.join(VOYAGE_ROOT, "..", "..");
const args = Object.fromEntries(
  process.argv.slice(2).reduce((acc, a, i, arr) => (a.startsWith("--") ? [...acc, [a.slice(2), arr[i + 1] && !arr[i + 1].startsWith("--") ? arr[i + 1] : true]] : acc), []),
);
const port = args.port;
if (!port) throw new Error("需要 --port");
const angle = String(args.angle || "d3d11");
const outDir = path.join(REPO_ROOT, args.out || `tmp/screenshot/t18-${port}`);
fs.mkdirSync(outDir, { recursive: true });

const fromTable = (n) => SCENES.find((s) => s.name === n);
const scenes = [
  fromTable("fuji-day"),
  fromTable("route-hnd-cts"),
  fromTable("low-sea-glint"),
  // 陆地低空：伊豆半岛北部上空，要 1.5 km，应被抬到下限
  { name: "fuji-low", p: { preset: "fuji", time: 930, altitude: 1.5, coverage: 0.1, "wing-pos": "-4" }, ground: true },
  // 清晨谷地雾：日出后不久，富士山以南的山区（强制这天有雾，免得撞上随机的无雾日）
  { name: "fuji-dawn-fog", p: { preset: "fuji", time: 390, altitude: 1.5, coverage: 0.05, "wing-pos": "-4" }, offset: [-15, -12], ground: true, pre: "window.__voyage.haze.override = { valleyFog: 1 }" },
  // 同一场景不强制：按当天的随机与时段
  { name: "fuji-dawn", p: { preset: "fuji", time: 400, altitude: 1.5, coverage: 0.05, "wing-pos": "-4" }, offset: [-15, -12], ground: true, pre: "window.__voyage.haze.override = {}" },
  // 华东平原（霾浓的地区）午后
  { name: "yangtze-day", p: { preset: "yangtze", time: 870, altitude: 6, coverage: 0.1, "wing-pos": "-4" }, ground: true },
];
const only = args.only ? String(args.only).split(",") : null;

const browser = await launchBrowser(chromium, { angle });
try {
  const context = await browser.newContext({ viewport: { width: 1600, height: 1200 }, deviceScaleFactor: 1 });
  const page = await context.newPage();
  page.on("console", (m) => {
    if (m.type() === "error") console.log("  [console.error]", m.text().slice(0, 300));
  });
  await page.goto(`http://127.0.0.1:${port}/?t18=${Date.now()}`, { waitUntil: "commit", timeout: 180000 });
  await page.bringToFront();
  await page.waitForFunction(() => window.__voyageStartup, null, { timeout: 300000, polling: 500 });
  for (const sc of scenes.filter((s) => !only || only.includes(s.name))) {
    if (sc.pre) await page.evaluate(sc.pre);
    const info = await page.evaluate(applyScene, { sc, defaults: DEFAULTS });
    await page.screenshot({ path: path.join(outDir, `${sc.name}.png`), timeout: 60000 });
    const frameMs = await page.evaluate((n) => window.__voyage.benchFrame(n), 20);
    const extra = await page.evaluate(() => {
      const v = window.__voyage;
      return { floor: v.state.floor, alt: v.state.altitudeKm, haze: v.haze?.current };
    });
    const meta = { scene: sc.name, info, frameMs: +frameMs.toFixed(2), ...extra };
    fs.writeFileSync(path.join(outDir, `${sc.name}.json`), JSON.stringify(meta, null, 2));
    console.log(`${sc.name}: ${frameMs.toFixed(2)} ms  alt=${extra.alt?.toFixed(2)}  floor=${JSON.stringify(extra.floor)}  haze=${JSON.stringify(extra.haze)}`);
  }
  await context.close();
} finally {
  await closeBrowserSafely(browser);
}
