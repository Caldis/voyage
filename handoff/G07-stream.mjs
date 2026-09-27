// G07（改自 G06-stream.mjs，import 改成相对路径，可在任意 worktree 的 apps/voyage 下跑）：
// 连续航程下的请求量 / 帧间隔 / 主线程长任务 / 纹理上传与 generateMipmap 次数 / Worker 耗时 / JS 堆。
// 用法：node handoff/G07-stream.mjs <端口> <流速> <秒数> [预设]；环境变量 G06_Q 附加 URL 参数（如 "&groundres=1024"）
import { chromium } from "playwright-core";
import { launchBrowser } from "../scripts/lib/chrome.mjs";
import { DEFAULTS, applyScene } from "../scripts/scenarios.mjs";

const [port, rateS, secsS, preset = "hnd-cts"] = process.argv.slice(2);
const rate = Number(rateS), secs = Number(secsS);
const browser = await launchBrowser(chromium, {});
const errors = [];
try {
  const ctx = await browser.newContext({ viewport: { width: 1600, height: 1200 } });
  const page = await ctx.newPage();
  page.on("console", (m) => m.type() === "error" && errors.push(m.text().slice(0, 200)));
  page.on("pageerror", (e) => errors.push(String(e).slice(0, 200)));
  // 纹理上传与 mip 生成的 CPU 侧耗时（主线程上调用返回的时间，不含 GPU 异步部分）
  await page.addInitScript(() => {
    const P = WebGL2RenderingContext.prototype;
    const st = (window.__g06up = { sub3d: 0, sub3dMs: 0, sub3dMax: 0, bytes: 0, mip: 0, mipMs: 0, mipMax: 0 });
    const o1 = P.texSubImage3D, o2 = P.generateMipmap;
    P.texSubImage3D = function (...a) {
      const t = performance.now();
      const r = o1.apply(this, a);
      const ms = performance.now() - t;
      // G07：按调用的宽 × 高 × 深算字节（带 srcOffset 的写法最后一个参数是数字）；只计 2D 数组纹理
      if (a[0] === 0x8c1a) { st.sub3d++; st.sub3dMs += ms; st.sub3dMax = Math.max(st.sub3dMax, ms); st.bytes += a[5] * a[6] * a[7] * 4; }
      return r;
    };
    P.generateMipmap = function (...a) {
      const t = performance.now();
      const r = o2.apply(this, a);
      const ms = performance.now() - t;
      if (a[0] === 0x8c1a) { st.mip++; st.mipMs += ms; st.mipMax = Math.max(st.mipMax, ms); } // 只计 2D 数组（地面）的整组 mip
      return r;
    };
    // 主线程上几个可疑调用的耗时（次数 / 总 / 最大，毫秒）
    const prof = (window.__g06prof = {});
    const wrap = (proto, name, label) => {
      const o = proto[name];
      if (!o) return;
      proto[name] = function (...a) {
        const t = performance.now();
        const r = o.apply(this, a);
        const ms = performance.now() - t;
        const p = (prof[label] ??= { n: 0, ms: 0, max: 0 });
        p.n++; p.ms += ms; p.max = Math.max(p.max, ms);
        return r;
      };
    };
    wrap(OffscreenCanvasRenderingContext2D.prototype, "drawImage", "osc.drawImage");
    wrap(CanvasRenderingContext2D.prototype, "drawImage", "cv.drawImage");
    wrap(CanvasRenderingContext2D.prototype, "getImageData", "cv.getImageData");
    wrap(OffscreenCanvas.prototype, "transferToImageBitmap", "transferToImageBitmap");
    wrap(Worker.prototype, "postMessage", "worker.postMessage");
    window.__g06lt = [];
    try { new PerformanceObserver((l) => { for (const e of l.getEntries()) window.__g06lt.push(e.duration); }).observe({ type: "longtask", buffered: true }); } catch {}
  });
  const requests = {};
  let counting = false;
  page.on("request", (r) => { if (counting) { const h = new URL(r.url()).host; requests[h] = (requests[h] ?? 0) + 1; } });
  await page.goto(`http://127.0.0.1:${port}/?g06=${Date.now()}${process.env.G06_Q || ""}`, { waitUntil: "commit", timeout: 180000 });
  await page.bringToFront();
  await page.waitForFunction(() => window.__voyageStartup, null, { timeout: 300000, polling: 500 });
  const t0 = Date.now();
  await page.evaluate(applyScene, { sc: { name: "s", p: { preset, time: 930, coverage: 0.3, "wing-pos": "-4" }, ground: true }, defaults: DEFAULTS, settle: true });
  const settleS = (Date.now() - t0) / 1000;
  await page.evaluate((r) => {
    const box = document.getElementById("voyage-on");
    box.checked = true;
    box.dispatchEvent(new Event("change"));
    window.__voyage.director.rate = r;
    const f = (window.__g06f = []);
    let last = performance.now();
    const q = (window.__g07q = { max: 0, heap: [] }); let n = 0;
    const tick = (t) => { f.push(t - last); last = t; const g = window.__voyage.ground; if (g.uploadQueue) q.max = Math.max(q.max, g.uploadQueue.length); if (++n % 600 === 0 && performance.memory) q.heap.push(Math.round(performance.memory.usedJSHeapSize / 1e6)); requestAnimationFrame(tick); };
    requestAnimationFrame(tick);
    window.__g06lt.length = 0;
    for (const k in window.__g06prof) delete window.__g06prof[k]; Object.assign(window.__g06up, { sub3d: 0, sub3dMs: 0, sub3dMax: 0, bytes: 0, mip: 0, mipMs: 0, mipMax: 0 });
  }, rate);
  counting = true;
  await page.waitForTimeout(secs * 1000);
  counting = false;
  const res = await page.evaluate(() => {
    const f = window.__g06f.slice(5);
    const n = (x) => f.filter((d) => d > x).length;
    const s = [...f].sort((a, b) => b - a);
    const g = window.__voyage.ground.imageryStats;
    return {
      frames: f.length, over16: n(16.7), over33: n(33.4), over50: n(50), over100: n(100), worst: s.slice(0, 6).map((x) => +x.toFixed(1)),
      longtasks: window.__g06lt.length, longtaskMax: Math.max(0, ...window.__g06lt).toFixed(0),
      upload: window.__g06up, worker: g.worker, fine: g.fine, res: g.res, warmup: g.warmup,
      prof: window.__g06prof, queueMax: window.__g07q.max, heapSeries: window.__g07q.heap, heapMB: performance.memory ? +(performance.memory.usedJSHeapSize / 1e6).toFixed(0) : null,
    };
  });
  const perMin = Object.fromEntries(Object.entries(requests).map(([h, c]) => [h, Math.round((c * 60) / secs)]));
  console.log(JSON.stringify({ port, rate, secs, settleS, ...res, requestsPerMin: perMin, errors: errors.length, err0: errors.slice(0, 3) }, null, 1));
} finally {
  await browser.close();
}
