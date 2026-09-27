#!/usr/bin/env node
// T35：舱内「看前方 / 看后方 / 默认坐姿」× 两个舱等的对照截图（私有 headless，复用 scenarios.mjs 的 applyScene）。
// 用法：node handoff/T35-shots.mjs --port 5235 [--angle vulkan] [--only a,b] [--out tmp/screenshot/T35/x] [--crop]
// 场景名：<舱等>-<视角>[-night]
//   舱等 biz / econ；视角 ahead（看前方）/ behind（看后方）/ seated（默认坐姿）；-night 夜里开灯（21:00）
import { chromium } from "playwright-core";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { DEFAULTS, applyScene } from "../scripts/scenarios.mjs";
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
const port = args.port || 5235;
const angle = args.angle || "d3d11";
const outDir = path.join(ROOT, args.out || "tmp/screenshot/T35/cur");
fs.mkdirSync(outDir, { recursive: true });
const DEFAULT_LIST = ["biz-ahead", "econ-ahead", "biz-behind", "biz-seated", "econ-seated"];
const names = args.only ? String(args.only).split(",") : DEFAULT_LIST;
const HEADS = { ahead: [-0.42, 0.1, -0.5], behind: [0.42, 0.1, -0.5], seated: [0, 0.02, -0.42] };
const scenes = names.map((nm) => {
  const [cls, view, night] = nm.split("-");
  if (!HEADS[view]) throw new Error(`未知视角 ${nm}`);
  return {
    name: nm,
    p: { preset: "wpac", time: night ? 1260 : 720, "wing-pos": "8", "cabin-class": cls === "econ" ? "economy" : "business" },
    head: HEADS[view],
  };
});

const browser = await launchBrowser(chromium, { angle });
try {
  const context = await browser.newContext({ viewport: { width: 1600, height: 1200 }, deviceScaleFactor: 1 });
  const page = await context.newPage();
  page.on("console", (m) => { if (m.type() === "error") console.log(`[控制台 error] ${m.text()}`); });
  page.on("pageerror", (e) => console.log(`[页面异常] ${e.message}`));
  await page.goto(`http://127.0.0.1:${port}/?dev=${Date.now()}`, { waitUntil: "commit", timeout: 180000 });
  await page.waitForFunction(() => window.__voyageStartup, null, { timeout: 300000, polling: 500 });
  await page.waitForTimeout(2000);
  for (const sc of scenes) {
    const t0 = Date.now();
    await page.evaluate(applyScene, { sc, defaults: DEFAULTS });
    await page.evaluate(() => (window.__voyage.wingDebug.strobe = 0));
    await page.waitForTimeout(500);
    await page.screenshot({ path: path.join(outDir, `${sc.name}.png`), timeout: 60000 });
    console.log(`  ${sc.name}  ${((Date.now() - t0) / 1000).toFixed(1)} s`);
  }
} finally {
  await closeBrowserSafely(browser);
}
