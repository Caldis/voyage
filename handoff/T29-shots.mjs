#!/usr/bin/env node
// T29：窗上的水对照截图（私有 headless，复用 scenarios.mjs 的场景表）。
// 用法：node apps/voyage/handoff/T29-shots.mjs --port 5229 [--angle vulkan] [--out tmp/screenshot/T29/cur]
// 拍：in-cloud（穿云中，湿透）、in-cloud-exit（爬出云顶后 6 秒，正在吹干）、in-cloud-close（贴窗 1:1）、
//     wet-sea（人为湿窗 + 低空晴天海面，看有明暗对比时的折射）、typhoon-outer（13 km，应当干燥）、
//     以及 in-cloud-close 的连拍（每张约 120 ms，看闪烁），每张全图 + 窗板中部放大 2 倍的裁剪
import { chromium } from "playwright-core";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { DEFAULTS, applyScene, pickScenes } from "../scripts/scenarios.mjs";
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
const port = args.port || 5229;
const angle = args.angle || "d3d11";
const outDir = path.join(ROOT, args.out || "tmp/screenshot/T29/cur");
fs.mkdirSync(outDir, { recursive: true });

const base = pickScenes(["in-cloud"])[0];
const setIn = ([id, val]) => {
  const el = document.getElementById(id);
  el.value = String(val);
  el.dispatchEvent(new Event(el.tagName === "SELECT" ? "change" : "input"));
};

const browser = await launchBrowser(chromium, { angle });
try {
  const context = await browser.newContext({ viewport: { width: 1600, height: 1200 }, deviceScaleFactor: 1 });
  const page = await context.newPage();
  page.on("console", (m) => { if (m.type() === "error") console.log("[console.error]", m.text().slice(0, 400)); });
  await page.goto(`http://127.0.0.1:${port}/?dev=${Date.now()}`, { waitUntil: "commit", timeout: 180000 });
  await page.waitForFunction(() => window.__voyageStartup, null, { timeout: 300000, polling: 500 });
  const crop = { x: 560, y: 260, width: 480, height: 360 };
  const shot = async (name) => {
    await page.screenshot({ path: path.join(outDir, `${name}.png`) });
    await page.screenshot({ path: path.join(outDir, `${name}-crop.png`), clip: crop });
    const st = await page.evaluate(() => ({ wet: window.__voyage.state.wetness, alt: window.__voyage.state.altitudeKm }));
    console.log(`  ${name}: wet=${st.wet.toFixed(2)} alt=${st.alt}`);
  };

  await page.evaluate(applyScene, { sc: base, defaults: DEFAULTS });
  await shot("in-cloud");
  // 爬出云顶：高度 3 km（ISA 约 −4.5°C，按常温规则吹干）
  await page.evaluate(setIn, ["altitude", 3]);
  await page.evaluate(() => window.__voyage.snapAll());
  await new Promise((r) => setTimeout(r, 6000));
  await shot("in-cloud-exit");

  // 贴窗 1:1
  await page.evaluate(applyScene, { sc: { ...base, head: [0, 0, -0.08] }, defaults: DEFAULTS });
  await shot("in-cloud-close");
  for (let i = 0; i < 3; i++) {
    await new Promise((r) => setTimeout(r, 120));
    await page.screenshot({ path: path.join(outDir, `burst-${i}.png`), clip: crop });
  }

  // 有明暗对比的背景：低空晴天海面 + 人为湿窗（每帧强制 wetness，只为看折射）
  await page.evaluate(applyScene, { sc: { name: "wet-sea", p: { preset: "wpac", time: 900, coverage: 0.35, altitude: 1.0, "wing-pos": "-4" } }, defaults: DEFAULTS });
  await page.evaluate(() => {
    const v = window.__voyage;
    const tick = () => { v.state.wetness = 0.9; requestAnimationFrame(tick); };
    tick();
  });
  await new Promise((r) => setTimeout(r, 800));
  await shot("wet-sea");
  await page.evaluate(applyScene, { sc: { name: "wet-sea-close", p: { preset: "wpac", time: 900, coverage: 0.35, altitude: 1.0, "wing-pos": "-4" }, head: [0, 0, -0.08] }, defaults: DEFAULTS });
  await shot("wet-sea-close");
  await page.reload({ waitUntil: "commit" });
  await page.waitForFunction(() => window.__voyageStartup, null, { timeout: 300000, polling: 500 });

  await page.evaluate(applyScene, { sc: pickScenes(["typhoon-outer"])[0], defaults: DEFAULTS });
  await shot("typhoon-outer");
} finally {
  await closeBrowserSafely(browser);
}
console.log(`输出：${path.relative(ROOT, outDir)}`);
