// T11：按节点类型拆开量 Web Audio 离线渲染的 CPU（需要 5211 上有开发服务器）。用法：node apps/voyage/handoff/T11-prof.mjs
import { chromium } from "playwright-core";
import { launchBrowser, closeBrowserSafely } from "../scripts/lib/chrome.mjs";
const browser = await launchBrowser(chromium, { angle: "d3d11" });
const page = await browser.newPage();
await page.goto("http://127.0.0.1:5211/src/audio.ts");
const r = await page.evaluate(async () => {
  const m = await import("/src/audio.ts");
  const fl = await import("/src/flight.ts");
  const SR = 48000, SEC = 30;
  const inp = { altitudeKm: 10.7, speedKms: fl.speedAt(10.7), climb: 0, turbulence: 0.03, inCloud: 0, airTempC: -50, slatDeg: 0, flapDeg: 0, spoilerDeg: 0, wingRootLE: 8, seatSign: 1 };
  const out = {};
  async function time(name, fn) {
    const ctx = new OfflineAudioContext(2, SR * SEC, SR);
    await fn(ctx);
    const t0 = performance.now();
    await ctx.startRendering();
    out[name] = +(((performance.now() - t0) / (SEC * 1000)) * 100).toFixed(2) + "%";
  }
  const loopSrc = (ctx) => { const b = ctx.createBuffer(2, SR * 5, SR); const s = ctx.createBufferSource(); s.buffer = b; s.loop = true; s.start(); return s; };
  await time("空图", async (ctx) => { const g = ctx.createGain(); g.connect(ctx.destination); });
  await time("1 个循环源", async (ctx) => { loopSrc(ctx).connect(ctx.destination); });
  await time("10 个循环源", async (ctx) => { for (let i = 0; i < 10; i++) loopSrc(ctx).connect(ctx.destination); });
  await time("1 个振荡器", async (ctx) => { const o = ctx.createOscillator(); o.connect(ctx.destination); o.start(); });
  await time("1 个压缩器", async (ctx) => { const c = ctx.createDynamicsCompressor(); loopSrc(ctx).connect(c).connect(ctx.destination); });
  await time("10 个声像器", async (ctx) => { for (let i = 0; i < 10; i++) { const p = ctx.createStereoPanner(); p.pan.value = 0.3; loopSrc(ctx).connect(p).connect(ctx.destination); } });
  await time("全图 immediate", async (ctx) => { const sc = new m.Soundscape(ctx, undefined, 3); sc.output.connect(ctx.destination); await sc.build(); sc.master.gain.value = 1; sc.update(inp, { immediate: true }); });
  await time("全图 setTarget 缓变", async (ctx) => { const sc = new m.Soundscape(ctx, undefined, 3); sc.output.connect(ctx.destination); await sc.build(); sc.master.gain.value = 1; sc.update(inp, { force: true }); });
  await time("全图 颠簸 0.8（事件）", async (ctx) => { const sc = new m.Soundscape(ctx, undefined, 3); sc.output.connect(ctx.destination); await sc.build(); sc.master.gain.value = 1; sc.update({ ...inp, turbulence: 0.8 }, { immediate: true, horizon: 30 }); });
  await time("全图 30 次近雷", async (ctx) => { const sc = new m.Soundscape(ctx, undefined, 3); sc.output.connect(ctx.destination); await sc.build(); sc.master.gain.value = 1; sc.update(inp, { immediate: true }); for (let i = 0; i < 30; i++) sc.thunderAt(i, 3, true); });
  return out;
});
console.log(r);
await closeBrowserSafely(browser);
