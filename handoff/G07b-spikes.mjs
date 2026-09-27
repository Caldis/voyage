// G07b：1× 下 > 16.7 ms 帧的同页交替 A/B 与归因（G07 审查 M1）。
// 做法：hnd-cts 连续航程 1×，同一页面在几种做法之间按窗口交替（ABBA…），每个窗口记录
//   - rAF 帧间隔（> 16.7 ms 记为尖峰）；
//   - Worker 每次任务的精确起止与分阶段时刻（imageryStats.worker.recent，G07b 新增：start / end / readMs / mipMs / marks，主线程时间轴）；
//   - 有上传工作的 drainUploads 调用时刻与耗时。
// 每个尖峰按帧中点归到某次 Worker 任务的阶段（read 位图读回 / water 水体栅格化 / waterRead 水体 getImageData / detail / night / roads / mips）、结束后 30 ms 内或任务外；
// 同时记它离该任务开始多少 ms、这个任务开始前 Worker 空了多久（背靠背任务 = 上一级结果正在暂存上传）、尖峰帧附近有没有上传。
// 开跑前等测量锁、跑时持锁（帧间隔测量怕别的代理的编译 / 冷启动），结束释放。
// 用法（apps/voyage 下）：node handoff/G07b-spikes.mjs <端口> [每窗口秒=60] [轮数=4] [做法=G07,G07b] [输出 json]
//   做法可选（前四种水体画布都是 GPU 的旧做法）：G06（GPU 整组 mip + 每帧一张）、G07（Worker mip 每级新分配 + 暂存）、
//   G07b（Worker mip 复用缓冲 + 暂存）、noMip（GPU 整组 mip + 暂存）、cpuWater（G07b + 水体画布 CPU 栅格 = G07b 最终默认）、cpuBoth（再加主线程拼影像 / 细节瓦片的画布也走 CPU 栅格）
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright-core";
import { launchBrowser } from "../scripts/lib/chrome.mjs";
import { tryAcquire, waitForRelease } from "../scripts/lib/measure-lock.mjs";
import { DEFAULTS, applyScene } from "../scripts/scenarios.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.join(here, "..", "..", "..");
const [port, winS = "60", roundsS = "4", modesS = "G07,G07b", outJson] = process.argv.slice(2);
const ALL = {
  G06: { gpuMips: true, staged: false, reuse: true, waterCpu: false },
  G07: { gpuMips: false, staged: true, reuse: false, waterCpu: false },
  G07b: { gpuMips: false, staged: true, reuse: true, waterCpu: false },
  noMip: { gpuMips: true, staged: true, reuse: true, waterCpu: false },
  cpuWater: { gpuMips: false, staged: true, reuse: true, waterCpu: true },
  cpuBoth: { gpuMips: false, staged: true, reuse: true, waterCpu: true, imageryCpu: true },
};
const modes = modesS.split(",");
for (const m of modes) if (!ALL[m]) throw new Error(`未知做法 ${m}`);

