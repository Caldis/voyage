#!/usr/bin/env node
// T34：窗上舱内倒影的对照截图（私有 headless，复用 scenarios.mjs 的场景表；由 T28-shots.mjs 改来）。
// 用法：node handoff/T34-shots.mjs --port 5234 [--angle vulkan] [--only a,b] [--out tmp/screenshot/T34/x] [--eval "js"]
// 场景名 = 回归场景名 + 可选后缀（可叠加）：
//   -on / -sleep / -off   舱灯三档（面板 cabin-light = true / false / off）
//   -econ                 经济舱（面板 cabin-class = economy）
//   -ahead                「看前方」视角
// 每个场景输出 <名>.png、<名>-mask.png（窗外遮罩）、<名>-refl.png（uDebug 31：窗内只留倒影）、
// <名>-surf.png（uDebug 33：只留面状倒影，不含阅读灯光点）和 <名>.json（适应结果）。
// 统计：python handoff/T34-stats.py <目录> [<目录> ...]
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
const port = args.port || 5234;
const angle = args.angle || "d3d11";
const outDir = path.join(ROOT, args.out || "tmp/screenshot/T34/cur");
fs.mkdirSync(outDir, { recursive: true });
const DEFAULT_LIST = [
  "night-city", "night-city-on", "night-city-off",
  "night-city-econ", "night-city-on-econ", "night-city-off-econ",
  "dusk-earthshadow", "noon-cumulus",
];
const names = args.only ? String(args.only).split(",") : DEFAULT_LIST;
const LIGHT = { on: true, sleep: false, off: "off" };
const scenes = names.map((nm) => {
  const base = pickScenes([nm.replace(/(-(on|sleep|off|econ|ahead))+$/, "")])[0];
  if (!base) throw new Error(`未知场景 ${nm}`);
  const sc = { ...base, name: nm, p: { ...base.p } };
  for (const tok of nm.slice(base.name.length).split("-").filter(Boolean)) {
    if (tok in LIGHT) sc.p["cabin-light"] = LIGHT[tok];
    if (tok === "econ") sc.p["cabin-class"] = "economy";
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
  const dbg = (v) => page.evaluate((x) => (window.__voyage.sceneMat.uniforms.uDebug.value = x), v);
  for (const sc of scenes) {
    await page.evaluate(applyScene, { sc, defaults: DEFAULTS });
    // 频闪灯关掉（它随机出现在截图里，一大团白光，干扰倒影统计；T30 交接里提过）
    await page.evaluate(() => (window.__voyage.wingDebug.strobe = 0));
    if (args.eval) await page.evaluate(String(args.eval));
    await page.waitForTimeout(400);
    await page.screenshot({ path: path.join(outDir, `${sc.name}.png`), timeout: 60000 });
    const meter = await page.evaluate(() => {
      const ex = window.__voyage.exposure;
      const px = new Float32Array(8);
      ex.pass.renderer.readRenderTargetPixels(ex.adapted[0], 0, 0, 2, 1, px);
      return Array.from(px);
    });
    // 倒影单独拍：先冻住曝光适应（uDt 恒为 0），否则窗外置黑后窗内测光变暗、几百毫秒内曝光就被拉高，量出来的倒影偏亮
    const freeze = (on) => page.evaluate((f) => {
      const u = window.__voyage.exposure.adaptMat.uniforms.uDt;
      if (f) Object.defineProperty(u, "value", { configurable: true, get: () => 0, set: () => {} });
      else { delete u.value; u.value = 0; }
    }, on);
    await freeze(true);
    await dbg(31);
    await page.waitForTimeout(120);
    await page.screenshot({ path: path.join(outDir, `${sc.name}-refl.png`), timeout: 60000 });
    await dbg(33);
    await page.waitForTimeout(120);
    await page.screenshot({ path: path.join(outDir, `${sc.name}-surf.png`), timeout: 60000 });
    await dbg(0);
    await freeze(false);
    await page.evaluate(() => (window.__voyage.exposure.finalMat.uniforms.uDebugMask.value = true));
    await page.waitForTimeout(300);
    await page.screenshot({ path: path.join(outDir, `${sc.name}-mask.png`), timeout: 60000 });
    await page.evaluate(() => (window.__voyage.exposure.finalMat.uniforms.uDebugMask.value = false));
    fs.writeFileSync(path.join(outDir, `${sc.name}.json`), JSON.stringify({ scene: sc.name, meter }, null, 2));
    console.log(`${sc.name}: meter=${meter.map((x) => x.toFixed(3)).join(",")}`);
  }
} finally {
  await closeBrowserSafely(browser);
}
