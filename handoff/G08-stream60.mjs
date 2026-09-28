// G08-STITCH：加速航程（默认 60×）下有没有积压。hnd-cts 连续航程，同一页面按窗口交替 G07b / G08 做法，
// 每 2 s 采一次：两个 Worker 的在途任务数（imageryStats.worker.queued / stitch.queued）、在建级别数、上传队列长度、在途瓦片数；
// 窗口末尾给出最大值、Worker 忙碌比例、> 16.7 / > 50 ms 帧与主线程长任务。积压 = 在途任务数一路涨、不回落。
// 用法（apps/voyage 下）：node handoff/G08-stream60.mjs <端口> [流速=60] [每窗口秒=60] [轮数=2]
import { chromium } from "playwright-core";
import { launchBrowser } from "../scripts/lib/chrome.mjs";
import { DEFAULTS, applyScene } from "../scripts/scenarios.mjs";

const [port, rateS = "60", winS = "60", roundsS = "2"] = process.argv.slice(2);
const browser = await launchBrowser(chromium, {});
try {
  const page = await (await browser.newContext({ viewport: { width: 1600, height: 1200 } })).newPage();
  const errors = [];
  page.on("console", (m) => m.type() === "error" && !/CORS|Failed to load resource|ERR_FAILED/.test(m.text()) && errors.push(m.text().slice(0, 160)));
  page.on("pageerror", (e) => errors.push("pageerror " + e.message.slice(0, 160)));
  await page.goto(`http://127.0.0.1:${port}/?g08s=${Date.now()}`, { waitUntil: "commit", timeout: 180000 });
  await page.bringToFront();
  await page.waitForFunction(() => window.__voyageStartup, null, { timeout: 300000, polling: 500 });
  await page.evaluate(applyScene, { sc: { name: "s", p: { preset: "hnd-cts", time: 930, coverage: 0.3, "wing-pos": "-4" }, ground: true }, defaults: DEFAULTS, settle: true });
  await page.waitForFunction(() => window.__voyage.ground.imageryStats.warmup.fine >= 0, null, { timeout: 180000, polling: 500 });
  await page.evaluate((rate) => {
    const v = window.__voyage;
    const box = document.getElementById("voyage-on");
    box.checked = true;
    box.dispatchEvent(new Event("change"));
    v.director.rate = rate;
    const st = (window.__g08s = { frames: [], long: [] });
    try { new PerformanceObserver((l) => { for (const e of l.getEntries()) st.long.push(Math.round(e.duration)); }).observe({ type: "longtask" }); } catch {}
    let last = performance.now();
    const tick = (t) => { st.frames.push(t - last); last = t; requestAnimationFrame(tick); };
    requestAnimationFrame(tick);
  }, Number(rateS));
  for (let r = 0; r < Number(roundsS); r++) {
    for (const mode of r % 2 === 0 ? ["G07b", "G08"] : ["G08", "G07b"]) {
      await page.evaluate((inW) => {
        const g = window.__voyage.ground;
        g.imageryInWorker = inW;
        const s = window.__g08s;
        s.frames.length = 0; s.long.length = 0;
        const st = g.imageryStats;
        s.w0 = { n: st.worker.count, ms: st.worker.totalMs, sn: st.stitch.count, sms: st.stitch.totalMs, t: performance.now() };
      }, mode === "G08");
      const samples = [];
      const n = Math.round(Number(winS) / 2);
      for (let k = 0; k < n; k++) {
        await page.waitForTimeout(2000);
        samples.push(await page.evaluate(() => {
          const g = window.__voyage.ground;
          const st = g.imageryStats;
          return { wq: st.worker.queued, sq: st.stitch.queued, building: g.levels.filter((l) => l.building).length, upq: g.uploadQueue.length, pending: g.pending };
        }));
      }
      const w = await page.evaluate(() => {
        const g = window.__voyage.ground;
        const st = g.imageryStats;
        const s = window.__g08s;
        const span = performance.now() - s.w0.t;
        return {
          frames: s.frames.length, over16: s.frames.filter((d) => d > 16.7).length, over50: s.frames.filter((d) => d > 50).length,
          long: s.long.length, long50: s.long.filter((d) => d > 50).length, longMax: Math.max(0, ...s.long),
          rasterTasks: st.worker.count - s.w0.n, rasterBusy: +((st.worker.totalMs - s.w0.ms) / span).toFixed(3),
          stitchTasks: st.stitch.count - s.w0.sn, stitchBusy: +((st.stitch.totalMs - s.w0.sms) / span).toFixed(3),
          minLevel: g.minLevel,
        };
      });
      const mx = (k) => Math.max(...samples.map((x) => x[k]));
      const last = samples.slice(-3).map((x) => `${x.wq}/${x.sq}`).join(" ");
      console.log(JSON.stringify({ round: r, mode, ...w, maxWorkerQueued: mx("wq"), maxStitchQueued: mx("sq"), maxBuilding: mx("building"), maxUploadQ: mx("upq"), maxPending: mx("pending"), last3: last }));
    }
  }
  console.log(`console error（不含瓦片跨域）：${errors.length}`, errors.slice(0, 3));
} finally {
  await browser.close();
}
