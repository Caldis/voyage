#!/usr/bin/env node
// T22：机翼表面对照截图（私有 headless，复用 scenarios.mjs 的场景表）。
// 用法：node handoff/T22-shots.mjs --port 5222 [--angle vulkan] [--only a,b] [--debug 0,1] [--out tmp/screenshot/T22/x] [--burst 3]
//   --debug：uWingDebug 取值列表（按位：1 去掉油罐鼓包，4 去掉环境反射……），每个值各拍一张
//   --eval：每个场景应用后在页面里执行的一段 JS（例如改 uWingSteps 做对照）
//   --evals：分号分隔的几段 JS，交替测机翼 pass 的耗时（中位数）
//   --burst：颠簸连拍张数（turbulence 0.6，每张间隔约 120 ms），看闪烁
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
const port = args.port || 5222;
const angle = args.angle || "d3d11";
const debugs = String(args.debug ?? "0").split(",").map(Number);
const burst = Number(args.burst || 0);
const outDir = path.join(ROOT, args.out || "tmp/screenshot/T22/cur");
fs.mkdirSync(outDir, { recursive: true });
// 额外的视角变体：<场景名>-ahead（「看前方」预设）、<场景名>-close（「贴窗」预设），头的位置取自 view-presets.ts（右侧座位）
const VIEW_HEADS = { ahead: [-0.42, 0.1, -0.5], close: [0, 0, -0.03] };
const names = args.only ? String(args.only).split(",") : ["sunset-wing", "noon-cumulus", "night-city", "in-cloud", "route-hnd-cts"];
const scenes = names.map((nm) => {
  const m = nm.match(/^(.*)-(ahead|close)$/);
  if (!m) return pickScenes([nm])[0];
  const base = pickScenes([m[1]])[0];
  return { ...base, name: nm, head: VIEW_HEADS[m[2]] };
});

const browser = await launchBrowser(chromium, { angle });
try {
  const context = await browser.newContext({ viewport: { width: 1600, height: 1200 }, deviceScaleFactor: 1 });
  const page = await context.newPage();
  await page.goto(`http://127.0.0.1:${port}/?dev=${Date.now()}`, { waitUntil: "commit", timeout: 180000 });
  await page.waitForFunction(() => window.__voyageStartup, null, { timeout: 300000, polling: 500 });
  // 机翼程序是后台 compileAsync，等它真正出图
  await page.waitForTimeout(3000);
  for (const sc of scenes) {
    await page.evaluate(applyScene, { sc, defaults: DEFAULTS });
    if (args.eval) await page.evaluate(String(args.eval));
    for (const dbg of debugs) {
      await page.evaluate((d) => { window.__voyage.wingMat.uniforms.uWingDebug.value = d; window.__voyage.wingDebug.strobe = 0; }, dbg);
      await page.waitForTimeout(600);
      const f = path.join(outDir, `${sc.name}-dbg${dbg}.png`);
      await page.screenshot({ path: f, timeout: 60000 });
      console.log(f);
    }
    if (burst > 0) {
      await page.evaluate(() => { window.__voyage.wingMat.uniforms.uWingDebug.value = 0; window.__voyage.state.turbulence = 0.6; });
      for (let i = 0; i < burst; i++) {
        await page.waitForTimeout(120);
        await page.screenshot({ path: path.join(outDir, `${sc.name}-burst${i}.png`), timeout: 60000 });
      }
      await page.evaluate(() => { window.__voyage.state.turbulence = 0.03; });
    }
    // --evals：分号分隔的多段 JS，交替执行、每段各测机翼 pass 5 轮 × 60 帧，取中位数（对照开销）
    const variants = args.evals ? String(args.evals).split(";") : [""];
    const res = variants.map(() => []);
    for (let round = 0; round < 5; round++) {
      for (let k = 0; k < variants.length; k++) {
        if (variants[k]) await page.evaluate(variants[k]);
        await page.evaluate(() => window.__voyage.benchWing(10));
        res[k].push(await page.evaluate(() => window.__voyage.benchWing(60)));
      }
    }
    variants.forEach((v, k) => {
      const m = res[k].sort((a, b) => a - b)[2];
      console.log(`${sc.name}: benchWing 中位数 ${m.toFixed(3)} ms  [${v || "当前"}]  全部 ${res[k].map((x) => x.toFixed(2)).join(" ")}`);
    });
  }
} finally {
  await closeBrowserSafely(browser);
}
