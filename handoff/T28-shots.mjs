#!/usr/bin/env node
// T28：舱内色适应对照截图（私有 headless，复用 scenarios.mjs 的场景表）。
// 用法：node handoff/T28-shots.mjs --port 5228 [--angle vulkan] [--only a,b] [--out tmp/screenshot/T28/x] [--eval "js"]
// 场景名 = 回归场景名 + 可选后缀（可叠加，顺序任意）：
//   -on / -sleep / -off   舱灯三档（面板 cabin-light = true / false / off）
//   -shade                遮光板全放下
//   -ahead                「看前方」视角（右侧座位，头的位置取自 view-presets.ts）
// 每个场景输出 <名>.png、<名>-mask.png（窗外遮罩，白 = 窗外）和 <名>.json（适应亮度 + 帧时间）。
// 统计：python handoff/T28-color.py <改前目录> <改后目录>
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
const port = args.port || 5228;
const angle = args.angle || "d3d11";
const outDir = path.join(ROOT, args.out || "tmp/screenshot/T28/cur");
fs.mkdirSync(outDir, { recursive: true });
const DEFAULT_LIST = [
  "noon-cumulus", "noon-cumulus-ahead", "fuji-day", "sunset-wing", "dusk-earthshadow", "in-cloud",
  "night-city-on", "night-city-on-ahead", "night-city-on-shade", "night-city", "night-city-off", "night-city-off-shade",
];
const names = args.only ? String(args.only).split(",") : DEFAULT_LIST;
const LIGHT = { on: true, sleep: false, off: "off" };
const scenes = names.map((nm) => {
  const base = pickScenes([nm.replace(/(-(on|sleep|off|shade|ahead))+$/, "")])[0];
  if (!base) throw new Error(`未知场景 ${nm}`);
  const sc = { ...base, name: nm, p: { ...base.p } };
  for (const tok of nm.slice(base.name.length).split("-").filter(Boolean)) {
    if (tok in LIGHT) sc.p["cabin-light"] = LIGHT[tok];
    if (tok === "shade") sc.p.shade = 1;
    if (tok === "ahead") sc.head = [-0.42, 0.1, -0.5];
  }
  return sc;
});

const browser = await launchBrowser(chromium, { angle });
try {
  const context = await browser.newContext({ viewport: { width: 1600, height: 1200 }, deviceScaleFactor: 1 });
  const page = await context.newPage();
  page.on("console", (m) => { if (m.type() === "error") console.log(`[控制台 error] ${m.text()}`); });
  page.on("pageerror", (e) => console.log(`[页面异常] ${e.message}`));
  await page.goto(`http://127.0.0.1:${port}/?dev=${Date.now()}`, { waitUntil: "commit", timeout: 180000 });
  await page.waitForFunction(() => window.__voyageStartup, null, { timeout: 300000, polling: 500 });
  await page.waitForTimeout(3000);
  for (const sc of scenes) {
    await page.evaluate(applyScene, { sc, defaults: DEFAULTS });
    if (args.eval) await page.evaluate(String(args.eval));
    await page.waitForTimeout(400);
    await page.screenshot({ path: path.join(outDir, `${sc.name}.png`), timeout: 60000 });
    const meter = await page.evaluate(() => {
      const ex = window.__voyage.exposure;
      const px = new Float32Array(8);
      ex.pass.renderer.readRenderTargetPixels(ex.adapted[0], 0, 0, 2, 1, px);
      return Array.from(px);
    });
    await page.evaluate(() => (window.__voyage.exposure.finalMat.uniforms.uDebugMask.value = true));
    await page.waitForTimeout(300);
    await page.screenshot({ path: path.join(outDir, `${sc.name}-mask.png`), timeout: 60000 });
    await page.evaluate(() => (window.__voyage.exposure.finalMat.uniforms.uDebugMask.value = false));
    const frames = [];
    for (let r = 0; r < 3; r++) frames.push(await page.evaluate((n) => window.__voyage.benchFrame(n), 30));
    const frameMs = frames.sort((a, b) => a - b)[1];
    fs.writeFileSync(path.join(outDir, `${sc.name}.json`), JSON.stringify({ scene: sc.name, meter, frameMs }, null, 2));
    console.log(`${sc.name}: frameMs=${frameMs.toFixed(2)} meter=${meter.map((x) => x.toFixed(3)).join(",")}`);
  }
} finally {
  await closeBrowserSafely(browser);
}
