// PUB-4 B4 自测（一次性脚本，用完可删）：确认 vcontinent 的 sunWeight 已压到 0，
// candidates() 在任何太阳高度角下都不会挑出它；同时 wonderById 按 id 手动召唤仍能找到它（不受影响）。
// 用法（仓库根）：node apps/voyage/handoff/PUB-4-b4-check.mjs [端口=5304]
import { chromium } from "playwright-core";
import { launchBrowser, closeBrowserSafely } from "../scripts/lib/chrome.mjs";

const port = process.argv[2] || "5304";
const url = `http://127.0.0.1:${port}/?voyage=0`;
const browser = await launchBrowser(chromium);
try {
  const ctx = await browser.newContext({ viewport: { width: 800, height: 600 } });
  const page = await ctx.newPage();
  await page.goto(url, { waitUntil: "commit", timeout: 60000 });
  await page.waitForFunction(() => window.__voyageStartup, null, { timeout: 60000 });
  const r = await page.evaluate(() => {
    const v = window.__voyage;
    const ctx0 = { lat: 20, lon: 140, heading: 90, seat: "right", altitudeKm: 10, inCloud: 0, coverage: 0.3, flightKey: "test" };
    const out = [];
    for (let sunAlt = -30; sunAlt <= 30; sunAlt += 5) {
      const cands = v.wonders.candidates({ ...ctx0, sunAltDeg: sunAlt });
      out.push({ sunAlt, ids: cands.map((c) => c.def.id) });
    }
    return out;
  });
  console.log(JSON.stringify(r, null, 2));
  await ctx.close();
} finally {
  await closeBrowserSafely(browser);
}
