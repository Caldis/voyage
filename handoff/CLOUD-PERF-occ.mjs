// PERF-2 自测：同一页面、同一组 uniform 下，云步进「查占据网格」与「不查」的 A/B：
//  - 逐像素对比 raw 目标（RGB 辐亮度 + T），输出差异统计和差异图；
//  - 用 timer query 交替测两种的云步进 GPU 时间，以及重建一次网格的 GPU 时间；
//  - 截图（正常运行的画面）；收集控制台 error。
// 用法：node apps/voyage/handoff/CLOUD-PERF-occ.mjs --port 5250 [--angle d3d11] [--only a,b] [--out tmp/screenshot/occ] [--noab]
import { createRequire } from "node:module";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(HERE, "..", "..", "..");  // 放在 apps/voyage/handoff/ 下
const VOY = path.join(ROOT, "apps", "voyage", "scripts");
const { chromium } = createRequire(path.join(ROOT, "apps", "voyage", "package.json"))("playwright-core");
const { DEFAULTS, applyScene, pickScenes } = await import("file://" + path.join(VOY, "scenarios.mjs").replace(/\\/g, "/"));
const { launchBrowser, closeBrowserSafely } = await import("file://" + path.join(VOY, "lib", "chrome.mjs").replace(/\\/g, "/"));

const args = {};
const av = process.argv.slice(2);
for (let i = 0; i < av.length; i++) if (av[i].startsWith("--")) { const n = av[i + 1]; if (n === undefined || n.startsWith("--")) args[av[i].slice(2)] = true; else { args[av[i].slice(2)] = n; i++; } }
const port = args.port || "5250";
const only = args.only ? args.only.split(",") : ["storm-day", "typhoon-eye", "typhoon-bands", "typhoon-outer"];
const outDir = path.join(ROOT, args.out || "tmp/screenshot/occ");
fs.mkdirSync(outDir, { recursive: true });