await waitForRelease(repoRoot, { timeoutMs: 30 * 60 * 1000 });
const release = tryAcquire(repoRoot, `G07b-spikes.mjs（G07b 帧尖峰同页交替，端口 ${port}）`);
if (!release) console.log("[G07b] 没抢到测量锁（刚被别人拿走），照常跑，结果注明");
const browser = await launchBrowser(chromium, {});
const windows = [];
try {
  const page = await (await browser.newContext({ viewport: { width: 1600, height: 1200 } })).newPage();
  const errors = [];
  page.on("console", (m) => m.type() === "error" && errors.push(m.text().slice(0, 120)));
  await page.goto(`http://127.0.0.1:${port}/?g07b=${Date.now()}`, { waitUntil: "commit", timeout: 180000 });
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
    const st = (window.__g07b = { frames: [], ups: [], long: [] });
    try {
      new PerformanceObserver((l) => { for (const e of l.getEntries()) st.long.push(Math.round(e.duration)); }).observe({ type: "longtask" });
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
        g.gpuMips = m.gpuMips;
        g.stagedUpload = m.staged;
        g.mipScratchReuse = m.reuse;
        g.waterCanvasCpu = !!m.waterCpu;
        g.imageryCanvasCpu = !!m.imageryCpu;
        const s = window.__g07b;
        s.frames.length = 0;
        s.ups.length = 0;
        s.t0 = performance.now();
        s.draw0 = { ...g.imageryStats.draw };
        s.long.length = 0;
      }, m);
      // Worker 的 recent 只留 64 次，60 s 约 90–130 次：分两次取
      const tasks = [];
      const half = (Number(winS) * 1000) / 2;
      for (let k = 0; k < 2; k++) {
        await page.waitForTimeout(half);
        tasks.push(...(await page.evaluate(() => window.__voyage.ground.imageryStats.worker.recent)));
      }
      const w = await page.evaluate((tasks) => {
        const s = window.__g07b;
        const uniq = new Map();
        for (const t of tasks) if (t.start >= s.t0 - 2000) uniq.set(t.start.toFixed(3), t);
        const T = [...uniq.values()].sort((a, b) => a.start - b.start);
        const f = s.frames.slice(3);
        const t0 = f[0][0], t1 = f[f.length - 1][1];
        let busy = 0;
        for (const t of T) busy += Math.max(0, Math.min(t.end, t1) - Math.max(t.start, t0));
        const spikes = f.filter(([a, b]) => b - a > 16.7).map(([a, b]) => {
          // 尖峰帧 [a, b]：找和它重叠的任务（任务结束后再放宽 30 ms：转移回主线程）
          const i = T.findIndex((t) => b > t.start && a < t.end + 30);
          const t = i >= 0 ? T[i] : null;
          let phase = "任务外";
          if (t) {
            // 尖峰帧的中点落在哪个阶段（marks 是各阶段的结束时刻）；帧很长时中点只是近似
            const rel = (a + b) / 2 - t.start;
            phase = rel > t.ms ? "结束后" : (t.marks.find(([, e]) => rel <= e)?.[0] ?? "其他");
          }
          const gap = t && i > 0 ? Math.round(t.start - T[i - 1].end) : null;
          const up = s.ups.filter(([u]) => u > a - 50 && u <= b).reduce((x, [, d]) => Math.max(x, d), -1);
          return { ms: +(b - a).toFixed(1), phase, sinceStart: t ? Math.round(b - t.start) : null, gapBefore: gap, readMs: t ? Math.round(t.readMs) : null, upMs: up >= 0 ? +up.toFixed(2) : null };
        });
        const med = (xs) => { const v = [...xs].sort((a, b) => a - b); return v.length ? +v[v.length >> 1].toFixed(1) : null; };
        return {
          frames: f.length, spanS: +((t1 - t0) / 1000).toFixed(1), over16: spikes.length, tasks: T.length, busyFrac: +(busy / (t1 - t0)).toFixed(3),
          taskMsMed: med(T.map((t) => t.ms)), readMsMed: med(T.map((t) => t.readMs)), mipMsMed: med(T.map((t) => t.mipMs)),
          marksMed: Object.fromEntries((T[0]?.marks ?? []).map(([n]) => [n, med(T.map((t) => t.marks.find((m) => m[0] === n)?.[1] ?? 0))])),
          backToBack: T.filter((t, i) => i > 0 && t.start - T[i - 1].end < 50).length,
          upFrames: s.ups.length, spikes,
          longTasks: s.long.slice(),
          draw: (() => { const d = window.__voyage.ground.imageryStats.draw; const n = d.count - s.draw0.count; return { n, avgMs: n ? +((d.totalMs - s.draw0.totalMs) / n).toFixed(2) : null, maxEverMs: +d.maxMs.toFixed(1) }; })(),
        };
      }, tasks);
      windows.push({ round: r, mode: name, ...w });
      console.log(JSON.stringify({ round: r, mode: name, ...w, spikes: w.spikes.map((x) => `${x.ms}ms@${x.phase}+${x.sinceStart}(gap ${x.gapBefore},read ${x.readMs},up ${x.upMs})`) }));
    }
  }
  const sum = {};
  for (const w of windows) {
    const S = (sum[w.mode] ??= { windows: 0, frames: 0, spanS: 0, over16: 0, tasks: 0, byPhase: {} });
    S.windows++; S.frames += w.frames; S.spanS += w.spanS; S.over16 += w.over16; S.tasks += w.tasks;
    for (const x of w.spikes) S.byPhase[x.phase] = (S.byPhase[x.phase] ?? 0) + 1;
  }
  for (const [k, S] of Object.entries(sum)) console.log(JSON.stringify({ mode: k, ...S, spanS: +S.spanS.toFixed(0), perMin: +((S.over16 / S.spanS) * 60).toFixed(2) }));
  console.log(`console error：${errors.length}`);
  if (outJson) fs.writeFileSync(outJson, JSON.stringify({ info, windows, sum, errors: errors.length }, null, 1));
} finally {
  await browser.close();
  release?.();
}
