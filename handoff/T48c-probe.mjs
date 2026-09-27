#!/usr/bin/env node
// T48c 飞行中读瞬态扣除的粗网格状态（R = 平滑的线性亮度、G = 带符号的线性变化），看巡航中 G 的分布。
// 用法（apps/voyage 下）：node handoff/T48c-probe.mjs --port 5224 --scenes-file <json> --only night-city-off [--frames 40]
import { chromium } from "playwright-core";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { DEFAULTS, applyScene, pinGeometry } from "../scripts/scenarios.mjs";
import { launchBrowser, closeBrowserSafely, resolveRepoPath } from "../scripts/lib/chrome.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.join(HERE, "..", "..", "..");
const args = {};
for (let i = 2; i < process.argv.length; i++) {
  const a = process.argv[i];
  if (a.startsWith("--")) args[a.slice(2)] = process.argv[i + 1] && !process.argv[i + 1].startsWith("--") ? process.argv[++i] : true;
}
let scenes = JSON.parse(fs.readFileSync(resolveRepoPath(REPO_ROOT, args["scenes-file"]), "utf8"));
if (args.only) { const only = String(args.only).split(","); scenes = scenes.filter((s) => only.includes(s.name)); }
const FR = Number(args.frames || 40);
const browser = await launchBrowser(chromium, { angle: "vulkan" });
try {
  const page = await (await browser.newContext({ viewport: { width: 1600, height: 1200 }, deviceScaleFactor: 1 })).newPage();
  await page.goto(`http://127.0.0.1:${args.port}/?dev=${Date.now()}`, { waitUntil: "commit", timeout: 180000 });
  await page.bringToFront();
  await page.waitForFunction(() => window.__voyageStartup, null, { timeout: 180000, polling: 500 });
  await page.evaluate(() => { const w = window.__voyage.weather; w.hold = true; w.heldIntensity = 0; });
  for (const sc of scenes) {
    await page.evaluate(applyScene, { sc, defaults: DEFAULTS, settle: true });
    await page.evaluate(pinGeometry, sc);
    await page.waitForFunction(() => !window.__voyage.ground || window.__voyage.ground.pending === 0, null, { timeout: 120000, polling: 500 }).catch(() => {});
    await page.evaluate(() => { if (window.__voyage.wingDebug) window.__voyage.wingDebug.strobe = 0; });
    await page.waitForTimeout(3000);
    const res = await page.evaluate(async (FR) => {
      const ex = window.__voyage.exposure, r = ex.pass.renderer;
      const out = [];
      for (let f = 0; f < FR; f++) {
        await new Promise((res) => requestAnimationFrame(res));
        const rt = ex.local[0];
        const buf = new Float32Array(rt.width * rt.height * 4);
        r.readRenderTargetPixels(rt, 0, 0, rt.width, rt.height, buf);
        // RG 目标读回的步长按实际读到的通道数判断：前半为 RG 交错
        const n = rt.width * rt.height;
        let pos = 0, neg = 0, npos = 0, maxRel = 0, sumL = 0;
        for (let i = 0; i < n; i++) {
          const ls = buf[i * 2], d = buf[i * 2 + 1];
          const L = ls; // 状态是线性亮度
          if (d > 0) { pos += d; npos += d > 0.05 * L ? 1 : 0; maxRel = Math.max(maxRel, d / Math.max(L, 1e-30)); } else neg += d;
          sumL += L;
        }
        out.push({ pos: pos / sumL, neg: neg / sumL, npos, maxRel });
      }
      return out;
    }, FR);
    const m = (k) => res.reduce((a, b) => a + b[k], 0) / res.length;
    console.log(`${sc.name}: 正变化/总亮 ${m("pos").toFixed(4)} 负 ${m("neg").toFixed(4)} 变亮 >5% 的格 ${m("npos").toFixed(0)} 最大相对 ${Math.max(...res.map((x) => x.maxRel)).toFixed(2)}`);
  }
} finally {
  await closeBrowserSafely(browser);
}
