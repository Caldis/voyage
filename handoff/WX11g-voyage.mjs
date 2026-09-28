// WX11g：连续航程里海面风速是否按天气场走。
//   ① 各地各月换预设（jump）后：导演的目标海面风 seaWindGoal、state.wind、海面实际用的风速与白浪覆盖率；
//   ② 东海 1 月 60× 连续航程 60 真实秒：每秒记一次风速，统计跨档次数、频谱计算次数、等频谱的帧数、ocean.update 最大耗时、> 16.7 ms 的帧。
// 用法：node apps/voyage/handoff/WX11g-voyage.mjs --port 5245
import { chromium } from "playwright-core";
import { DEFAULTS, applyScene } from "../scripts/scenarios.mjs";
import { launchBrowser, closeBrowserSafely } from "../scripts/lib/chrome.mjs";

const port = process.argv.includes("--port") ? process.argv[process.argv.indexOf("--port") + 1] : "5245";
const browser = await launchBrowser(chromium);
try {
  const page = await browser.newPage({ viewport: { width: 1600, height: 1200 } });
  const errors = [];
  page.on("console", (m) => m.type() === "error" && errors.push(m.text()));
  page.on("pageerror", (e) => errors.push(String(e)));
  await page.goto(`http://127.0.0.1:${port}/?quality=high`);
  await page.waitForFunction(() => window.__voyageStartup && window.__voyage && window.__voyage.ocean, null, { timeout: 300000 });
  await page.waitForTimeout(3000);
  const cases = [
    ["ecs", "2026-01-16"],
    ["wpac", "2026-01-16"],
    ["wpac", "2026-07-16"],
    ["scs", "2026-05-15"],
    ["fuji", "2026-01-16"],
  ];
  for (const [preset, date] of cases) {
    const sc = { name: `${preset}-${date}`, p: { preset, date, time: 720 }, continuousJourney: true, wait: 1500 };
    await page.evaluate(applyScene, { sc, defaults: DEFAULTS });
    const r = await page.evaluate(async () => {
      const v = window.__voyage;
      for (let i = 0; i < 200 && v.ocean.stats.wind !== v.state.wind; i++) await new Promise((res) => requestAnimationFrame(res));
      const wd = v.director.weather;
      return { goal: wd.seaWindGoal, stateWind: v.state.wind, ocean: v.ocean.stats.wind, level: v.ocean.stats.level, coverage: v.ocean.stats.coverage, hs: v.ocean.stats.hs, info: wd.describe() };
    });
    console.log(`${preset} ${date}: 目标 ${r.goal?.toFixed(2)} m/s、state.wind ${r.stateWind?.toFixed(2)}、海面 ${r.ocean?.toFixed(2)}（档 ${JSON.stringify(r.level)}）、白浪覆盖率 ${(r.coverage * 100).toFixed(2)}%、Hs ${r.hs.toFixed(2)} m｜${r.info}`);
  }
  // ② 东海 1 月，60× 连续航程
  await page.evaluate(applyScene, { sc: { name: "ecs-60x", p: { preset: "ecs", date: "2026-01-16", time: 600 }, continuousJourney: true, playRate: 60, wait: 1500 }, defaults: DEFAULTS });
  await page.bringToFront();
  const res = await page.evaluate(async () => {
    const v = window.__voyage;
    v.director.rate = 60; // 连续航程的流速由导演管（state.playRate 只管不开连续航程时的时间流速）
    const upd = v.ocean.update.bind(v.ocean);
    let updMax = 0, updOver5 = 0;
    v.ocean.update = (...a) => {
      const t0 = performance.now();
      upd(...a);
      const ms = performance.now() - t0;
      updMax = Math.max(updMax, ms);
      if (ms > 5) updOver5++;
    };
    const b0 = v.ocean.stats.builds, h0 = v.ocean.stats.holds;
    const lvl0 = JSON.stringify(v.ocean.stats.level.slice(0, 2));
    let crossings = 0, lastLvl = lvl0;
    let last = performance.now(), over = 0, frames = 0, fmax = 0;
    const samples = [];
    let on = true;
    const loop = (t) => {
      const dt = t - last;
      last = t;
      frames++;
      fmax = Math.max(fmax, dt);
      if (dt > 16.7) over++;
      const l = JSON.stringify(v.ocean.stats.level.slice(0, 2));
      if (l !== lastLvl) (crossings++, (lastLvl = l));
      if (on) requestAnimationFrame(loop);
    };
    requestAnimationFrame(loop);
    const tSim0 = v.state.simTime;
    for (let s = 0; s < 60; s++) {
      await new Promise((r) => setTimeout(r, 1000));
      samples.push(+v.state.wind.toFixed(2));
    }
    on = false;
    v.ocean.update = upd;
    return { simHours: +((v.state.simTime - tSim0) / 3.6e6).toFixed(2), goal: v.director.weather.seaWindGoal, samples, crossings, builds: v.ocean.stats.builds - b0, holds: v.ocean.stats.holds - h0, updMax: +updMax.toFixed(2), updOver5, frames, over16_7: over, frameMax: +fmax.toFixed(1), info: v.director.weather.describe() };
  });
  console.log(`\n东海 1 月 60×（${res.simHours} 模拟小时）：风速 ${res.samples[0]} → ${res.samples.at(-1)}（最后目标 ${res.goal?.toFixed(2)}），跨档 ${res.crossings} 次，频谱计算 ${res.builds} 档，等频谱 ${res.holds} 帧，ocean.update 最大 ${res.updMax} ms（> 5 ms ${res.updOver5} 次），帧 ${res.frames}、> 16.7 ms ${res.over16_7}、最大 ${res.frameMax} ms`);
  console.log("每秒风速", res.samples.join(" "));
  console.log(res.info);
  console.log(`console error ${errors.length} 条`, errors.slice(0, 3));
} finally {
  await closeBrowserSafely(browser);
}
