#!/usr/bin/env node
// STROBE-FLASH：飞行中逐帧读回整个画布（每个 rAF 紧跟主循环 readPixels，不截图），量翼尖频闪帧相对闪前几帧的
// 整窗 / 分区亮度跳变，并逐帧记 uStrobe 与自动曝光的适应状态（窗外对数均值 o、舱内 c、窗外线性均值 h）。
// 用法：node handoff/STROBE-FLASH-live.mjs --port 5263 --jobs handoff/STROBE-FLASH-jobs.json [--frames 360] [--out tmp/screenshot/STROBE-FLASH/live]
// jobs：[{ name, scene: 场景名或对象, pre?: js, variants: [{ name, js? }] }]；变体 js 里 v = window.__voyage，
//   每个变体跑完会把 js 里用 keep(obj, key) 记下的属性复原（变体之间互不影响）。
// 区域：窗外遮罩（曝光合成的 uDebugMask）把画面分成「舱内」「窗内」；窗内再按离频闪灯芯的屏幕距离分 近 < 80 px / 中 80–250 / 远 > 250。
// 灯芯位置 = 冻结后频闪钉亮 / 钉灭两帧显示差最大的像素。
// 指标（显示 0–255 的亮度 Y）：
//   跳变 = 每段频闪（连续 uStrobe ≥ 0.5 的帧）里区域均值的最大值 − 该段开始前 3 帧的均值（取各段平均，另给最大）；
//   爆闪像素 = 窗内远区里「闪亮帧 − 闪前帧 ≥ 8 级」的像素占远区的比例（按 4× 下采样的亮度图）；
//   闪烁像素（不含频闪）= 去掉频闪帧及其前后帧后，时间二阶差 > 16 级的帧占比 > 5% 的像素数（窗内远区，4× 下采样）。
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright-core";
import { DEFAULTS, applyScene, pinGeometry, SCENES } from "../scripts/scenarios.mjs";
import { launchBrowser, closeBrowserSafely } from "../scripts/lib/chrome.mjs";
import { groundSettle } from "../scripts/lib/ab-live.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, "../../..");
const args = {};
for (let i = 2; i < process.argv.length; i++) {
  const a = process.argv[i];
  if (a.startsWith("--")) args[a.slice(2)] = process.argv[i + 1] && !process.argv[i + 1].startsWith("--") ? process.argv[++i] : true;
}
const port = args.port || 5263;
const frames = +(args.frames || 360);
const outDir = path.resolve(REPO, args.out || "tmp/screenshot/STROBE-FLASH/live");
fs.mkdirSync(outDir, { recursive: true });
const jobs = JSON.parse(fs.readFileSync(path.resolve(REPO, "apps/voyage", args.jobs), "utf8"));
const only = args.only ? String(args.only).split(",") : null;

