// NIGHT-AP-1：空气透视 LUT pass 的 GPU 成本，单路（apMoon=false）对两路（太阳 −10°、月亮 +10°，second = true），ABBA 8 轮
import { chromium } from "playwright-core";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { launchBrowser, closeBrowserSafely } from "../scripts/lib/chrome.mjs";
import { acquireOrWait } from "../scripts/lib/measure-lock.mjs";

const REPO = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const port = process.argv[process.argv.indexOf("--port") + 1] || 5295;
const release = await acquireOrWait(REPO, "NIGHT-AP-1 空气透视 LUT 计时", console.log);
const browser = await launchBrowser(chromium, { angle: "d3d11" });
try {
  const page = await (await browser.newContext({ viewport: { width: 1600, height: 1200 } })).newPage();
  await page.goto(`http://127.0.0.1:${port}/?dev=${Date.now()}&voyage=0`, { waitUntil: "commit", timeout: 180000 });
  await page.waitForFunction(() => window.__voyageStartup, null, { timeout: 300000, polling: 500 });
  await page.bringToFront();
  await page.waitForTimeout(5000);
  const r = await page.evaluate(async () => {
    const v = window.__voyage;
    v.freeze(true);
    const gl = v.clouds.pass.renderer.getContext();
    const ext = gl.getExtension("EXT_disjoint_timer_query_webgl2");
    const A = v.atmosphere;
    const d = (alt, az) => { const a = (alt * Math.PI) / 180, b = (az * Math.PI) / 180; return [Math.cos(a) * Math.sin(b), Math.sin(a), -Math.cos(a) * Math.cos(b)]; };
    const sun = d(-10, 290), moon = d(10, 110);
    const mk = v.sceneMat.uniforms.uMoonIlluminance.value.clone().set(2.8e-4, 2.7e-4, 2.4e-4);
    const time = async (fn, n) => {
      const q = gl.createQuery();
      gl.beginQuery(ext.TIME_ELAPSED_EXT, q);
      for (let i = 0; i < n; i++) fn();
      gl.endQuery(ext.TIME_ELAPSED_EXT);
      while (!gl.getQueryParameter(q, gl.QUERY_RESULT_AVAILABLE)) await new Promise((r) => requestAnimationFrame(r));
      return gl.getQueryParameter(q, gl.QUERY_RESULT) / 1e6 / n;
    };
    const run = (moonOn) => () => { A.apMoon = moonOn; A.updateAerialPerspective(6370.7, sun, 120, moon, mk); };
    const one = [], two = [], one2 = [], st = [];
    await time(run(true), 10); st.push({ ...A.apState });
    for (let k = 0; k < 8; k++) {
      const order = k % 2 ? [[two, true], [one, false], [one2, false]] : [[one, false], [two, true], [one2, false]];
      for (const [arr, on] of order) arr.push(await time(run(on), 40));
    }
    A.apMoon = true;
    const med = (a) => a.slice().sort((x, y) => x - y)[a.length >> 1];
    return { oneMs: med(one), twoMs: med(two), one2Ms: med(one2), st, raw: { one, two, one2 } };
  });
  console.log(JSON.stringify(r));
} finally {
  await closeBrowserSafely(browser);
  release();
}
