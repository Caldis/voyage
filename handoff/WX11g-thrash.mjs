// WX11g 返工 M1：风速在档边界来回时 Worker 重算几档（审查口径：9.99 ↔ 10.01、13.49 ↔ 13.51 各来回 20 次）；
// 另记启动时的频谱计算档数（审查 L1：第一帧同一档不应在主线程和 Worker 各算一遍）。
// 用法：node apps/voyage/handoff/WX11g-thrash.mjs --port 5245
import { chromium } from "playwright-core";
import { launchBrowser, closeBrowserSafely } from "../scripts/lib/chrome.mjs";

const port = process.argv.includes("--port") ? process.argv[process.argv.indexOf("--port") + 1] : "5245";
const browser = await launchBrowser(chromium);
try {
  const page = await browser.newPage({ viewport: { width: 1600, height: 1200 } });
  const errors = [];
  page.on("console", (m) => m.type() === "error" && errors.push(m.text()));
  page.on("pageerror", (e) => errors.push(String(e)));
  await page.goto(`http://127.0.0.1:${port}/?quality=high`);
  await page.waitForFunction(() => window.__voyageStartup && window.__voyage && window.__voyage.ocean, null, { timeout: 300000 });
  await page.waitForTimeout(3000);
  const res = await page.evaluate(async () => {
    const v = window.__voyage;
    const raf = (n = 1) => new Promise((r) => { let k = 0; const f = () => (++k >= n ? r() : requestAnimationFrame(f)); requestAnimationFrame(f); });
    const settle = async () => { for (let i = 0; i < 600 && v.ocean.stats.pending > 0; i++) await raf(); await raf(5); };
    const startup = { builds: v.ocean.stats.builds, syncBuildMs: v.ocean.stats.syncBuildMs };
    const out = { startup };
    for (const [lo, hi] of [[9.99, 10.01], [13.49, 13.51]]) {
      v.state.wind = lo;
      for (let i = 0; i < 600 && v.ocean.stats.wind !== lo; i++) await raf();
      await settle();
      const b0 = v.ocean.stats.builds, h0 = v.ocean.stats.holds;
      for (let k = 0; k < 20; k++) {
        v.state.wind = hi;
        await raf(3);
        v.state.wind = lo;
        await raf(3);
      }
      await settle();
      out[`${lo}↔${hi}`] = { rebuilds: v.ocean.stats.builds - b0, holds: v.ocean.stats.holds - h0 };
    }
    return out;
  });
  console.log(JSON.stringify(res));
  console.log(`console error ${errors.length} 条`, errors.slice(0, 3));
} finally {
  await closeBrowserSafely(browser);
}
