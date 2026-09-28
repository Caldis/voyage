// G08-STITCH：开页面、摆场景、等首载完成，打印影像拼接的诊断（Worker 各阶段、解码命中、各站点请求）与 console error。
// 用法（apps/voyage 下）：node handoff/G08-diag.mjs <端口> [预设=fuji] [时间=720] [额外 URL 参数]
import { chromium } from "playwright-core";
import { launchBrowser } from "../scripts/lib/chrome.mjs";
import { DEFAULTS, applyScene } from "../scripts/scenarios.mjs";

const [port, preset = "fuji", time = "720", query = ""] = process.argv.slice(2);
const browser = await launchBrowser(chromium, {});
try {
  const page = await (await browser.newContext({ viewport: { width: 1600, height: 1200 } })).newPage();
  const errors = [];
  page.on("console", (m) => m.type() === "error" && !/CORS|Failed to load resource|ERR_FAILED/.test(m.text()) && errors.push(m.text().slice(0, 200)));
  page.on("console", (m) => m.type() === "warning" && console.log("[warn]", m.text().slice(0, 200)));
  page.on("pageerror", (e) => errors.push("pageerror " + e.message.slice(0, 200)));
  // G08_BLOCK=0.5：按比例拦掉 EOX 请求（模拟限流），看缺瓦片时的回退；G08_SHOT=路径：结束时截一张
  const block = Number(process.env.G08_BLOCK ?? 0);
  if (block > 0) {
    const re = /tiles\.maps\.eox\.at/;
    await page.route(re, (r) => (Math.random() < block ? r.abort() : r.continue()));
  }
  // G08_NOWORKER=stitch：拼接 Worker 起不来（由合成 Worker 自己拼）；=all：两个都起不来（主线程兜底）。测回退路径用
  const noWorker = process.env.G08_NOWORKER;
  if (noWorker) {
    await page.addInitScript((mode) => {
      const W = window.Worker;
      window.Worker = function (url, opts) {
        if (mode === "all" || String(url).includes("tile-compose")) throw new Error("G08 测试：禁止创建 Worker");
        return new W(url, opts);
      };
    }, noWorker);
  }
  const t0 = Date.now();
  await page.goto(`http://127.0.0.1:${port}/?g08=${Date.now()}${query ? "&" + query : ""}`, { waitUntil: "commit", timeout: 180000 });
  await page.waitForFunction(() => window.__voyageStartup, null, { timeout: 300000, polling: 500 });
  await page.evaluate(applyScene, { sc: { name: "s", p: { preset, time: Number(time) }, ground: true }, defaults: DEFAULTS, settle: true });
  await page.waitForFunction(() => { const w = window.__voyage.ground.imageryStats.warmup; return w.fine >= 0; }, null, { timeout: 180000, polling: 500 }).catch(() => console.log("等 warmup.fine 超时"));
  const s = await page.evaluate(() => {
    const g = window.__voyage.ground;
    const st = g.imageryStats;
    return {
      inWorker: g.imageryInWorker, res: st.res, warmup: st.warmup, pending: g.pending,
      worker: { count: st.worker.count, maxMs: Math.round(st.worker.maxMs), decodedCached: st.worker.decodedCached,
        last: st.worker.recent.slice(-4).map((t) => ({ ms: Math.round(t.ms), read: Math.round(t.readMs), decoded: t.decoded, hits: t.hits, marks: t.marks.map(([n, e]) => `${n}:${Math.round(e)}`).join(" ") })) },
      stitch: st.stitch && { count: st.stitch.count, maxMs: Math.round(st.stitch.maxMs), decodedCached: st.stitch.decodedCached, aa: st.stitch.aa,
        last: st.stitch.recent.slice(-4).map((t) => ({ ms: Math.round(t.ms), decoded: t.decoded, hits: t.hits, marks: t.marks.map(([n, e]) => `${n}:${Math.round(e)}`).join(" ") })) },
      draw: st.draw,
      hosts: Object.fromEntries(Object.entries(st.hosts).map(([h, x]) => [h, { req: x.requests, ok: x.ok, failed: x.failed, thr: x.throttled, miss: x.missing }])),
    };
  });
  if (process.env.G08_SHOT) await page.screenshot({ path: process.env.G08_SHOT });
  console.log(`载入到 warmup 完成 ${((Date.now() - t0) / 1000).toFixed(1)} s`);
  console.log(JSON.stringify(s, null, 1));
  console.log(`console error（不含瓦片跨域）：${errors.length}`, errors.slice(0, 5));
} finally {
  await browser.close();
}
