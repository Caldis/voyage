// G08-STITCH：1× 下 > 16.7 ms 帧的同页交替 A/B 与归因（由 G07b-spikes.mjs 改来）。
// 做法：hnd-cts 连续航程 1×，同一页面在几种做法之间按窗口交替（ABBA…），每个窗口记录
//   - rAF 帧间隔（> 16.7 ms 记为尖峰）、主线程长任务（PerformanceObserver longtask）；
//   - 合成 Worker（imageryStats.worker.recent）与拼接 Worker（imageryStats.stitch.recent，G08 新增）每次任务的起止与分阶段时刻；
//   - 有上传工作的 drainUploads 调用时刻与耗时。
// 每个尖峰按帧中点归到合成 Worker 的阶段（read = G07b 做法里的 GPU 位图读回 / water / waterRead / detail / night / roads / mips）、
// 同时标出它是否落在拼接 Worker 的某个阶段（eoxDecode / eoxStitch / gsiDecode / gsiStitch）。
// 开跑前等测量锁、跑时持锁（帧间隔测量怕别的代理的编译 / 冷启动），结束释放。
// 用法（apps/voyage 下）：node handoff/G08-spikes.mjs <端口> [每窗口秒=60] [轮数=4] [做法=G07b,G08] [输出 json]
//   做法：G07b（主线程 GPU 画布拼、Worker 读回位图 = G07b 默认）、G08（拼接 Worker 在 CPU 画布上拼 = G08 默认）、
//   G08inRaster（拼接 Worker 停用、由合成 Worker 自己拼，对照用：只能在页面刚载入时选一次，这里不提供）
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright-core";
import { launchBrowser } from "../scripts/lib/chrome.mjs";
import { tryAcquire, waitForRelease } from "../scripts/lib/measure-lock.mjs";
import { DEFAULTS, applyScene } from "../scripts/scenarios.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.join(here, "..", "..", "..");
const [port, winS = "60", roundsS = "4", modesS = "G07b,G08", outJson] = process.argv.slice(2);
const ALL = {
  G07b: { inWorker: false },
  G08: { inWorker: true },
};
const modes = modesS.split(",");
for (const m of modes) if (!ALL[m]) throw new Error(`未知做法 ${m}`);

