// PUB-3b：发布版美术过一遍用的一次性脚本（只看不改）。
// 默认首屏（不带任何参数、全新 localStorage）1600×1200 与 390×844；聚焦观察（Z）；转头到极限（拖动 + 前伸）。
// 用法（仓库根）：node apps/voyage/handoff/PUB-3b-look.mjs [端口=5181]
import { chromium } from "playwright-core";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { launchBrowser, closeBrowserSafely } from "../scripts/lib/chrome.mjs";

const REPO = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const OUT = path.join(REPO, "tmp", "screenshot", "PUB-3b", "c");
fs.mkdirSync(OUT, { recursive: true });
const port = process.argv[2] || "5181";
const url = `http://127.0.0.1:${port}/`;
const errors = [];

async function openPage(browser, opts) {
  const ctx = await browser.newContext(opts);
  const page = await ctx.newPage();
  page.on("console", (m) => { if (m.type() === "error") errors.push(`[${opts.viewport.width}] ${m.text()}`); });
  page.on("pageerror", (e) => errors.push(`[${opts.viewport.width}] pageerror ${e.message}`));
  await page.goto(url, { waitUntil: "commit", timeout: 180000 });
  await page.waitForFunction(() => window.__voyageStartup, null, { timeout: 240000 });
  return { ctx, page };
}
const shot = (page, name) => page.screenshot({ path: path.join(OUT, name + ".png") });
const info = (page) => page.evaluate(() => {
  const v = window.__voyage;
  return { head: v.head && { x: v.head.x, y: v.head.y, z: v.head.z }, lim: v.headLimits && { pos: v.headLimits.pos, neg: v.headLimits.neg },
    sun: v.state && v.state.sunElevDeg, time: v.state && v.state.time, preset: v.state && v.state.preset, heading: v.state && v.state.heading };
});

const browser = await launchBrowser(chromium);
try {
  // 1) 桌面默认首屏
  const { ctx, page } = await openPage(browser, { viewport: { width: 1600, height: 1200 } });
  await page.waitForTimeout(3000);
  await shot(page, "first-1600-t3");
  await page.waitForTimeout(12000);
  await shot(page, "first-1600-t15");
  console.log("first-1600", JSON.stringify(await info(page)));

  // 2) 聚焦观察（Z 按住）
  await page.mouse.move(800, 600);
  await page.keyboard.down("z");
  await page.waitForTimeout(900);
  await shot(page, "focus-z");
  await page.keyboard.up("z");
  await page.waitForTimeout(800);

  // 3) 转头到极限：按下立刻拖走（不触发聚焦），左右各拖到底
  const drag = async (dx, dy) => {
    await page.mouse.move(800, 600);
    await page.mouse.down();
    for (let i = 1; i <= 20; i++) await page.mouse.move(800 + (dx * i) / 20, 600 + (dy * i) / 20);
    await page.mouse.up();
    await page.waitForTimeout(1500);
  };
  await drag(-1400, 0); await drag(-1400, 0);
  await shot(page, "turn-left"); console.log("turn-left", JSON.stringify(await info(page)));
  await drag(1400, 0); await drag(1400, 0); await drag(1400, 0);
  await shot(page, "turn-right"); console.log("turn-right", JSON.stringify(await info(page)));
  await drag(0, -1200); await shot(page, "turn-up");
  await drag(0, 1200); await drag(0, 1200); await shot(page, "turn-down");
  // 前伸贴窗后再左右到底
  await page.mouse.move(800, 600);
  for (let i = 0; i < 30; i++) { await page.mouse.wheel(0, -300); await page.waitForTimeout(30); }
  await page.waitForTimeout(1200);
  await drag(-1400, 0); await drag(-1400, 0);
  await shot(page, "lean-left"); console.log("lean-left", JSON.stringify(await info(page)));
  await drag(1400, 0); await drag(1400, 0); await drag(1400, 0);
  await shot(page, "lean-right"); console.log("lean-right", JSON.stringify(await info(page)));
  // 前伸 + 聚焦中再拖到底（聚焦时限位放宽）
  await page.mouse.move(800, 600);
  await page.keyboard.down("z");
  await page.waitForTimeout(600);
  await drag(-1400, 0); await drag(-1400, 0); await drag(-1400, 0);
  await shot(page, "lean-zoom-left"); console.log("lean-zoom-left", JSON.stringify(await info(page)));
  await page.keyboard.up("z");
  await page.waitForTimeout(1500);
  await shot(page, "lean-zoom-left-release"); console.log("lean-zoom-left-release", JSON.stringify(await info(page)));
  // 后仰到底
  for (let i = 0; i < 40; i++) { await page.mouse.wheel(0, 300); await page.waitForTimeout(30); }
  await page.waitForTimeout(1200);
  await drag(-1400, 0); await drag(-1400, 0);
  await shot(page, "back-left");
  await drag(1400, 0); await drag(1400, 0); await drag(1400, 0);
  await shot(page, "back-right");
  await ctx.close();

  // 4) 手机默认首屏
  const m = await openPage(browser, { viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true });
  await m.page.waitForTimeout(3000);
  await shot(m.page, "first-390-t3");
  await m.page.waitForTimeout(10000);
  await shot(m.page, "first-390-t13");
  console.log("first-390", JSON.stringify(await info(m.page)));
  // 展开抽屉看一眼
  const handle = await m.page.$("#panel-handle");
  if (handle) { await handle.click(); await m.page.waitForTimeout(800); await shot(m.page, "first-390-drawer"); }
  else console.log("没找到抽屉把手选择器");
  await m.ctx.close();
} finally {
  await closeBrowserSafely(browser);
  console.log("errors:", errors.length ? errors.join("\n") : "无");
}
