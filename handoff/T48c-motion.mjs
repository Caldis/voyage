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
const ROUNDS = Number(args.rounds ?? 20);
const N = Number(args.n || 10);
const SEGS = Number(args.segs || 5);
const SETTLE = Number(args.settle || 700);
const [cx, cy, cw, ch] = String(args.crop || "400,700,800,450").split(",").map(Number);
const ALL_MODES = {
  // 返工后（已知闪光才扣）的参数只剩闪光期间的速率 uLocalRate（标量）；不闪时扣除量恒为 0，tau / inst 的差别只在频闪那 50 ms
  tau: "u.uNightLocal.value.y = 0.6; r.value = 4;",
  inst: "u.uNightLocal.value.y = 0.6; r.value = 1e6;",
  noLocal: "u.uNightLocal.value.y = 0; r.value = 4;",
};
// --modes tau,inst,noLocal（默认）
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
    //   每轮的模式顺序轮换（第 r 轮从第 r 个模式开始），抵消「画面慢慢离开城区」造成的先后偏差。
    //   --inpage：不截图，在页面里每个 rAF 紧跟主循环之后 readPixels 裁剪区（截图会让帧间隔忽长忽短，带时间常数的一方被这种
    //   不均匀的 dt 额外调制，量出来的抖动是假的），逐帧记整片均值与 16×16 分块均值，写 inpage.json
    const names = Object.keys(MODES);
    const inpage = {};
    for (let r = 0; r < SEGS; r++) {
      for (let j = 0; j < names.length; j++) {
        const m = names[(j + r) % names.length];
        await setMode(m);
        await page.waitForTimeout(SETTLE);
        if (args.inpage) {
          const res = await page.evaluate(async ({ crop, n }) => {
            const cv = document.querySelector("canvas");
            const gl = cv.getContext("webgl2");
            const sx = gl.drawingBufferWidth / cv.clientWidth, sy = gl.drawingBufferHeight / cv.clientHeight;
            const w = Math.round(crop[2] * sx), h = Math.round(crop[3] * sy);
            const x = Math.round(crop[0] * sx), y = gl.drawingBufferHeight - Math.round((crop[1] + crop[3]) * sy);
            const buf = new Uint8Array(w * h * 4);
            const T = 16, tw = Math.floor(w / T), th = Math.floor(h / T);
            const frames = [], dts = [];
            let last = performance.now();
            for (let i = 0; i < n; i++) {
              // 主循环的 rAF 回调先注册，同一帧里先于这里执行：读到的是刚画完的这一帧
              const now = await new Promise((res) => requestAnimationFrame(res));
              gl.bindFramebuffer(gl.FRAMEBUFFER, null);
              gl.readPixels(x, y, w, h, gl.RGBA, gl.UNSIGNED_BYTE, buf);
              let sum = 0;
              const tiles = new Float64Array(tw * th);
              for (let yy = 0; yy < th * T; yy++) for (let xx = 0; xx < tw * T; xx++) {
                const k = (yy * w + xx) * 4;
                const l = 0.2126 * buf[k] + 0.7152 * buf[k + 1] + 0.0722 * buf[k + 2];
                sum += l;
                tiles[Math.floor(yy / T) * tw + Math.floor(xx / T)] += l / (T * T);
              }
              frames.push({ mean: sum / (tw * th * T * T), tiles: Array.from(tiles, (v) => Math.round(v * 100) / 100) });
              dts.push(now - last); last = now;
            }
            return { frames, dts };
          }, { crop: [cx, cy, cw, ch], n: N });
          (inpage[m] ||= []).push(res);
          continue;
        }
        for (let i = 0; i < N; i++) {
          await raf2();
          await page.screenshot({ path: path.join(dir, `seq-${m}-${String(r).padStart(2, "0")}-${String(i).padStart(3, "0")}.png`), clip });
        }
      }
    }
    if (args.inpage) fs.writeFileSync(path.join(dir, "inpage.json"), JSON.stringify(inpage));
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