await waitForRelease(repoRoot, { timeoutMs: 60 * 60 * 1000 });
const release = tryAcquire(repoRoot, `G08-spikes.mjs（G08-STITCH 帧尖峰同页交替，端口 ${port}）`);
if (!release) console.log("[G08] 没抢到测量锁（刚被别人拿走），照常跑，结果注明");
const browser = await launchBrowser(chromium, {});
const windows = [];
try {
  const page = await (await browser.newContext({ viewport: { width: 1600, height: 1200 } })).newPage();
  const errors = [];
  page.on("console", (m) => m.type() === "error" && !/CORS|Failed to load resource|ERR_FAILED/.test(m.text()) && errors.push(m.text().slice(0, 160)));
  page.on("pageerror", (e) => errors.push("pageerror " + e.message.slice(0, 160)));
  await page.goto(`http://127.0.0.1:${port}/?g08=${Date.now()}`, { waitUntil: "commit", timeout: 180000 });
  await page.bringToFront();
  await page.waitForFunction(() => window.__voyageStartup, null, { timeout: 300000, polling: 500 });
  await page.evaluate(applyScene, { sc: { name: "s", p: { preset: "hnd-cts", time: 930, coverage: 0.3, "wing-pos": "-4" }, ground: true }, defaults: DEFAULTS, settle: true });
  await page.waitForFunction(() => { const w = window.__voyage.ground.imageryStats.warmup; return !w || w.fine >= 0; }, null, { timeout: 180000, polling: 500 });
  const info = await page.evaluate(() => {
    const v = window.__voyage;
    const g = v.ground;
    const box = document.getElementById("voyage-on");
    box.checked = true;
    box.dispatchEvent(new Event("change"));
    v.director.rate = 1;
    const st = (window.__g08 = { frames: [], ups: [], long: [] });
    try {
      new PerformanceObserver((l) => { for (const e of l.getEntries()) st.long.push([e.startTime, Math.round(e.duration)]); }).observe({ type: "longtask" });
    } catch {}
    const orig = g.drainUploads.bind(g);
    g.drainUploads = () => {
      if (!g.uploadQueue.length) return orig();
      const t = performance.now();
      orig();
      st.ups.push([t, performance.now() - t]);
    };
    let last = performance.now();
    const tick = (t) => { st.frames.push([last, t]); last = t; requestAnimationFrame(tick); };
    requestAnimationFrame(tick);
    return { tier: v.quality.tier, level: v.quality.level, groundRes: v.quality.groundRes.res, reason: v.quality.groundRes.reason };
  });
  console.log(JSON.stringify(info));
  for (let r = 0; r < Number(roundsS); r++) {
    const order = r % 2 === 0 ? modes : [...modes].reverse();
    for (const name of order) {
      const m = ALL[name];
      await page.evaluate((m) => {
        const g = window.__voyage.ground;
        g.imageryInWorker = m.inWorker;
        const s = window.__g08;
        s.frames.length = 0;
        s.ups.length = 0;
        s.t0 = performance.now();
        s.draw0 = { ...g.imageryStats.draw };
        s.long.length = 0;
      }, m);
      // 两个 Worker 的 recent 都只留 64 次：每 15 s 取一次
      const tasks = [], stitches = [];
      const quarter = (Number(winS) * 1000) / 4;
      for (let k = 0; k < 4; k++) {
        await page.waitForTimeout(quarter);
        const got = await page.evaluate(() => { const st = window.__voyage.ground.imageryStats; return [st.worker.recent, st.stitch?.recent ?? []]; });
        tasks.push(...got[0]);
        stitches.push(...got[1]);
      }
      const w = await page.evaluate(([tasks, stitches]) => {
        const s = window.__g08;
        const uniq = (xs) => { const u = new Map(); for (const t of xs) if (t.start >= s.t0 - 2000) u.set(t.start.toFixed(3), t); return [...u.values()].sort((a, b) => a.start - b.start); };
        const T = uniq(tasks), ST = uniq(stitches);
        const f = s.frames.slice(3);
        const t0 = f[0][0], t1 = f[f.length - 1][1];
        const busyOf = (L) => { let b = 0; for (const t of L) b += Math.max(0, Math.min(t.end, t1) - Math.max(t.start, t0)); return +(b / (t1 - t0)).toFixed(3); };
        const phaseOf = (L, a, b) => {
          const i = L.findIndex((t) => b > t.start && a < t.end + 30);
          const t = i >= 0 ? L[i] : null;
          if (!t) return { phase: "任务外", t: null, i };
          const rel = (a + b) / 2 - t.start;
          return { phase: rel > t.ms ? "结束后" : (t.marks.find(([, e]) => rel <= e)?.[0] ?? "其他"), t, i };
        };
        const spikes = f.filter(([a, b]) => b - a > 16.7).map(([a, b]) => {
          const R = phaseOf(T, a, b), S = phaseOf(ST, a, b);
          const up = s.ups.filter(([u]) => u > a - 50 && u <= b).reduce((x, [, d]) => Math.max(x, d), -1);
          const lt = s.long.filter(([st, d]) => st < b && st + d > a).reduce((x, [, d]) => Math.max(x, d), 0);
          return { ms: +(b - a).toFixed(1), phase: R.phase, stitch: S.phase, sinceStart: R.t ? Math.round(b - R.t.start) : null, readMs: R.t ? Math.round(R.t.readMs) : null, upMs: up >= 0 ? +up.toFixed(2) : null, longTask: lt };
        });
        const med = (xs) => { const v = [...xs].sort((a, b) => a - b); return v.length ? +v[v.length >> 1].toFixed(1) : null; };
        const d = window.__voyage.ground.imageryStats.draw; const dn = d.count - s.draw0.count;
        return {
          frames: f.length, spanS: +((t1 - t0) / 1000).toFixed(1), over16: spikes.length, over25: spikes.filter((x) => x.ms > 25).length,
          tasks: T.length, busyFrac: busyOf(T), stitches: ST.length, stitchBusyFrac: busyOf(ST),
          taskMsMed: med(T.map((t) => t.ms)), readMsMed: med(T.map((t) => t.readMs)), stitchMsMed: med(ST.map((t) => t.ms)),
          upFrames: s.ups.length, spikes,
          longTasks: s.long.map(([, d]) => d),
          draw: { n: dn, avgMs: dn ? +((d.totalMs - s.draw0.totalMs) / dn).toFixed(2) : null },
        };
      }, [tasks, stitches]);
      windows.push({ round: r, mode: name, ...w });
      console.log(JSON.stringify({ round: r, mode: name, ...w, spikes: w.spikes.map((x) => `${x.ms}ms@${x.phase}/${x.stitch}+${x.sinceStart}(read ${x.readMs},up ${x.upMs},lt ${x.longTask})`) }));
    }
  }
  const sum = {};
  for (const w of windows) {
    const S = (sum[w.mode] ??= { windows: 0, frames: 0, spanS: 0, over16: 0, over25: 0, tasks: 0, longTasks: 0, long50: 0, byPhase: {}, byStitch: {} });
    S.windows++; S.frames += w.frames; S.spanS += w.spanS; S.over16 += w.over16; S.over25 += w.over25; S.tasks += w.tasks;
    S.longTasks += w.longTasks.length; S.long50 += w.longTasks.filter((d) => d > 50).length;
    for (const x of w.spikes) { S.byPhase[x.phase] = (S.byPhase[x.phase] ?? 0) + 1; S.byStitch[x.stitch] = (S.byStitch[x.stitch] ?? 0) + 1; }
  }
  for (const [k, S] of Object.entries(sum)) console.log(JSON.stringify({ mode: k, ...S, spanS: +S.spanS.toFixed(0), perMin: +((S.over16 / S.spanS) * 60).toFixed(2) }));
  console.log(`console error（不含瓦片跨域）：${errors.length}`, errors.slice(0, 3));
  if (outJson) fs.writeFileSync(outJson, JSON.stringify({ info, windows, sum, errors: errors.length }, null, 1));
} finally {
  await browser.close();
  release?.();
}
