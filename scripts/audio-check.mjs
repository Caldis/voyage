#!/usr/bin/env node
// T11 声音的离线检查：headless 里听不见声音，就用 OfflineAudioContext 把各状态渲染几秒，
// 输出各倍频程能量、A 计权总声级（相对值）、峰值、左右相干度，确认频谱塑形正确、没有削波。
//
// 用法（apps/voyage 目录下）：
//   node scripts/audio-check.mjs [--port 5211]      # 端口上没有开发服务器时自己起一个 vite，结束时关掉
//   node scripts/audio-check.mjs --rail [--port …]  # 只查火车（TR07）：几何节奏表、渲染出来的节奏周期、道口多普勒、各场景频谱
//   node scripts/audio-check.mjs --rail --all       # 飞机 + 火车都查
// 输出：<仓库>/tmp/audio-check/spectra.json（飞机）、rail.json（火车），并在终端打印 Markdown 表。
// 火车部分不量 CPU（只量主线程 update 的单次耗时）；飞机部分的 cpu() 是 CPU 测量，跑之前按 README 看一眼测量锁。
//
// 口径：所有数字都是 dBFS（音量滑块 100%、压缩器之后）。噪声床的参考是 audio.ts 的 AIRFLOW_RMS（巡航气流层 −26 dBFS）。
// 注意 DynamicsCompressorNode 按 Web Audio 规范自带补偿增益（阈值 −3、比率 20 时约 +1.7 dB），所有输出整体抬一点。
// CPU：用 OfflineAudioContext.suspend() 每 0.25 s 停一下调用 update（和实时一样只预排 0.3 s 内的事件），
// 渲染墙钟 / 音频时长 ≈ 实时播放时音频线程 + 主线程 update 占一个核的比例（含 suspend 往返，偏保守）。

import { chromium } from "playwright-core";
import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { registerHooks } from "node:module";
import { launchBrowser, closeBrowserSafely } from "./lib/chrome.mjs";

const VOYAGE_ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const REPO_ROOT = path.join(VOYAGE_ROOT, "..", "..");
const argv = process.argv.slice(2);
const port = Number(argv[argv.indexOf("--port") + 1] || 5211) || 5211;
const base = `http://127.0.0.1:${port}`;
const railMode = argv.includes("--rail");
const planeMode = !railMode || argv.includes("--all");

async function reachable() {
  try {
    const r = await fetch(`${base}/src/audio.ts`);
    return r.ok;
  } catch {
    return false;
  }
}

let server = null;
if (!(await reachable())) {
  server = spawn(process.execPath, [path.join(VOYAGE_ROOT, "node_modules", "vite", "bin", "vite.js"), "--port", String(port), "--strictPort", "--host", "127.0.0.1"], { cwd: VOYAGE_ROOT, stdio: "ignore" });
  for (let i = 0; i < 60 && !(await reachable()); i++) await new Promise((r) => setTimeout(r, 500));
}

