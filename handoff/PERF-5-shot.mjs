#!/usr/bin/env node
// 面板截图：确认新画质下拉 + 状态行渲染正常
import { chromium } from "playwright-core";
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
  await page.goto(`http://127.0.0.1:${port}/?dev=${Date.now()}`, { waitUntil: "commit", timeout: 180000 });
  await page.bringToFront();
  await page.waitForFunction(() => window.__voyageStartup, null, { timeout: 300000, polling: 500 });
  await page.waitForTimeout(2000);
  await page.screenshot({ path: path.join(outDir, "panel-default.png") });
  const sel = await page.$("#quality");
  await sel.scrollIntoViewIfNeeded();
  await page.waitForTimeout(200);
  const box = await sel.boundingBox();
  await page.screenshot({
    path: path.join(outDir, "panel-quality-zoom.png"),
    clip: { x: Math.max(0, box.x - 40), y: Math.max(0, box.y - 220), width: 400, height: 320 },
  });
  console.log("done");
} finally {
  await closeBrowserSafely(browser);
}
