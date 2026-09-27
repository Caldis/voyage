#!/usr/bin/env node
// W01：天梯 / 建木的验收截图（私有 headless，复用 scenarios.mjs 的 applyScene）。
// 用法：node apps/voyage/handoff/W01-shots.mjs --port 5260 [--angle vulkan] [--out tmp/screenshot/W01/cur] [--only dusk,noon]
// 拍：tether-dusk（左座朝东、日落后，地影吞掉下段、上段仍亮）、tether-noon（右座、正午，远而淡）、
//     tether-night（右座、深夜、舱灯全关，航标灯）、jianmu-dusk（建木皮肤）、tether-cloud（有云时被云遮挡）、
//     off-noon（奇观模式关，和 master 对照用）；每张全图 + 窗板中部 1:1 裁剪；dusk 另拍 3 张连拍裁剪看闪烁；
//     reveal-*：浮现过程（20 s 浮现，每 5 s 一张）
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
const port = args.port || 5260;
const angle = args.angle || "d3d11";
const outDir = path.join(ROOT, args.out || "tmp/screenshot/W01/cur");
const only = args.only ? String(args.only).split(",") : null;
fs.mkdirSync(outDir, { recursive: true });

// 奇观放在窗口正对方向（forwardOffsetDeg 0）、指定距离，直接显形
const SHOTS = [
  { name: "tether-dusk", p: { preset: "wpac", seat: "left", time: 1078, "wing-pos": "-4", coverage: 0.3, "cabin-light": "false" }, wonder: { id: "tether", distKm: 370 } },
  { name: "tether-noon", p: { preset: "wpac", time: 720, "wing-pos": "-4", coverage: 0.3 }, wonder: { id: "tether", distKm: 370 } },
  { name: "tether-night", p: { preset: "wpac", time: 1290, "wing-pos": "-4", coverage: 0.3, "cabin-light": "off" }, wonder: { id: "tether", distKm: 370 } },
  { name: "jianmu-dusk", p: { preset: "wpac", seat: "left", time: 1078, "wing-pos": "-4", coverage: 0.3, "cabin-light": "false" }, wonder: { id: "jianmu", distKm: 380 } },
  { name: "tether-cloud", p: { preset: "wpac", seat: "left", time: 1074, "wing-pos": "-4", "cloud-preset": "deck-below", altitude: 6.5, coverage: 0.7, "cabin-light": "false" }, wonder: { id: "tether", distKm: 370 } },
  { name: "off-noon", p: { preset: "wpac", time: 720, "wing-pos": "-4", coverage: 0.3 }, wonder: null },
];

const browser = await launchBrowser(chromium, { angle });
try {
  const context = await browser.newContext({ viewport: { width: 1600, height: 1200 }, deviceScaleFactor: 1 });
  const page = await context.newPage();
  page.on("console", (m) => { if (m.type() === "error") console.log("[console.error]", m.text().slice(0, 400)); });
  page.on("pageerror", (e) => console.log("[pageerror]", String(e).slice(0, 400)));
  await page.goto(`http://127.0.0.1:${port}/?dev=${Date.now()}`, { waitUntil: "commit", timeout: 180000 });
  await page.bringToFront();
  await page.waitForFunction(() => window.__voyageStartup, null, { timeout: 300000, polling: 500 });
  const crop = { x: 600, y: 0, width: 400, height: 600 };
  const shot = async (name) => {
    await page.screenshot({ path: path.join(outDir, `${name}.png`) });
    await page.screenshot({ path: path.join(outDir, `${name}-crop.png`), clip: crop });
    const st = await page.evaluate(() => ({ w: window.__voyage.wonders.describe(), info: document.getElementById("info").textContent.split("\n")[0] }));
    console.log(`  ${name}: ${st.w} | ${st.info}`);
  };
  for (const sc of SHOTS) {
    if (only && !only.includes(sc.name)) continue;
    await page.evaluate(applyScene, { sc: { ...sc, wait: 200 }, defaults: DEFAULTS });
    await page.evaluate((w) => {
      const ws = window.__voyage.wonders;
      ws.clear();
      ws.enabled = !!w;
      if (w) ws.trigger(w.id, { forwardOffsetDeg: w.fwd ?? 0, distKm: w.distKm, reveal: 1 });
    }, sc.wonder);
    await new Promise((r) => setTimeout(r, 2500));
    await shot(sc.name);
    if (sc.name === "tether-dusk") {
      for (let i = 0; i < 3; i++) {
        await new Promise((r) => setTimeout(r, 150));
        await page.screenshot({ path: path.join(outDir, `burst-${i}.png`), clip: { x: 760, y: 20, width: 100, height: 220 } });
      }
    }
  }
  if (!only || only.includes("reveal")) {
    await page.evaluate(applyScene, { sc: { ...SHOTS[0], wait: 200 }, defaults: DEFAULTS });
    await page.evaluate(() => {
      const ws = window.__voyage.wonders;
      ws.clear();
      ws.enabled = true;
      ws.trigger("tether", { forwardOffsetDeg: 0, distKm: 370, reveal: 0, riseS: 20 });
    });
    for (let i = 0; i < 6; i++) {
      await page.screenshot({ path: path.join(outDir, `reveal-${i}.png`), clip: { x: 700, y: 0, width: 200, height: 600 } });
      await new Promise((r) => setTimeout(r, 4000));
    }
  }
} finally {
  await closeBrowserSafely(browser);
}
console.log(`输出：${path.relative(ROOT, outDir)}`);
