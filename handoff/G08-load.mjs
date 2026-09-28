// G08-STITCH：首载时间对照（两个端口交替，每次新开浏览器 = 冷缓存）。记 reset 起到粗版全部就位（warmup.coarse）、
// 全部升级成 fine（warmup.fine）的毫秒数，以及那段时间里的主线程长任务（> 50 ms）与各站点失败数。
// 用法（apps/voyage 下）：node handoff/G08-load.mjs <端口A> <端口B> [轮数=3] [场景=fuji-day,route-hnd-cts]
import { chromium } from "playwright-core";
import { launchBrowser } from "../scripts/lib/chrome.mjs";
import { DEFAULTS, applyScene } from "../scripts/scenarios.mjs";

const [pa, pb, roundsS = "3", scenesS = "fuji-day,route-hnd-cts"] = process.argv.slice(2);
const S = {
  "fuji-day": { preset: "fuji", time: 930, altitude: 6, coverage: 0.05, "wing-pos": "-4" },
  "route-hnd-cts": { preset: "hnd-cts", time: 990, coverage: 0.05, "wing-pos": "8" },
};
const rows = [];
for (let r = 0; r < Number(roundsS); r++) {
  for (const name of scenesS.split(",")) {
    for (const port of r % 2 === 0 ? [pa, pb] : [pb, pa]) {
      const browser = await launchBrowser(chromium, {});
      try {
        const page = await (await browser.newContext({ viewport: { width: 1600, height: 1200 } })).newPage();
        await page.addInitScript(() => {
          window.__g08long = [];
          try {
            new PerformanceObserver((l) => { for (const e of l.getEntries()) window.__g08long.push(Math.round(e.duration)); }).observe({ type: "longtask", buffered: true });
          } catch {}
        });
        await page.goto(`http://127.0.0.1:${port}/?g08load=${Date.now()}`, { waitUntil: "commit", timeout: 180000 });
        await page.bringToFront();
        await page.waitForFunction(() => window.__voyageStartup, null, { timeout: 300000, polling: 250 });
        await page.evaluate(applyScene, { sc: { name, p: S[name], ground: true }, defaults: DEFAULTS, settle: false });
        // 长任务从页面载入起算（含着色器编译，两边相同），比的是差值
        const ok = await page.waitForFunction(() => window.__voyage.ground.imageryStats.warmup.fine >= 0, null, { timeout: 240000, polling: 250 }).then(() => true, () => false);
        const s = await page.evaluate(() => {
          const st = window.__voyage.ground.imageryStats;
          return { warmup: st.warmup, long: window.__g08long.slice(), failed: Object.fromEntries(Object.entries(st.hosts).map(([h, x]) => [h.split(".")[1] ?? h, x.failed])) };
        });
        const row = { round: r, scene: name, port, ok, coarse: Math.round(s.warmup.coarse), fine: Math.round(s.warmup.fine), long50: s.long.filter((x) => x > 50).length, longMax: Math.max(0, ...s.long), failed: s.failed };
        rows.push(row);
        console.log(JSON.stringify(row));
      } finally {
        await browser.close();
      }
    }
  }
}
const med = (xs) => { const v = [...xs].sort((a, b) => a - b); return v.length ? v[v.length >> 1] : null; };
for (const name of scenesS.split(","))
  for (const port of [pa, pb]) {
    const R = rows.filter((x) => x.scene === name && x.port === port && x.ok);
    console.log(`${name} 端口 ${port}：粗版就位中位 ${med(R.map((x) => x.coarse))} ms（${R.map((x) => x.coarse).join(" / ")}），全部 fine 中位 ${med(R.map((x) => x.fine))} ms（${R.map((x) => x.fine).join(" / ")}），>50 ms 长任务 ${R.map((x) => x.long50).join(" / ")}`);
  }
