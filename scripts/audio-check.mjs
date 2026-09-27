#!/usr/bin/env node
// T11 声音的离线检查：headless 里听不见声音，就用 OfflineAudioContext 把各状态渲染几秒，
// 输出各倍频程能量、A 计权总声级（相对值）、峰值、左右相干度，确认频谱塑形正确、没有削波。
//
// 用法（apps/voyage 目录下）：
//   node scripts/audio-check.mjs [--port 5211]      # 端口上没有开发服务器时自己起一个 vite，结束时关掉
// 输出：<仓库>/tmp/audio-check/spectra.json，并在终端打印 Markdown 表。
//
// 口径：所有数字都是 dBFS（音量滑块 100%、压缩器之后）。噪声床的参考是 audio.ts 的 AIRFLOW_RMS（巡航气流层 −26 dBFS）。
// 注意 DynamicsCompressorNode 按 Web Audio 规范自带补偿增益（阈值 −3、比率 20 时约 +1.7 dB），所有输出整体抬一点。
// CPU：用 OfflineAudioContext.suspend() 每 0.25 s 停一下调用 update（和实时一样只预排 0.3 s 内的事件），
// 渲染墙钟 / 音频时长 ≈ 实时播放时音频线程 + 主线程 update 占一个核的比例（含 suspend 往返，偏保守）。

import { chromium } from "playwright-core";
import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { launchBrowser, closeBrowserSafely } from "./lib/chrome.mjs";

const VOYAGE_ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const REPO_ROOT = path.join(VOYAGE_ROOT, "..", "..");
const argv = process.argv.slice(2);
const port = Number(argv[argv.indexOf("--port") + 1] || 5211) || 5211;
const base = `http://127.0.0.1:${port}`;

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
} finally {
  await closeBrowserSafely(browser);
  if (server) server.kill();
}
