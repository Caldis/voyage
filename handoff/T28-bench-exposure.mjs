#!/usr/bin/env node
// T28：只测曝光 pass（测光 + 适应 + 最终合成）的 GPU 时间，两个端口交替对照。整帧 bench 在 GPU 被别的代理占满时噪声 ±15%，看不出 0.05 ms 级的差。
// 用法：node handoff/T28-bench-exposure.mjs <端口A> <端口B> [轮数]
import { chromium } from "playwright-core";
import { DEFAULTS, applyScene, pickScenes } from "../scripts/scenarios.mjs";
import { launchBrowser, closeBrowserSafely } from "../scripts/lib/chrome.mjs";

const [pa, pb, roundsArg] = process.argv.slice(2);
const rounds = Number(roundsArg || 7);
const browser = await launchBrowser(chromium, { angle: "d3d11" });
try {
  const pages = {};
  for (const port of [pa, pb]) {
    const ctx = await browser.newContext({ viewport: { width: 1600, height: 1200 }, deviceScaleFactor: 1 });
    const page = await ctx.newPage();
    await page.addInitScript(() => {
      const orig = HTMLCanvasElement.prototype.getContext;
      HTMLCanvasElement.prototype.getContext = function (t, ...r) {
        const c = orig.call(this, t, ...r);
        if (t === "webgl2" && c && !window.__glProbe) window.__glProbe = c;
        return c;
      };
    });
    await page.goto(`http://127.0.0.1:${port}/?b=${Date.now()}`, { waitUntil: "commit", timeout: 180000 });
    await page.waitForFunction(() => window.__voyageStartup, null, { timeout: 300000, polling: 500 });
    await page.evaluate(applyScene, { sc: pickScenes(["noon-cumulus"])[0], defaults: DEFAULTS });
    pages[port] = page;
  }
  const res = { [pa]: [], [pb]: [] };
  for (let r = 0; r < rounds; r++) {
    for (const port of [pa, pb]) {
      const ms = await pages[port].evaluate(async () => {
        const gl = window.__glProbe;
        const ext = gl.getExtension("EXT_disjoint_timer_query_webgl2");
        const ex = window.__voyage.exposure;
        const u = ex.finalMat.uniforms;
        const hdr = u.uHdr.value, bloom = u.uBloom.value;
        const q = gl.createQuery();
        gl.beginQuery(ext.TIME_ELAPSED_EXT, q);
        for (let i = 0; i < 100; i++) ex.render(hdr, bloom, 0.016);
        gl.endQuery(ext.TIME_ELAPSED_EXT);
        while (!gl.getQueryParameter(q, gl.QUERY_RESULT_AVAILABLE)) await new Promise((r) => requestAnimationFrame(r));
        return gl.getQueryParameter(q, gl.QUERY_RESULT) / 1e6 / 100;
      });
      res[port].push(ms);
    }
  }
  for (const port of [pa, pb]) {
    const s = res[port].slice().sort((a, b) => a - b);
    console.log(`${port}: 曝光 pass 中位数 ${s[Math.floor(s.length / 2)].toFixed(4)} ms  全部 ${res[port].map((x) => x.toFixed(4)).join(" ")}`);
  }
} finally {
  await closeBrowserSafely(browser);
}
