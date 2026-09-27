#!/usr/bin/env node
// T48c 运动中对照：不冻结、飞机照常飞，比较局部适应「带时间常数（tau）/ 即时（inst，= T48b）/ 关（noLocal）」。
//  1. 交替块：每轮依次切到三种模式，各等 --settle ms（让时间滤波收敛）再截同一裁剪——看时间常数在画面移动时
//     让城区整体亮了多少（移动时新进来的亮区还没被压下去）；
//  2. 连续段：三种模式轮流，每段连续截 --n 帧（每帧间隔两个 rAF），共 --segs 轮——看整片亮度的帧间抖动（呼吸）。
// 用法（apps/voyage 下）：node handoff/T48c-motion.mjs --port 5224 --scenes-file <json> --out <dir> [--crop x,y,w,h] [--rounds 20] [--segs 5] [--n 10] [--settle 700] [--modes tau,inst,noLocal]
import { chromium } from "playwright-core";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { DEFAULTS, applyScene } from "../scripts/scenarios.mjs";
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
const scenes = JSON.parse(fs.readFileSync(resolveRepoPath(REPO_ROOT, args["scenes-file"]), "utf8"));
const ROUNDS = Number(args.rounds || 20);
const N = Number(args.n || 10);
const SEGS = Number(args.segs || 5);
const SETTLE = Number(args.settle || 700);
const [cx, cy, cw, ch] = String(args.crop || "400,700,800,450").split(",").map(Number);
const ALL_MODES = {
  tau: "u.uNightLocal.value.y = 0.6; r.value.set(4, 10);",
  inst: "u.uNightLocal.value.y = 0.6; r.value.set(1e6, 1e6);",
  noLocal: "u.uNightLocal.value.y = 0; r.value.set(4, 10);",
  tauF: "u.uNightLocal.value.y = 0.6; r.value.set(4, 1e6);",   // 变暗即时
  tau15: "u.uNightLocal.value.y = 0.6; r.value.set(1 / 0.15, 10);",
};
// --modes tau,inst,noLocal（默认）；可选 tauF（变暗即时）、tau15（变亮 τ 0.15 s）
const MODES = Object.fromEntries(String(args.modes || "tau,inst,noLocal").split(",").map((m) => [m, ALL_MODES[m]]));
if (readLock(REPO_ROOT)) await waitForRelease(REPO_ROOT, { log: (s) => console.log(`[motion] ${s}`) });
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
  const setMode = (m) => page.evaluate((js) => { const v = window.__voyage; const u = v.exposure.finalMat.uniforms; const r = v.exposure.localMat.uniforms.uLocalRate; new Function("v", "u", "r", js)(v, u, r); }, MODES[m]);
  const raf2 = () => page.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))));
  for (const sc of scenes) {
    const e0 = errors.length;
    await page.evaluate(applyScene, { sc, defaults: DEFAULTS, settle: true });
    await page.waitForFunction(() => !window.__voyage.ground || window.__voyage.ground.pending === 0, null, { timeout: 120000, polling: 500 }).catch(() => console.log("等瓦片超时"));
    await page.evaluate(() => { const w = window.__voyage.wingDebug; if (w) w.strobe = 0; });
    await page.waitForTimeout(3000);
    const dir = path.join(outDir, sc.name);
    fs.mkdirSync(dir, { recursive: true });
    const clip = { x: cx, y: cy, width: cw, height: ch };
    const t0 = Date.now();
    // 连续段放前面（画面还在城区上），并且按模式轮流、每段 --n 帧：三种模式看到的内容相近，帧间抖动才可比
    for (let r = 0; r < SEGS; r++) {
      for (const m of Object.keys(MODES)) {
        await setMode(m);
        await page.waitForTimeout(SETTLE);
        for (let i = 0; i < N; i++) {
          await raf2();
          await page.screenshot({ path: path.join(dir, `seq-${m}-${String(r).padStart(2, "0")}-${String(i).padStart(3, "0")}.png`), clip });
        }
      }
    }
    for (let i = 0; i < ROUNDS; i++) {
      for (const m of Object.keys(MODES)) {
        await setMode(m);
        await page.waitForTimeout(SETTLE);
        await page.screenshot({ path: path.join(dir, `blk-${m}-${String(i).padStart(3, "0")}.png`), clip });
      }
    }
    await setMode("tau");
    const errs = errors.slice(e0);
    console.log(`${sc.name}: 用时 ${((Date.now() - t0) / 1000).toFixed(1)} s，pending=${await page.evaluate(() => window.__voyage.ground?.pending)}，errors=${errs.length}，cors=${errs.filter((t) => /CORS|eox/i.test(t)).length}`);
  }
} finally {
  await closeBrowserSafely(browser);
}