const browser = await launchBrowser(chromium, { angle: "d3d11" });
try {
  const page = await browser.newPage();
  page.on("console", (m) => m.type() === "error" && console.error("[页面]", m.text()));
  // 直接打开模块源码这个地址（同源、轻量，不会启动渲染器），再在页面里动态 import
  await page.goto(`${base}/src/audio.ts`);
  if (railMode) await railCheck(page);
  if (planeMode) {
  const result = await page.evaluate(async () => {
    const m = await import("/src/audio.ts");
    const fl = await import("/src/flight.ts");
    const SR = 48000;
    const BANDS = [31.5, 63, 125, 250, 500, 1000, 2000, 4000, 8000, 16000];

    // ---------- 分析 ----------
    function fft(re, im) {
      const n = re.length;
      for (let i = 1, j = 0; i < n; i++) {
        let bit = n >> 1;
        for (; j & bit; bit >>= 1) j ^= bit;
        j ^= bit;
        if (i < j) {
          [re[i], re[j]] = [re[j], re[i]];
          [im[i], im[j]] = [im[j], im[i]];
        }
      }
      for (let len = 2; len <= n; len <<= 1) {
        const ang = (-2 * Math.PI) / len, wr = Math.cos(ang), wi = Math.sin(ang), half = len >> 1;
        for (let i = 0; i < n; i += len) {
          let cr = 1, ci = 0;
          for (let k = 0; k < half; k++) {
            const a = i + k, b = a + half;
            const xr = re[b] * cr - im[b] * ci, xi = re[b] * ci + im[b] * cr;
            re[b] = re[a] - xr; im[b] = im[a] - xi; re[a] += xr; im[a] += xi;
            const nr = cr * wr - ci * wi; ci = cr * wi + ci * wr; cr = nr;
          }
        }
      }
    }
    const aWeightDb = (f) => {
      const f2 = f * f;
      const ra = (12194 ** 2 * f2 * f2) / ((f2 + 20.6 ** 2) * Math.sqrt((f2 + 107.7 ** 2) * (f2 + 737.9 ** 2)) * (f2 + 12194 ** 2));
      return 20 * Math.log10(ra) + 2.0;
    };
    const db = (x) => (x > 0 ? 10 * Math.log10(x) : -200);
    /** Welch 功率谱（Hann，50% 重叠）：返回每个频点的均方值贡献（L、R、交叉谱） */
    function analyze(buf, t0 = 0.2, t1 = buf.duration) {
      const L = buf.getChannelData(0), R = buf.getChannelData(1);
      const i0 = Math.floor(t0 * SR), i1 = Math.floor(t1 * SR);
      const N = 16384, hop = N / 2;
      const w = new Float64Array(N);
      let wss = 0;
      for (let i = 0; i < N; i++) { w[i] = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / N); wss += w[i] * w[i]; }
      const pl = new Float64Array(N / 2), pr = new Float64Array(N / 2), cre = new Float64Array(N / 2), cim = new Float64Array(N / 2);
      let segs = 0;
      for (let s = i0; s + N <= i1; s += hop) {
        const ar = new Float64Array(N), ai = new Float64Array(N), br = new Float64Array(N), bi = new Float64Array(N);
        for (let i = 0; i < N; i++) { ar[i] = L[s + i] * w[i]; br[i] = R[s + i] * w[i]; }
        fft(ar, ai); fft(br, bi);
        for (let k = 1; k < N / 2; k++) {
          pl[k] += ar[k] * ar[k] + ai[k] * ai[k];
          pr[k] += br[k] * br[k] + bi[k] * bi[k];
          cre[k] += ar[k] * br[k] + ai[k] * bi[k];
          cim[k] += ai[k] * br[k] - ar[k] * bi[k];
        }
        segs++;
      }
      // 归一：单边谱，Σ 频点 = 均方值
      const norm = 2 / (segs * N * wss);
      const df = SR / N;
      const bands = {};
      let totalMs = 0, aMs = 0;
      const coh = {};
      for (const fc of BANDS) {
        let e = 0, sl = 0, sr = 0, xr = 0, xi = 0;
        for (let k = Math.ceil(fc / Math.SQRT2 / df); k < Math.min(N / 2, fc * Math.SQRT2 / df); k++) {
          e += ((pl[k] + pr[k]) / 2) * norm;
          sl += pl[k]; sr += pr[k]; xr += cre[k]; xi += cim[k];
        }
        bands[fc] = +db(e).toFixed(1);
        coh[fc] = +(Math.hypot(xr, xi) / Math.sqrt(sl * sr + 1e-30)).toFixed(2);
      }
      for (let k = 1; k < N / 2; k++) {
        const e = ((pl[k] + pr[k]) / 2) * norm;
        totalMs += e;
        aMs += e * 10 ** (aWeightDb(k * df) / 10);
      }
      let peak = 0, clip = 0;
      for (let i = i0; i < i1; i++) {
        const a = Math.max(Math.abs(L[i]), Math.abs(R[i]));
        if (a > peak) peak = a;
        if (a >= 0.999) clip++;
      }
      // 每 0.5 s 的 RMS（dBFS），看事件的时间包络
      const env = [];
      for (let s = i0; s + SR / 2 <= i1; s += SR / 2) {
        let e = 0;
        for (let i = s; i < s + SR / 2; i++) e += (L[i] * L[i] + R[i] * R[i]) / 2;
        env.push(+db(e / (SR / 2)).toFixed(1));
      }
      // 低频（< 150 Hz，二阶低通）每 0.25 s 的 RMS：颠簸闷响、雷声主要在这里
      const lf = [];
      {
        const w0 = (2 * Math.PI * 150) / SR, al = Math.sin(w0) / (2 * 0.707), cs = Math.cos(w0);
        const b0 = (1 - cs) / 2 / (1 + al), b1 = (1 - cs) / (1 + al), a1 = (-2 * cs) / (1 + al), a2 = (1 - al) / (1 + al);
        let x1 = 0, x2 = 0, y1 = 0, y2 = 0, e = 0, c = 0;
        for (let i = i0; i < i1; i++) {
          const x = (L[i] + R[i]) / 2;
          const y = b0 * x + b1 * x1 + b0 * x2 - a1 * y1 - a2 * y2;
          x2 = x1; x1 = x; y2 = y1; y1 = y;
          e += y * y;
          if (++c === SR / 4) { lf.push(+db(e / c).toFixed(1)); e = 0; c = 0; }
        }
      }
      return { lfEnvelope: lf, bands, totalDbfs: +db(totalMs).toFixed(1), aDbfs: +db(aMs).toFixed(1), peakDbfs: +(20 * Math.log10(peak + 1e-12)).toFixed(1), clipped: clip, coherence: coh, envelope: env };
    }

    // ---------- 场景 ----------
    const input = (o = {}) => {
      const alt = o.altitudeKm ?? 10.7;
      return { altitudeKm: alt, speedKms: fl.speedAt(alt), climb: 0, turbulence: 0.03, inCloud: 0, airTempC: fl.outsideAirTempC(alt), slatDeg: 0, flapDeg: 0, spoilerDeg: 0, wingRootLE: 8, seatSign: 1, ...o };
    };
    async function render(name, sec, setup) {
      const ctx = new OfflineAudioContext(2, SR * sec, SR);
      const sc = new m.Soundscape(ctx, { aircon: true, chime: false }, 7);
      sc.output.connect(ctx.destination);
      const tb = performance.now();
      await sc.build();
      const buildMs = performance.now() - tb;
      sc.master.gain.value = 1;
      setup(sc);
      const t0 = performance.now();
      const buf = await ctx.startRendering();
      const renderMs = performance.now() - t0;
      return { name, seconds: sec, buildMs: Math.round(buildMs), renderMs: Math.round(renderMs), targets: sc.targets, ...analyze(buf) };
    }
    const upd = (o) => (sc) => sc.update(input(o), { immediate: true, horizon: 100 });
    const out = [];
    // CPU 先测（后面场景多了以后内存 / GC 会干扰计时）
    async function cpu(o, sec = 60) {
      const ctx = new OfflineAudioContext(2, SR * sec, SR);
      const sc = new m.Soundscape(ctx, { aircon: true, chime: true }, 11);
      sc.output.connect(ctx.destination);
      await sc.build();
      sc.master.gain.value = 1;
      sc.update(input(o), { immediate: true, horizon: 0.3 });
      for (let t = 0.25; t < sec; t += 0.25) {
        ctx.suspend(t).then(() => {
          sc.update(input(o), { force: true, horizon: 0.3 });
          if (Math.abs(t % 10) < 1e-6) sc.thunderAt(t + 0.1, 3 + (t % 20), true); // 每 10 s 一次雷
          ctx.resume();
        });
      }
      const t0 = performance.now();
      const buf = await ctx.startRendering();
      const ms = performance.now() - t0;
      const a = analyze(buf);
      return { realtimeFactor: +(ms / (sec * 1000)).toFixed(4), peakDbfs: a.peakDbfs, clipped: a.clipped };
    }
    const cpuQuiet = await cpu({});
    const cpuBusy = await cpu({ turbulence: 0.8, inCloud: 0.4, altitudeKm: 3, flapDeg: 20, slatDeg: 22, spoilerDeg: 10 });
    out.push(await render("巡航（10.7 km，机翼后方）", 5, upd({})));
    out.push(await render("巡航 · 座位机翼上方", 4, upd({ wingRootLE: 3 })));
    out.push(await render("巡航 · 座位机翼前方", 4, upd({ wingRootLE: -4 })));
    out.push(await render("巡航 · 空调关", 4, (sc) => { sc.options.aircon = false; upd({})(sc); }));
    out.push(await render("爬升（6 km，爬升推力）", 5, upd({ altitudeKm: 6, climb: 1 })));
    out.push(await render("下降（6 km，慢车 + 减速板 20°）", 5, upd({ altitudeKm: 6, climb: -1, spoilerDeg: 20 })));
    out.push(await render("进近平飞（1.0 km，襟翼收起）", 4, upd({ altitudeKm: 1.0 })));
    out.push(await render("襟翼放出（1.0 km，CONF 3：缝翼 22° / 襟翼 20°）", 5, upd({ altitudeKm: 1.0, slatDeg: 22, flapDeg: 20 })));
    out.push(await render("襟翼 FULL（0.6 km，27° / 40°）", 5, upd({ altitudeKm: 0.6, slatDeg: 27, flapDeg: 40 })));
    out.push(await render("颠簸（巡航，强度 0.8）", 10, upd({ turbulence: 0.8 })));
    out.push(await render("穿云 · 雨（3 km，−4.5°C，云密度 0.6，颠簸 0.4）", 5, upd({ altitudeKm: 3, inCloud: 0.6, turbulence: 0.4 })));
    out.push(await render("对照：3 km 云外（颠簸 0.4）", 5, upd({ altitudeKm: 3, turbulence: 0.4 })));
    out.push(await render("穿云 · 冰晶（巡航，云密度 0.5，颠簸 0.4）", 5, upd({ inCloud: 0.5, turbulence: 0.4 })));
    for (const [d, cg] of [[3, true], [10, false], [30, false], [60, false]]) {
      const dur = 4 + Math.min(d, 30) * 0.18 + 3;
      out.push(await render(`雷声 ${d} km${cg ? "（云地闪）" : "（云内闪）"}·只有雷`, Math.ceil(dur), (sc) => { upd({})(sc); sc.bed.gain.value = 0; sc.thunderAt(0.3, d, cg); }));
      out.push(await render(`雷声 ${d} km · 叠在巡航底噪上`, Math.ceil(dur), (sc) => { upd({})(sc); sc.thunderAt(0.3, d, cg); }));
    }
    out.push(await render("提示音（只有提示音）", 4, (sc) => { upd({})(sc); sc.bed.gain.value = 0; sc.chimeAt(0.2); }));

    // 主线程：update 的单次耗时
    const ctx = new OfflineAudioContext(2, SR, SR);
    const sc = new m.Soundscape(ctx, { aircon: true, chime: false }, 7);
    await sc.build();
    const t0 = performance.now();
    for (let i = 0; i < 2000; i++) sc.update(input({ turbulence: 0.5, altitudeKm: 10 + (i % 10) * 0.01 }), { force: true, horizon: 0.25 });
    const updateUs = ((performance.now() - t0) / 2000) * 1000;
    return { sampleRate: SR, scenes: out, cpu: { 平静巡航: cpuQuiet, 全部图层加颠簸与雷: cpuBusy, buildMs: out[0].buildMs, updateUs: +updateUs.toFixed(1) } };
  });

  const outDir = path.join(REPO_ROOT, "tmp", "audio-check");
  fs.mkdirSync(outDir, { recursive: true });
  fs.writeFileSync(path.join(outDir, "spectra.json"), JSON.stringify(result, null, 2));
  const bands = [31.5, 63, 125, 250, 500, 1000, 2000, 4000, 8000, 16000];
  console.log(`| 场景 | ${bands.map((b) => (b >= 1000 ? `${b / 1000}k` : b)).join(" | ")} | 总 dBFS | A 计权 | 峰值 | 削波 |`);
  console.log(`| --- | ${bands.map(() => "---").join(" | ")} | --- | --- | --- | --- |`);
  for (const s of result.scenes) console.log(`| ${s.name} | ${bands.map((b) => s.bands[b]).join(" | ")} | ${s.totalDbfs} | ${s.aDbfs} | ${s.peakDbfs} | ${s.clipped} |`);
  const cruise = result.scenes[0];
  console.log("\n巡航左右相干度（各倍频程）：", JSON.stringify(cruise.coherence));
  for (const s of result.scenes.filter((x) => x.name.includes("雷") || x.name.includes("颠簸") || x.name.includes("提示"))) console.log(`${s.name}
  每 0.5 s 全频 RMS：`, s.envelope.join(" "), `
  每 0.25 s 低频 RMS：`, s.lfEnvelope.join(" "));
  console.log("\nCPU：", JSON.stringify(result.cpu));
  console.log(`\n已写入 ${path.join(outDir, "spectra.json")}`);
  }
} finally {
  await closeBrowserSafely(browser);
  if (server) server.kill();
}

