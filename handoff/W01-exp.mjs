#!/usr/bin/env node
// W01 实验：同一场景下改天梯的外观参数（反照率、半径）连拍裁剪，挑参数用。
// 用法：node apps/voyage/handoff/W01-exp.mjs --port 5260 [--angle vulkan] [--time 1078] [--seat left] [--out tmp/screenshot/W01/exp]
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
const port = args.port || 5260;
const outDir = path.join(ROOT, args.out || "tmp/screenshot/W01/exp");
fs.mkdirSync(outDir, { recursive: true });
const VARIANTS = JSON.parse(args.variants || '[[0.06,0.28],[0.02,0.28],[0.006,0.28],[0.002,0.28]]');

const browser = await launchBrowser(chromium, { angle: args.angle || "d3d11" });
try {
  const context = await browser.newContext({ viewport: { width: 1600, height: 1200 }, deviceScaleFactor: 1 });
  const page = await context.newPage();
  page.on("console", (m) => { if (m.type() === "error") console.log("[console.error]", m.text().slice(0, 300)); });
  await page.goto(`http://127.0.0.1:${port}/?dev=${Date.now()}`, { waitUntil: "commit", timeout: 180000 });
  await page.bringToFront();
  await page.waitForFunction(() => window.__voyageStartup, null, { timeout: 300000, polling: 500 });
  const sc = { name: "exp", p: { preset: "wpac", seat: args.seat || "left", time: Number(args.time || 1078), "wing-pos": "-4", coverage: 0.3, "cabin-light": "false" }, wait: 200 };
  await page.evaluate(applyScene, { sc, defaults: DEFAULTS });
  for (const [alb, rad] of VARIANTS) {
    await page.evaluate(([alb, rad, dist]) => {
      const ws = window.__voyage.wonders;
      ws.clear();
      ws.enabled = true;
      ws.trigger("tether", { forwardOffsetDeg: 0, distKm: dist, reveal: 1 });
      ws.active.def.look.albedo = [alb, alb, alb * 1.05];
      ws.active.def.look.radiusKm = rad;
    }, [alb, rad, Number(args.dist || 370)]);
    await new Promise((r) => setTimeout(r, 2000));
    const name = `a${alb}-r${rad}`;
    await page.screenshot({ path: path.join(outDir, `${name}.png`), clip: { x: 600, y: 0, width: 400, height: 600 } });
    console.log("  ", name);
  }
} finally {
  await closeBrowserSafely(browser);
}