const browser = await launchBrowser(chromium, { angle: args.angle || "d3d11" });
const errors = [];
try {
  const ctx = await browser.newContext({ viewport: { width: 1600, height: 1200 }, deviceScaleFactor: 1 });
  const page = await ctx.newPage();
  page.on("console", (m) => { if (m.type() === "error" || m.type() === "warning") errors.push(`[${m.type()}] ${m.text()}`); });
  page.on("pageerror", (e) => errors.push("[pageerror] " + e.message));
  await page.goto(`http://127.0.0.1:${port}/?occ=${Date.now()}`, { waitUntil: "commit", timeout: 180000 });
  await page.bringToFront();
  await page.waitForFunction(() => window.__voyageStartup, null, { timeout: 300000, polling: 500 });
  if (args.pre) {
    // 形如 [["找","换"],...] 的 JSON 文件：替换云步进源码后重编（对照实验）
    const reps = JSON.parse(fs.readFileSync(args.pre, "utf8"));
    await page.evaluate((reps) => {
      const m = window.__voyage.clouds.marchMat;
      let s = m.fragmentShader;
      for (const [a, b] of reps) { if (!s.includes(a)) throw new Error("pattern miss: " + a); s = s.split(a).join(b); }
      m.fragmentShader = s;
      m.needsUpdate = true;
    }, reps);
  }
  for (const sc of pickScenes(only)) {
    await page.evaluate(applyScene, { sc, defaults: DEFAULTS });
    await page.waitForFunction(() => window.__voyage.clouds.occState === "ready", null, { timeout: 180000, polling: 250 });
    await page.waitForTimeout(1500);
    await page.screenshot({ path: path.join(outDir, `${sc.name}.png`) });
    if (args.noab) { console.log(sc.name, "截图完成"); continue; }
    const res = await page.evaluate(async ([cmp, avgN]) => {
      const c = window.__voyage.clouds;
      const r = c.pass.renderer;
      const m0 = c.marchMat;
      let m2 = null;
      if (cmp) {
        if (!window.__cmpMat) {
          const mm = m0.clone();
          mm.uniforms = m0.uniforms;
          let s = m0.fragmentShader;
          for (const [a, b] of cmp) { if (!s.includes(a)) throw new Error("pattern miss: " + a); s = s.split(a).join(b); }
          mm.fragmentShader = s;
          window.__cmpMat = mm;
        }
        m2 = window.__cmpMat;
      }
      const m = m0;
      const matFor = (valid) => (m2 ? (valid ? m2 : m0) : m0);
      const gl = r.getContext();
      const ext = gl.getExtension("EXT_disjoint_timer_query_webgl2");
      c.occEnabled = true;
      c.updateOccupancy();
      const w = c.raw.width, h = c.raw.height;
      const read = (valid, frame = 5) => {
        m.uniforms.uOccValid.value = m2 ? 1 : valid;
        m.uniforms.uFrame.value = frame;
        c.pass.render(matFor(valid), c.raw);
        const b = new Uint16Array(w * h * 4);
        r.readRenderTargetPixels(c.raw, 0, 0, w, h, b);
        return b;
      };
      // avg > 1：每种各取 avg 个抖动帧求平均（近似时域累积后的画面），噪声底用另外 avg 帧的平均
      const hf0 = (x) => { const s = x >> 15, e = (x >> 10) & 31, f = x & 1023; const v = e === 0 ? f * 2 ** -24 : (1 + f / 1024) * 2 ** (e - 15); return s ? -v : v; };
      const readAvg = (valid, f0, n) => {
        const acc = new Float32Array(w * h * 4);
        for (let k = 0; k < n; k++) { const b = read(valid, f0 + k); for (let i = 0; i < acc.length; i++) acc[i] += hf0(b[i]) / n; }
        // 编回半精度位模式，后面的统计代码不用改
        const out = new Uint16Array(acc.length);
        const f32 = new Float32Array(1), u32 = new Uint32Array(f32.buffer);
        for (let i = 0; i < acc.length; i++) {
          f32[0] = acc[i]; const x = u32[0];
          const sgn = (x >>> 16) & 0x8000; let e = ((x >>> 23) & 0xff) - 127 + 15; const m = (x >>> 13) & 0x3ff;
          out[i] = e <= 0 ? sgn : e >= 31 ? sgn | 0x7c00 : sgn | (e << 10) | m;
        }
        return out;
      };
      const N = avgN;
      const on = N > 1 ? readAvg(1, 0, N) : read(1), off = N > 1 ? readAvg(0, 0, N) : read(0), off6 = N > 1 ? readAvg(0, N, N) : read(0, 6);
      const hf = (x) => {
        const s = x >> 15, e = (x >> 10) & 31, f = x & 1023;
        const v = e === 0 ? f * 2 ** -24 : e === 31 ? Infinity : (1 + f / 1024) * 2 ** (e - 15);
        return s ? -v : v;
      };
      // 噪声底：同一材质、只换抖动帧号（uFrame 5 → 6）的逐帧差异
      let fT = 0, fL = 0, fSum = 0, fN = 0;
      for (let i = 0; i < w * h; i++) {
        const dT = Math.abs(hf(off[i * 4 + 3]) - hf(off6[i * 4 + 3]));
        const La = hf(off[i * 4]) + hf(off[i * 4 + 1]) + hf(off[i * 4 + 2]);
        const Lb = hf(off6[i * 4]) + hf(off6[i * 4 + 1]) + hf(off6[i * 4 + 2]);
        const dL = Math.abs(La - Lb) / Math.max(La, Lb, 1e-3);
        if (dT > 0.02) fT++;
        if (dL > 0.05) fL++;
        if (La > 0) { fSum += dL; fN++; }
      }
      const floor = { fT, fL, fMean: fSum / Math.max(fN, 1) };
      let nT = 0, nL = 0, maxT = 0, sumL = 0, n = 0;
      const img = new ImageData(w, h);
      for (let i = 0; i < w * h; i++) {
        const Ton = hf(on[i * 4 + 3]), Toff = hf(off[i * 4 + 3]);
        const Lon = hf(on[i * 4]) + hf(on[i * 4 + 1]) + hf(on[i * 4 + 2]);
        const Loff = hf(off[i * 4]) + hf(off[i * 4 + 1]) + hf(off[i * 4 + 2]);
        const dT = Math.abs(Ton - Toff);
        const dL = Math.abs(Lon - Loff) / Math.max(Loff, Lon, 1e-3);
        if (dT > 0.02) nT++;
        if (dL > 0.05) nL++;
        maxT = Math.max(maxT, dT);
        if (Loff > 0) { sumL += dL; n++; }
        const k = ((h - 1 - Math.floor(i / w)) * w + (i % w)) * 4;
        img.data[k] = Math.min(255, dT * 2550);
        img.data[k + 1] = Math.min(255, dL * 2550);
        img.data[k + 2] = 0;
        img.data[k + 3] = 255;
      }
      const cv = document.createElement("canvas");
      cv.width = w; cv.height = h;
      cv.getContext("2d").putImageData(img, 0, 0);
      const diffPng = cv.toDataURL("image/png");
      // GPU 计时：交替 3 轮，每轮 20 次
      const timeIt = (fn) => { const q = gl.createQuery(); gl.beginQuery(ext.TIME_ELAPSED_EXT, q); fn(); gl.endQuery(ext.TIME_ELAPSED_EXT); return q; };
      const qs = [];
      for (let k = 0; k < 3; k++) for (const valid of [1, 0]) {
        m.uniforms.uOccValid.value = m2 ? 1 : valid;
        const mv = matFor(valid);
        qs.push([valid, timeIt(() => { for (let j = 0; j < 20; j++) c.pass.render(mv, c.raw); })]);
      }
      m.uniforms.uOccValid.value = 1;
      const qbs = [0, 1, 2].map(() => timeIt(() => { c.occKey = ""; c.updateOccupancy(true); }));
      const qb = qbs[2];
      const wait = async (q) => { while (!gl.getQueryParameter(q, gl.QUERY_RESULT_AVAILABLE)) await new Promise((res) => setTimeout(res, 5)); return gl.getQueryParameter(q, gl.QUERY_RESULT) / 1e6; };
      const tOn = [], tOff = [];
      for (const [valid, q] of qs) (valid ? tOn : tOff).push((await wait(q)) / 20);
      const qss = [0, 1, 2].map(() => timeIt(() => { c.shadowKey = ""; c.updateShadow(); }));
      const ss = []; for (const q of qss) ss.push(await wait(q));
      window.__shadowMs = ss.sort((x, y) => x - y)[1];
      const bs = []; for (const q of qbs) bs.push(await wait(q));
      const build = bs.sort((x, y) => x - y)[1];
      return { shadowMs: window.__shadowMs, w, h, nT, nL, maxT, meanRel: sumL / Math.max(n, 1), floor, tOn, tOff, build, disjoint: gl.getParameter(ext.GPU_DISJOINT_EXT), diffPng };
    }, [args.cmp ? JSON.parse(fs.readFileSync(args.cmp, "utf8")) : null, +(args.avg || 1)]);
    fs.writeFileSync(path.join(outDir, `${sc.name}-diff.png`), Buffer.from(res.diffPng.split(",")[1], "base64"));
    const med = (a) => [...a].sort((x, y) => x - y)[Math.floor(a.length / 2)];
    console.log(`${sc.name}: 步进 ${args.cmp ? "变体" : "查网格"} ${med(res.tOn).toFixed(2)} ms（${res.tOn.map((x) => x.toFixed(2)).join("/")}）  ${args.cmp ? "原样" : "不查"} ${med(res.tOff).toFixed(2)} ms（${res.tOff.map((x) => x.toFixed(2)).join("/")}）  建网格 ${res.build.toFixed(2)} ms  建云影图 ${res.shadowMs.toFixed(2)} ms  disjoint=${res.disjoint}`);
    console.log(`   噪声底（只换抖动帧）：|ΔT|>0.02 ${res.floor.fT} 像素，|ΔL|>5% ${res.floor.fL} 像素，平均相对差 ${res.floor.fMean.toExponential(2)}`);
    console.log(`   差异：|ΔT|>0.02 ${res.nT} 像素，|ΔL|>5% ${res.nL} 像素（共 ${res.w}×${res.h}），max|ΔT| ${res.maxT.toFixed(3)}，云像素平均相对差 ${res.meanRel.toExponential(2)}`);
  }
} finally {
  console.log("控制台 error / warning：" + (errors.length ? "\n  " + errors.slice(0, 30).join("\n  ") : "无"));
  await closeBrowserSafely(browser);
}
process.exit(0);
