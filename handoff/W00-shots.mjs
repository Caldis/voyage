#!/usr/bin/env node
// W00：云间层奇观接口的验收截图（私有 headless，复用 scenarios.mjs 的 applyScene；页面带 ?w00probe 才编进测试体）。
// 用法：node apps/voyage/handoff/W00-shots.mjs --port 5200 [--angle d3d11] [--out tmp/screenshot/W00/cur] [--only a,b] [--noprobe]
// 拍：
//   noon-cumulus    回归场景原样（没有奇观；和对照端口逐像素比，确认零回归）
//   probe-behind    浓积云（1.4–6.5 km）里 70 km 外的测试体：前面的云挡住它一部分、它挡住身后的云
//   probe-front     层积云云海（1.0–2.2 km）上方浮着的测试体（抬高 1.5 km）：它挡住身后的云海，云海上有它的影子
//   taa-*           probe-behind 场景里快速转航向（约 20°/s）：运动中与停下后各拍几张，看轮廓有没有拖影 / 鬼影
import { chromium } from "playwright-core";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { DEFAULTS, applyScene } from "../scripts/scenarios.mjs";
import { launchBrowser, closeBrowserSafely } from "../scripts/lib/chrome.mjs";

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const args = {};
for (let i = 2; i < process.argv.length; i++) {
  const a = process.argv[i];
  if (a.startsWith("--")) {
    const n = process.argv[i + 1];
    if (n !== undefined && !n.startsWith("--")) { args[a.slice(2)] = n; i++; } else args[a.slice(2)] = true;
  }
}
const port = args.port || 5200;
const angle = args.angle || "d3d11";
const outDir = path.join(ROOT, args.out || "tmp/screenshot/W00/cur");
const only = args.only ? String(args.only).split(",") : null;
fs.mkdirSync(outDir, { recursive: true });

const SHOTS = [
  { name: "noon-cumulus", p: { preset: "wpac", time: 720, "wing-pos": "8" }, wonder: null },
  { name: "probe-behind", p: { preset: "wpac", seat: "left", time: 900, "wing-pos": "-4", "cloud-preset": "towering", coverage: 0.55 }, wonder: { distKm: 70, fwd: 0, baseKm: -1.5 } },
  { name: "probe-front", p: { preset: "wpac", seat: "left", time: 900, "wing-pos": "-4", "cloud-preset": "stratocumulus", coverage: 0.78 }, wonder: { distKm: 45, fwd: 0, baseKm: 1.5 } },
];

const browser = await launchBrowser(chromium, { angle });
try {
  const context = await browser.newContext({ viewport: { width: 1600, height: 1200 }, deviceScaleFactor: 1 });
  const page = await context.newPage();
  page.on("console", (m) => { if (m.type() === "error") console.log("[console.error]", m.text().slice(0, 400)); });
  page.on("pageerror", (e) => console.log("[pageerror]", String(e).slice(0, 400)));
  const q = args.noprobe ? "" : "&w00probe";
  const t0 = Date.now();
  await page.goto(`http://127.0.0.1:${port}/?dev=${Date.now()}${q}`, { waitUntil: "commit", timeout: 180000 });
  await page.bringToFront();
  await page.waitForFunction(() => window.__voyageStartup, null, { timeout: 300000, polling: 500 });
  console.log(`  启动 ${((Date.now() - t0) / 1000).toFixed(1)} s`);
  const crop = { x: 580, y: 480, width: 400, height: 260 };
  for (const sc of SHOTS) {
    if (only && !only.includes(sc.name) && !(sc.name === "probe-behind" && only.includes("taa"))) continue;
    await page.evaluate(applyScene, { sc: { ...sc, wait: 200 }, defaults: DEFAULTS });
    await page.evaluate((w) => {
      const ws = window.__voyage.wonders;
      ws.clear();
      ws.enabled = !!w;
      if (w) ws.trigger("w00-probe", { forwardOffsetDeg: w.fwd, distKm: w.distKm, reveal: 1, baseKm: w.baseKm });
    }, sc.wonder);
    if (sc.wonder) {
      // 奇观变体（#define WONDER_LAYER）第一次用时在后台编译
      const t1 = Date.now();
      await page.waitForFunction(() => ["ready", "failed"].includes(window.__voyage.clouds.wonderLayerState), null, { timeout: 180000, polling: 250 });
      const st = await page.evaluate(() => window.__voyage.clouds.wonderLayerState);
      if (Date.now() - t1 > 500) console.log(`  奇观变体 ${st}，等了 ${((Date.now() - t1) / 1000).toFixed(1)} s`);
    }
    await page.waitForTimeout(2500);
    if (!only || only.includes(sc.name)) {
      await page.screenshot({ path: path.join(outDir, `${sc.name}.png`) });
      await page.screenshot({ path: path.join(outDir, `${sc.name}-crop.png`), clip: crop });
      const st = await page.evaluate(() => ({ w: window.__voyage.wonders.describe(), info: document.getElementById("info").textContent.split("\n")[0] }));
      console.log(`  ${sc.name}: ${st.w} | ${st.info}`);
    }
    if (sc.name === "probe-behind" && (!only || only.includes("taa"))) {
      // 摇航向：以原航向为中心 ±4°、周期 1.6 s 来回摆（峰值约 16°/s，比真实转弯快 5 倍），奇观和云一起在窗里横移、不出画
      await page.evaluate(() => {
        const v = window.__voyage;
        const h0 = v.state.heading;
        const t0 = performance.now();
        window.__w00spin = true;
        const step = () => {
          if (!window.__w00spin) { v.state.heading = h0; return; }
          v.state.heading = (h0 + 4 * Math.sin(((performance.now() - t0) / 1600) * 2 * Math.PI) + 360) % 360;
          requestAnimationFrame(step);
        };
        requestAnimationFrame(step);
      });
      for (let i = 0; i < 4; i++) {
        await page.waitForTimeout(230);
        await page.screenshot({ path: path.join(outDir, `taa-moving-${i}.png`), clip: crop });
      }
      await page.evaluate(() => { window.__w00spin = false; });
      await page.screenshot({ path: path.join(outDir, `taa-stop-0.png`), clip: crop });
      await page.waitForTimeout(100);
      await page.screenshot({ path: path.join(outDir, `taa-stop-1.png`), clip: crop });
      await page.waitForTimeout(1500);
      await page.screenshot({ path: path.join(outDir, `taa-stop-2.png`), clip: crop });
      console.log("  taa: 运动中 4 张、停下后 0 / 0.1 / 1.6 s 各 1 张");
    }
  }
} finally {
  await closeBrowserSafely(browser);
}
console.log(`输出：${path.relative(ROOT, outDir)}`);
