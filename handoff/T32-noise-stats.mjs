#!/usr/bin/env node
// T32：读出启动时生成的云噪声纹理（形状 128³ / 细节 64³），统计各通道和 fbm 组合的均值、标准差
// （方差守恒混合要用均值；结果写进 clouds.glsl.ts 的常量）。用法：node apps/voyage/handoff/T32-noise-stats.mjs --port 5232
import { chromium } from "playwright-core";
import { launchBrowser, closeBrowserSafely } from "../scripts/lib/chrome.mjs";

const port = process.argv.includes("--port") ? process.argv[process.argv.indexOf("--port") + 1] : 5232;
const browser = await launchBrowser(chromium, { angle: "vulkan" });
try {
  const page = await (await browser.newContext({ viewport: { width: 800, height: 600 } })).newPage();
  await page.goto(`http://127.0.0.1:${port}/?dev=${Date.now()}`, { waitUntil: "commit" });
  await page.waitForFunction(() => window.__voyageStartup, null, { timeout: 600000, polling: 500 });
  const r = await page.evaluate(() => {
    const u = window.__voyage.cloudUniforms;
    const stat = (tex, wts) => {
      const d = tex.image.data;
      const n = d.length / 4;
      const out = {};
      const acc = (k, v) => { out[k] ??= [0, 0]; out[k][0] += v; out[k][1] += v * v; };
      for (let i = 0; i < n; i++) {
        const c = [d[4 * i], d[4 * i + 1], d[4 * i + 2], d[4 * i + 3]].map((x) => x / 255);
        c.forEach((v, k) => acc("ch" + k, v));
        for (const [name, w, off] of wts) acc(name, w.reduce((s, wk, k) => s + wk * c[k + off], 0));
      }
      for (const k in out) { const m = out[k][0] / n; out[k] = { mean: +m.toFixed(4), sd: +Math.sqrt(out[k][1] / n - m * m).toFixed(4) }; }
      return out;
    };
    return {
      detail: stat(u.uDetailNoise.value, [["dfbm", [0.625, 0.25, 0.125], 0]]),
      shape: stat(u.uShapeNoise.value, [["fbm", [0.625, 0.25, 0.125], 1]]),
    };
  });
  console.log(JSON.stringify(r, null, 1));
} finally {
  await closeBrowserSafely(browser);
}
