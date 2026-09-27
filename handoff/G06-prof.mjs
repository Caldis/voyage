// G06：1× 巡航时 > 20 ms 的帧里主线程在干什么（CDP 采样剖析，PERF-9 同法的简化版）
import { chromium } from "file:///D:/Code/opus-test/.claude/worktrees/agent-a1c121a158e5469bd/node_modules/.pnpm/playwright-core@1.63.0/node_modules/playwright-core/index.mjs";
import { launchBrowser } from "file:///D:/Code/opus-test/.claude/worktrees/agent-a1c121a158e5469bd/apps/voyage/scripts/lib/chrome.mjs";
import { DEFAULTS, applyScene } from "file:///D:/Code/opus-test/.claude/worktrees/agent-a1c121a158e5469bd/apps/voyage/scripts/scenarios.mjs";

const [port, secsS] = process.argv.slice(2);
const secs = Number(secsS || 60);
const browser = await launchBrowser(chromium, {});
try {
  const ctx = await browser.newContext({ viewport: { width: 1600, height: 1200 } });
  const page = await ctx.newPage();
  await page.goto(`http://127.0.0.1:${port}/?g06p=${Date.now()}`, { waitUntil: "commit", timeout: 180000 });
  await page.bringToFront();
  await page.waitForFunction(() => window.__voyageStartup, null, { timeout: 300000, polling: 500 });
  await page.evaluate(applyScene, { sc: { name: "s", p: { preset: "hnd-cts", time: 930, coverage: 0.3, "wing-pos": "-4" }, ground: true }, defaults: DEFAULTS, settle: true });
  const cdp = await ctx.newCDPSession(page);
  await cdp.send("Profiler.enable");
  await cdp.send("Profiler.setSamplingInterval", { interval: 200 });
  await page.evaluate(() => {
    const box = document.getElementById("voyage-on");
    box.checked = true;
    box.dispatchEvent(new Event("change"));
    window.__voyage.director.rate = 1;
    const f = (window.__g06f = []);
    let last = performance.now();
    const tick = (t) => { f.push([last, t]); last = t; requestAnimationFrame(tick); };
    requestAnimationFrame(tick);
  });
  const pn0 = await page.evaluate(() => performance.now());
  await cdp.send("Profiler.start");
  const pn1 = await page.evaluate(() => performance.now());
  await page.waitForTimeout(secs * 1000);
  const { profile } = await cdp.send("Profiler.stop");
  const frames = await page.evaluate(() => window.__g06f.filter(([a, b]) => b - a > 20));
  // profile 时间（μs，从 startTime 起）≈ 页面 performance.now() 的 (pn0+pn1)/2 起点
  const origin = (pn0 + pn1) / 2;
  const nodes = new Map(profile.nodes.map((n) => [n.id, n]));
  const parent = new Map();
  for (const n of profile.nodes) for (const c of n.children ?? []) parent.set(c, n.id);
  const label = (id) => {
    const n = nodes.get(id);
    const cf = n.callFrame;
    let s = `${cf.functionName || "(anon)"} ${cf.url.split("/").pop()}:${cf.lineNumber + 1}`;
    const p = parent.get(id);
    if (p) { const pc = nodes.get(p).callFrame; s += ` ← ${pc.functionName || "(anon)"} ${pc.url.split("/").pop()}:${pc.lineNumber + 1}`; }
    return s;
  };
  let t = 0;
  const agg = new Map();
  for (let i = 0; i < profile.samples.length; i++) {
    t += profile.timeDeltas[i];
    const ms = origin + t / 1000;
    if (!frames.some(([a, b]) => ms >= a - 3 && ms <= b + 3)) continue;
    const k = label(profile.samples[i]);
    agg.set(k, (agg.get(k) ?? 0) + (profile.timeDeltas[i + 1] ?? 200) / 1000);
  }
  console.log(`> 20 ms 的帧：${frames.length}，各帧长：${frames.map(([a, b]) => (b - a).toFixed(0)).join(",")}`);
  for (const [k, v] of [...agg].sort((a, b) => b[1] - a[1]).slice(0, 25)) console.log(`${v.toFixed(1).padStart(7)} ms  ${k}`);
} finally {
  await browser.close();
}
