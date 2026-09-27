// G07：诊断用——夜景首载完后看影像瓦片失败数，截一张；再强制所有级别重建（失败的瓦片会重试）、等就位再截一张。
// 用来判断「master 夜景近处发糊」是不是首载时 EOX 限流丢了瓦片（缺影像 → 回退粗级别、没有建成区灯点）。
// 用法（apps/voyage 下）：node handoff/G07-rebuild-check.mjs <端口> <输出目录(绝对)>
import { chromium } from "playwright-core";
import fs from "node:fs";
import path from "node:path";
import { launchBrowser } from "../scripts/lib/chrome.mjs";
import { DEFAULTS, applyScene } from "../scripts/scenarios.mjs";

const [port, out] = process.argv.slice(2);
fs.mkdirSync(out, { recursive: true });
const browser = await launchBrowser(chromium, {});
try {
  const page = await (await browser.newContext({ viewport: { width: 1600, height: 1200 } })).newPage();
  await page.goto(`http://127.0.0.1:${port}/?g07=${Date.now()}`, { waitUntil: "commit", timeout: 180000 });
  await page.bringToFront();
  await page.waitForFunction(() => window.__voyageStartup, null, { timeout: 300000, polling: 500 });
  const sc = { name: "night-city", p: { preset: "fuji", date: "2026-01-16", time: 1260, altitude: 4, coverage: 0.05, "cabin-light": false }, offset: [0, -25], head: -0.25 };
  await page.evaluate(applyScene, { sc: { ...sc, ground: false, wait: 0 }, defaults: DEFAULTS, settle: false });
  await page.evaluate(() => { const v = window.__voyage; v.freeze(true); v.cloudUniforms.uCloudOffset.value.set(0, -25); });
  const settle = () => page.waitForFunction(() => { const g = window.__voyage.ground; const w = g.imageryStats.warmup; return g.pending === 0 && g.levelUniform.every((u) => u.w > 0.5) && !g.levels.some((l) => l.building) && (!w || w.fine >= 0); }, null, { timeout: 150000, polling: 500 }).catch(() => console.log("等待超时"));
  const eox = () => page.evaluate(() => { const h = window.__voyage.ground.imageryStats.hosts; const k = Object.keys(h).find((x) => x.includes("eox")); const s = h[k]; return { requests: s.requests, ok: s.ok, failed: s.failed, throttled: s.throttled }; });
  await settle();
  await page.waitForTimeout(1500);
  console.log("首载后 EOX：", JSON.stringify(await eox()));
  await page.screenshot({ path: path.join(out, "1-first.png") });
  // 强制全部重建（中心设成 NaN；只在这个诊断里用，heightAt 在重建期间会读到 NaN，无妨）
  await page.evaluate(() => { for (const l of window.__voyage.ground.levels) l.cx = NaN; });
  await page.waitForTimeout(1000);
  await settle();
  await page.waitForTimeout(1500);
  console.log("重建后 EOX：", JSON.stringify(await eox()));
  await page.screenshot({ path: path.join(out, "2-rebuilt.png") });
} finally {
  await browser.close();
}
