#!/usr/bin/env node
// W01b：相机微动看闪烁。把头部横向每步挪 0.06 mm（相机朝向跟着转约 0.012°，几百 km 外的奇观在屏幕上挪约 0.25 像素），
// 连拍 8 帧同一块裁剪，输出每帧裁剪区的亮度和（能量守恒：亚像素移动时应基本不变）与一张 4 倍最近邻放大的拼图。
// 用法（仓库根）：node apps/voyage/handoff/W01b-flicker.mjs --port 5201 [--angle d3d11] [--out tmp/screenshot/W01b/flicker]
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
const port = args.port || 5201;
const outDir = path.join(ROOT, args.out || "tmp/screenshot/W01b/flicker");
fs.mkdirSync(outDir, { recursive: true });
const summon = (id, km) => `v.wonders.enabled = true; for (let i = 0; i < 2; i++) await new Promise((r) => requestAnimationFrame(r)); v.wonders.trigger("${id}", { forwardOffsetDeg: 0, distKm: ${km}, reveal: 1 });`;
const SHOTS = [
  { name: "tether-noon", p: { preset: "wpac", date: "2026-09-27", time: 720, coverage: 0.3, "wing-pos": "-4" }, js: summon("tether", 370), clip: { x: 760, y: 150, width: 80, height: 330 } },
  { name: "tether-dusk", p: { preset: "wpac", seat: "left", date: "2026-09-27", time: 1078, coverage: 0.3, "cabin-light": false, "wing-pos": "-4" }, js: summon("tether", 370), clip: { x: 770, y: 100, width: 80, height: 260 } },
  { name: "jianmu-day", p: { preset: "wpac", date: "2026-09-27", time: 900, coverage: 0.3, "wing-pos": "-4" }, js: summon("jianmu", 380), clip: { x: 740, y: 440, width: 120, height: 120 } },
];

const browser = await launchBrowser(chromium, { angle: args.angle || "d3d11" });
try {
  const context = await browser.newContext({ viewport: { width: 1600, height: 1200 }, deviceScaleFactor: 1 });
  const page = await context.newPage();
  page.on("console", (m) => { if (m.type() === "error") console.log("[console.error]", m.text().slice(0, 300)); });
  page.on("pageerror", (e) => console.log("[pageerror]", String(e).slice(0, 300)));
  await page.goto(`http://127.0.0.1:${port}/?dev=${Date.now()}`, { waitUntil: "commit", timeout: 180000 });
  await page.waitForFunction(() => window.__voyageStartup, null, { timeout: 300000, polling: 500 });
  for (const sc of SHOTS) {
    await page.evaluate(applyScene, { sc: { ...sc, wait: 1500 }, defaults: DEFAULTS });
    const sums = [];
    const files = [];
    for (let i = 0; i < 8; i++) {
      await page.evaluate((dx) => { const h = window.__voyage.head; h.x = h.tx = dx; }, i * 0.00006);
      await page.waitForTimeout(250);
      const buf = await page.screenshot({ clip: sc.clip });
      const f = path.join(outDir, `${sc.name}-${i}.png`);
      fs.writeFileSync(f, buf);
      files.push(f);
      sums.push(await page.evaluate(async (b64) => {
        const img = await createImageBitmap(await (await fetch(`data:image/png;base64,${b64}`)).blob());
        const c = new OffscreenCanvas(img.width, img.height);
        const g = c.getContext("2d");
        g.drawImage(img, 0, 0);
        const d = g.getImageData(0, 0, img.width, img.height).data;
        let s = 0;
        for (let k = 0; k < d.length; k += 4) s += d[k] + d[k + 1] + d[k + 2];
        return s / (img.width * img.height * 3);
      }, buf.toString("base64")));
    }
    const mean = sums.reduce((a, b) => a + b, 0) / sums.length;
    console.log(`  ${sc.name}: 裁剪区平均亮度 ${sums.map((s) => s.toFixed(2)).join(" / ")}（最大偏差 ${Math.max(...sums.map((s) => Math.abs(s - mean))).toFixed(2)} / 255）`);
    fs.writeFileSync(path.join(outDir, `${sc.name}.list`), files.join("\n"));
  }
} finally {
  await closeBrowserSafely(browser);
}
