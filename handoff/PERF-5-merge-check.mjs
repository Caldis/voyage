#!/usr/bin/env node
// 合并 master 之后的交付前验收：noon-cumulus 截图 + 控制台 error 检查。
// 用法：node apps/voyage/handoff/PERF-5-merge-check.mjs --port 5245
import { chromium } from "playwright-core";
import { DEFAULTS, applyScene } from "../scripts/scenarios.mjs";
import { launchBrowser, closeBrowserSafely } from "../scripts/lib/chrome.mjs";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const port = process.argv.includes("--port") ? process.argv[process.argv.indexOf("--port") + 1] : 5245;
const HERE = path.dirname(fileURLToPath(import.meta.url));
const outDir = path.join(HERE, "..", "..", "..", "tmp", "screenshot", "PERF-5");
fs.mkdirSync(outDir, { recursive: true });

const browser = await launchBrowser(chromium, { angle: "d3d11" });
try {
  const context = await browser.newContext({ viewport: { width: 1600, height: 1200 }, deviceScaleFactor: 1 });
  const page = await context.newPage();
  const errors = [];
  page.on("console", (m) => { if (m.type() === "error") errors.push("console: " + m.text()); });
  page.on("pageerror", (e) => errors.push("pageerror: " + e.message));
  await page.goto(`http://127.0.0.1:${port}/?dev=${Date.now()}`, { waitUntil: "commit", timeout: 180000 });
  await page.bringToFront();
  await page.waitForFunction(() => window.__voyageStartup, null, { timeout: 300000, polling: 500 });
  await page.evaluate(applyScene, { sc: { name: "noon-cumulus", p: { preset: "wpac", time: 720, "wing-pos": "8" }, wait: 2000 }, defaults: DEFAULTS });
  await page.screenshot({ path: path.join(outDir, "merge-noon-cumulus.png") });

  const state = await page.evaluate(() => ({
    quality: window.__voyage.quality.describe(),
    audioPresent: !!window.__voyage.audio,
    cloudScale: window.__voyage.clouds.resolutionScale,
  }));
  console.log("状态：" + JSON.stringify(state));
  console.log("控制台错误数：" + errors.length);
  errors.forEach((e) => console.log("  " + e));
} finally {
  await closeBrowserSafely(browser);
}
