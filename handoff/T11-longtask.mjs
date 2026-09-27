// T11：量首次启用声音时合成缓冲造成的主线程长任务（需要 5211 上有服务）。用法：node apps/voyage/handoff/T11-longtask.mjs
import { chromium } from "playwright-core";
import { launchBrowser, closeBrowserSafely } from "../scripts/lib/chrome.mjs";
const browser = await launchBrowser(chromium, { angle: "d3d11" });
const page = await browser.newPage();
await page.goto("http://127.0.0.1:5211/src/audio.ts");
const r = await page.evaluate(async () => {
  const m = await import("/src/audio.ts");
  const tasks = [];
  const ob = new PerformanceObserver((l) => l.getEntries().forEach((e) => tasks.push(Math.round(e.duration))));
  ob.observe({ type: "longtask" });
  const ctx = new OfflineAudioContext(2, 44100, 44100);
  const t0 = performance.now();
  await new m.Soundscape(ctx, undefined, 5).build();
  const total = performance.now() - t0;
  await new Promise((r) => setTimeout(r, 200));
  ob.disconnect();
  return { totalMs: Math.round(total), longTasksMs: tasks };
});
console.log(r);
await closeBrowserSafely(browser);
