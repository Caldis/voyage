// G07：诊断用——设好场景后隔几秒打印一次窗外变体 / 高度 / 地面状态（排查两版画面差异的来源）。
// 用法（apps/voyage 下）：node handoff/G07-state.mjs <端口> [秒数=40] [额外 URL 参数]
import { chromium } from "playwright-core";
import { launchBrowser } from "../scripts/lib/chrome.mjs";
import { DEFAULTS, applyScene } from "../scripts/scenarios.mjs";

const [port, secsS = "40", extraQ = ""] = process.argv.slice(2);
const browser = await launchBrowser(chromium, {});
try {
  const page = await (await browser.newContext({ viewport: { width: 1600, height: 1200 } })).newPage();
  await page.goto(`http://127.0.0.1:${port}/?g07=${Date.now()}${extraQ}`, { waitUntil: "commit", timeout: 180000 });
  await page.bringToFront();
  await page.waitForFunction(() => window.__voyageStartup, null, { timeout: 300000, polling: 500 });
  const sc = { name: "night-city", p: { preset: "fuji", date: "2026-01-16", time: 1260, altitude: 4, coverage: 0.05, "cabin-light": false }, offset: [0, -25], head: -0.25 };
  await page.evaluate(applyScene, { sc: { ...sc, ground: false, wait: 0 }, defaults: DEFAULTS, settle: false });
  await page.evaluate(() => { const v = window.__voyage; v.freeze(true); v.cloudUniforms.uCloudOffset.value.set(0, -25); });
  for (let t = 0; t < Number(secsS); t += 4) {
    console.log(
      await page.evaluate((t) => {
        const v = window.__voyage;
        const g = v.ground;
        const st = g.imageryStats;
        return JSON.stringify({ t, alt: +v.state.altitudeKm.toFixed(3), vs: v.groundDetail.variantStatus.shown + "/" + v.groundDetail.variantStatus.wanted, valid: g.levelUniform.map((u) => (u.w > 0.5 ? 1 : 0)).join(""), fine: (st.fine ?? []).map((f) => (f ? 1 : 0)).join(""), pending: g.pending, detailOn: st.detailOn, hosts: Object.fromEntries(Object.entries(st.hosts).map(([h, s]) => [h.split(".")[0] + "." + h.split(".")[1], `${s.ok}/${s.requests} f${s.failed} t${s.throttled} m${s.missing}`])) });
      }, t),
    );
    await page.waitForTimeout(4000);
  }
} finally {
  await browser.close();
}
