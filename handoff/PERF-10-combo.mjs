// PERF-10 返工验证：卷云 / 奇观在场时，按导演的流程（先 weatherReady 预告，返回 true 才摆放）放雷暴 / 台风，
// 摆放之后每一帧步进实际画的变体都应该就是想要的变体（不回退到丢掉卷云 / 奇观的子集），云影 / 探针天气版与步进一致。
// 用法：node apps/voyage/handoff/PERF-10-combo.mjs --port 5210 [--out 截图目录]
import { chromium } from "playwright-core";
import path from "node:path";
import { mkdirSync } from "node:fs";
import { launchBrowser, closeBrowserSafely } from "../scripts/lib/chrome.mjs";
import { DEFAULTS, applyScene } from "../scripts/scenarios.mjs";

const args = process.argv.slice(2);
const port = args[args.indexOf("--port") + 1];
const out = args.includes("--out") ? args[args.indexOf("--out") + 1] : null;
if (out) mkdirSync(out, { recursive: true });
const browser = await launchBrowser(chromium, { angle: "d3d11" });
let fail = 0;
try {
  const ctx = await browser.newContext({ viewport: { width: 1600, height: 1200 } });
  const page = await ctx.newPage();
  page.on("pageerror", (e) => console.log("[pageerror]", e.message));
  page.on("console", (m) => (m.type() === "error" || m.type() === "warning") && console.log(`[console.${m.type()}]`, m.text()));
  await page.goto(`http://127.0.0.1:${port}/?combo=${Date.now()}`, { waitUntil: "commit" });
  await page.bringToFront();
  await page.waitForFunction(() => window.__voyageStartup, null, { timeout: 300000, polling: 250 });

  const cases = [
    {
      name: "cirrus+storm",
      sc: { name: "cirrus+storm", p: { preset: "wpac", time: 720, "cloud-preset": "cirrus", coverage: 0.5, altitude: 9, "wing-pos": "8" }, offset: [0, 0], wait: 500 },
      kind: "storm",
    },
    {
      name: "wonder+typhoon",
      sc: {
        name: "wonder+typhoon",
        p: { preset: "wpac", seat: "right", date: "2026-09-27", time: 975, "cloud-preset": "stratocumulus", coverage: 0.6, "wing-pos": "-4" },
        offset: [0, 0],
        wait: 500,
        js: 'v.wonders.enabled = true; for (let i = 0; i < 2; i++) await new Promise((r) => requestAnimationFrame(r)); v.wonders.trigger("floatcity", { forwardOffsetDeg: 0, distKm: 80, reveal: 1, seed: 0.23 }); for (let i = 0; i < 240 && v.clouds.wonderLayerState !== "ready"; i++) await new Promise((r) => setTimeout(r, 250)); return v.clouds.wonderLayerState;',
      },
      kind: "typhoon",
    },
  ];
  for (const c of cases) {
    await page.evaluate(applyScene, { sc: c.sc, defaults: DEFAULTS });
    const r = await page.evaluate(async (kind) => {
      const v = window.__voyage;
      const c = v.clouds;
      const frame = () => new Promise((res) => requestAnimationFrame(res));
      for (let i = 0; i < 60; i++) await frame();
      const before = c.variantStatus;
      // 导演的流程：预告，直到返回 true 才摆放
      const t0 = performance.now();
      let ready = false;
      while (!ready && performance.now() - t0 < 120000) {
        ready = c.prepareWeather(kind === "storm", kind === "typhoon");
        if (!ready) await frame();
      }
      const waited = Math.round(performance.now() - t0);
      const off = v.cloudUniforms.uCloudOffset.value;
      // 摆在视野外（机头前方 250 km），和导演一样；这里只验证步进变体是否跳变
      if (kind === "storm") v.weather.addStorm({ id: "combo#0", x: off.x + 0, z: off.y - 250, radius: 6, top: 13 });
      else v.weather.setHurricane({ id: "combo", x: off.x, z: off.y - 500, eye: 20 });
      const bad = [];
      for (let i = 0; i < 180; i++) {
        await frame();
        const s = c.variantStatus;
        if (s.shown !== s.wanted) bad.push(`${i}:${s.shown}≠${s.wanted}`);
      }
      const after = c.variantStatus;
      if (kind === "storm") v.weather.removeStorms((s) => s.id === "combo#0");
      else v.weather.setHurricane(null);
      for (let i = 0; i < 10; i++) await frame();
      return { before, waited, after, bad: bad.slice(0, 5), badCount: bad.length, back: c.variantStatus.shown };
    }, c.kind);
    const ok = r.badCount === 0 && /[ST]/.test(r.after.shown) && r.after.shown.includes("C");
    if (!ok) fail++;
    console.log(`${ok ? "[OK]  " : "[FAIL]"} ${c.name}: 摆放前 shown=${r.before.shown}；预告等了 ${r.waited} ms；摆放后 180 帧 shown=${r.after.shown} wanted=${r.after.wanted}，不一致 ${r.badCount} 帧 ${r.bad.join(" ")}；天气小程序 ${r.after.weatherAux}；撤掉后回到 ${r.back}`);
    if (out) await page.screenshot({ path: path.join(out, `${c.name}.png`) });
  }
} finally {
  await closeBrowserSafely(browser);
}
process.exit(fail ? 1 : 0);
