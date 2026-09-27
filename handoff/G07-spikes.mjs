// G07：同页交替 A/B，量「上传那一帧」的帧间隔尖峰：G06 做法（gpuMips = true：第 0 级 + 整个数组 generateMipmap）
// 与 G07 做法（Worker 算这一层的 mip、按级上传）各跑若干个窗口交替进行，抵消其他代理占 GPU 造成的时段差异。
// 帧间隔 > 16.7 ms 的帧里，区分「这一帧里有地面纹理上传」和「没有」——前者才是本任务要消掉的。
// 用法（apps/voyage 下）：node handoff/G07-spikes.mjs <端口> [每窗口秒数=30] [窗口对数=2] [流速=1] [预设=hnd-cts] [额外 URL 参数]
import { chromium } from "playwright-core";
import { launchBrowser } from "../scripts/lib/chrome.mjs";
import { DEFAULTS, applyScene } from "../scripts/scenarios.mjs";

const [port, winS = "30", pairsS = "2", rateS = "1", preset = "hnd-cts", extraQ = ""] = process.argv.slice(2);
const browser = await launchBrowser(chromium, {});
try {
  const page = await (await browser.newContext({ viewport: { width: 1600, height: 1200 } })).newPage();
  const errors = [];
  page.on("console", (m) => m.type() === "error" && errors.push(m.text().slice(0, 160)));
  await page.goto(`http://127.0.0.1:${port}/?g07=${Date.now()}${extraQ}`, { waitUntil: "commit", timeout: 180000 });
  await page.bringToFront();
  await page.waitForFunction(() => window.__voyageStartup, null, { timeout: 300000, polling: 500 });
  await page.evaluate(applyScene, { sc: { name: "s", p: { preset, time: 930, coverage: 0.3, "wing-pos": "-4" }, ground: true }, defaults: DEFAULTS, settle: true });
  // 等首载升级完
  await page.waitForFunction(() => { const w = window.__voyage.ground.imageryStats.warmup; return !w || w.fine >= 0; }, null, { timeout: 120000, polling: 500 });
  await page.evaluate((r) => {
    const v = window.__voyage;
    const g = v.ground;
    const box = document.getElementById("voyage-on");
    box.checked = true;
    box.dispatchEvent(new Event("change"));
    v.director.rate = r;
    const st = (window.__g07 = { ups: [], upMs: [], frames: [], commits: [] });
    // 每帧的上传推进（drainUploads）：队列非空的那一帧记下时刻与主线程耗时（含暂存写入 / 最后一帧的拷贝 + 换中心）
    const orig = g.drainUploads.bind(g);
    g.drainUploads = () => { if (!g.uploadQueue.length) return orig(); const n0 = g.uploadQueue.length; const t = performance.now(); orig(); st.ups.push(t); st.upMs.push(performance.now() - t); if (g.uploadQueue.length < n0) st.commits.push([t, performance.now() - t]); };
    let last = performance.now();
    const tick = (t) => { st.frames.push([last, t]); last = t; requestAnimationFrame(tick); };
    requestAnimationFrame(tick);
  }, Number(rateS));
  const windows = [];
  for (let p = 0; p < Number(pairsS); p++) {
    for (const gpuMips of p % 2 === 0 ? [true, false] : [false, true]) {
      // G06 做法 = 整组 generateMipmap + 每帧直传一张（PERF-8）；G07 = Worker mip + 暂存缓冲原子换上
      await page.evaluate((m) => { const s = window.__g07; const g = window.__voyage.ground; g.gpuMips = m; g.stagedUpload = !m; s.ups.length = 0; s.upMs.length = 0; s.frames.length = 0; s.commits.length = 0; }, gpuMips);
      await page.waitForTimeout(Number(winS) * 1000);
      windows.push(
        await page.evaluate((m) => {
          const s = window.__g07;
          const f = s.frames.slice(3);
          const withUp = (a, b) => s.ups.some((u) => u > a && u <= b);
          const spikes = f.filter(([a, b]) => b - a > 16.7);
          const upFrames = f.filter(([a, b]) => withUp(a, b));
          const sorted = [...s.upMs].sort((x, y) => x - y);
          return {
            mode: m ? "G06 整组 generateMipmap + 每帧直传一张" : "G07 按层 mip + 暂存原子换上",
            frames: f.length,
            over16: spikes.length,
            over16WithUpload: spikes.filter(([a, b]) => withUp(a, b)).length,
            // 尖峰帧之前 50 ms 内有上传（GPU 侧的活可能拖到后一两帧才显出来）
            over16Near: spikes.filter(([a, b]) => withUp(a - 50, b)).length,
            over33: f.filter(([a, b]) => b - a > 33.4).length,
            uploads: s.ups.length,
            uploadFrameIntervalMax: +Math.max(0, ...upFrames.map(([a, b]) => b - a)).toFixed(1),
            uploadFrameIntervalMed: upFrames.length ? +[...upFrames.map(([a, b]) => b - a)].sort((x, y) => x - y)[upFrames.length >> 1].toFixed(1) : null,
            uploadCallMsMed: sorted.length ? +sorted[sorted.length >> 1].toFixed(2) : null,
            uploadCallMsMax: sorted.length ? +sorted[sorted.length - 1].toFixed(2) : null,
            // 换上新一版的那一帧（一批传完、换中心）：主线程耗时与帧间隔
            commits: s.commits.length,
            commitCallMsMax: +Math.max(0, ...s.commits.map((c) => c[1])).toFixed(2),
            commitFrameIntervals: s.commits.map(([t]) => { const fr = f.find(([a, b]) => t > a && t <= b); return fr ? +(fr[1] - fr[0]).toFixed(1) : null; }).sort((x, y) => y - x).slice(0, 5),
          };
        }, gpuMips),
      );
    }
  }
  for (const w of windows) console.log(JSON.stringify(w));
  console.log("console error:", errors.length);
} finally {
  await browser.close();
}