// =============================================================================================
// 火车（TR07）：`--rail`。先在 node 里打印几何推导的节奏表与多普勒理论值（sound-model.ts，纯计算），
// 再在页面里用 OfflineAudioContext 渲染火车的声音图，量节奏周期（自相关 + 起音检测）、道口多普勒（逐帧找谱峰）与各场景频谱。
// =============================================================================================
async function railCheck(page) {
  registerHooks({
    resolve(spec, ctx, next) {
      try {
        return next(spec, ctx);
      } catch (e) {
        if (spec.startsWith(".") && !spec.endsWith(".ts")) return next(`${spec}.ts`, ctx);
        throw e;
      }
    },
  });
  const sm = await import(pathToFileURL(path.join(VOYAGE_ROOT, "src", "rail", "sound-model.ts")).href);
  const geo = {};
  for (const kmh of [90, 60, 40]) geo[kmh] = sm.rhythmTable(kmh);
  const c = sm.SOUND_SPEED_MS, v90 = 25;
  geo.doppler = {
    c: +c.toFixed(1),
    approach: +sm.observerDoppler(v90, 1).toFixed(4),
    recede: +sm.observerDoppler(v90, -1).toFixed(4),
    tones: sm.BELL_FREQS_HZ.map((f) => [f, +(f * sm.observerDoppler(v90, 1)).toFixed(1), +(f * sm.observerDoppler(v90, -1)).toFixed(1)]),
    semitonesDrop: +(12 * Math.log2(sm.observerDoppler(v90, 1) / sm.observerDoppler(v90, -1))).toFixed(2),
  };
  console.log("\n## 火车：几何推导的接缝节奏（sound-model.ts，3 辆编组坐中间，听者在本车两台车中点）");
  for (const kmh of [90, 60, 40]) {
    const g = geo[kmh];
    console.log(`${kmh} km/h：周期 ${g.periodS} s；撞击时刻（s，括号里是车轴位置 m / 本车 = *）：` + g.hits.map((h) => `${h.t}(${h.a}${h.own ? "*" : ""})`).join(" "));
  }
  console.log(`道口多普勒（静止声源、运动听者 (c ± v)/c，c = ${geo.doppler.c} m/s，90 km/h）：靠近 ×${geo.doppler.approach}、离开 ×${geo.doppler.recede}，跌落 ${geo.doppler.semitonesDrop} 半音；` + geo.doppler.tones.map(([f, a, b]) => `${f} Hz → ${a} / ${b}`).join("，"));

  const res = await page.evaluate(async () => {
    const ar = await import("/src/rail/audio-rail.ts");
    const sm = await import("/src/rail/sound-model.ts");
    const dataM = await import("/src/rail/data.ts");
    const corM = await import("/src/rail/corridor.ts");
    const trM = await import("/src/rail/train.ts");
    const SR = 48000;
    const BANDS = [31.5, 63, 125, 250, 500, 1000, 2000, 4000, 8000, 16000];
    const db = (x) => (x > 0 ? 10 * Math.log10(x) : -200);
    function fft(re, im) {
      const n = re.length;
      for (let i = 1, j = 0; i < n; i++) {
        let bit = n >> 1;
        for (; j & bit; bit >>= 1) j ^= bit;
        j ^= bit;
        if (i < j) { [re[i], re[j]] = [re[j], re[i]]; [im[i], im[j]] = [im[j], im[i]]; }
      }
      for (let len = 2; len <= n; len <<= 1) {
        const ang = (-2 * Math.PI) / len, wr = Math.cos(ang), wi = Math.sin(ang), half = len >> 1;
        for (let i = 0; i < n; i += len) {
          let cr = 1, ci = 0;
          for (let k = 0; k < half; k++) {
            const a = i + k, b = a + half;
            const xr = re[b] * cr - im[b] * ci, xi = re[b] * ci + im[b] * cr;
            re[b] = re[a] - xr; im[b] = im[a] - xi; re[a] += xr; im[a] += xi;
            const nr = cr * wr - ci * wi; ci = cr * wi + ci * wr; cr = nr;
          }
        }
      }
    }
    const aW = (f) => { const f2 = f * f; const ra = (12194 ** 2 * f2 * f2) / ((f2 + 20.6 ** 2) * Math.sqrt((f2 + 107.7 ** 2) * (f2 + 737.9 ** 2)) * (f2 + 12194 ** 2)); return 20 * Math.log10(ra) + 2.0; };
    function spectrum(buf, t0 = 0.3, t1 = buf.duration) {
      const L = buf.getChannelData(0), R = buf.getChannelData(1);
      const N = 16384, hop = N / 2, i0 = Math.floor(t0 * SR), i1 = Math.floor(t1 * SR);
      const w = new Float64Array(N); let wss = 0;
      for (let i = 0; i < N; i++) { w[i] = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / N); wss += w[i] * w[i]; }
      const p = new Float64Array(N / 2); let segs = 0;
      for (let s = i0; s + N <= i1; s += hop) {
        for (const ch of [L, R]) {
          const re = new Float64Array(N), im = new Float64Array(N);
          for (let i = 0; i < N; i++) re[i] = ch[s + i] * w[i];
          fft(re, im);
          for (let k = 1; k < N / 2; k++) p[k] += (re[k] * re[k] + im[k] * im[k]) / 2;
        }
        segs++;
      }
      const norm = 2 / (Math.max(segs, 1) * N * wss), df = SR / N;
      const bands = {}; let tot = 0, aTot = 0;
      for (const fc of BANDS) { let e = 0; for (let k = Math.ceil(fc / Math.SQRT2 / df); k < Math.min(N / 2, (fc * Math.SQRT2) / df); k++) e += p[k] * norm; bands[fc] = +db(e).toFixed(1); }
      for (let k = 1; k < N / 2; k++) { tot += p[k] * norm; aTot += p[k] * norm * 10 ** (aW(k * df) / 10); }
      let peak = 0, clip = 0;
      for (let i = i0; i < i1; i++) { const a = Math.max(Math.abs(L[i]), Math.abs(R[i])); peak = Math.max(peak, a); if (a >= 0.999) clip++; }
      return { bands, totalDbfs: +db(tot).toFixed(1), aDbfs: +db(aTot).toFixed(1), peakDbfs: +(20 * Math.log10(peak + 1e-12)).toFixed(1), clipped: clip };
    }
    /** 渲染：每 0.1 s 停一下调用 update（和实时一样只预排 0.3 s） */
    async function render(sec, { track, joints = "jointed", bed = true, events = true, frame, seed = 5, announce }) {
      const ctx = new OfflineAudioContext(2, Math.round(SR * sec), SR);
      const sc = new ar.RailSoundscape(ctx, track, { aircon: true, joints }, seed);
      sc.output.connect(ctx.destination);
      await sc.build();
      sc.master.gain.value = 1;
      if (!bed) sc.bed.gain.value = 0;
      if (!events) sc.events.gain.value = 0;
      sc.logEnabled = true;
      sc.update(frame(0), { immediate: true, horizon: 0.3 });
      const tl = [];
      for (let i = 1; i * 0.1 < sec - 0.05; i++) {
        const t = +(i * 0.1).toFixed(4);
        ctx.suspend(t).then(() => {
          sc.update(frame(ctx.currentTime), { force: true, horizon: 0.3 });
          tl.push({ t: +ctx.currentTime.toFixed(3), ...sc.targets });
          ctx.resume();
        });
      }
      if (announce) sc.announceAt(0.3, announce);
      const buf = await ctx.startRendering();
      return { buf, sc, tl };
    }
    const flat = (extra = {}) => ({ crossings: [], turnouts: [], curvature: () => 0, bridge: () => false, ...extra });
    const cruise = (kmh, s0 = 1000, eyeD = -0.95) => (t) => ({ s: s0 + (kmh / 3.6) * t, dir: 1, speed: kmh / 3.6, effort: 0.12, dwell: 0, eyeD, seatSign: 1 });

    /** 节奏：只听事件，高频（> 1 kHz 的金属声）5 ms 帧能量找起音；全频 10 ms 包络做自相关求周期 */
    function rhythm(buf, t0 = 0.5) {
      const x = buf.getChannelData(0), y = buf.getChannelData(1);
      const i0 = Math.floor(t0 * SR);
      // 一阶高通 1 kHz
      const a = Math.exp((-2 * Math.PI * 1000) / SR);
      let hp = 0, px = 0;
      const F = SR / 200; // 5 ms
      const hf = [], env = [];
      let e = 0, e2 = 0, c = 0;
      for (let i = i0; i < x.length; i++) {
        const m = (x[i] + y[i]) / 2;
        hp = a * (hp + m - px); px = m;
        e += hp * hp; e2 += m * m;
        if (++c === F) { hf.push(e / F); env.push(e2 / F); e = 0; e2 = 0; c = 0; }
      }
      const mx = Math.max(...hf);
      const onsets = [];
      for (let k = 1; k < hf.length - 1; k++) {
        if (hf[k] > mx * 0.01 && hf[k] >= hf[k - 1] && hf[k] >= hf[k + 1] && hf[k] > 4 * (hf[k - 2] ?? 0)) {
          const t = t0 + k * 0.005;
          if (!onsets.length || t - onsets[onsets.length - 1] > 0.03) onsets.push(+t.toFixed(3));
        }
      }
      // 自相关（10 ms 帧的全频能量包络，去均值），滞后 0.4–2.5 s 找最大
      const env10 = [];
      for (let k = 0; k + 1 < env.length; k += 2) env10.push(Math.sqrt(env[k] + env[k + 1]));
      const mean = env10.reduce((s, v) => s + v, 0) / env10.length;
      const z = env10.map((v) => v - mean);
      let best = 0, bestLag = 0;
      const ac = [];
      for (let lag = 40; lag <= 250 && lag < z.length / 2; lag++) {
        let s = 0;
        for (let k = 0; k + lag < z.length; k++) s += z[k] * z[k + lag];
        s /= z.length - lag;
        ac.push(s);
        if (s > best) { best = s; bestLag = lag; }
      }
      // 防倍周期：周期 T 的包络在 2T、3T 处的自相关和 T 处几乎一样高，取「≥ 最大值 90%」的局部峰里最短的滞后
      for (let i = 1; i < ac.length - 1; i++) {
        if (ac[i] >= 0.9 * best && ac[i] >= ac[i - 1] && ac[i] >= ac[i + 1]) {
          bestLag = i + 40;
          break;
        }
      }
      // 抛物线插值
      const li = bestLag - 40;
      let frac = 0;
      if (li > 0 && li < ac.length - 1) { const [p, q, r] = [ac[li - 1], ac[li], ac[li + 1]]; frac = (0.5 * (p - r)) / (p - 2 * q + r || 1); }
      return { onsets, periodS: +((bestLag + frac) * 0.01).toFixed(3) };
    }

    const out = { rhythm: {}, spectra: [], doppler: null, motor: null, line: null };

    // ---- 节奏 ----
    for (const kmh of [90, 60]) {
      const sec = kmh === 90 ? 8.5 : 10.5;
      const { buf, sc } = await render(sec, { track: flat(), bed: false, frame: cruise(kmh) });
      const r = rhythm(buf);
      // 起音相对本车第一下「タタン」的相位（取一个周期里的前几个）
      const P = 25 / (kmh / 3.6);
      const sched = sc.log.joints.filter((j) => j.t > 0.5);
      const strong = sched.filter((j) => j.gain > 0.03);
      out.rhythm[kmh] = { measuredPeriodS: r.periodS, theoryPeriodS: +P.toFixed(3), onsetsDetected: r.onsets.length, scheduledHits: sched.length, scheduledStrong: strong.length, onsetsFirst2s: r.onsets.filter((t) => t < 2.5), scheduledFirst2s: [...new Set(strong.filter((j) => j.t < 2.5).map((j) => +j.t.toFixed(3)))] };
    }
    {
      const { buf, sc } = await render(8.5, { track: flat(), joints: "welded", bed: false, frame: cruise(90, 1000) });
      const r = rhythm(buf);
      out.rhythm.welded = { onsetsDetected: r.onsets.length, scheduledHits: sc.log.joints.length, note: "长轨化：8 s 里只可能遇到伸缩接头（每 1200 m 一处，示例）" };
    }

    // ---- 道口多普勒：道口在 s = 1100，90 km/h 从 1000 开过去；只听事件（撞击也关：直线长轨，没有接缝） ----
    {
      const sc0 = 1100, kmh = 90, v = kmh / 3.6, s0 = 1000, sec = 9;
      const { buf, sc } = await render(sec, { track: flat({ crossings: [sc0] }), joints: "welded", bed: false, frame: cruise(kmh, s0) });
      const tPass = (sc0 - s0) / v;
      const devs = sm.crossingDevices(0);
      // 逐帧（8192 点、hop 2048）找 600–850 Hz 里最强的两个峰，取低的一个（700 Hz 那个音）
      const x = buf.getChannelData(0), y = buf.getChannelData(1);
      const N = 8192, hop = 2048, frames = [];
      const w = new Float64Array(N); for (let i = 0; i < N; i++) w[i] = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / N);
      for (let s = 0; s + N <= x.length; s += hop) {
        const re = new Float64Array(N), im = new Float64Array(N);
        for (let i = 0; i < N; i++) re[i] = ((x[s + i] + y[s + i]) / 2) * w[i];
        fft(re, im);
        const df = SR / N, mag = (k) => Math.hypot(re[k], im[k]);
        const k0 = Math.floor(600 / df), k1 = Math.ceil(850 / df);
        const peaks = [];
        for (let k = k0 + 1; k < k1; k++) if (mag(k) > mag(k - 1) && mag(k) >= mag(k + 1)) peaks.push(k);
        peaks.sort((a, b) => mag(b) - mag(a));
        const top = peaks.slice(0, 2).sort((a, b) => a - b);
        if (!top.length) continue;
        const k = top[0];
        const [p, q, r] = [Math.log(mag(k - 1) + 1e-20), Math.log(mag(k) + 1e-20), Math.log(mag(k + 1) + 1e-20)];
        const d = (0.5 * (p - r)) / (p - 2 * q + r || 1);
        let e = 0; for (let i = 0; i < N; i++) e += re[i] * re[i];
        frames.push({ t: +((s + N / 2) / SR).toFixed(3), f: +((k + d) * df).toFixed(1), lvl: +db(mag(k) ** 2).toFixed(1) });
      }
      const loud = Math.max(...frames.map((f) => f.lvl));
      const ok = frames.filter((f) => f.lvl > loud - 30);
      const med = (a) => { const b = [...a].sort((p, q) => p - q); return b.length ? b[Math.floor(b.length / 2)] : null; };
      const before = med(ok.filter((f) => f.t < tPass - 0.8 && f.t > tPass - 3).map((f) => f.f));
      const after = med(ok.filter((f) => f.t > tPass + 0.8 && f.t < tPass + 3).map((f) => f.f));
      const lowF = Math.min(...devs.map((d) => d.f[0]));
      out.doppler = {
        crossingAtS: tPass.toFixed(2), devices: devs.map((d) => ({ f: d.f.map((z) => +z.toFixed(1)), ds: +d.ds.toFixed(2), d: +d.d.toFixed(2) })),
        measuredBeforeHz: before, measuredAfterHz: after, ratio: before && after ? +(after / before).toFixed(4) : null,
        theory: { lowToneHz: +lowF.toFixed(1), approachHz: +(lowF * sm.observerDoppler(v, 1)).toFixed(1), recedeHz: +(lowF * sm.observerDoppler(v, -1)).toFixed(1), ratio: +(sm.observerDoppler(v, -1) / sm.observerDoppler(v, 1)).toFixed(4) },
        strikes: sc.log.bells.length,
        firstStrikeT: sc.log.bells[0]?.t, lastStrikeT: sc.log.bells.at(-1)?.t,
        pitchTrack: frames.filter((f) => Math.abs(f.t - tPass) < 1.2).map((f) => `${f.t}:${f.f}`),
      };
      out.spectra.push({ name: "道口通过（只有警报声，90 km/h）", ...spectrum(buf, tPass - 1, tPass + 1) });
    }

    // ---- 各场景频谱 ----
    const scene = async (name, sec, o, t0 = 0.5) => {
      const r = await render(sec, o);
      const sp = spectrum(r.buf, t0);
      out.spectra.push({ name, ...sp, last: r.tl.at(-1) });
      return r;
    };
    await scene("巡航 90 km/h · 定尺（示例）", 6, { track: flat(), frame: cruise(90) });
    await scene("巡航 90 km/h · 长轨化", 6, { track: flat(), joints: "welded", frame: cruise(90) });
    await scene("巡航 60 km/h · 定尺", 6, { track: flat(), frame: cruise(60) });
    await scene("巡航 90 km/h · 定尺 · 桥上", 6, { track: flat({ bridge: () => true }), frame: cruise(90) });
    await scene("弯道 R = 270 m · 80 km/h（尖啸）", 8, { track: flat({ curvature: () => 1 / 270 }), joints: "welded", frame: cruise(80) });
    await scene("对照：直线 80 km/h 长轨", 8, { track: flat(), joints: "welded", frame: cruise(80) });
    // 起步：0 → 60 km/h，0.6 m/s²（train.ts 的 ACCEL）
    {
      const a = 0.6, vmax = 60 / 3.6, sec = 30;
      const frame = (t) => { const v = Math.min(a * t, vmax); const tt = Math.min(t, vmax / a); const s = 1000 + 0.5 * a * tt * tt + vmax * Math.max(0, t - vmax / a); return { s, dir: 1, speed: v, effort: v < vmax - 0.05 ? 1 : 0.12, dwell: 0, eyeD: -0.95, seatSign: 1 }; };
      const r = await render(sec, { track: flat(), frame });
      out.spectra.push({ name: "起步加速 0 → 60 km/h（整段）", ...spectrum(r.buf, 0.3) });
      const steps = [];
      let lastP = null;
      for (const x of r.tl) if (x.motorPulses !== lastP) { steps.push({ t: x.t, kmh: +(Math.min(a * x.t, vmax) * 3.6).toFixed(1), pulses: x.motorPulses, hz: +x.motorHz.toFixed(0) }); lastP = x.motorPulses; }
      out.motor = { steps, gearHzAt60: +r.tl.at(-1).gearHz.toFixed(0) };
    }
    // 制动停车：30 km/h、0.7 m/s² 减速到 0，停 5 s
    {
      const v0 = 30 / 3.6, b = 0.7, tStop = v0 / b, sec = tStop + 6;
      const frame = (t) => { const tt = Math.min(t, tStop); const v = Math.max(v0 - b * tt, 0); return { s: 1000 + v0 * tt - 0.5 * b * tt * tt, dir: 1, speed: v, effort: t < tStop ? -0.8 : 0, dwell: t < tStop ? 0 : 40 - (t - tStop), eyeD: -0.95, seatSign: 1 }; };
      const r = await render(sec, { track: flat(), frame });
      const L = r.buf.getChannelData(0);
      const env = [];
      for (let s = 0; s + SR / 2 <= L.length; s += SR / 2) { let e = 0; for (let i = s; i < s + SR / 2; i++) e += L[i] * L[i]; env.push(+db(e / (SR / 2)).toFixed(1)); }
      out.spectra.push({ name: "制动停车 30 → 0 km/h（最后 4 s 前）", ...spectrum(r.buf, tStop - 4, tStop) });
      out.spectra.push({ name: "停车后（只有空调）", ...spectrum(r.buf, tStop + 2.5, sec) });
      out.brake = { tStop: +tStop.toFixed(2), envelopeDbfsPerHalfSecond: env };
    }
    {
      const r = await render(7, { track: flat(), bed: false, frame: (t) => ({ s: 1000, dir: 1, speed: 0, effort: 0, dwell: 30, eyeD: -0.95, seatSign: 1 }), announce: { text: "次は 豊科", kind: "next", durationS: 3 + 2 * 0.28 } });
      out.spectra.push({ name: "车内广播喃喃声（只有它）", ...spectrum(r.buf, 0.3, 4.5) });
    }

    // ---- 真实线路：松本出发后 0.4–1.3 km（3 处道口 + R ≈ 274 m 的弯道），用 train.ts 的真实速度曲线 ----
    {
      const data = await dataM.loadRailData("oito-matsumoto-shinanoomachi", "/data/rail/");
      const cor = new corM.Corridor(data);
      const train = new trM.Train(cor, { s: 380, dir: 1, speed: 60 / 3.6 });
      const track = ar.trackInfoFrom(cor);
      let lastT = 0;
      const frame = (t) => {
        if (t > lastT) train.update(t - lastT);
        lastT = t;
        return ar.railFrameFrom(train, train.pose("right"), 1);
      };
      const r = await render(40, { track, frame });
      const tl = r.tl;
      out.line = {
        from: 380, to: +train.s.toFixed(0), kmhEnd: +(train.speed * 3.6).toFixed(0),
        turnouts: track.turnouts.slice(0, 6).map((s) => +s.toFixed(0)), turnoutCount: track.turnouts.length,
        jointHits: r.sc.log.joints.length, bellStrikes: r.sc.log.bells.length,
        squealMax: Math.max(...tl.map((x) => x.squealLin)), squealActiveFrames: tl.filter((x) => x.squealLin > 0).length,
        ...spectrum(r.buf, 0.5),
      };
    }

    // ---- 主线程：update 单次耗时 ----
    {
      const ctx = new OfflineAudioContext(2, SR, SR);
      const sc = new ar.RailSoundscape(ctx, flat({ crossings: [1010, 1500] }), { aircon: true, joints: "jointed" }, 3);
      await sc.build();
      const t0 = performance.now();
      for (let i = 0; i < 500; i++) sc.update(cruise(90)(i * 0.01), { force: true, horizon: 0.3 });
      out.updateUs = +(((performance.now() - t0) / 500) * 1000).toFixed(1);
    }
    return out;
  });
  res.geometry = geo;
  const outDir = path.join(REPO_ROOT, "tmp", "audio-check");
  fs.mkdirSync(outDir, { recursive: true });
  fs.writeFileSync(path.join(outDir, "rail.json"), JSON.stringify(res, null, 2));
  console.log("\n## 火车：渲染出来的节奏");
  for (const [k, r] of Object.entries(res.rhythm)) console.log(k, JSON.stringify(r));
  console.log("\n## 火车：道口多普勒（实测 = 渲染结果逐帧谱峰的中位数，通过前 0.8–3 s / 通过后 0.8–3 s）");
  console.log(JSON.stringify(res.doppler, null, 1));
  console.log("\n## 火车：变频器换挡（示意）", JSON.stringify(res.motor));
  console.log("制动停车包络（每 0.5 s，dBFS）：", res.brake.envelopeDbfsPerHalfSecond.join(" "), `（停稳于 ${res.brake.tStop} s）`);
  console.log("\n## 火车：频谱（dBFS，音量 100%）");
  const bands = [31.5, 63, 125, 250, 500, 1000, 2000, 4000, 8000, 16000];
  console.log(`| 场景 | ${bands.map((b) => (b >= 1000 ? `${b / 1000}k` : b)).join(" | ")} | 总 | A 计权 | 峰值 | 削波 |`);
  console.log(`| --- | ${bands.map(() => "---").join(" | ")} | --- | --- | --- | --- |`);
  for (const s of [...res.spectra, { name: "真实线路 0.4 km 起 40 s（train.ts 速度曲线）", ...res.line }]) console.log(`| ${s.name} | ${bands.map((b) => s.bands[b]).join(" | ")} | ${s.totalDbfs} | ${s.aDbfs} | ${s.peakDbfs} | ${s.clipped} |`);
  const { bands: _b, ...lineRest } = res.line;
  console.log("\n真实线路：", JSON.stringify(lineRest));
  console.log(`主线程 update 单次：${res.updateUs} µs`);
  console.log(`\n已写入 ${path.join(outDir, "rail.json")}`);
}
