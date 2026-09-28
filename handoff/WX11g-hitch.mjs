// WX11g：海面换档时主线程有没有长帧。页面照常飞（1× 巡航，不冻结），按下面两段强制改风速，
// 同时在页内记录：每次 ocean.update 的耗时、每个 rAF 的帧间隔、longtask（> 50 ms）、ocean.stats。
//   ① 跳档：每 1.5 s 换一个风速（0 → 22 → 0，每档都要新算频谱，缓存从冷开始）；
//   ② 连续扫：风速按 1 m/s / 真实秒从 0 扫到 20 再扫回来（跨档靠预取）。
// 用法：node apps/voyage/handoff/WX11g-hitch.mjs --port 5245 [--port2 5305] [--scene low-sea-glint]
// 改前（master）的 ocean.update 风速一变就在主线程同步重算频谱，可以拿 --port2 对照。
import { chromium } from "playwright-core";
import { DEFAULTS, SCENES, applyScene } from "../scripts/scenarios.mjs";
import { launchBrowser, closeBrowserSafely } from "../scripts/lib/chrome.mjs";

const arg = (k, d) => {
  const i = process.argv.indexOf(k);
  return i > 0 ? process.argv[i + 1] : d;
};
const ports = [arg("--port", "5245"), arg("--port2", null)].filter(Boolean);
const sceneName = arg("--scene", "low-sea-glint");
const sc = SCENES.find((s) => s.name === sceneName);

async function run(port) {
  const browser = await launchBrowser(chromium);
  try {
    const page = await browser.newPage({ viewport: { width: 1600, height: 1200 } });
    const errors = [];
    page.on("console", (m) => m.type() === "error" && errors.push(m.text()));
    page.on("pageerror", (e) => errors.push(String(e)));
    await page.goto(`http://127.0.0.1:${port}/?quality=high`);
    await page.waitForFunction(() => window.__voyageStartup && window.__voyage && window.__voyage.ocean, null, { timeout: 300000 });
    await page.waitForTimeout(3000);
    await page.evaluate(applyScene, { sc, defaults: DEFAULTS });
    await page.bringToFront();
    const res = await page.evaluate(async () => {
      const v = window.__voyage;
      v.state.playRate = 1; // 1× 巡航
      const upd = v.ocean.update.bind(v.ocean);
      const rec = { upd: [], frames: [], long: [] };
      let phase = "idle";
      v.ocean.update = (...a) => {
        const t0 = performance.now();
        upd(...a);
        const ms = performance.now() - t0;
        rec.upd.push([phase, ms]);
      };
      const obs = new PerformanceObserver((l) => l.getEntries().forEach((e) => rec.long.push([phase, Math.round(e.duration)])));
      try {
        obs.observe({ type: "longtask", buffered: false });
      } catch {}
      let last = performance.now();
      let on = true;
      const loop = (t) => {
        rec.frames.push([phase, t - last]);
        last = t;
        if (on) requestAnimationFrame(loop);
      };
      requestAnimationFrame(loop);
      const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
      phase = "idle";
      await sleep(3000);
      phase = "jump";
      for (const w of [0, 1.5, 3, 5, 7, 10, 13.5, 17.5, 22, 17.5, 13.5, 10, 7, 5, 3, 1.5, 0]) {
        v.state.wind = w;
        await sleep(1500);
      }
      phase = "sweep";
      const t0 = performance.now();
      await new Promise((r) => {
        const step = () => {
          const s = (performance.now() - t0) / 1000;
          v.state.wind = s < 20 ? s : Math.max(0, 40 - s);
          if (s < 40) requestAnimationFrame(step);
          else r();
        };
        requestAnimationFrame(step);
      });
      phase = "end";
      await sleep(500);
      on = false;
      obs.disconnect();
      v.ocean.update = upd;
      const st = v.ocean.stats ?? {};
      const summ = (ph) => {
        const u = rec.upd.filter((x) => x[0] === ph).map((x) => x[1]).sort((a, b) => a - b);
        const f = rec.frames.filter((x) => x[0] === ph).map((x) => x[1]).sort((a, b) => a - b);
        const q = (a, p) => (a.length ? +a[Math.min(a.length - 1, Math.floor(p * a.length))].toFixed(2) : null);
        return {
          frames: f.length,
          frameMed: q(f, 0.5),
          frameP99: q(f, 0.99),
          frameMax: q(f, 1),
          over16_7: f.filter((x) => x > 16.7).length,
          over33: f.filter((x) => x > 33.4).length,
          oceanUpdMed: q(u, 0.5),
          oceanUpdP99: q(u, 0.99),
          oceanUpdMax: q(u, 1),
          oceanUpdOver5: u.filter((x) => x > 5).length,
          longtasks: rec.long.filter((x) => x[0] === ph).map((x) => x[1]),
        };
      };
      return { idle: summ("idle"), jump: summ("jump"), sweep: summ("sweep"), stats: JSON.parse(JSON.stringify(st)) };
    });
    return { port, res, errors };
  } finally {
    await closeBrowserSafely(browser);
  }
}

for (const p of ports) {
  const r = await run(p);
  console.log(`\n=== 端口 ${r.port}（${sceneName}）===`);
  for (const ph of ["idle", "jump", "sweep"]) console.log(ph.padEnd(6), JSON.stringify(r.res[ph]));
  console.log("ocean.stats", JSON.stringify(r.res.stats));
  console.log(`console error ${r.errors.length} 条`, r.errors.slice(0, 3));
}
