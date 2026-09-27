// G07：首载过程逐次「换一版」的截图（冻结在场景机位），量每次级别就位 / 升级瞬间的画面跳变。
// 用法（在 apps/voyage 下）：node handoff/G07-load.mjs <端口> <输出目录(绝对)> <场景名> [额外 URL 参数]
// 场景：fuji-day / route-hnd-cts / night-city / route-hnd-cts-night（和 G06-shots 同机位，云量 0.05）
// 每当「可用级别数」或「已升级成 fine 的级别数」变化，等 4 帧后截一张（文件名带时间与状态），最后打印时间线。
// 画面跳变：对相邻两张跑 scripts/compare.mjs --diff（本脚本末尾自动做，输出 mean / p99 / 超阈值占比）。
import { chromium } from "playwright-core";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { launchBrowser } from "../scripts/lib/chrome.mjs";
import { DEFAULTS, applyScene } from "../scripts/scenarios.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const [port, outDir, name, extraQ = ""] = process.argv.slice(2);
const S = {
  "fuji-day": { p: { preset: "fuji", time: 930, altitude: 6, coverage: 0.05, "wing-pos": "-4" }, offset: [-20, 0.2] },
  "route-hnd-cts": { p: { preset: "hnd-cts", time: 990, coverage: 0.05, "wing-pos": "8" } },
  "night-city": { p: { preset: "fuji", date: "2026-01-16", time: 1260, altitude: 4, coverage: 0.05, "cabin-light": false }, offset: [0, -25], head: -0.25 },
  "route-hnd-cts-night": { p: { preset: "hnd-cts", date: "2026-01-16", time: 1290, coverage: 0.05, seat: "left", "cabin-light": false, "wing-pos": "8" } },
};
const sc = { name, ...S[name] };
fs.mkdirSync(outDir, { recursive: true });
const browser = await launchBrowser(chromium, {});
const errors = [];
const timeline = [];
try {
  const ctx = await browser.newContext({ viewport: { width: 1600, height: 1200 } });
  const page = await ctx.newPage();
  let tStart = Date.now();
  const errSec = [];
  page.on("console", (m) => { if (m.type() === "error") { errors.push(m.text().slice(0, 200)); errSec.push((Date.now() - tStart) / 1000); } });
  // EOX 请求按秒计数（首载的请求量与突发）
  const eox = [];
  page.on("request", (r) => { if (r.url().includes("eox.at")) eox.push((Date.now() - tStart) / 1000); });
  page.on("pageerror", (e) => errors.push(String(e).slice(0, 200)));
  await page.goto(`http://127.0.0.1:${port}/?g07=${Date.now()}${extraQ}`, { waitUntil: "commit", timeout: 180000 });
  await page.bringToFront();
  await page.waitForFunction(() => window.__voyageStartup, null, { timeout: 300000, polling: 500 });
  // 场景设好（不等地面）→ 立刻冻结在场景机位；换预设会 reset 地面，从这一刻起算首载
  await page.evaluate(applyScene, { sc: { ...sc, ground: false, wait: 0 }, defaults: DEFAULTS, settle: false });
  const [ox, oz] = sc.offset ?? [0, 0];
  const t0 = await page.evaluate(({ ox, oz }) => {
    const v = window.__voyage;
    v.wingDebug && (v.wingDebug.strobe = 0);
    v.freeze(true);
    v.cloudUniforms.uCloudOffset.value.set(ox, oz);
    const s = v.state;
    s.heading = s.preset.heading; s.bankDeg = 0; s.rollDeg = 0; s.pitchDeg = 2.5; s.turbulence = 0;
    return performance.now();
  }, { ox, oz });
  tStart = Date.now();
  eox.length = 0; errSec.length = 0; errors.length = 0;
  const state = () =>
    page.evaluate(() => {
      const g = window.__voyage.ground;
      const st = g.imageryStats;
      return { valid: g.levelUniform.filter((u) => u.w > 0.5).length, fine: (st.fine ?? []).filter(Boolean).length, pending: g.pending, warmup: st.warmup ?? null, res: st.res ?? 2048, t: performance.now() };
    });
  const frames = (n) => page.evaluate((n) => new Promise((r) => { let k = 0; const f = () => (++k >= n ? r() : requestAnimationFrame(f)); requestAnimationFrame(f); }), n);
  let last = "";
  let idx = 0;
  let calm = 0;
  const deadline = Date.now() + 150000;
  while (Date.now() < deadline) {
    const s = await state();
    const key = `${s.valid}/${s.fine}`;
    if (key !== last) {
      await frames(4);
      const s2 = await state();
      const file = path.join(outDir, `${String(idx++).padStart(2, "0")}-v${s2.valid}-f${s2.fine}.png`);
      await page.screenshot({ path: file });
      timeline.push({ file: path.basename(file), sec: +((s2.t - t0) / 1000).toFixed(1), valid: s2.valid, fine: s2.fine, pending: s2.pending });
      last = `${s2.valid}/${s2.fine}`;
      calm = 0;
    }
    // 全部就位（7 级可用、pending 0、升级完或 1024 档）后再观察 3 s 就结束
    const done = s.valid === 7 && s.pending === 0 && (s.res === 1024 || s.fine === 7 || s.warmup === null);
    calm = done ? calm + 1 : 0;
    if (calm >= 15) break;
    await page.waitForTimeout(200);
  }
  const fin = await state();
  console.log(JSON.stringify({ port, name, extraQ, warmup: fin.warmup, res: fin.res, errors: errors.length, err0: errors.slice(0, 2) }));
  for (const t of timeline) console.log(JSON.stringify(t));
  const hist = (a) => { const h = {}; for (const x of a) { const k = Math.floor(x / 5) * 5; h[k] = (h[k] ?? 0) + 1; } return h; };
  console.log("EOX 请求 / 5 s:", JSON.stringify(hist(eox)), "合计", eox.length);
  console.log("console error / 5 s:", JSON.stringify(hist(errSec)));
} finally {
  await browser.close();
}
// 相邻两张的差（compare.mjs --diff）
for (let i = 1; i < timeline.length; i++) {
  const a = path.join(outDir, timeline[i - 1].file), b = path.join(outDir, timeline[i].file);
  const r = spawnSync(process.execPath, [path.join(here, "../scripts/compare.mjs"), "--diff", b, "--json", a], { encoding: "utf8" });
  let d = null;
  try { d = JSON.parse(r.stdout); } catch { d = r.stdout.trim().split("\n").slice(-3).join(" | "); }
  const brief = d && typeof d === "object" ? { mean: d.mean ?? d.diff?.mean, p99: d.p99 ?? d.diff?.p99, over: d.pctOver ?? d.overThreshold ?? d.diff?.pctOver } : d;
  console.log(`${timeline[i - 1].file} → ${timeline[i].file}`, JSON.stringify(brief ?? d));
}