const browser = await launchBrowser(chromium, { angle: "d3d11" });
const results = {};
try {
  for (const job of jobs) {
    if (only && !only.includes(job.name)) continue;
    const ctx = await browser.newContext({ viewport: { width: 1600, height: 1200 }, deviceScaleFactor: 1 });
    const page = await ctx.newPage();
    const errors = [];
    page.on("pageerror", (e) => errors.push(e.message));
    page.on("console", (m) => { if (m.type() === "error" && !/eox\.at|tiles|CORS|net::ERR/i.test(m.text())) errors.push(m.text()); });
    await page.goto(`http://127.0.0.1:${port}/?dev=${Date.now()}&voyage=0${job.query || ""}`, { waitUntil: "commit", timeout: 180000 });
    await page.bringToFront();
    await page.waitForFunction(() => window.__voyageStartup, null, { timeout: 180000, polling: 500 });
    const renderer = await page.evaluate(() => {
      const gl = document.createElement("canvas").getContext("webgl2");
      const e = gl.getExtension("WEBGL_debug_renderer_info");
      return gl.getParameter(e.UNMASKED_RENDERER_WEBGL);
    });
    if (/swiftshader|warp/i.test(renderer)) throw new Error(`软渲染：${renderer}`);
    const sc = typeof job.scene === "string" ? SCENES.find((s) => s.name === job.scene) : job.scene;
    if (!sc) throw new Error(`没有场景 ${job.scene}`);
    await page.evaluate(() => {
      const el = document.getElementById("quality");
      if (el) { el.value = "high"; el.dispatchEvent(new Event("change", { bubbles: true })); }
      const w = window.__voyage.weather; w.hold = true; w.heldIntensity = 0; // 不让闪电混进来
    });
    await page.evaluate(applyScene, { sc, defaults: DEFAULTS, settle: true });
    await page.evaluate(pinGeometry, sc);
    if (job.pre) await page.evaluate(new Function(`return (async () => { const v = window.__voyage; ${job.pre} })()`));
    await page.evaluate(() => new Promise((r) => { let k = 0; const f = () => (++k >= 90 ? r() : requestAnimationFrame(f)); requestAnimationFrame(f); }));
    if (sc.ground) { await page.evaluate(() => window.__voyage.freeze(true)); await groundSettle(page, 120000).catch(() => {}); await page.evaluate(() => window.__voyage.freeze(false)); }
    // 区域掩码：窗外遮罩 + 灯芯位置（冻结、频闪钉亮 / 钉灭）
    const geo = await page.evaluate(async () => {
      const v = window.__voyage;
      const gl = v.clouds.pass.renderer.getContext();
      const W = gl.drawingBufferWidth, H = gl.drawingBufferHeight;
      const raf = (n = 1) => new Promise((r) => { let k = 0; const f = () => (++k >= n ? r() : requestAnimationFrame(f)); requestAnimationFrame(f); });
      const read = () => { const b = new Uint8Array(W * H * 4); gl.bindFramebuffer(gl.FRAMEBUFFER, null); gl.readPixels(0, 0, W, H, gl.RGBA, gl.UNSIGNED_BYTE, b); return b; };
      v.freeze(true);
      v.exposure.finalMat.uniforms.uDebugMask.value = true; await raf(3);
      const m = read();
      v.exposure.finalMat.uniforms.uDebugMask.value = false;
      v.wingDebug.strobe = 1; await raf(4); const a = read();
      v.wingDebug.strobe = 0; await raf(4); const b = read();
      v.wingDebug.strobe = null;
      let best = -1, bx = 0, by = 0;
      for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
        const k = (y * W + x) * 4;
        const d = (a[k] + a[k + 1] + a[k + 2]) - (b[k] + b[k + 1] + b[k + 2]);
        if (d > best) { best = d; bx = x; by = y; }
      }
      // 区域编号（按 GL 行序，自下而上）：0 舱内、1 窗内近、2 窗内中、3 窗内远
      const reg = new Uint8Array(W * H);
      for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
        const k = y * W + x;
        if (m[k * 4] < 128) { reg[k] = 0; continue; }
        const r = Math.hypot(x - bx, y - by);
        reg[k] = r < 80 ? 1 : r < 250 ? 2 : 3;
      }
      window.__sfReg = reg;
      v.freeze(false);
      return { W, H, lampX: bx, lampY: H - 1 - by, lampDiff: best };
    });
    console.log(`\n== ${job.name}（${renderer.slice(0, 60)}…）灯芯屏幕位置 ${geo.lampX},${geo.lampY}（钉亮 − 钉灭 RGB 和 ${geo.lampDiff}）`);
    results[job.name] = { geo, variants: {} };
    for (const va of job.variants) {
      if (va.shot) {
        // 截图变体：套用 js → 冻结 → 频闪钉灭若干帧（闪光扣除的状态收敛到闪前）→ localDt = 0 保持状态 → 钉亮（模拟闪光第一帧）→ 截图；
        // 另截一张钉灭的。冻结时自动曝光不动、闪光扣除按「闪光前」的状态，和飞行中频闪第一帧一致（除了飞机没在动）
        const tag = `${job.name}_${va.name}`;
        await page.evaluate(async (js) => {
          const v = window.__voyage;
          const saved = (window.__sfSaved = []);
          const keep = (o, k) => saved.push([o, k, o[k]]);
          const patch = (m, pairs) => {
            keep(m, "fragmentShader");
            let s = m.fragmentShader;
            for (const [a, b] of pairs) { if (!s.includes(a)) throw new Error("patch 找不到：" + a.slice(0, 80)); s = s.split(a).join(b); }
            m.fragmentShader = s;
            m.needsUpdate = true;
          };
          if (js) await new Function("v", "keep", "patch", `return (async () => { ${js} })()`)(v, keep, patch);
          const raf = (n) => new Promise((r) => { let k = 0; const f = () => (++k >= n ? r() : requestAnimationFrame(f)); requestAnimationFrame(f); });
          v.freeze(true);
          v.exposure.localDt = null;
          v.wingDebug.strobe = 0;
          await raf(30);
        }, va.js || "");
        await page.screenshot({ path: path.join(outDir, `${tag}_off.png`) });
        await page.evaluate(async () => {
          const v = window.__voyage;
          const raf = (n) => new Promise((r) => { let k = 0; const f = () => (++k >= n ? r() : requestAnimationFrame(f)); requestAnimationFrame(f); });
          v.exposure.localDt = 0;
          v.wingDebug.strobe = 1;
          await raf(3);
        });
        await page.screenshot({ path: path.join(outDir, `${tag}_on.png`) });
        await page.evaluate(async () => {
          const v = window.__voyage;
          v.exposure.localDt = null;
          v.wingDebug.strobe = null;
          for (const [o, k, val] of window.__sfSaved.reverse()) { o[k] = val; if (k === "fragmentShader") o.needsUpdate = true; }
          v.freeze(false);
        });
        console.log(`${va.name}（截图）：${tag}_off.png / _on.png`);
        continue;
      }
      if (va.probe) {
        // 探针变体：只跑 js、打印返回值，不录帧
        const r = await page.evaluate(async (js) => new Function("v", `return (async () => { ${js} })()`)(window.__voyage), va.js);
        console.log(`${va.name}（探针）：${JSON.stringify(r)}`);
        continue;
      }
      const rec = await page.evaluate(async ({ js, frames }) => {
        const v = window.__voyage;
        const saved = [];
        const keep = (o, k) => saved.push([o, k, o[k]]);
        // 改着色器原文：patch(材质, [[查找, 替换], …])，找不到直接报错
        const patch = (m, pairs) => {
          keep(m, "fragmentShader");
          let s = m.fragmentShader;
          for (const [a, b] of pairs) { if (!s.includes(a)) throw new Error("patch 找不到：" + a.slice(0, 80)); s = s.split(a).join(b); }
          m.fragmentShader = s;
          m.needsUpdate = true;
        };
        if (js) await new Function("v", "keep", "patch", `return (async () => { ${js} })()`)(v, keep, patch);
        const gl = v.clouds.pass.renderer.getContext();
        const R = v.clouds.pass.renderer;
        const W = gl.drawingBufferWidth, H = gl.drawingBufferHeight;
        const reg = window.__sfReg;
        const raf = () => new Promise((r) => requestAnimationFrame(r));
        for (let i = 0; i < 40; i++) await raf();
        const buf = new Uint8Array(W * H * 4);
        const S = 4, w4 = Math.floor(W / S), h4 = Math.floor(H / S);
        const out = { strobe: [], t: [], mean: [], adapt: [], small: [] };
        const ad = new Float32Array(8);
        for (let f = 0; f < frames; f++) {
          const now = await raf();
          gl.bindFramebuffer(gl.FRAMEBUFFER, null);
          gl.readPixels(0, 0, W, H, gl.RGBA, gl.UNSIGNED_BYTE, buf);
          const s = [0, 0, 0, 0], n = [0, 0, 0, 0];
          for (let y = 0; y < H; y += 2) for (let x = 0; x < W; x += 2) {
            const k = y * W + x;
            const L = 0.2126 * buf[4 * k] + 0.7152 * buf[4 * k + 1] + 0.0722 * buf[4 * k + 2];
            s[reg[k]] += L; n[reg[k]]++;
          }
          out.mean.push(s.map((x, i) => x / Math.max(1, n[i])));
          const sm = new Uint8Array(w4 * h4);
          for (let y = 0; y < h4; y++) for (let x = 0; x < w4; x++) {
            const k = (y * S) * W + x * S;
            sm[y * w4 + x] = Math.round(0.2126 * buf[4 * k] + 0.7152 * buf[4 * k + 1] + 0.0722 * buf[4 * k + 2]);
          }
          out.small.push(sm);
          // 按 main.ts 的时序（ts % 1.1 的两个 50 ms 窗）算「本该在闪」，钉灭频闪的对照变体也能按同样的帧分段
          const ph = (now / 1000) % 1.1;
          out.strobe.push(ph < 0.05 || (ph > 0.14 && ph < 0.19) ? 1 : 0);
          out.t.push(now);
          try { R.readRenderTargetPixels(v.exposure.adapted[0], 0, 0, 1, 1, ad); out.adapt.push([ad[0], ad[1], ad[2]]); } catch { out.adapt.push(null); }
        }
        for (const [o, k, val] of saved.reverse()) { o[k] = val; if (k === "fragmentShader") o.needsUpdate = true; }
        window.__sfSmall = out.small;
        const regSmall = new Uint8Array(w4 * h4);
        for (let y = 0; y < h4; y++) for (let x = 0; x < w4; x++) regSmall[y * w4 + x] = reg[(y * S) * W + x * S];
        window.__sfRegSmall = regSmall;
        return { strobe: out.strobe, t: out.t, mean: out.mean, adapt: out.adapt, w4, h4 };
      }, { js: va.js || "", frames });
      // 像素级统计在页内算（整批小图传回 node 会撑爆堆）
      rec.small = null;
      const px = await page.evaluate(({ strobe }) => {
        const small = window.__sfSmall, reg = window.__sfRegSmall, N = reg.length;
        const st = strobe.map((x) => x >= 0.5);
        const segs = [];
        for (let i = 1; i < st.length; i++) if (st[i] && !st[i - 1]) { let j = i; while (j < st.length && st[j]) j++; if (i >= 3 && j < st.length) segs.push([i, j]); i = j; }
        const flashFrac = segs.map(([a, b]) => {
          let cnt = 0, tot = 0;
          for (let k = 0; k < N; k++) {
            if (reg[k] !== 3) continue;
            tot++;
            let mx = 0; for (let i = a; i < b; i++) mx = Math.max(mx, small[i][k]);
            if (mx - small[a - 1][k] >= 8) cnt++;
          }
          return cnt / Math.max(1, tot);
        });
        // 闪光期间「变暗」的像素（T48c P2-1 的口径：频闪亮起时翼梢 / 灯芯反而变暗）：闪光各帧的最大值都比闪前一帧暗 ≥ 4 级，窗内近 + 中区，4× 下采样
        const darkPx = segs.map(([a, b]) => {
          let cnt = 0;
          for (let k = 0; k < N; k++) {
            if (reg[k] !== 1 && reg[k] !== 2) continue;
            let mx = 0; for (let i = a; i < b; i++) mx = Math.max(mx, small[i][k]);
            if (mx - small[a - 1][k] <= -4) cnt++;
          }
          return cnt;
        });
        const skip = st.map((x, i) => x || st[i - 1] || st[i + 1]);
        const over = new Uint16Array(N);
        let used = 0;
        for (let i = 1; i < st.length - 1; i++) {
          if (skip[i - 1] || skip[i] || skip[i + 1]) continue;
          used++;
          const A = small[i - 1], B = small[i], C = small[i + 1];
          for (let k = 0; k < N; k++) if (Math.abs(B[k] - 0.5 * (A[k] + C[k])) > 16) over[k]++;
        }
        let flick = 0, flickNear = 0;
        for (let k = 0; k < N; k++) if (used && over[k] / used > 0.05) { if (reg[k] >= 2) flick++; else if (reg[k] === 1) flickNear++; }
        window.__sfSmall = null;
        return { flashFrac, darkPx, flick, flickNear, used };
      }, { strobe: rec.strobe });
      // 频闪段
      const st = rec.strobe.map((x) => x >= 0.5);
      const segs = [];
      for (let i = 1; i < st.length; i++) if (st[i] && !st[i - 1]) { let j = i; while (j < st.length && st[j]) j++; if (i >= 3 && j < st.length) segs.push([i, j]); i = j; }
      const regN = ["舱内", "窗内近", "窗内中", "窗内远"];
      const jumps = regN.map(() => []);
      for (const [a, b] of segs) {
        for (let r = 0; r < 4; r++) {
          const pre = (rec.mean[a - 1][r] + rec.mean[a - 2][r] + rec.mean[a - 3][r]) / 3;
          let mx = -1e9; for (let i = a; i < b; i++) mx = Math.max(mx, rec.mean[i][r]);
          jumps[r].push(mx - pre);
        }
      }
      const { flashFrac, darkPx, flick, flickNear, used } = px;
      const avg = (a) => (a.length ? a.reduce((x, y) => x + y, 0) / a.length : NaN);
      const dts = rec.t.slice(1).map((x, i) => x - rec.t[i]).sort((a, b) => a - b);
      // 自动曝光：频闪段内窗外对数均值 o 的最大抬升（log2）
      const adJ = segs.map(([a, b]) => { const pre = rec.adapt[a - 1]?.[0]; let mx = -1e9; for (let i = a; i < Math.min(b + 3, rec.adapt.length); i++) mx = Math.max(mx, rec.adapt[i]?.[0] ?? -1e9); return mx - pre; });
      const row = {
        segs: segs.length,
        jump: Object.fromEntries(regN.map((r, i) => [r, [+avg(jumps[i]).toFixed(2), +Math.max(...jumps[i], -1e9).toFixed(2)]])),
        base: Object.fromEntries(regN.map((r, i) => [r, +avg(rec.mean.map((m) => m[i])).toFixed(2)])),
        flashFarFrac: +avg(flashFrac).toFixed(4),
        darkNearMid: +avg(darkPx).toFixed(1),
        flickerNoStrobe: { 中远: flick, 近: flickNear, used },
        adaptJumpLog2: +avg(adJ).toFixed(4),
        dtMedian: +dts[Math.floor(dts.length / 2)].toFixed(2),
      };
      results[job.name].variants[va.name] = row;
      fs.writeFileSync(path.join(outDir, `${job.name}_${va.name}_series.json`), JSON.stringify({ strobe: rec.strobe, t: rec.t, mean: rec.mean, adapt: rec.adapt }));
      console.log(`${va.name}: 频闪段 ${row.segs}，跳变 均/最大（级）舱内 ${row.jump["舱内"]} 近 ${row.jump["窗内近"]} 中 ${row.jump["窗内中"]} 远 ${row.jump["窗内远"]}；基线 ${JSON.stringify(row.base)}；远区爆闪像素 ${(row.flashFarFrac * 100).toFixed(1)}%；近中变暗像素 ${row.darkNearMid}；非频闪闪烁像素 中远 ${flick} 近 ${flickNear}（${used} 帧）；适应 o 抬升 ${row.adaptJumpLog2} 档；帧间隔 ${row.dtMedian} ms`);
    }
    if (errors.length) console.log(`console error ${errors.length}：${errors.slice(0, 3).join(" | ")}`);
    results[job.name].errors = errors.length;
    await ctx.close();
  }
} finally {
  fs.writeFileSync(path.join(outDir, "summary.json"), JSON.stringify(results, null, 1));
  await closeBrowserSafely(browser);
}
