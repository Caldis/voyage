#!/usr/bin/env node
// TR07：火车模式下声音在主线程上的开销拆分（CabinAudio.update 每帧 / RailAudio.frame / RailSoundscape.update）。
// 用法：node apps/voyage/handoff/TR07-prof.mjs [--port 5277]（需要该端口上有开发服务器）
import { chromium } from "playwright-core";
import { launchBrowser, closeBrowserSafely } from "../scripts/lib/chrome.mjs";

const argv = process.argv.slice(2);
const port = Number(argv.includes("--port") ? argv[argv.indexOf("--port") + 1] : 5277);
const browser = await launchBrowser(chromium, { angle: "d3d11", extraArgs: ["--autoplay-policy=user-gesture-required"] });
try {
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
  await page.goto(`http://127.0.0.1:${port}/`);
  await page.waitForFunction(() => document.getElementById("loading")?.classList.contains("done"), null, { timeout: 240000 });
  await page.click("#sound-on");
  await page.selectOption("#vehicle", "train");
  await page.waitForFunction(() => window.__voyage.rail.active && window.__voyage.audio.railAudio.scape, null, { timeout: 60000 });
  await page.waitForTimeout(2000);
  const r = await page.evaluate(async () => {
    const a = window.__voyage.audio, ra = a.railAudio, sc = ra.scape;
    const wrap = (obj, key) => {
      const orig = obj[key].bind(obj), st = { ms: 0, n: 0, max: 0 };
      obj[key] = (...args) => { const t0 = performance.now(); const out = orig(...args); const d = performance.now() - t0; st.ms += d; st.n++; st.max = Math.max(st.max, d); return out; };
      return st;
    };
    const s1 = wrap(a, "update"), s2 = wrap(ra, "frame"), s3 = wrap(sc, "update"), s4 = wrap(sc, "announceAt");
    await new Promise((res) => setTimeout(res, 10000));
    const f = (s) => ({ calls: s.n, avgUs: +((s.ms / Math.max(s.n, 1)) * 1000).toFixed(1), maxMs: +s.max.toFixed(2), totalMs: +s.ms.toFixed(1) });
    return { cabinUpdate: f(s1), railFrame: f(s2), scapeUpdate: f(s3), announce: f(s4) };
  });
  console.log(JSON.stringify(r, null, 1));
} finally {
  await closeBrowserSafely(browser);
}
