#!/usr/bin/env node
// W00 追加：面板「立即召唤」的复现与验收（默认坐姿、白天晴空）。
// 用法：node apps/voyage/handoff/W00-summon.mjs --port 5200 [--out tmp/screenshot/W00/summon] [--attach]
//   --attach：先调 wonders.attachView(sceneMat.uniforms)（main.ts 接入那一行之前，用它在页面里模拟接入）
// 做法和面板按钮一样：wonders.trigger(id, { riseS: 20, forwardOffsetDeg: 6 })，等浮现完（25 s）再拍；
// 同时打印相机视线的水平方位、奇观的方位和距离，看是不是刷在了视野外。
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
const outDir = path.join(ROOT, args.out || "tmp/screenshot/W00/summon");
fs.mkdirSync(outDir, { recursive: true });

const browser = await launchBrowser(chromium, { angle: args.angle || "d3d11" });
try {
  const context = await browser.newContext({ viewport: { width: 1600, height: 1200 }, deviceScaleFactor: 1 });
  const page = await context.newPage();
  page.on("console", (m) => { if (m.type() === "error") console.log("[console.error]", m.text().slice(0, 400)); });
  page.on("pageerror", (e) => console.log("[pageerror]", String(e).slice(0, 400)));
  await page.goto(`http://127.0.0.1:${port}/?dev=${Date.now()}`, { waitUntil: "commit", timeout: 180000 });
  await page.bringToFront();
  await page.waitForFunction(() => window.__voyageStartup, null, { timeout: 300000, polling: 500 });
  for (const id of ["tether", "jianmu"]) {
    // 默认坐姿（右座、机翼默认位置）、正午、晴空（云量 0.1）
    await page.evaluate(applyScene, { sc: { name: id, p: { preset: "wpac", time: 720, coverage: 0.1 }, wait: 200 }, defaults: DEFAULTS });
    const info = await page.evaluate(({ id, attach }) => {
      const v = window.__voyage;
      const ws = v.wonders;
      if (attach && ws.attachView) ws.attachView(v.sceneMat.uniforms);
      ws.enabled = true;
      ws.clear();
      ws.trigger(id, { riseS: 20, forwardOffsetDeg: 6 }); // 与 ui.ts 的「立即召唤」完全相同
      // 相机视线（屏幕中心）的水平方位：cabinRay 的中心 = uCamBasis 的 −z 列，再乘 uCabinToWorld
      const u = v.sceneMat.uniforms;
      const e = u.uCamBasis.value.elements;
      const fwd = [-e[6], -e[7], -e[8]];
      const m = u.uCabinToWorld.value.elements;
      const w = [m[0] * fwd[0] + m[3] * fwd[1] + m[6] * fwd[2], m[1] * fwd[0] + m[4] * fwd[1] + m[7] * fwd[2], m[2] * fwd[0] + m[5] * fwd[1] + m[8] * fwd[2]];
      const view = ((Math.atan2(w[0], -w[2]) * 180) / Math.PI + 360) % 360;
      return { view: view.toFixed(1), heading: v.state.heading.toFixed(1), seat: v.state.seat };
    }, { id, attach: !!args.attach });
    await page.waitForTimeout(25000);
    const st = await page.evaluate(() => window.__voyage.wonders.describe());
    console.log(`  ${id}: 视线方位 ${info.view}°（航向 ${info.heading}°，${info.seat === "right" ? "右" : "左"}座） | ${st}`);
    await page.screenshot({ path: path.join(outDir, `summon-${id}.png`) });
  }
} finally {
  await closeBrowserSafely(browser);
}
console.log(`输出：${path.relative(ROOT, outDir)}`);
