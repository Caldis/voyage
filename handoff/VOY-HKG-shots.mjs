// VOY-HKG 交付截图：scs 预设启动（切过去、画面稳定后）与 60 s 后两张，验证首段不再是 HKG→HKG 空转。
// 用法：node apps/voyage/handoff/VOY-HKG-shots.mjs <端口> [--out tmp/screenshot/VOY-HKG]
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright-core";
import { launchBrowser, closeBrowserSafely } from "../scripts/lib/chrome.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, "../../..");
const argv = process.argv.slice(2);
const port = Number(argv[0]);
const outDir = path.resolve(repoRoot, argv.includes("--out") ? argv[argv.indexOf("--out") + 1] : "tmp/screenshot/VOY-HKG");
fs.mkdirSync(outDir, { recursive: true });
if (!port) throw new Error("用法：node VOY-HKG-shots.mjs <端口> [--out dir]");

const browser = await launchBrowser(chromium, { angle: "d3d11" });
try {
  const ctx = await browser.newContext({ viewport: { width: 1600, height: 1200 } });
  const page = await ctx.newPage();
  await page.goto(`http://127.0.0.1:${port}/?voyage=1`, { waitUntil: "commit", timeout: 180000 });
  await page.bringToFront();
  await page.waitForFunction(() => window.__voyageStartup, null, { timeout: 300000, polling: 100 });
  await page.evaluate(() => document.getElementById("panel").classList.remove("hidden"));
  await page.selectOption("#preset", "scs");
  // 切换预设会重建地面 / 云场，等新场景的首帧渲染稳定（同 __voyageStartup 那条着色器编译进度条消失）
  await page.waitForFunction(() => !document.getElementById("loading") || document.getElementById("loading").hidden || getComputedStyle(document.getElementById("loading")).display === "none", null, { timeout: 30000 }).catch(() => {});
  await new Promise((r) => setTimeout(r, 1500));
  const t0 = Date.now();
  const s0 = await page.evaluate(() => {
    const v = window.__voyage;
    return { bankDeg: +v.state.bankDeg.toFixed(2), heading: +v.state.heading.toFixed(1), leg: v.director.leg && { from: v.director.leg.from.code, to: v.director.leg.to.code, distKm: Math.round(v.director.leg.distKm) } };
  });
  console.log("启动时：", JSON.stringify(s0));
  await page.screenshot({ path: path.join(outDir, "scs-start.png") });

  while (Date.now() - t0 < 60000) await new Promise((r) => setTimeout(r, 1000));
  const s60 = await page.evaluate(() => {
    const v = window.__voyage;
    return { bankDeg: +v.state.bankDeg.toFixed(2), heading: +v.state.heading.toFixed(1), leg: v.director.leg && { from: v.director.leg.from.code, to: v.director.leg.to.code, distKm: Math.round(v.director.leg.distKm) } };
  });
  console.log("60 s 后：", JSON.stringify(s60));
  await page.screenshot({ path: path.join(outDir, "scs-60s.png") });
  await ctx.close();
} finally {
  await closeBrowserSafely(browser);
}
