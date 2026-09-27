#!/usr/bin/env node
// T08：在回归场景的基础上改几个面板值再截图（黄昏开灯过程、座位 / 高度变体）。
// 用法：node handoff/T08-shots.mjs --port 5208 [--angle vulkan] --scene route-hnd-cts-night --set time=1080,altitude=10.7 [--name 自定义名] [--out tmp/screenshot/T08/x]
import { chromium } from "playwright-core";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { DEFAULTS, applyScene, pickScenes } from "../scripts/scenarios.mjs";
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
const port = args.port || 5208;
const angle = args.angle || "d3d11";
const outDir = path.join(ROOT, args.out || "tmp/screenshot/T08/shots");
fs.mkdirSync(outDir, { recursive: true });
const base = pickScenes([args.scene || "route-hnd-cts-night"])[0];
if (!base) throw new Error(`未知场景 ${args.scene}`);
// --set 可以给多组，用 ; 分隔：每组截一张
const groups = String(args.set || "").split(";").filter(Boolean);
if (groups.length === 0) groups.push("");

const browser = await launchBrowser(chromium, { angle });
try {
  const context = await browser.newContext({ viewport: { width: 1600, height: 1200 }, deviceScaleFactor: 1 });
  const page = await context.newPage();
  page.on("console", (m) => { if (m.type() === "error" || m.text().includes("[T08-timing]")) console.log(`[控制台 ${m.type()}] ${m.text()}`); });
  page.on("pageerror", (e) => console.log(`[页面异常] ${e.message}`));
  await page.goto(`http://127.0.0.1:${port}/?t08=${Date.now()}`, { waitUntil: "commit", timeout: 180000 });
  await page.waitForFunction(() => window.__voyageStartup, null, { timeout: 300000, polling: 500 });
  await page.waitForTimeout(2000);
  for (const g of groups) {
    const p = { ...base.p };
    for (const kv of g.split(",").filter(Boolean)) {
      const [k, v] = kv.split("=");
      p[k] = v === "true" ? true : v === "false" ? false : isNaN(Number(v)) ? v : Number(v);
    }
    const name = `${args.name || base.name}${g ? "_" + g.replace(/[=,]/g, "-") : ""}`;
    await page.evaluate(applyScene, { sc: { ...base, p }, defaults: DEFAULTS });
    await page.evaluate(() => (window.__voyage.wingDebug.strobe = 0));
    await page.waitForTimeout(800);
    await page.screenshot({ path: path.join(outDir, `${name}.png`), timeout: 60000 });
    console.log(`[T08-shots] ${name}`);
  }
  // --longtask 秒数：截图之后继续飞，统计主线程长任务（≥50 ms）。clipmap 每飞过一级边长的 1/8 就重建这一级，
  // 60× 加速时细级别每一两秒重建一次，能看出重建时主线程卡不卡（道路栅格化是否真的都在 Worker 里）
  if (args.longtask) {
    const secs = Number(args.longtask);
    const r = await page.evaluate(async (s) => {
      const tasks = [];
      const ob = new PerformanceObserver((l) => { for (const e of l.getEntries()) tasks.push(e.duration); });
      ob.observe({ type: "longtask", buffered: false });
      const el = document.getElementById("speed");
      if (el) { el.value = "60"; el.dispatchEvent(new Event("change")); el.dispatchEvent(new Event("input")); }
      await new Promise((res) => setTimeout(res, s * 1000));
      ob.disconnect();
      tasks.sort((a, b) => b - a);
      return { n: tasks.length, max: tasks[0] ?? 0, top: tasks.slice(0, 8).map((x) => Math.round(x)), speedEl: !!el };
    }, secs);
    console.log(`[T08-shots] 长任务 ${secs} s：${JSON.stringify(r)}`);
  }
} finally {
  await closeBrowserSafely(browser);
}
