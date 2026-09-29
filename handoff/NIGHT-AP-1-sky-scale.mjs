// NIGHT-AP-1：实测「地平线天光系数」——天空视图 LUT 地平线上第一行、所有方位的亮度均值 vs 光源高度角
// 用法：node apps/voyage/handoff/NIGHT-AP-1-sky-scale.mjs --port 5295
import { chromium } from "playwright-core";
import { launchBrowser, closeBrowserSafely } from "../scripts/lib/chrome.mjs";

const port = process.argv[process.argv.indexOf("--port") + 1] || 5295;
const browser = await launchBrowser(chromium, { angle: "d3d11" });
try {
  const page = await (await browser.newContext({ viewport: { width: 800, height: 600 } })).newPage();
  await page.goto(`http://127.0.0.1:${port}/?dev=${Date.now()}&voyage=0`, { waitUntil: "commit", timeout: 180000 });
  await page.waitForFunction(() => window.__voyageStartup, null, { timeout: 300000, polling: 500 });
  const r = await page.evaluate(() => {
    const v = window.__voyage;
    v.freeze(true);
    const A = v.atmosphere, pass = A.pass, rr = pass.renderer;
    const W = 192, H = 108, row = Math.floor(0.5 * (H - 1));
    const buf = new Float32Array(W * 4);
    const out = {};
    const elevs = [];
    for (let e = -30; e <= -2; e += 1) elevs.push(e);
    for (const e of [0, 2, 5, 10, 20, 30, 45, 60, 90]) elevs.push(e);
    for (const alt of [0.3, 3, 10.7, 13]) {
      const camR = 6360 + alt;
      const row_ = [];
      for (const e of elevs) {
        const m = A.skyViewMaterial;
        m.uniforms.uCamR.value = camR;
        m.uniforms.uSunCosZenith.value = Math.sin((e * Math.PI) / 180);
        pass.render(m, A.skyView);
        rr.readRenderTargetPixels(A.skyView, 0, row, W, 1, buf);
        let s = 0;
        for (let i = 0; i < W; i++) s += 0.2126 * buf[4 * i] + 0.7152 * buf[4 * i + 1] + 0.0722 * buf[4 * i + 2];
        row_.push(+Math.log10(Math.max(s / W, 1e-40)).toFixed(2));
      }
      out[alt] = row_;
    }
    return { elevs, out, float32: A.float32 };
  });
  console.log(JSON.stringify(r));
} finally {
  await closeBrowserSafely(browser);
}
