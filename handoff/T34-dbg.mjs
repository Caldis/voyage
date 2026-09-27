import { chromium } from "playwright-core";
import { DEFAULTS, applyScene, pickScenes } from "../scripts/scenarios.mjs";
import { launchBrowser, closeBrowserSafely } from "../scripts/lib/chrome.mjs";
const [scene, dbg, out] = process.argv.slice(2);
const browser = await launchBrowser(chromium, { angle: "d3d11" });
try {
  const page = await (await browser.newContext({ viewport: { width: 1600, height: 1200 } })).newPage();
  await page.goto(`http://127.0.0.1:5234/?dev=${Date.now()}`, { waitUntil: "commit" });
  await page.waitForFunction(() => window.__voyageStartup, null, { timeout: 300000, polling: 500 });
  const sc = pickScenes([scene])[0];
  await page.evaluate(applyScene, { sc, defaults: DEFAULTS });
  await page.evaluate((d) => {
    window.__voyage.wingDebug.strobe = 0;
    const u = window.__voyage.exposure.adaptMat.uniforms.uDt;
    Object.defineProperty(u, "value", { configurable: true, get: () => 0, set: () => {} });
    window.__voyage.sceneMat.uniforms.uDebug.value = Number(d);
  }, dbg);
  await page.waitForTimeout(300);
  await page.screenshot({ path: out });
} finally {
  await closeBrowserSafely(browser);
}
