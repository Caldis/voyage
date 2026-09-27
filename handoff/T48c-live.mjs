#!/usr/bin/env node
// T48c 飞行中某一刻的瞬态扣除对画面的实际作用（改自审查脚本 t48crev-live.mjs）。
// 冻结工具把瞬态扣除视为「直接收敛」，看不到飞行中的状态，所以：飞机照常飞 → 等频闪灭且离上次闪光 ≥ 0.4 s →
// 同一个 rAF 回调里 localDt = 0 并冻结（保持那一刻的平滑状态）→ 截 A；localDt = null（直接收敛，扣除 0）→ 截 B。
// A − B = 飞行中这一刻瞬态扣除让画面亮了多少（应 ≈ 0：巡航中没有瞬态）。
// 用法（apps/voyage 下）：node handoff/T48c-live.mjs --port 5224 --scenes-file <json> --out <dir> [--samples 4] [--only a,b] [--js "l.uErode.value.set(0, 1)"]
// 分析：python handoff/T48c-cfg/t48c_livean.py <dir>
import { chromium } from "playwright-core";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { DEFAULTS, applyScene, pinGeometry } from "../scripts/scenarios.mjs";
import { launchBrowser, closeBrowserSafely, resolveRepoPath } from "../scripts/lib/chrome.mjs";
import { readLock, waitForRelease } from "../scripts/lib/measure-lock.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.join(HERE, "..", "..", "..");
const args = {};
for (let i = 2; i < process.argv.length; i++) {
  const a = process.argv[i];
  if (a.startsWith("--")) args[a.slice(2)] = process.argv[i + 1] && !process.argv[i + 1].startsWith("--") ? process.argv[++i] : true;
}
const outDir = resolveRepoPath(REPO_ROOT, args.out);
fs.mkdirSync(outDir, { recursive: true });
const SAMPLES = Number(args.samples || 4);
let scenes = JSON.parse(fs.readFileSync(resolveRepoPath(REPO_ROOT, args["scenes-file"]), "utf8"));
if (args.only) { const only = String(args.only).split(","); scenes = scenes.filter((s) => only.includes(s.name)); }
if (readLock(REPO_ROOT)) await waitForRelease(REPO_ROOT, { log: (s) => console.log(`[live] ${s}`) });
const browser = await launchBrowser(chromium, { angle: "vulkan" });
try {
  const context = await browser.newContext({ viewport: { width: 1600, height: 1200 }, deviceScaleFactor: 1 });
  const page = await context.newPage();
  const errors = [];
  page.on("console", (m) => m.type() === "error" && errors.push(m.text()));
  await page.goto(`http://127.0.0.1:${args.port}/?dev=${Date.now()}`, { waitUntil: "commit", timeout: 180000 });
  await page.bringToFront();
  await page.waitForFunction(() => window.__voyageStartup, null, { timeout: 180000, polling: 500 });
  await page.evaluate(() => { const w = window.__voyage.weather; w.hold = true; w.heldIntensity = 0; });
  // --js：页面就绪后执行一次（v = __voyage、u = 曝光合成 uniforms、l = 局部适应 pass 的 uniforms），比较参数用
  if (args.js) await page.evaluate((js) => { const v = window.__voyage; new Function("v", "u", "l", js)(v, v.exposure.finalMat.uniforms, v.exposure.localMat.uniforms); }, String(args.js));
  const raf = (n) => page.evaluate(async (n) => { for (let i = 0; i < n; i++) await new Promise((r) => requestAnimationFrame(r)); }, n);
  for (const sc of scenes) {
    const e0 = errors.length;
    await page.evaluate(applyScene, { sc, defaults: DEFAULTS, settle: true });
    await page.evaluate(pinGeometry, sc);
    await page.waitForFunction(() => !window.__voyage.ground || window.__voyage.ground.pending === 0, null, { timeout: 120000, polling: 500 }).catch(() => console.log("等瓦片超时"));
    await page.waitForTimeout(3000);
    for (let i = 0; i < SAMPLES; i++) {
      await page.waitForTimeout(700 + 350 * i);
      const info = await page.evaluate(async () => {
        const v = window.__voyage;
        for (;;) {
          const now = await new Promise((r) => requestAnimationFrame(r));
          const ph = (now / 1000) % 1.1;
          if (ph > 0.6 && ph < 1.0) { v.exposure.localDt = 0; v.freeze(true); return { ph, pending: v.ground?.pending }; }
        }
      });
      await raf(30);
      await page.screenshot({ path: path.join(outDir, `${sc.name}.${i}.hold.png`) });
      await page.evaluate(() => { window.__voyage.exposure.localDt = null; });
      await raf(30);
      await page.screenshot({ path: path.join(outDir, `${sc.name}.${i}.conv.png`) });
      // 噪声底：再等 30 帧拍一张同状态的（冻结期间瓦片 / 细节仍可能落地，A − B 里「两个方向都有」的差来自这里）
      await raf(30);
      await page.screenshot({ path: path.join(outDir, `${sc.name}.${i}.conv2.png`) });
      await page.evaluate(() => window.__voyage.freeze(false));
      console.log(sc.name, i, JSON.stringify(info));
    }
    const errs = errors.slice(e0);
    console.log(`${sc.name}: errors=${errs.length} cors=${errs.filter((t) => /CORS|eox/i.test(t)).length}`);
  }
} finally {
  await closeBrowserSafely(browser);
}
