#!/usr/bin/env node
// W01：窗外 pass 开销对照（同一页面、同一场景，奇观开 / 关交替批渲，剔除离群后取均值）。
// 用法：node apps/voyage/handoff/W01-bench.mjs --port 5260 [--angle d3d11] [--rounds 9] [--frames 40]
import { chromium } from "playwright-core";
import { DEFAULTS, applyScene } from "../scripts/scenarios.mjs";
import { launchBrowser, closeBrowserSafely } from "../scripts/lib/chrome.mjs";

const args = {};
for (let i = 2; i < process.argv.length; i++) {
  const a = process.argv[i];
  if (a.startsWith("--")) {
    const n = process.argv[i + 1];
    if (n !== undefined && !n.startsWith("--")) { args[a.slice(2)] = n; i++; } else args[a.slice(2)] = true;
  }
}
const port = args.port || 5260;
const rounds = Number(args.rounds || 9);
const frames = Number(args.frames || 40);
const SCENES = [
  { name: "dusk", p: { preset: "wpac", seat: "left", time: 1078, "wing-pos": "-4", coverage: 0.3 } },
  { name: "noon", p: { preset: "wpac", time: 720, "wing-pos": "-4", coverage: 0.3 } },
];

const browser = await launchBrowser(chromium, { angle: args.angle || "d3d11" });
try {
  const context = await browser.newContext({ viewport: { width: 1600, height: 1200 }, deviceScaleFactor: 1 });
  const page = await context.newPage();
  await page.goto(`http://127.0.0.1:${port}/?dev=${Date.now()}`, { waitUntil: "commit", timeout: 180000 });
  await page.bringToFront();
  await page.waitForFunction(() => window.__voyageStartup, null, { timeout: 300000, polling: 500 });
  for (const sc of SCENES) {
    await page.evaluate(applyScene, { sc: { ...sc, wait: 500 }, defaults: DEFAULTS });
    const res = await page.evaluate(({ rounds, frames }) => {
      const v = window.__voyage;
      const ws = v.wonders;
      const set = (on) => {
        ws.clear();
        ws.enabled = on;
        if (on) ws.trigger("tether", { forwardOffsetDeg: 0, distKm: 370, reveal: 1 });
        v.benchFrame(1); // 让 wonders.update 把 uniform 写进去
      };
      const out = { off: [], on: [] };
      for (const on of [false, true]) { set(on); v.benchScene(10, "outside"); }
      for (let r = 0; r < rounds; r++) {
        for (const on of [false, true]) {
          set(on);
          out[on ? "on" : "off"].push(v.benchScene(frames, "outside"));
        }
      }
      return out;
    }, { rounds, frames });
    const tm = (a) => {
      const s = [...a].sort((x, y) => x - y).slice(1, -1);
      return s.reduce((p, c) => p + c, 0) / s.length;
    };
    console.log(`${sc.name}: 窗外 pass 关 ${tm(res.off).toFixed(3)} ms，开 ${tm(res.on).toFixed(3)} ms，差 ${(tm(res.on) - tm(res.off)).toFixed(3)} ms`);
  }
} finally {
  await closeBrowserSafely(browser);
}
