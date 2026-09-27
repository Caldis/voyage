// G07：级别「挪中心重建」过程中逐帧的画面变化（冻结机位，不动相机）。正确的重建前后画面应几乎不变（同一片地面、只是换了 clipmap 的中心）；
// 如果三张纹理（影像 / 水体 / 高度）分几帧上传、中心 uniform 最后才换，中间几帧就是「新纹理 + 旧中心」的错位（整级影像平移 1/8 边长）。
// 做法：冻结在场景机位、全部就位后，每帧（rAF，主循环渲染之后）readPixels 读窗外一块区域，与上一帧求平均绝对差；
// 然后让第 L 级以偏开 1/8 边长的中心重建一次（update 随后会再把它挪回来，又一次重建），打印逐帧差异序列里的尖峰。
// 用法（apps/voyage 下）：node handoff/G07-recenter.mjs <端口> [级别=4] [场景=fuji-day] [额外 URL 参数]
import { chromium } from "playwright-core";
import { launchBrowser } from "../scripts/lib/chrome.mjs";
import { DEFAULTS, applyScene } from "../scripts/scenarios.mjs";

const [port, levelS = "4", name = "fuji-day", extraQ = ""] = process.argv.slice(2);
const S = {
  "fuji-day": { p: { preset: "fuji", time: 930, altitude: 6, coverage: 0.05, "wing-pos": "-4" }, offset: [-20, 0.2] },
  "route-hnd-cts": { p: { preset: "hnd-cts", time: 990, coverage: 0.05, "wing-pos": "8" }, offset: [0, 0] },
  "route-hnd-cts-night": { p: { preset: "hnd-cts", date: "2026-01-16", time: 1290, coverage: 0.05, seat: "left", "cabin-light": false, "wing-pos": "8" }, offset: [0, 0] },
};
const sc = { name, ...S[name] };
const browser = await launchBrowser(chromium, {});
try {
  const page = await (await browser.newContext({ viewport: { width: 1600, height: 1200 } })).newPage();
  await page.goto(`http://127.0.0.1:${port}/?g07=${Date.now()}${extraQ}`, { waitUntil: "commit", timeout: 180000 });
  await page.bringToFront();
  await page.waitForFunction(() => window.__voyageStartup, null, { timeout: 300000, polling: 500 });
  await page.evaluate(applyScene, { sc: { ...sc, ground: false, wait: 0 }, defaults: DEFAULTS, settle: false });
  await page.evaluate(([ox, oz]) => {
    const v = window.__voyage;
    v.wingDebug && (v.wingDebug.strobe = 0);
    v.freeze(true);
    v.cloudUniforms.uCloudOffset.value.set(ox, oz);
    const s = v.state;
    s.heading = s.preset.heading; s.bankDeg = 0; s.rollDeg = 0; s.pitchDeg = 2.5; s.turbulence = 0;
  }, sc.offset ?? [0, 0]);
  await page.waitForFunction(() => {
    const g = window.__voyage.ground;
    const w = g.imageryStats.warmup;
    return g.pending === 0 && g.levelUniform.every((u) => u.w > 0.5) && (!w || w.fine >= 0);
  }, null, { timeout: 180000, polling: 500 });
  await page.waitForTimeout(3000);
  const res = await page.evaluate(async (L) => {
    const v = window.__voyage;
    const g = v.ground;
    const gl = g.gl;
    const W = 800, H = 360, X = 400, Y = 1200 - 700 - H; // 窗外中下部（readPixels 原点在左下）
    const buf = [new Uint8Array(W * H * 4), new Uint8Array(W * H * 4)];
    const series = [];
    let k = 0, have = false, stop = false;
    const up = [];
    const orig = g.upload.bind(g);
    g.upload = (...a) => { up.push({ frame: series.length, tex: a[0] === g.albedo ? "影像" : a[0] === g.water ? "水体" : "高度" }); orig(...a); };
    const tick = () => {
      if (stop) return;
      const cur = buf[k & 1], prev = buf[(k + 1) & 1];
      gl.readPixels(X, Y, W, H, gl.RGBA, gl.UNSIGNED_BYTE, cur);
      if (have) {
        let s = 0;
        for (let i = 0; i < cur.length; i += 4) s += Math.abs(cur[i] - prev[i]) + Math.abs(cur[i + 1] - prev[i + 1]) + Math.abs(cur[i + 2] - prev[i + 2]);
        series.push(+(s / (3 * W * H)).toFixed(3));
      }
      have = true;
      k++;
      requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
    await new Promise((r) => setTimeout(r, 500));
    const l = g.levels[L];
    const uni = [];
    const u0 = g.levelUniform[L].clone();
    // 偏开 1/8 边长重建（update 之后会发现中心不对、再挪回来）
    g.build(L, l.cx + l.size / 8, l.cz, l.detail, l.fine);
    const t0 = performance.now();
    while (performance.now() - t0 < 12000) {
      await new Promise((r) => setTimeout(r, 50));
      const u = g.levelUniform[L];
      if (!uni.length || uni[uni.length - 1].x !== u.x) uni.push({ frame: series.length, x: u.x });
    }
    stop = true;
    g.upload = orig;
    const peaks = series.map((d, i) => ({ i, d })).filter((p) => p.d > 0.05);
    return { level: L, uniformX0: u0.x, uniformChanges: uni, uploads: up, frames: series.length, peaks, maxDiff: Math.max(...series) };
  }, Number(levelS));
  console.log(JSON.stringify(res));
} finally {
  await browser.close();
}
